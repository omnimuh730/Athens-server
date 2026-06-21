import { ObjectId } from "mongodb";
import { accountInfoCollection, resumeGeneratorConfigCollection, resumeGenerationsCollection } from "../db/mongo.js";
import { syncGeneratedResumeAfterRun } from "../services/generatedResumeService.js";
import {
  PROVIDERS,
  getProvider,
  chatCompletion,
  listModels,
  verifyKey,
  addUsage,
  EMPTY_USAGE,
} from "../services/llm/llmService.js";

const cleanString = (v) => String(v ?? "").trim();

/** Resolve an applier's autoBidProfile (exact, then case-insensitive). */
async function findProfile(applierNameRaw) {
  const name = String(applierNameRaw ?? "").trim();
  if (!name || !accountInfoCollection) return null;
  const proj = { projection: { autoBidProfile: 1 } };
  let acc = await accountInfoCollection.findOne({ name }, proj);
  if (!acc) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    acc = await accountInfoCollection.findOne({ name: { $regex: new RegExp(`^${esc}$`, "i") } }, proj);
  }
  return acc?.autoBidProfile || null;
}

function apiKeyFor(profile, providerId) {
  const provider = getProvider(providerId);
  return String(profile?.[provider.keyField] || "").trim();
}

/** GET /personal/llm-models?provider=&applierName= — model list per provider. */
export async function getLlmModels(req, res) {
  try {
    const providerId = PROVIDERS[req.query?.provider] ? req.query.provider : "openai";
    const provider = getProvider(providerId);
    // Fixed-catalog providers (DeepSeek) don't need a key to list models.
    if (Array.isArray(provider.models)) {
      return res.json({ success: true, provider: providerId, models: provider.models });
    }
    const profile = await findProfile(req.query?.applierName);
    const apiKey = apiKeyFor(profile, providerId);
    if (!apiKey) {
      return res.json({ success: true, provider: providerId, models: [], error: `No ${provider.label} API key in profile.` });
    }
    const models = await listModels({ provider: providerId, apiKey, force: req.query?.force === "1" });
    return res.json({ success: true, provider: providerId, models });
  } catch (err) {
    // A bad/expired key is an expected, recoverable condition — warn, don't spam
    // a full stack trace, and let the UI fall back to its default model list.
    console.warn(`GET /api/personal/llm-models failed: ${err.message}`);
    return res.status(200).json({ success: false, models: [], error: err.message });
  }
}

/**
 * Parse a JSON object from a model reply, tolerating Markdown code fences and
 * stray prose (Claude often wraps JSON in ```json … ```).
 */
function parseJsonLoose(text) {
  const raw = String(text ?? "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  const fenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(fenced);
  } catch {
    /* fall through */
  }
  const first = fenced.indexOf("{");
  const last = fenced.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(fenced.slice(first, last + 1));
  }
  throw new Error("No JSON object found in model response.");
}

const PURPOSES = new Set(["summary", "skills", "experience", "education"]);

// Resolve the reference tokens a prompt may use into concrete strings, derived
// from the candidate profile + JD. `{career}` is a newline-joined summary of all
// roles; `{companyN_*}` expose each role's fields (N is 1-based, by recency order
// as stored on the profile).
function buildTokenMap(identity, jobDescription) {
  const careers = Array.isArray(identity?.careers) ? identity.careers : [];
  const field = (v) => cleanString(v);
  const map = {
    job_description: cleanString(jobDescription),
    career: careers
      .map((c) => [field(c?.title), field(c?.company), field(c?.period)].filter(Boolean).join(" | "))
      .filter(Boolean)
      .join("\n"),
  };
  careers.forEach((c, i) => {
    const n = i + 1;
    map[`company${n}_name`] = field(c?.company);
    map[`company${n}_title`] = field(c?.title);
    map[`company${n}_duration`] = field(c?.period);
  });
  return map;
}

function buildContextBlock(identity) {
  // Stable prefix (kept identical across steps) so the prompt cache covers it.
  return `CANDIDATE PROFILE — these are authoritative facts. Do not invent employers, dates, schools, or credentials.\n\n${JSON.stringify(
    identity ?? {},
    null,
    2,
  )}`;
}

