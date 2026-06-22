// Server-side résumé PDF for agent runs — config-driven so it matches the Profile page's
// Resume Generator output (saved layout order, theme font/sizes/colors, template style). The
// Profile page renders its PDF from the live React preview via puppeteer; here we mirror that
// template from the generated sections + identity + the SAME saved config, then feed the same
// paged-Chromium renderer (htmlToPdf). Each PDF is saved to a timestamped folder for review.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToPdf } from "../controllers/resumePdfController.js";

const REVIEW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".local", "agent-resumes");

const esc = (v) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clean = (v) => String(v ?? "").trim();
// Escape, then render the inline markdown the generator emits (**bold**, *italic*) — matches
// the preview's renderRich instead of showing literal asterisks.
const md = (v) =>
  esc(v).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

const SECTION_LABEL = { summary: "Summary", experience: "Experience", skills: "Skills", education: "Education" };
const DEFAULT_LAYOUT = [{ type: "summary" }, { type: "experience" }, { type: "skills" }, { type: "education" }];

const SERIF = new Set(["Georgia", "Times New Roman", "Garamond", "Cambria", "Source Serif 4", "Merriweather", "Lora", "PT Serif"]);
function fontStack(name) {
  if (!name) return "sans-serif";
  if (name.includes(",")) return name;
  const generic = SERIF.has(name) ? "serif" : "sans-serif";
  return `${/\s/.test(name) ? `"${name}"` : name}, ${generic}`;
}
// Google-Fonts stylesheet link for a web font (skip system serif/sans families).
function fontLinks(name) {
  if (!name || SERIF.has(name) || ["Arial", "Helvetica"].includes(name)) return [];
  const fam = name.replace(/\s+/g, "+");
  return [`https://fonts.googleapis.com/css2?family=${fam}:ital,wght@0,400;0,600;0,700;1,400&display=swap`];
}

