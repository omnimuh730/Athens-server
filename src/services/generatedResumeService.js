import { ObjectId } from "mongodb";
import { userResumesCollection, accountInfoCollection, resumeGenerationsCollection } from "../db/mongo.js";
import { mergeSkillProfiles } from "./resumeSkillMerge.js";
import {
  buildUserGraphFromResume,
  mergeSkillsIntoPersonalInfo,
  rebuildProfileGraph,
} from "./userKnowledgeGraph/index.js";
import { syncEmbeddingsAfterResumeAnalysis } from "./embeddings/embeddingIngest.js";
import { invalidateRecommendationCache } from "./recommendation/recommendationService.js";

function cleanString(v) {
  return String(v ?? "").trim();
}

function sectionsToText(sections, identity) {
  const parts = [];
  const summary = sections?.summary?.summary ?? sections?.summary;
  if (typeof summary === "string" && summary.trim()) parts.push(summary.trim());

  const groups = sections?.skills?.skills;
  if (Array.isArray(groups)) {
    const skillLines = groups
      .map((g) => {
        const items = Array.isArray(g?.items) ? g.items.map(String).filter(Boolean) : [];
        if (!items.length) return "";
        const cat = cleanString(g?.category);
        return cat ? `${cat}: ${items.join(", ")}` : items.join(", ");
      })
      .filter(Boolean);
    if (skillLines.length) parts.push(`Skills\n${skillLines.join("\n")}`);
  }

  const exps = sections?.experience?.experiences ?? sections?.experience?.experience;
  if (Array.isArray(exps)) {
    const expLines = exps.map((e) => {
      const title = cleanString(e?.title);
      const company = cleanString(e?.company);
      const period = cleanString(e?.period);
      const bullets = Array.isArray(e?.bullets) ? e.bullets.map(String).filter(Boolean) : [];
      return [title, company, period, ...bullets.map((b) => `- ${b}`)].filter(Boolean).join("\n");
    });
    if (expLines.length) parts.push(`Experience\n${expLines.join("\n\n")}`);
  }

  if (identity?.fullName) parts.unshift(identity.fullName);
  return parts.join("\n\n");
}

function deriveTechStack(sections, jobDescription) {
  const groups = sections?.skills?.skills;
  if (Array.isArray(groups) && groups.length) {
    const first = groups
      .slice(0, 2)
      .map((g) => cleanString(g?.category))
      .filter(Boolean);
    if (first.length) return first.join(" + ");
  }
  const jd = cleanString(jobDescription);
  if (jd.length > 60) return `${jd.slice(0, 57)}…`;
  return jd || "Generated";
}

/** Build a skill profile from LLM-generated sections — no extra LLM call. */
export function extractSkillProfileFromSections(sections, identity) {
  const text = sectionsToText(sections, identity);
  const raw = [];
  const groups = sections?.skills?.skills;
  if (Array.isArray(groups)) {
    for (const g of groups) {
      const items = Array.isArray(g?.items) ? g.items : [];
      for (const item of items) {
        const name = cleanString(item);
        if (name) raw.push({ name, strength: 7.5 });
      }
    }
  }
  return mergeSkillProfiles(raw, text);
}

async function findOwnerId(ownerName) {
  if (!accountInfoCollection) return null;
  const name = cleanString(ownerName);
  if (!name) return null;
  let acc = await accountInfoCollection.findOne({ name }, { projection: { _id: 1 } });
  if (!acc) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    acc = await accountInfoCollection.findOne({ name: { $regex: new RegExp(`^${esc}$`, "i") } }, { projection: { _id: 1 } });
  }
  return acc?._id ?? null;
}

/**
 * After a successful generation run, persist skill analysis derived from LLM
 * output (no re-analysis) and register the resume in the user library.
 */
export async function syncGeneratedResumeAfterRun({
  generationId,
  ownerName,
  sections,
  identity,
  jobDescription,
  templateId,
}) {
  if (!userResumesCollection || !sections || !ownerName) return null;

  const skillProfile = extractSkillProfileFromSections(sections, identity);
  const extractedText = sectionsToText(sections, identity);
  const techStack = deriveTechStack(sections, jobDescription);
  const fullName = cleanString(identity?.fullName) || "Resume";
  const now = new Date().toISOString();
  const fileName = `${fullName.replace(/\s+/g, "_")}_generated_${Date.now()}.txt`;

  const ownerId = await findOwnerId(ownerName);
  if (!ownerId) {
    console.warn("[generatedResumeService] ownerId not found for", ownerName);
    return { skillProfile, skippedLibrary: true };
  }

  const buffer = Buffer.from(extractedText || "Generated resume", "utf8");
  const doc = {
    ownerId,
    ownerName,
    techStack,
    fileName,
    mimeType: "text/plain",
    sizeBytes: buffer.length,
    storage: "inline",
    contentBase64: buffer.toString("base64"),
    gridFsId: null,
    extractedText,
    source: "generated",
    generationId: generationId ? String(generationId) : null,
    templateId: templateId ?? null,
    isPrimary: false,
    analyzed: true,
    analyzedAt: now,
    skillProfile,
    analysisError: null,
    uploadedAt: now,
    updatedAt: now,
  };

  let resumeId;
  if (generationId && resumeGenerationsCollection) {
    const existing = await userResumesCollection.findOne({
      ownerName,
      generationId: String(generationId),
    });
    if (existing) {
      await userResumesCollection.updateOne(
        { _id: existing._id },
        {
          $set: {
            techStack,
            fileName,
            extractedText,
            skillProfile,
            analyzed: true,
            analyzedAt: now,
            templateId: templateId ?? null,
            updatedAt: now,
            contentBase64: doc.contentBase64,
            sizeBytes: doc.sizeBytes,
          },
        },
      );
      resumeId = existing._id;
    }
  }

  if (!resumeId) {
    const result = await userResumesCollection.insertOne(doc);
    resumeId = result.insertedId;
  }

  const resumeIdStr = String(resumeId);

  if (generationId && resumeGenerationsCollection) {
    await resumeGenerationsCollection.updateOne(
      { _id: new ObjectId(String(generationId)) },
      {
        $set: {
          skillProfile,
          analyzed: true,
          analyzedAt: now,
          libraryResumeId: resumeIdStr,
        },
      },
    );
  }

  await buildUserGraphFromResume({
    applierName: ownerName,
    resumeId: resumeIdStr,
    resumeName: fileName,
    skills: skillProfile,
  });
  await mergeSkillsIntoPersonalInfo(skillProfile.map((s) => s.name));
  await rebuildProfileGraph(ownerName);
  await syncEmbeddingsAfterResumeAnalysis(resumeIdStr, ownerName, { applierName: ownerName });
  invalidateRecommendationCache(ownerName);

  return { skillProfile, resumeId: resumeIdStr, fileName };
}