// Validate + resolve a generation request. Returns { ok, ... } or { ok:false, status, error }.
async function prepareGeneration(body) {
  const providerId = PROVIDERS[body.provider] ? body.provider : "openai";
  const model = String(body.model || "").trim();
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (!model) return { ok: false, status: 400, error: "model is required" };
  if (!steps.length) return { ok: false, status: 400, error: "steps are required" };

  const profile = await findProfile(body.applierName);
  const apiKey = apiKeyFor(profile, providerId);
  if (!apiKey) {
    return { ok: false, status: 400, error: `No ${getProvider(providerId).label} API key configured in profile.` };
  }

  // Exactly one final step per purpose that appears.
  const finalsByPurpose = {};
  for (const s of steps) {
    if (s?.kind === "final" && PURPOSES.has(s.purpose)) finalsByPurpose[s.purpose] = (finalsByPurpose[s.purpose] || 0) + 1;
  }
  const bad = Object.entries(finalsByPurpose).find(([, n]) => n !== 1);
  if (bad) return { ok: false, status: 400, error: `${bad[0]} must have exactly one final step (found ${bad[1]}).` };

  return { ok: true, providerId, model, steps, apiKey };
}

/**
 * Runs the resume pipeline as one continuous, cached conversation. The system
 * instruction + profile form a stable prefix (kept in the prompt cache via
 * cacheKey), each step appends a turn, and final steps return JSON for a section.
 * `onStep` is invoked after every step for live progress streaming.
 */
async function runGeneration({ providerId, apiKey, model, steps, systemInstruction, identity, applierName, jobDescription, reasoningEffort }, onStep) {
  // Substitute reference tokens in any prompt with real values:
  //   {job_description}                          → the JD text the user typed
  //   {career}                                   → all roles, one per line
  //   {companyN_name|title|duration} (N = 1,2,…) → fields of the Nth career
  const tokenMap = buildTokenMap(identity, jobDescription);
  const applyTokens = (text) =>
    String(text ?? "").replace(/\{[a-z0-9_]+\}/gi, (match) => {
      const key = match.slice(1, -1).toLowerCase();
      return Object.prototype.hasOwnProperty.call(tokenMap, key) ? tokenMap[key] : match;
    });

  const messages = [
    { role: "system", content: applyTokens(systemInstruction || "You are an expert resume writer.") },
    { role: "user", content: buildContextBlock(identity) },
  ];
  const sections = {};
  const perStep = [];
  let usage = EMPTY_USAGE();

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] || {};
    const isFinal = step.kind === "final";
    if (onStep) onStep({ phase: "step-start", index: i + 1, total: steps.length, name: step.name || `Step ${i + 1}`, purpose: step.purpose, kind: step.kind });

    let userContent = applyTokens(step.prompt || "");
    if (isFinal && step.schema) {
      userContent += `\n\nReturn ONLY a JSON object that conforms to this JSON Schema:\n${JSON.stringify(step.schema)}`;
    }
    messages.push({ role: "user", content: userContent });

    const { content, usage: stepUsage } = await chatCompletion({
      provider: providerId,
      apiKey,
      model,
      messages,
      jsonMode: isFinal,
      cacheKey: `resume-${applierName || "anon"}`, // stable → prompt-cache the prefix
      reasoningEffort,
    });
    messages.push({ role: "assistant", content });
    usage = addUsage(usage, stepUsage);

    let output = content;
    if (isFinal) {
      try {
        output = parseJsonLoose(content);
        if (PURPOSES.has(step.purpose)) sections[step.purpose] = output;
      } catch {
        const e = new Error(`${step.purpose} final step returned invalid JSON.`);
        e.status = 502;
        throw e;
      }
    }
    const entry = { index: i + 1, name: step.name || `Step ${i + 1}`, purpose: step.purpose, kind: step.kind, usage: stepUsage, output };
    perStep.push(entry);
    if (onStep) onStep({ phase: "step-done", ...entry, cumulative: usage });
  }

  return { sections, perStep, usage };
}

// Persist a finished (or failed) run to the local resume_generations history.
async function saveGenerationRun(doc) {
  try {
    if (resumeGenerationsCollection) {
      const result = await resumeGenerationsCollection.insertOne(doc);
      return result.insertedId;
    }
  } catch (err) {
    console.warn("[resume_generations] insert failed:", err.message);
  }
  return null;
}

function configSnapshot(body) {
  return {
    provider: body.provider,
    model: body.model,
    reasoningEffort: body.reasoningEffort ?? null,
    templateId: body.templateId ?? null,
    template: body.template ?? null,
    theme: body.theme ?? null,
    layout: body.layout ?? null,
    systemInstruction: body.systemInstruction ?? null,
    jobDescription: body.jobDescription ?? null,
    steps: body.steps ?? null,
  };
}

