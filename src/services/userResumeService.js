import { ObjectId, GridFSBucket } from "mongodb";
import { userResumesCollection, userKnowledgeGraphsCollection } from "../db/mongo.js";
import { rebuildProfileGraph } from "./userKnowledgeGraph/index.js";
import { removeResumeEmbedding, upsertProfileEmbedding } from "./embeddings/embeddingIngest.js";
import { invalidateRecommendationCache } from "./recommendation/recommendationService.js";

const INLINE_MAX_BYTES = 8 * 1024 * 1024; // 8MB

const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
]);

function cleanString(v) {
  return String(v ?? "").trim();
}

function toSummary(doc) {
  const skillProfile = Array.isArray(doc.skillProfile) ? doc.skillProfile : [];
  return {
    id: String(doc._id),
    ownerId: doc.ownerId ? String(doc.ownerId) : null,
    ownerName: doc.ownerName,
    techStack: doc.techStack,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes ?? 0,
    extractedText: doc.extractedText ? doc.extractedText.slice(0, 500) : "",
    isPrimary: Boolean(doc.isPrimary),
    analyzed: Boolean(doc.analyzed),
    analyzedAt: doc.analyzedAt || null,
    skillCount: skillProfile.length,
    uploadedAt: doc.uploadedAt,
    updatedAt: doc.updatedAt,
  };
}

async function extractText(buffer, mimeType, fileName) {
  const lower = String(fileName || "").toLowerCase();
  try {
    if (mimeType === "text/plain" || lower.endsWith(".txt")) {
      return buffer.toString("utf8");
    }
    if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
      const pdfParse = (await import("pdf-parse")).default;
      const result = await pdfParse(buffer);
      return result?.text || "";
    }
    if (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      lower.endsWith(".docx")
    ) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result?.value || "";
    }
  } catch (err) {
    console.warn("[userResumeService] text extraction failed:", err.message);
  }
  return "";
}

function getGridFsBucket() {
  if (!userResumesCollection) return null;
  const db = userResumesCollection.db;
  return new GridFSBucket(db, { bucketName: "user_resume_files" });
}

async function storeContent(buffer) {
  if (buffer.length <= INLINE_MAX_BYTES) {
    return { storage: "inline", contentBase64: buffer.toString("base64"), gridFsId: null };
  }
  const bucket = getGridFsBucket();
  if (!bucket) throw new Error("GridFS not available");
  const gridFsId = new ObjectId();
  await new Promise((resolve, reject) => {
    const stream = bucket.openUploadStreamWithId(gridFsId, `resume-${gridFsId}`);
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(buffer);
  });
  return { storage: "gridfs", contentBase64: null, gridFsId };
}

async function readContent(doc) {
  if (doc.storage === "gridfs" && doc.gridFsId) {
    const bucket = getGridFsBucket();
    if (!bucket) throw new Error("GridFS not available");
    const chunks = [];
    await new Promise((resolve, reject) => {
      bucket
        .openDownloadStream(doc.gridFsId)
        .on("data", (chunk) => chunks.push(chunk))
        .on("error", reject)
        .on("end", resolve);
    });
    return Buffer.concat(chunks);
  }
  if (doc.contentBase64) {
    return Buffer.from(doc.contentBase64, "base64");
  }
  return null;
}

async function deleteStoredContent(doc) {
  if (doc.storage === "gridfs" && doc.gridFsId) {
    const bucket = getGridFsBucket();
    if (bucket) {
      try {
        await bucket.delete(doc.gridFsId);
      } catch {
        /* ignore */
      }
    }
  }
}

function parseOwnerId(raw) {
  if (!raw) return null;
  try {
    return new ObjectId(String(raw));
  } catch {
    return null;
  }
}

export async function listUserResumes(ownerName) {
  if (!userResumesCollection) throw new Error("Database not ready");
  const name = cleanString(ownerName);
  if (!name) throw new Error("ownerName is required");

  const docs = await userResumesCollection
    .find({ ownerName: name })
    .sort({ isPrimary: -1, uploadedAt: -1 })
    .toArray();

  return docs.map(toSummary);
}

export async function getUserResume(id, ownerName) {
  if (!userResumesCollection) throw new Error("Database not ready");
  const name = cleanString(ownerName);
  if (!name) throw new Error("ownerName is required");

  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    throw new Error("Invalid resume id");
  }

  const doc = await userResumesCollection.findOne({ _id: objectId, ownerName: name });
  if (!doc) return null;

  const buffer = await readContent(doc);
  return {
    ...toSummary(doc),
    extractedText: doc.extractedText || "",
    contentBase64: buffer ? buffer.toString("base64") : null,
  };
}

