import {
  listUserResumes,
  getUserResume,
  createUserResume,
  bulkCreateUserResumes,
  setPrimaryUserResume,
  deleteUserResume,
} from "../services/userResumeService.js";
import { analyzeResumeSkills } from "../services/resumeSkillAnalysisService.js";

export async function listUserResumesHandler(req, res) {
  try {
    const ownerName = String(req.query?.ownerName ?? "").trim();
    if (!ownerName) {
      return res.status(400).json({ success: false, error: "ownerName is required" });
    }
    const resumes = await listUserResumes(ownerName);
    return res.json({ success: true, resumes });
  } catch (err) {
    console.error("GET /api/personal/user-resumes error", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function getUserResumeHandler(req, res) {
  try {
    const ownerName = String(req.query?.ownerName ?? "").trim();
    if (!ownerName) {
      return res.status(400).json({ success: false, error: "ownerName is required" });
    }
    const resume = await getUserResume(req.params.id, ownerName);
    if (!resume) {
      return res.status(404).json({ success: false, error: "Resume not found" });
    }
    return res.json({ success: true, resume });
  } catch (err) {
    console.error("GET /api/personal/user-resumes/:id error", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function createUserResumeHandler(req, res) {
  try {
    const { ownerName, ownerId, techStack, fileName, mimeType, contentBase64 } = req.body || {};
    const resume = await createUserResume({ ownerName, ownerId, techStack, fileName, mimeType, contentBase64 });
    return res.status(201).json({ success: true, resume });
  } catch (err) {
    console.error("POST /api/personal/user-resumes error", err);
    const status = /required|Invalid|Unsupported|Empty/.test(err.message) ? 400 : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

export async function bulkCreateUserResumesHandler(req, res) {
  try {
    const { ownerName, ownerId, items } = req.body || {};
    if (!ownerName || !ownerId) {
      return res.status(400).json({ success: false, error: "ownerName and ownerId are required" });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, error: "items array is required" });
    }
    const result = await bulkCreateUserResumes(items, ownerName, ownerId);
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    console.error("POST /api/personal/user-resumes/bulk error", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function setPrimaryUserResumeHandler(req, res) {
  try {
    const ownerName = String(req.body?.ownerName ?? "").trim();
    if (!ownerName) {
      return res.status(400).json({ success: false, error: "ownerName is required" });
    }
    const resume = await setPrimaryUserResume(req.params.id, ownerName);
    return res.json({ success: true, resume });
  } catch (err) {
    console.error("PUT /api/personal/user-resumes/:id/primary error", err);
    const status = /not found/i.test(err.message) ? 404 : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

export async function deleteUserResumeHandler(req, res) {
  try {
    const ownerName = String(req.query?.ownerName ?? "").trim();
    if (!ownerName) {
      return res.status(400).json({ success: false, error: "ownerName is required" });
    }
    const result = await deleteUserResume(req.params.id, ownerName);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("DELETE /api/personal/user-resumes/:id error", err);
    const status = /not found/i.test(err.message) ? 404 : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

export async function analyzeUserResumeHandler(req, res) {
  try {
    const ownerName = String(req.body?.ownerName ?? "").trim();
    const force = Boolean(req.body?.force);
    if (!ownerName) {
      return res.status(400).json({ success: false, error: "ownerName is required" });
    }

    const result = await analyzeResumeSkills(req.params.id, ownerName, { force });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("POST /api/personal/user-resumes/:id/analyze error", err);
    const status = /not found|required|Invalid|No LLM|no extractable|invalid JSON|no usable/i.test(err.message)
      ? 400
      : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}