/**
 * POST /personal/resume-generate — non-streaming. Runs the pipeline, persists
 * the run, returns the full result + usage.
 */
export async function generateResume(req, res) {
  const body = req.body || {};
  const prep = await prepareGeneration(body);
  if (!prep.ok) return res.status(prep.status).json({ success: false, error: prep.error });
  const startedAt = new Date();
  try {
    const result = await runGeneration({ ...prep, systemInstruction: body.systemInstruction, identity: body.identity, applierName: body.applierName, jobDescription: body.jobDescription, reasoningEffort: body.reasoningEffort });
    const generationId = await saveGenerationRun({
      applierName: cleanString(body.applierName) || null,
      provider: prep.providerId,
      model: prep.model,
      status: "completed",
      config: configSnapshot(body),
      identity: body.identity ?? null,
      jobDescription: cleanString(body.jobDescription) || null,
      sections: result.sections,
      perStep: result.perStep,
      usage: result.usage,
      startedAt,
      finishedAt: new Date(),
    });
    try {
      await syncGeneratedResumeAfterRun({
        generationId,
        ownerName: cleanString(body.applierName),
        sections: result.sections,
        identity: body.identity,
        jobDescription: cleanString(body.jobDescription),
        templateId: body.templateId ?? null,
      });
    } catch (syncErr) {
      console.warn("[resume-generate] library sync failed:", syncErr.message);
    }
    return res.json({ success: true, provider: prep.providerId, model: prep.model, ...result });
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    const friendly = status === 429 ? `${err.message} — rate limited; wait a few seconds and try again.` : err.message;
    console.warn(`POST /api/personal/resume-generate failed (${status}): ${err.message}`);
    await saveGenerationRun({
      applierName: cleanString(body.applierName) || null,
      provider: prep.providerId,
      model: prep.model,
      status: "failed",
      error: err.message,
      config: configSnapshot(body),
      startedAt,
      finishedAt: new Date(),
    });
    return res.status(status === 429 ? 429 : 500).json({ success: false, error: friendly, status });
  }
}

/**
 * POST /personal/resume-generate/stream — Server-Sent Events. Emits a `step`
 * event as each step starts/finishes (with per-step + cumulative usage), then a
 * `done` (or `error`) event. The run is persisted to history on completion.
 */
export async function generateResumeStream(req, res) {
  const body = req.body || {};
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const prep = await prepareGeneration(body);
  if (!prep.ok) {
    send("error", { error: prep.error, status: prep.status });
    return res.end();
  }
  send("start", { provider: prep.providerId, model: prep.model, total: prep.steps.length });

  const startedAt = new Date();
  try {
    const result = await runGeneration(
      { ...prep, systemInstruction: body.systemInstruction, identity: body.identity, applierName: body.applierName, jobDescription: body.jobDescription, reasoningEffort: body.reasoningEffort },
      (evt) => send("step", evt),
    );
    const generationId = await saveGenerationRun({
      applierName: cleanString(body.applierName) || null,
      provider: prep.providerId,
      model: prep.model,
      status: "completed",
      config: configSnapshot(body),
      identity: body.identity ?? null,
      jobDescription: cleanString(body.jobDescription) || null,
      sections: result.sections,
      perStep: result.perStep,
      usage: result.usage,
      startedAt,
      finishedAt: new Date(),
    });
    try {
      await syncGeneratedResumeAfterRun({
        generationId,
        ownerName: cleanString(body.applierName),
        sections: result.sections,
        identity: body.identity,
        jobDescription: cleanString(body.jobDescription),
        templateId: body.templateId ?? null,
      });
    } catch (syncErr) {
      console.warn("[resume-generate/stream] library sync failed:", syncErr.message);
    }
    send("done", { provider: prep.providerId, model: prep.model, sections: result.sections, usage: result.usage });
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    const friendly = status === 429 ? `${err.message} — rate limited; wait a few seconds and try again.` : err.message;
    console.warn(`stream resume-generate failed (${status}): ${err.message}`);
    await saveGenerationRun({
      applierName: cleanString(body.applierName) || null,
      provider: prep.providerId,
      model: prep.model,
      status: "failed",
      error: err.message,
      config: configSnapshot(body),
      startedAt,
      finishedAt: new Date(),
    });
    send("error", { error: friendly, status });
  }
  res.end();
}