export async function createUserResume(payload) {
  if (!userResumesCollection) throw new Error("Database not ready");

  const ownerName = cleanString(payload.ownerName);
  const techStack = cleanString(payload.techStack);
  const fileName = cleanString(payload.fileName);
  const mimeType = cleanString(payload.mimeType) || "application/octet-stream";
  const contentBase64 = String(payload.contentBase64 || "");

  if (!ownerName) throw new Error("ownerName is required");
  if (!techStack) throw new Error("techStack is required");
  if (!fileName) throw new Error("fileName is required");
  if (!contentBase64) throw new Error("contentBase64 is required");

  const ownerId = parseOwnerId(payload.ownerId);
  if (!ownerId) throw new Error("Valid ownerId is required");

  const buffer = Buffer.from(contentBase64, "base64");
  if (!buffer.length) throw new Error("Empty file content");

  if (!ALLOWED_MIME.has(mimeType) && !/\.(pdf|docx?|txt)$/i.test(fileName)) {
    throw new Error("Unsupported file type. Use PDF, DOCX, or TXT.");
  }

  const extractedText = await extractText(buffer, mimeType, fileName);
  const stored = await storeContent(buffer);
  const now = new Date().toISOString();

  const existingCount = await userResumesCollection.countDocuments({ ownerName });
  const isPrimary = existingCount === 0;

  const doc = {
    ownerId,
    ownerName,
    techStack,
    fileName,
    mimeType,
    sizeBytes: buffer.length,
    storage: stored.storage,
    contentBase64: stored.contentBase64,
    gridFsId: stored.gridFsId,
    extractedText,
    isPrimary,
    uploadedAt: now,
    updatedAt: now,
  };

  const result = await userResumesCollection.insertOne(doc);
  return toSummary({ ...doc, _id: result.insertedId });
}

export async function bulkCreateUserResumes(items, ownerName, ownerId) {
  const results = { ok: [], failed: [] };
  for (const item of items || []) {
    try {
      const summary = await createUserResume({
        ...item,
        ownerName: item.ownerName || ownerName,
        ownerId: item.ownerId || ownerId,
      });
      results.ok.push(summary);
    } catch (err) {
      results.failed.push({ fileName: item?.fileName || "unknown", error: err.message });
    }
  }
  return results;
}

export async function setPrimaryUserResume(id, ownerName) {
  if (!userResumesCollection) throw new Error("Database not ready");
  const name = cleanString(ownerName);
  if (!name) throw new Error("ownerName is required");

  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    throw new Error("Invalid resume id");
  }

  const doc = await userResumesCollection.findOne({ _id: objectId, ownerName: name });
  if (!doc) throw new Error("Resume not found");

  const now = new Date().toISOString();
  await userResumesCollection.updateMany({ ownerName: name }, { $set: { isPrimary: false, updatedAt: now } });
  await userResumesCollection.updateOne({ _id: objectId }, { $set: { isPrimary: true, updatedAt: now } });

  return toSummary({ ...doc, isPrimary: true, updatedAt: now });
}

export async function deleteUserResume(id, ownerName) {
  if (!userResumesCollection) throw new Error("Database not ready");
  const name = cleanString(ownerName);
  if (!name) throw new Error("ownerName is required");

  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    throw new Error("Invalid resume id");
  }

  const doc = await userResumesCollection.findOne({ _id: objectId, ownerName: name });
  if (!doc) throw new Error("Resume not found");

  await deleteStoredContent(doc);
  await userResumesCollection.deleteOne({ _id: objectId });
  await removeResumeEmbedding(String(objectId));
  await upsertProfileEmbedding(name);
  invalidateRecommendationCache(name);

  if (userKnowledgeGraphsCollection) {
    await userKnowledgeGraphsCollection.deleteOne({
      applierName: name,
      resumeId: String(objectId),
    });
    await rebuildProfileGraph(name);
  }

  if (doc.isPrimary) {
    const next = await userResumesCollection.findOne({ ownerName: name }, { sort: { uploadedAt: -1 } });
    if (next) {
      await userResumesCollection.updateOne({ _id: next._id }, { $set: { isPrimary: true } });
    }
  }

  return { deleted: true, id: String(objectId) };
}

export async function listUserResumesForOwner(ownerName) {
  if (!userResumesCollection) throw new Error("Database not ready");
  const name = cleanString(ownerName);
  return userResumesCollection.find({ ownerName: name }).toArray();
}
