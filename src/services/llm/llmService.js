// Unified LLM access for the resume generator.
//
// Both supported providers speak the OpenAI Chat Completions wire format, so a
// single adapter handles them — they differ only by base URL and which profile
// field holds the API key:
//   - openai   → https://api.openai.com/v1   (gpt-* models)
//   - deepseek → https://api.deepseek.com/v1 (deepseek-v4-* models)

import { costFromUsage, findPricing } from "../../../../codex(legacy)/core-backend/src/pricing.mjs";

export const PROVIDERS = {
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyField: "openaiApiKey",
    // null → models are discovered live from the provider's /v1/models endpoint.
    models: null,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyField: "deepseekApiKey",
    // Fixed two-tier catalog: Flash (fast/cheap) and Pro (reasoning).
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
};

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS.openai;
}

// ---------------------------------------------------------------------------
// Pricing + token/cost calculator — delegates to codex/core-backend/pricing.mjs
// (source of truth for OpenAI + DeepSeek V4 cache hit/miss rates).
// ---------------------------------------------------------------------------

/** @deprecated Use findPricing from core-backend; kept for callers expecting { input, cached, output }. */
export function getPricing(model) {
  const row = findPricing(model);
  if (!row) return null;
  return { input: row.input, cached: row.cachedInput ?? row.input, output: row.output };
}

/**
 * Turn a raw OpenAI-style `usage` object into a normalized token + cost summary.
 * inputTokens = cache-miss input; cachedTokens = cache-hit input (DeepSeek naming).
 */
export function summarizeUsage(usage, model) {
  const u = costFromUsage(model, usage);
  const pricing = findPricing(model);
  const totalInput = u.inputTokens + u.cachedTokens;
  const costNoCache = pricing
    ? (totalInput / 1_000_000) * pricing.input + (u.outputTokens / 1_000_000) * pricing.output
    : null;
  const savings = costNoCache != null ? Math.max(0, costNoCache - u.costUsd) : null;

  return {
    model,
    inputTokens: u.inputTokens,
    cachedTokens: u.cachedTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    cost: u.costUsd,
    savings,
    priced: u.priced,
  };
}

const EMPTY_USAGE = () => ({
  model: null,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cost: 0,
  savings: 0,
});

/** Accumulate per-step usage into a running session total. */
export function addUsage(a, b) {
  if (!b) return a;
  return {
    model: b.model ?? a.model,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost == null || b.cost == null ? null : a.cost + b.cost,
    savings: a.savings == null || b.savings == null ? null : a.savings + b.savings,
  };
}

export { EMPTY_USAGE };

/** Human-readable USD for logs/UI (4 decimal places for sub-cent costs). */
export function formatCostUsd(cost) {
  if (cost == null || !Number.isFinite(cost)) return null;
  if (cost === 0) return '$0.0000';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(4)}`;
}

/** One-line token + cost summary for skill analysis logs. */
export function formatUsageSummary(usage) {
  if (!usage) return '';
  const cost = formatCostUsd(usage.cost);
  const parts = [
    `${usage.inputTokens?.toLocaleString() ?? 0} in`,
    `${usage.outputTokens?.toLocaleString() ?? 0} out`,
  ];
  if (usage.cachedTokens > 0) parts.push(`${usage.cachedTokens.toLocaleString()} cached`);
  if (cost) parts.push(cost);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Chat + model listing
// ---------------------------------------------------------------------------

/**
 * One OpenAI-compatible chat completion. `cacheKey` keeps the stable prompt
 * prefix in the provider's prompt cache so the conversation history resent on
 * each step is billed at the discounted cached rate instead of full price.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch that retries transient failures — 429 (rate limit) and 5xx — with
// exponential backoff, honoring a Retry-After header when present. The resume
// pipeline fires several calls back-to-back, which easily trips a provider's
// rate limit; this keeps generation resilient. 4xx (other than 429) is returned
// immediately so an invalid key / bad request surfaces right away.
async function fetchRetry(url, init, { timeoutMs = 120000, retries = 4, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt >= retries) throw err; // network error / timeout
      await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt >= retries) return response; // give up; let the caller read the error body
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
    await sleep(Math.min(delay, 15000));
  }
}

// Reasoning effort applies only to OpenAI reasoning models. Note the supported
// set varies by model (gpt-5-nano accepts "minimal"; newer models want
// none/low/medium/high/xhigh), so the caller chooses and we only attach it for
// OpenAI reasoning models.
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const isReasoningModel = (model) => /^(gpt-5|o1|o3|o4)/i.test(String(model));

export async function chatCompletion({ provider, apiKey, model, messages, jsonMode = false, cacheKey, reasoningEffort, timeoutMs = 120000 }) {
  const p = getProvider(provider);
  if (!apiKey) {
    throw new Error(`No API key configured for ${p.label}. Add it under Settings → Profile.`);
  }

  const body = { model, messages };
  // Both OpenAI and DeepSeek support response_format json_object (DeepSeek
  // requires the word "json" in the prompt, which the schema instruction adds).
  if (jsonMode && (p.id === "openai" || p.id === "deepseek")) body.response_format = { type: "json_object" };
  if (cacheKey) body.prompt_cache_key = cacheKey;
  // Only OpenAI reasoning models accept reasoning_effort; send the chosen level.
  if (p.id === "openai" && isReasoningModel(model) && reasoningEffort && reasoningEffort !== "default") {
    body.reasoning_effort = reasoningEffort;
  }

  const response = await fetchRetry(
    `${p.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    { timeoutMs },
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `${p.label} request failed (${response.status})`);
    err.status = response.status;
    err.provider = p.id;
    throw err;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (content == null) throw new Error(`${p.label} returned an empty response.`);
  return { content, usage: summarizeUsage(data?.usage, model) };
}