/** GET /personal/resume-generator/config?applierName= — load saved config. */
export async function getGeneratorConfig(req, res) {
  try {
    const applierName = cleanString(req.query?.applierName);
    if (!applierName || !resumeGeneratorConfigCollection) return res.json({ success: true, config: null });
    const doc = await resumeGeneratorConfigCollection.findOne({ applierName });
    return res.json({ success: true, config: doc?.config ?? null, updatedAt: doc?.updatedAt ?? null });
  } catch (err) {
    console.warn("GET /api/personal/resume-generator/config error:", err.message);
    return res.json({ success: false, config: null, error: err.message });
  }
}

/** PUT /personal/resume-generator/config — save config for the applier. */
export async function saveGeneratorConfig(req, res) {
  try {
    const body = req.body || {};
    const applierName = cleanString(body.applierName);
    if (!applierName) return res.status(400).json({ success: false, error: "applierName is required" });
    if (!resumeGeneratorConfigCollection) return res.status(503).json({ success: false, error: "DB not ready" });
    const config = body.config && typeof body.config === "object" ? body.config : {};
    await resumeGeneratorConfigCollection.updateOne(
      { applierName },
      { $set: { applierName, config, updatedAt: new Date() } },
      { upsert: true },
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("PUT /api/personal/resume-generator/config error", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /personal/llm-key-check — verify an API key is valid.
 * Body: { provider, apiKey?, applierName? } — tests the supplied key (e.g. an
 * unsaved one being typed), or the stored profile key when apiKey is omitted.
 */
export async function checkLlmKey(req, res) {
  try {
    const body = req.body || {};
    const providerId = PROVIDERS[body.provider] ? body.provider : "openai";
    let apiKey = cleanString(body.apiKey);
    if (!apiKey) {
      const profile = await findProfile(body.applierName);
      apiKey = apiKeyFor(profile, providerId);
    }
    const result = await verifyKey({ provider: providerId, apiKey });
    // On a valid key, also return the live model list so callers (e.g. the
    // Profile page model dropdown) can populate from the same round-trip using
    // the just-verified key — no second request, no key in a query string.
    let models = [];
    if (result.ok) {
      try {
        models = await listModels({ provider: providerId, apiKey });
      } catch (modelErr) {
        console.warn(`llm-key-check: model list failed for ${providerId}: ${modelErr.message}`);
      }
    }
    return res.json({ success: true, provider: providerId, models, ...result });
  } catch (err) {
    console.warn("POST /api/personal/llm-key-check error:", err.message);
    return res.json({ success: false, ok: false, message: err.message });
  }
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LIST_PROJECTION = {
  "perStep.output": 0,
  "config.steps": 0,
  "config.layout": 0,
  "sections.skills": 0,
  "sections.experience": 0,
};

/** Build Mongo filter for resume generation history (search + filters). */
function buildGenerationsFilter(query, applierName) {
  const filter = { applierName };

  const status = cleanString(query?.status) || "all";
  if (status !== "all") filter.status = status;

  const model = cleanString(query?.model);
  if (model) filter.model = model;

  const provider = cleanString(query?.provider);
  if (provider) filter.provider = provider;

  const templateId = cleanString(query?.templateId);
  if (templateId) filter["config.templateId"] = templateId;

  const fromRaw = cleanString(query?.from);
  const toRaw = cleanString(query?.to);
  if (fromRaw || toRaw) {
    filter.startedAt = {};
    if (fromRaw) {
      const from = new Date(fromRaw);
      if (!Number.isNaN(from.getTime())) filter.startedAt.$gte = from;
    }
    if (toRaw) {
      const to = new Date(toRaw);
      if (!Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        filter.startedAt.$lte = to;
      }
    }
    if (!Object.keys(filter.startedAt).length) delete filter.startedAt;
  }

  const search = cleanString(query?.search || query?.q);
  const searchIn = cleanString(query?.searchIn) || "all";
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    const clauses = [];
    if (searchIn === "jd" || searchIn === "all") {
      clauses.push({ jobDescription: rx });
    }
    if (searchIn === "resume" || searchIn === "all") {
      clauses.push(
        { "sections.summary.summary": rx },
        { "sections.skills.skills.category": rx },
        { "sections.skills.skills.items": rx },
        { "sections.experience.experiences.title": rx },
        { "sections.experience.experiences.company": rx },
        { "sections.experience.experiences.bullets": rx },
        { "sections.experience.experience.title": rx },
        { "sections.experience.experience.company": rx },
        { "sections.experience.experience.bullets": rx },
        { "identity.fullName": rx },
        { "identity.email": rx },
      );
    }
    if (clauses.length) filter.$or = clauses;
  }

  return filter;
}

function buildGenerationsSort(sortKey) {
  switch (cleanString(sortKey)) {
    case "oldest":
      return { startedAt: 1 };
    case "cost-desc":
      return { "usage.cost": -1, startedAt: -1 };
    case "cost-asc":
      return { "usage.cost": 1, startedAt: -1 };
    case "tokens-desc":
      return { "usage.totalTokens": -1, startedAt: -1 };
    default:
      return { startedAt: -1 };
  }
}

async function loadGenerationFacets(applierName) {
  const base = { applierName };
  const [models, providers, templates, statusRows, totals] = await Promise.all([
    resumeGenerationsCollection.distinct("model", base),
    resumeGenerationsCollection.distinct("provider", base),
    resumeGenerationsCollection.distinct("config.templateId", base),
    resumeGenerationsCollection.aggregate([
      { $match: base },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray(),
    resumeGenerationsCollection.aggregate([
      { $match: { ...base, status: "completed" } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalTokens: { $sum: { $ifNull: ["$usage.totalTokens", 0] } },
          totalCost: { $sum: { $ifNull: ["$usage.cost", 0] } },
        },
      },
    ]).toArray(),
  ]);

  const statusCounts = { completed: 0, failed: 0 };
  for (const row of statusRows) {
    if (row._id === "completed" || row._id === "failed") statusCounts[row._id] = row.count;
  }

  const agg = totals[0] || { count: 0, totalTokens: 0, totalCost: 0 };
  return {
    models: models.filter(Boolean).sort(),
    providers: providers.filter(Boolean).sort(),
    templates: templates.filter(Boolean).sort(),
    statusCounts,
    stats: {
      completed: agg.count,
      totalTokens: agg.totalTokens,
      totalCost: agg.totalCost,
    },
  };
}

/**
 * GET /personal/resume-generations?applierName=&limit=&offset=&search=&searchIn=
 *   &status=&model=&provider=&templateId=&from=&to=&sort=&includeFacets=
 * Run history with search, filters, pagination (summary snippet only — no full sections).
 */
export async function listGenerations(req, res) {
  try {
    const applierName = cleanString(req.query?.applierName);
    if (!applierName || !resumeGenerationsCollection) {
      return res.json({ success: true, runs: [], total: 0, limit: 20, offset: 0 });
    }

    const limit = Math.max(1, Math.min(100, parseInt(req.query?.limit, 10) || 20));
    const offset = Math.max(0, parseInt(req.query?.offset, 10) || 0);
    const filter = buildGenerationsFilter(req.query, applierName);
    const sort = buildGenerationsSort(req.query?.sort);

    const [total, runs, facets] = await Promise.all([
      resumeGenerationsCollection.countDocuments(filter),
      resumeGenerationsCollection
        .find(filter, { projection: LIST_PROJECTION })
        .sort(sort)
        .skip(offset)
        .limit(limit)
        .toArray(),
      req.query?.includeFacets === "1" ? loadGenerationFacets(applierName) : null,
    ]);

    return res.json({ success: true, runs, total, limit, offset, ...(facets ? { facets } : {}) });
  } catch (err) {
    console.warn("GET /api/personal/resume-generations error:", err.message);
    return res.json({ success: false, runs: [], total: 0, error: err.message });
  }
}

/** GET /personal/resume-generations/:id?applierName= — one full run (sections, config, JD). */
export async function getGeneration(req, res) {
  try {
    const applierName = cleanString(req.query?.applierName);
    const id = cleanString(req.params?.id);
    if (!resumeGenerationsCollection || !id) return res.status(400).json({ success: false, error: "id is required" });
    let _id;
    try {
      _id = new ObjectId(id);
    } catch {
      return res.status(400).json({ success: false, error: "invalid id" });
    }
    const filter = applierName ? { _id, applierName } : { _id };
    const run = await resumeGenerationsCollection.findOne(filter);
    if (!run) return res.status(404).json({ success: false, error: "Run not found" });
    return res.json({ success: true, run });
  } catch (err) {
    console.warn("GET /api/personal/resume-generations/:id error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
