// List the local Google Chrome profiles (for the Deploy Agent "Chrome profile"
// picker). Read-only: parses Chrome's `Local State` profile.info_cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// claude-code/agent/connect-google.mjs (the import utility) — sibling of Athens-server.
const CONNECT_SCRIPT = path.resolve(__dirname, "..", "..", "..", "claude-code", "agent", "connect-google.mjs");

// User-data-dir locations by OS (the one containing `Local State`).
const CHROME_DIRS = [
  "Library/Application Support/Google/Chrome", // macOS
  ".config/google-chrome", // Linux
  "AppData/Local/Google/Chrome/User Data", // Windows
];

function chromeUserDataDir() {
  for (const rel of CHROME_DIRS) {
    const p = path.join(os.homedir(), rel);
    if (fs.existsSync(path.join(p, "Local State"))) return p;
  }
  return null;
}

/** GET /personal/chrome-profiles — [{ dir, name, email }] for installed Chrome profiles. */
export async function listChromeProfiles(req, res) {
  try {
    const base = chromeUserDataDir();
    if (!base) return res.json({ success: true, profiles: [], userDataDir: null });
    const ls = JSON.parse(fs.readFileSync(path.join(base, "Local State"), "utf8"));
    const cache = ls?.profile?.info_cache || {};
    const profiles = Object.entries(cache)
      .filter(([dir]) => fs.existsSync(path.join(base, dir)))
      .map(([dir, info]) => ({ dir, name: info?.name || dir, email: info?.user_name || "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ success: true, profiles, userDataDir: base });
  } catch (err) {
    console.warn("GET /api/personal/chrome-profiles error:", err.message);
    return res.json({ success: true, profiles: [], error: err.message });
  }
}

/** GET /personal/chrome-profiles/avatar?dir=Profile%2063 — the profile's Google photo. */
export async function chromeProfileAvatar(req, res) {
  try {
    const base = chromeUserDataDir();
    const dir = String(req.query?.dir || "");
    if (!base || !dir) return res.status(404).end();
    // Guard against path traversal — only allow a direct profile subdir name.
    const safeDir = path.basename(dir);
    const file = path.join(base, safeDir, "Google Profile Picture.png");
    if (!file.startsWith(path.join(base, safeDir)) || !fs.existsSync(file)) return res.status(404).end();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return fs.createReadStream(file).pipe(res);
  } catch {
    return res.status(404).end();
  }
}

/**
 * POST /personal/chrome-profiles/import { applierName, profileDir }
 * Imports the chosen Chrome profile's logged-in session into the applicant's
 * storage-state file (so MCP agents reuse it, concurrently). Chrome must be quit.
 */
export async function importChromeSession(req, res) {
  const applierName = String(req.body?.applierName || "").trim();
  const profileDir = String(req.body?.profileDir || "").trim();
  if (!applierName || !profileDir) {
    return res.status(400).json({ success: false, error: "applierName and profileDir are required" });
  }
  try {
    const child = spawn("node", [CONNECT_SCRIPT, "--applier", applierName, "--chrome-profile", profileDir], {
      cwd: path.dirname(CONNECT_SCRIPT),
    });
    let out = "", err = "";
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 90_000);
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("exit", (code) => {
      clearTimeout(t);
      if (code === 0) return res.json({ success: true, message: (out.trim().split("\n").pop() || "Session imported").trim() });
      return res.status(500).json({ success: false, error: (err || out || "import failed").trim().slice(0, 300) });
    });
    child.on("error", (e) => { clearTimeout(t); res.status(500).json({ success: false, error: e.message }); });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