/** Build résumé body HTML mirroring the saved template (harvard etc.) + theme + layout order. */
export function sectionsToHtml(sections, identity, config) {
  const id = identity || {};
  const theme = (config && config.theme) || {};
  const layout = Array.isArray(config?.layout) && config.layout.length ? config.layout : DEFAULT_LAYOUT;
  const text = theme.text || "#0f172a";
  const baseSize = Number(theme.baseSize) || 10.5;
  const nameSize = Number(theme.nameSize) || 24;
  const titleSizeDef = Number(theme.titleSize) || 12;
  const headerAlign = theme.headerAlign || "center";

  const heading = (label, color, size) =>
    `<div style="font-size:${size}pt;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.08em;text-align:center;border-top:1px solid ${color};border-bottom:1px solid ${color};padding:3px 0;margin-bottom:7px;break-after:avoid;">${esc(label)}</div>`;
  const metaSpan = (t, size, italic) =>
    t ? `<span style="opacity:.72;white-space:nowrap;font-size:${size}pt;${italic ? "font-style:italic;" : ""}">${esc(t)}</span>` : "";

  const body = (type, bodySize, color) => {
    const meta = Math.max(8, bodySize - 1);
    if (type === "summary") {
      const s = clean(sections?.summary?.summary ?? sections?.summary);
      return s ? `<p style="margin:0;text-align:justify;font-size:${bodySize}pt;">${md(s)}</p>` : "";
    }
    if (type === "skills") {
      const groups = Array.isArray(sections?.skills?.skills) ? sections.skills.skills : [];
      const rows = groups.map((g) => {
        const items = Array.isArray(g?.items) ? g.items.map(clean).filter(Boolean) : [];
        if (!items.length) return "";
        const cat = clean(g?.category);
        return `<div style="margin-bottom:3px;font-size:${bodySize}pt;">${cat ? `<span style="font-weight:700;color:${color};">${md(cat)}:</span> ` : ""}${md(items.join(", "))}</div>`;
      }).filter(Boolean);
      return rows.join("");
    }
    if (type === "experience") {
      const exps = sections?.experience?.experiences ?? sections?.experience?.experience;
      if (!Array.isArray(exps) || !exps.length) return "";
      return exps.map((e) => {
        const company = clean(e?.company), title = clean(e?.title), period = clean(e?.period), loc = clean(e?.location);
        const bullets = Array.isArray(e?.bullets) ? e.bullets.map(clean).filter(Boolean) : [];
        const rowCss = "display:flex;justify-content:space-between;gap:12px;align-items:baseline;";
        return `<div style="margin-bottom:10px;break-inside:avoid;font-size:${bodySize}pt;">
            <div style="${rowCss}"><span style="font-weight:700;">${esc(company)}</span>${metaSpan(loc, meta)}</div>
            <div style="${rowCss}"><span style="font-weight:700;">${esc(title)}</span>${metaSpan(period, meta)}</div>
            ${bullets.length ? `<ul style="list-style:disc;margin:2px 0 0;padding-left:18px;">${bullets.map((b) => `<li style="margin-bottom:1px;break-inside:avoid;text-align:justify;">${md(b)}</li>`).join("")}</ul>` : ""}
          </div>`;
      }).join("");
    }
    if (type === "education") {
      const edus = Array.isArray(id.education) ? id.education
        : (sections?.education?.education ?? sections?.education?.educations ?? []);
      if (!Array.isArray(edus) || !edus.length) return "";
      return edus.map((e) => {
        const school = clean(e?.school), degree = clean(e?.degree), period = clean(e?.period);
        return `<div style="break-inside:avoid;margin-bottom:8px;font-size:${bodySize}pt;">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;"><span style="font-weight:700;">${esc(school)}</span>${metaSpan(period, meta)}</div>
            ${degree ? `<div style="font-style:italic;color:${color};">${esc(degree)}</div>` : ""}
          </div>`;
      }).join("");
    }
    return "";
  };

  const contacts = [clean(id.location), clean(id.email), clean(id.phone), clean(id.linkedin)].filter(Boolean);
  const blocks = [
    `<header style="text-align:${headerAlign};margin-bottom:8px;">
       <div style="font-size:${nameSize}pt;font-weight:700;color:${text};">${esc(clean(id.fullName))}</div>
       <div style="font-size:${Math.max(8, baseSize - 1.5)}pt;color:${text};opacity:.85;margin-top:3px;">${contacts.map(esc).join("&nbsp;&nbsp;•&nbsp;&nbsp;")}</div>
     </header>`,
  ];
  for (const sec of layout) {
    const type = sec.type;
    if (!SECTION_LABEL[type]) continue;
    const bodySize = Number(sec.bodySize) || baseSize;
    const titleSize = Number(sec.titleSize) || titleSizeDef;
    const color = sec.titleColor || text;
    const inner = body(type, bodySize, color);
    if (inner) blocks.push(`<div style="margin-bottom:14px;">${heading(SECTION_LABEL[type], color, titleSize)}${inner}</div>`);
  }
  return blocks.join("\n");
}

/**
 * Render the generated résumé to a PDF buffer (same pipeline + saved config as the Profile
 * page) and save a copy to a timestamped review folder. Returns { buffer, savedPath, reviewDir }.
 */
export async function renderAgentResumePdf({ sections, identity, applierName, jobId, config }) {
  const theme = (config && config.theme) || {};
  const html = sectionsToHtml(sections, identity, config);
  const buffer = await htmlToPdf({
    html,
    paper: theme.paper === "a4" ? "a4" : "letter",
    marginInches: Number(theme.margin) || 0.65,
    font: fontStack(theme.font),
    baseSizePt: Number(theme.baseSize) || 10.5,
    fontLinks: fontLinks(theme.font),
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reviewDir = path.join(REVIEW_ROOT, stamp);
  const safe = (s) => String(s || "").replace(/[^\w.\- ]+/g, "_").slice(0, 60);
  const base = `${safe(applierName) || "resume"}-${safe(jobId) || "job"}`;
  let savedPath = "";
  try {
    fs.mkdirSync(reviewDir, { recursive: true });
    savedPath = path.join(reviewDir, `${base}.pdf`);
    fs.writeFileSync(savedPath, buffer);
    fs.writeFileSync(path.join(reviewDir, `${base}.html`), html, "utf8");
  } catch {
    /* review copy is best-effort */
  }
  return { buffer, savedPath, reviewDir };
}
