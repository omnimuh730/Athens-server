import puppeteer from "puppeteer";

/**
 * Server-side resume PDF rendering.
 *
 * The frontend sends the already-rendered, inline-styled resume DOM (the inner
 * HTML of the live preview's `.resume-page`). We render it with headless Chromium
 * in true paged mode — content flows naturally and every page gets the same
 * margin via `@page` — so the output matches the preview without the broken
 * pagination, missing top margins, and blank pages that `window.print()` produced.
 *
 * Rendering from the preview's own DOM means no template logic is re-implemented
 * here, so nothing is lost in translation.
 */

let browserPromise = null;

// Reuse a single Chromium instance across requests; relaunch if it died.
async function getBrowser() {
	if (browserPromise) {
		const b = await browserPromise.catch(() => null);
		if (b && b.connected) return b;
		browserPromise = null;
	}
	browserPromise = puppeteer.launch({
		headless: "new",
		args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
	});
	return browserPromise;
}

function escapeAttr(value) {
	return String(value).replace(/[<>"]/g, "");
}

const PAPER = { letter: "Letter", a4: "A4" };

function buildHtmlDocument({ html, paper, marginInches, font, baseSizePt, fontLinks }) {
	const size = PAPER[paper] || "Letter";
	const margin = Number.isFinite(marginInches) && marginInches >= 0 ? marginInches : 0.5;
	const base = Number.isFinite(baseSizePt) && baseSizePt > 0 ? baseSizePt : 10.5;
	const fontFamily = font ? String(font) : "Georgia, 'Times New Roman', serif";
	const links = Array.isArray(fontLinks)
		? fontLinks
				.filter((h) => typeof h === "string" && /^https?:\/\//.test(h))
				.map((h) => `<link rel="stylesheet" href="${escapeAttr(h)}">`)
				.join("\n")
		: "";

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
${links}
<style>
  @page { size: ${size}; margin: ${margin}in; }
  html, body { margin: 0; padding: 0; background: #fff; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: ${fontFamily};
    font-size: ${base}pt;
    line-height: 1.42;
    color: #111827;
  }
  /* The preview wraps content in a fixed-size, clipped page box; in paged mode we
     let it flow full-width and rely on @page for margins. */
  .resume-print-body { width: 100%; }
</style>
</head>
<body>
  <div class="resume-print-body">${html}</div>
</body>
</html>`;
}

/**
 * Render résumé body HTML to a PDF Buffer with the SAME paged Chromium pipeline the Profile
 * page uses (so server-generated agent résumés match the preview output). Reusable by the
 * route handler and the agent résumé service.
 */
export async function htmlToPdf({ html, paper = "letter", marginInches, font, baseSizePt, fontLinks } = {}) {
	const body = typeof html === "string" ? html : "";
	if (!body.trim()) throw new Error("html is required");
	const doc = buildHtmlDocument({ html: body, paper: paper === "a4" ? "a4" : "letter", marginInches, font, baseSizePt, fontLinks });
	const browser = await getBrowser();
	const page = await browser.newPage();
	try {
		await page.setContent(doc, { waitUntil: "networkidle0", timeout: 30000 });
		await page.evaluate(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready; });
		return await page.pdf({ printBackground: true, preferCSSPageSize: true });
	} finally {
		await page.close().catch(() => {});
	}
}

/** POST /personal/resume-pdf — render the preview DOM to a downloadable PDF. */
export async function renderResumePdf(req, res) {
	try {
		const body = req.body || {};
		const pdf = await htmlToPdf({
			html: typeof body.html === "string" ? body.html : "",
			paper: body.paper === "a4" ? "a4" : "letter",
			marginInches: Number(body.marginInches),
			font: body.font,
			baseSizePt: Number(body.baseSizePt),
			fontLinks: body.fontLinks,
		});
		const rawName = String(body.fileName || "resume.pdf").replace(/[^\w.\- ]+/g, "_");
		const fileName = rawName.toLowerCase().endsWith(".pdf") ? rawName : `${rawName}.pdf`;
		res.setHeader("Content-Type", "application/pdf");
		res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
		res.setHeader("Content-Length", pdf.length);
		return res.end(pdf);
	} catch (err) {
		console.error("POST /api/personal/resume-pdf failed:", err.message);
		return res.status(err.message === "html is required" ? 400 : 500).json({ success: false, error: err.message });
	}
}