// Small in-memory cache so the model dropdown doesn't hit the provider on every
// keystroke / focus.
const modelCache = new Map(); // provider -> { at, models }
const MODEL_TTL_MS = 5 * 60 * 1000;

/**
 * Lightweight credential check. OpenAI is verified by listing models;
 * fixed-catalog providers (DeepSeek) by a tiny chat completion. Returns { ok, status, message }.
 */
export async function verifyKey({ provider, apiKey }) {
  const p = getProvider(provider);
  if (!apiKey) return { ok: false, status: 400, message: `No ${p.label} API key provided.` };
  try {
    if (Array.isArray(p.models)) {
      // Fixed-catalog provider (DeepSeek): cheapest valid call is a 1-token completion.
      const response = await fetchRetry(
        `${p.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: p.models[0], messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
        },
        { timeoutMs: 15000, retries: 1 },
      );
      const data = await response.json().catch(() => ({}));
      if (response.ok) return { ok: true, status: 200, message: `${p.label} key is valid.` };
      return { ok: false, status: response.status, message: data?.error?.message || `${p.label} rejected the key (${response.status}).` };
    }
    // OpenAI: list models.
    const response = await fetchRetry(`${p.baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } }, { timeoutMs: 15000, retries: 1 });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      const count = Array.isArray(data?.data) ? data.data.length : 0;
      return { ok: true, status: 200, message: `${p.label} key is valid (${count} models available).` };
    }
    return { ok: false, status: response.status, message: data?.error?.message || `${p.label} rejected the key (${response.status}).` };
  } catch (err) {
    return { ok: false, status: 0, message: `Could not reach ${p.label}: ${err.message}` };
  }
}

export async function listModels({ provider, apiKey, force = false }) {
  const p = getProvider(provider);
  // Fixed-catalog providers (e.g. DeepSeek's two-tier list).
  if (Array.isArray(p.models)) return p.models;
  const cached = modelCache.get(p.id);
  if (!force && cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.models;
  if (!apiKey) throw new Error(`No API key configured for ${p.label}.`);

  const response = await fetchRetry(
    `${p.baseUrl}/models`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    { timeoutMs: 20000, retries: 2 },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `${p.label} model list failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  const ids = Array.isArray(data?.data) ? data.data.map((m) => String(m?.id || "")).filter(Boolean) : [];
  // Keep chat-capable models; drop embeddings/audio/image/moderation endpoints.
  const models = ids
    .filter((id) => /(gpt|claude|o1|o3|o4)/i.test(id))
    .filter((id) => !/(embedding|whisper|tts|audio|image|moderation|realtime|search|transcribe)/i.test(id))
    .sort();
  modelCache.set(p.id, { at: Date.now(), models });
  return models;
}
