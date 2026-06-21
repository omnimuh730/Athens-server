import { ObjectId } from "mongodb";
import { userResumesCollection, accountInfoCollection } from "../db/mongo.js";
import { chatCompletion, getProvider } from "./llm/llmService.js";
import { RESUME_SKILL_ANALYSIS_PROMPT } from "../config/resumeSkillAnalysisPrompt.js";
import {
  buildUserGraphFromResume,
  mergeSkillsIntoPersonalInfo,
  rebuildProfileGraph,
} from "./userKnowledgeGraph/index.js";
import { mergeSkillProfiles } from "./resumeSkillMerge.js";
import { parseSkillProfileJson } from "./resumeSkillProfile.js";
import { syncEmbeddingsAfterResumeAnalysis } from "./embeddings/embeddingIngest.js";
import { invalidateRecommendationCache } from "./recommendation/recommendationService.js";

async function findAccount(applierNameRaw) {
  const name = String(applierNameRaw ?? "").trim();
  if (!name || !accountInfoCollection) return null;
  const proj = { projection: { autoBidProfile: 1 } };
  let acc = await accountInfoCollection.findOne({ name }, proj);
  if (!acc) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    acc = await accountInfoCollection.findOne({ name: { $regex: new RegExp(`^${esc}$`, "i") } }, proj);
  }
  return acc;
}

function apiKeyFor(profile, providerId) {
  const provider = getProvider(providerId);
  return String(profile?.[provider.keyField] || "").trim();
}

async function extractSkillsWithLlm(extractedText, profile) {
  const providerId = profile?.deepseekApiKey
    ? "deepseek"
    : profile?.openaiApiKey
      ? "openai"
      : "deepseek";
  const apiKey = apiKeyFor(profile, providerId);
  if (!apiKey) {
    throw new Error("No LLM API key configured in profile (OpenAI or DeepSeek).");
  }

  const model =
    providerId === "openai"
      ? String(profile?.openaiModel || "").trim() || "gpt-4o-mini"
      : "deepseek-v4-flash";

  const text = String(extractedText || "").trim();
  if (!text) throw new Error("Resume has no extractable text");

  const truncated = text.length > 12000 ? `${text.slice(0, 12000)}\n\n[truncated]` : text;

  const result = await chatCompletion({
    provider: providerId,
    apiKey,
    model,
    messages: [
      { role: "system", content: RESUME_SKILL_ANALYSIS_PROMPT },
      { role: "user", content: `Resume text:\n\n${truncated}` },
    ],
  });

  return {
    skillProfile: mergeSkillProfiles(parseSkillProfileJson(result?.content), text),
    usage: result?.usage || null,
    provider: providerId,
    model,
  };
}

async function loadResumeDoc(resumeId, ownerName) {
  if (!userResumesCollection) throw new Error("Database not ready");
  const name = String(ownerName || "").trim();
  if (!name) throw new Error("ownerName is required");

  let objectId;
  try {
    objectId = new ObjectId(resumeId);
  } catch {
    throw new Error("Invalid resume id");
  }

  const doc = await userResumesCollection.findOne({ _id: objectId, ownerName: name });
  if (!doc) throw new Error("Resume not found");
  return doc;
}

/**
 * Analyze resume skills with LLM, build per-resume graph, merge into profile knowledge.
 */
export async function analyzeResumeSkills(resumeId, ownerName, { force = false } = {}) {
  const doc = await loadResumeDoc(resumeId, ownerName);
  const resumeIdStr = String(doc._id);

  if (doc.source === "generated" && doc.analyzed && Array.isArray(doc.skillProfile) && doc.skillProfile.length && !force) {
    const graph = await buildUserGraphFromResume({
      applierName: ownerName,
      resumeId: resumeIdStr,
      resumeName: doc.fileName,
      skills: doc.skillProfile,
    });
    const profileGraph = await rebuildProfileGraph(ownerName);
    return {
      alreadyAnalyzed: true,
      skillProfile: doc.skillProfile,
      graph,
      profileGraph,
      usage: null,
      fromGeneration: true,
    };
  }

  if (doc.analyzed && !force && Array.isArray(doc.skillProfile) && doc.skillProfile.length) {
    const graph = await buildUserGraphFromResume({
      applierName: ownerName,
      resumeId: resumeIdStr,
      resumeName: doc.fileName,
      skills: doc.skillProfile,
    });
    const profileGraph = await rebuildProfileGraph(ownerName);
    return {
      alreadyAnalyzed: true,
      skillProfile: doc.skillProfile,
      graph,
      profileGraph,
      usage: null,
    };
  }

  const acc = await findAccount(ownerName);
  if (!acc) throw new Error("Account not found");

  const profile = acc.autoBidProfile || {};
  let skillProfile;
  let usage;
  let provider;
  let model;

  try {
    const llmResult = await extractSkillsWithLlm(doc.extractedText, profile);
    skillProfile = llmResult.skillProfile;
    usage = llmResult.usage;
    provider = llmResult.provider;
    model = llmResult.model;
  } catch (err) {
    const now = new Date().toISOString();
    await userResumesCollection.updateOne(
      { _id: doc._id },
      { $set: { analysisError: err.message, updatedAt: now } },
    );
    throw err;
  }

  const now = new Date().toISOString();
  await userResumesCollection.updateOne(
    { _id: doc._id },
    {
      $set: {
        analyzed: true,
        analyzedAt: now,
        skillProfile,
        analysisError: null,
        updatedAt: now,
      },
    },
  );

  const graph = await buildUserGraphFromResume({
    applierName: ownerName,
    resumeId: resumeIdStr,
    resumeName: doc.fileName,
    skills: skillProfile,
  });

  await mergeSkillsIntoPersonalInfo(skillProfile.map((s) => s.name));
  const profileGraph = await rebuildProfileGraph(ownerName);

  await syncEmbeddingsAfterResumeAnalysis(resumeIdStr, ownerName, { applierName: ownerName });
  invalidateRecommendationCache(ownerName);

  return {
    alreadyAnalyzed: false,
    skillProfile,
    graph,
    profileGraph,
    usage,
    provider,
    model,
  };
}
