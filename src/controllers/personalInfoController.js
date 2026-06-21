
import { personalInfoCollection, accountInfoCollection, getCloudMirrorStatus } from "../db/mongo.js";
import { updateAccountInfoById } from "../services/accountInfoStore.js";
import { resolvePersonalSkill } from "../services/skillGraph/resolve.js";
import { normalizeSkillKey } from "../services/skillGraph/normalize.js";
import { emptyResumeCatalog, validateResumeCatalog } from "../services/resumeCatalogService.js";

/** Build personal skill document with graph canonicalId. */
async function buildPersonalSkillDoc(name) {
	const resolved = await resolvePersonalSkill(name);
	return {
		name: resolved.raw || name.trim(),
		normalizedKey: resolved.normalizedKey || normalizeSkillKey(name),
		canonicalId: resolved.canonicalId || null,
		createdAt: new Date().toISOString(),
	};
}

export async function getSkills(req, res) {
	try {
		if (!personalInfoCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const docs = await personalInfoCollection.find({}).toArray();
		const skills = docs.map(d => d.name);
		const canonicalIds = docs.map(d => d.canonicalId).filter(Boolean);
		return res.json({ success: true, skills, canonicalIds });
	} catch (err) {
		console.error('GET /api/personal/skills error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function addSkill(req, res) {
	try {
		if (!personalInfoCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const { skill } = req.body;
		if (!skill || typeof skill !== 'string') return res.status(400).json({ success: false, error: 'Missing skill string in body' });
		const name = skill.trim();
		if (!name) return res.status(400).json({ success: false, error: 'Empty skill' });
		const doc = await buildPersonalSkillDoc(name);
		await personalInfoCollection.updateOne({ name: doc.name }, { $set: doc }, { upsert: true });
		const docs = await personalInfoCollection.find({}).toArray();
		return res.json({ success: true, skills: docs.map(d => d.name) });
	} catch (err) {
		console.error('POST /api/personal/skills error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function deleteSkill(req, res) {
	try {
		if (!personalInfoCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const { skill } = req.body;
		if (!skill || typeof skill !== 'string') return res.status(400).json({ success: false, error: 'Missing skill string in body' });
		const name = skill.trim();
		if (!name) return res.status(400).json({ success: false, error: 'Empty skill' });
		await personalInfoCollection.deleteOne({ name });
		const docs = await personalInfoCollection.find({}).toArray();
		return res.json({ success: true, skills: docs.map(d => d.name) });
	} catch (err) {
		console.error('DELETE /api/personal/skills error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function updateSkills(req, res) {
	try {
		if (!personalInfoCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const { skills } = req.body;
		if (!Array.isArray(skills)) return res.status(400).json({ success: false, error: 'Missing skills array in body' });
		await personalInfoCollection.deleteMany({});
		if (skills.length) {
			const docs = [];
			for (const name of skills) {
				const trimmed = String(name).trim();
				if (!trimmed) continue;
				docs.push(await buildPersonalSkillDoc(trimmed));
			}
			if (docs.length) await personalInfoCollection.insertMany(docs);
		}
		const docs = await personalInfoCollection.find({}).toArray();
		return res.json({ success: true, skills: docs.map(d => d.name) });
	} catch (err) {
		console.error('POST /api/personal/skills/update error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

const ALLOWED_GENDER = new Set(["", "prefer_not_say", "female", "male", "non_binary", "other"]);
const ALLOWED_PRONOUNS = new Set([
	"",
	"prefer_not_say",
	"she/her",
	"he/him",
	"they/them",
	"she/they",
	"he/they",
	"xe/xem",
	"ze/hir",
	"other",
]);
const ALLOWED_SEXUAL_ORIENTATION = new Set([
	"",
	"prefer_not_say",
	"heterosexual",
	"gay",
	"lesbian",
	"bisexual",
	"pansexual",
	"asexual",
	"other",
]);
const ALLOWED_YES_NO_DECLINE = new Set(["", "prefer_not_say", "yes", "no"]);
const ALLOWED_VETERAN = new Set(["", "prefer_not_say", "protected", "not_protected"]);
const ALLOWED_RACE = new Set([
	"",
	"prefer_not_say",
	"american_indian_alaska_native",
	"asian",
	"black",
	"native_hawaiian",
	"white",
	"two_or_more",
	"other",
]);
const ALLOWED_IMMIGRATION_STATUS = new Set([
	"",
	"prefer_not_say",
	"us_citizen",
	"permanent_resident",
	"work_visa",
	"requires_sponsorship",
]);

function pickAllowed(value, allowed) {
	const s = String(value ?? "").trim();
	return allowed.has(s) ? s : "";
}

const MAX_EDUCATION = 15;
const MAX_CAREERS = 25;

function normMonth(m) {
	const s = String(m ?? "").trim();
	if (!s) return "";
	const n = parseInt(s, 10);
	if (n >= 1 && n <= 12) return String(n);
	return "";
}

function normYear(y) {
	const s = String(y ?? "").trim();
	if (/^\d{4}$/.test(s)) return s;
	return "";
}

function normalizeEducationEntries(arr) {
	if (!Array.isArray(arr)) return [];
	return arr.slice(0, MAX_EDUCATION).map((e) => ({
		school: String(e?.school ?? "").trim(),
		diploma: String(e?.diploma ?? "").trim(),
		startMonth: normMonth(e?.startMonth),
		startYear: normYear(e?.startYear),
		endMonth: normMonth(e?.endMonth),
		endYear: normYear(e?.endYear),
	}));
}

function normalizeCareerEntries(arr) {
	if (!Array.isArray(arr)) return [];
	return arr.slice(0, MAX_CAREERS).map((c) => {
		const endPresent =
			!!c?.endPresent ||
			String(c?.endMonth ?? "")
				.trim()
				.toLowerCase() === "present";
		return {
			company: String(c?.company ?? "").trim(),
			title: String(c?.title ?? "").trim(),
			startMonth: normMonth(c?.startMonth),
			startYear: normYear(c?.startYear),
			endPresent,
			endMonth: endPresent ? "" : normMonth(c?.endMonth),
			endYear: endPresent ? "" : normYear(c?.endYear),
		};
	});
}

function normalizeAge(raw) {
	const s = String(raw ?? "").trim().replace(/\D/g, "").slice(0, 3);
	return s;
}

function normalizeAutoBidProfile(body) {
	const g = String(body.gender || "").trim();
	const gender = ALLOWED_GENDER.has(g) ? g : "";
	const pronouns = pickAllowed(body.pronouns, ALLOWED_PRONOUNS);
	const so = String(body.sexualOrientation || "").trim();
	const sexualOrientation = ALLOWED_SEXUAL_ORIENTATION.has(so) ? so : "";
	return {
		fullName: String(body.fullName || "").trim(),
		firstName: String(body.firstName || "").trim(),
		lastName: String(body.lastName || "").trim(),
		age: normalizeAge(body.age),
		address: String(body.address || "").trim(),
		city: String(body.city || "").trim(),
		state: String(body.state || "").trim(),
		country: String(body.country || "").trim(),
		zipCode: String(body.zipCode || "").trim(),
		desiredSalary: String(body.desiredSalary || "").trim().slice(0, 64),
		gender,
		pronouns,
		sexualOrientation,
		email: String(body.email || "").trim(),
		gmailAppPassword: String(body.gmailAppPassword || "").trim().slice(0, 128),
		openaiApiKey: String(body.openaiApiKey || "").trim().slice(0, 256),
		openaiModel: String(body.openaiModel || "gpt-5-nano").trim().slice(0, 64) || "gpt-5-nano",
		deepseekApiKey: String(body.deepseekApiKey || "").trim().slice(0, 256),
		defaultPassword: String(body.defaultPassword || "").trim().slice(0, 256),
		phone: String(body.phone || "").trim(),
		linkedin: String(body.linkedin || "").trim(),
		github: String(body.github || "").trim(),
		portfolioUrl: String(body.portfolioUrl || "").trim(),
		education: normalizeEducationEntries(body.education),
		careers: normalizeCareerEntries(body.careers),
		prefSponsorship: !!body.prefSponsorship,
		prefVeteranFriendly: !!body.prefVeteranFriendly,
		prefDisabilityFriendly: !!body.prefDisabilityFriendly,
		demographicHispanic: pickAllowed(body.demographicHispanic, ALLOWED_YES_NO_DECLINE),
		demographicRaceEthnicity: pickAllowed(body.demographicRaceEthnicity, ALLOWED_RACE),
		demographicDisability: pickAllowed(body.demographicDisability, ALLOWED_YES_NO_DECLINE),
		demographicMilitaryStatus: pickAllowed(body.demographicMilitaryStatus, ALLOWED_VETERAN),
		sponsorship: pickAllowed(body.sponsorship, ALLOWED_YES_NO_DECLINE),
		immigrationStatus: pickAllowed(body.immigrationStatus, ALLOWED_IMMIGRATION_STATUS),
		resumeFolderUrl: String(body.resumeFolderUrl || "").trim(),
		updatedAt: new Date().toISOString(),
	};
}

function defaultEducationEntry() {
	return { school: "", diploma: "", startMonth: "", startYear: "", endMonth: "", endYear: "" };
}

function defaultCareerEntry() {
	return { company: "", title: "", startMonth: "", startYear: "", endMonth: "", endYear: "", endPresent: false };
}

/** Shape returned in GET `profile` (stored or empty). */
function buildAutoBidProfileResponse(p) {
	const educationRaw = Array.isArray(p.education) ? p.education : [];
	const careersRaw = Array.isArray(p.careers) ? p.careers : [];
	const education = educationRaw.length ? educationRaw : [defaultEducationEntry()];
	const careers = careersRaw.length ? careersRaw : [defaultCareerEntry()];
	return {
		fullName: p.fullName || "",
		firstName: p.firstName || "",
		lastName: p.lastName || "",
		age: p.age != null ? String(p.age) : "",
		address: p.address || "",
		city: p.city || "",
		state: p.state || "",
		country: p.country || "",
		zipCode: p.zipCode || "",
		desiredSalary: p.desiredSalary || "",
		gender: p.gender || "",
		pronouns: p.pronouns || "",
		sexualOrientation: p.sexualOrientation || "",
		email: p.email || "",
		gmailAppPassword: p.gmailAppPassword || "",
		openaiApiKey: p.openaiApiKey || "",
		openaiModel: p.openaiModel || "gpt-5-nano",
		deepseekApiKey: p.deepseekApiKey || "",
		defaultPassword: p.defaultPassword || "",
		phone: p.phone || "",
		linkedin: p.linkedin || "",
		github: p.github || "",
		portfolioUrl: p.portfolioUrl || "",
		education,
		careers,
		companyCareer: p.companyCareer || "",
		prefSponsorship: !!p.prefSponsorship,
		prefVeteranFriendly: !!p.prefVeteranFriendly,
		prefDisabilityFriendly: !!p.prefDisabilityFriendly,
		demographicHispanic: p.demographicHispanic || "",
		demographicRaceEthnicity: p.demographicRaceEthnicity || "",
		demographicDisability: p.demographicDisability || "",
		demographicMilitaryStatus: p.demographicMilitaryStatus || "",
		sponsorship: p.sponsorship || "",
		immigrationStatus: p.immigrationStatus || "",
		resumeFolderUrl: p.resumeFolderUrl || "",
		updatedAt: p.updatedAt || null,
	};
}

/**
 * Resolve `account_info` by applier name: exact match first, then case-insensitive.
 * @param {string} nameRaw
 * @param {object} [projection] Mongo projection (defaults to name + autoBidProfile)
 */
async function findAccountByApplierName(nameRaw, projection) {
	const trimmed = String(nameRaw ?? "").trim();
	if (!trimmed || !accountInfoCollection) return null;
	const proj = projection || { name: 1, autoBidProfile: 1, vendorAllowed: 1 };
	let acc = await accountInfoCollection.findOne({ name: trimmed }, { projection: proj });
	if (acc) return acc;
	const esc = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	acc = await accountInfoCollection.findOne({ name: { $regex: new RegExp(`^${esc}$`, "i") } }, { projection: proj });
	return acc || null;
}

export async function getAutoBidProfile(req, res) {
	try {
		if (!accountInfoCollection) return res.status(503).json({ success: false, error: "Database not ready" });
		const name = String(req.query?.applierName || "").trim();
		if (!name) return res.status(400).json({ success: false, error: "applierName query required" });
		const acc = await findAccountByApplierName(name);
		if (!acc) {
			return res.json({
				success: true,
				accountExists: false,
				vendorAllowed: false,
				profile: buildAutoBidProfileResponse({}),
			});
		}
		const p = acc.autoBidProfile || {};
		return res.json({
			success: true,
			accountExists: true,
			vendorAllowed: Boolean(acc.vendorAllowed),
			profile: buildAutoBidProfileResponse(p),
		});
	} catch (err) {
		console.error("GET /api/personal/auto-bid-profile error", err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function upsertAutoBidProfile(req, res) {
	try {
		if (!accountInfoCollection) return res.status(503).json({ success: false, error: "Database not ready" });
		const body = req.body || {};
		const name = String(body.applierName || "").trim();
		if (!name) return res.status(400).json({ success: false, error: "applierName required in body" });
		const autoBidProfile = normalizeAutoBidProfile(body);
		const vendorAllowed = body.vendorAllowed === true || body.vendorAllowed === "true";
		const acc = await findAccountByApplierName(name, { _id: 1, name: 1 });
		if (!acc) {
			return res.status(404).json({
				success: false,
				error: `No account named "${name}". Add it under Applier accounts in the sidebar (or POST /api/account_info) before saving the profile.`,
			});
		}
		const r = await updateAccountInfoById(acc._id, acc.name, {
			$set: { autoBidProfile, vendorAllowed },
		});
		if (r.matchedCount === 0) {
			return res.status(404).json({
				success: false,
				error: `No account named "${name}". Add it under Applier accounts in the sidebar (or POST /api/account_info) before saving the profile.`,
			});
		}
		return res.json({
			success: true,
			profile: autoBidProfile,
			vendorAllowed,
			cloudMirror: getCloudMirrorStatus(),
		});
	} catch (err) {
		console.error("PUT /api/personal/auto-bid-profile error", err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function updateAutoBidOpenAiModel(req, res) {
	try {
		if (!accountInfoCollection) return res.status(503).json({ success: false, error: "Database not ready" });
		const body = req.body || {};
		const name = String(body.applierName || "").trim();
		const profileIdKey = String(body.profileIdKey || "").trim();
		if (!name) return res.status(400).json({ success: false, error: "applierName required in body" });
		if (!profileIdKey) return res.status(400).json({ success: false, error: "profileIdKey required in body" });

		const acc = await findAccountByApplierName(name, { _id: 1, name: 1 });
		if (!acc) {
			return res.status(404).json({ success: false, error: `No account named "${name}".` });
		}

		const profileId = String(acc._id);
		if (profileId !== profileIdKey) {
			return res.status(403).json({
				success: false,
				error: "Profile key does not match the loaded profile _id.",
			});
		}

		const openaiModel = String(body.openaiModel || "gpt-5-nano").trim().slice(0, 64) || "gpt-5-nano";
		const r = await updateAccountInfoById(acc._id, acc.name, {
			$set: {
				"autoBidProfile.openaiModel": openaiModel,
				"autoBidProfile.updatedAt": new Date().toISOString(),
			},
		});
		if (r.matchedCount === 0) {
			return res.status(404).json({ success: false, error: `No account named "${name}".` });
		}

		return res.json({
			success: true,
			profileId,
			openaiModel,
			cloudMirror: getCloudMirrorStatus(),
		});
	} catch (err) {
		console.error("POST /api/personal/auto-bid-profile/openai-model error", err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function getResumeCatalog(req, res) {
	try {
		if (!accountInfoCollection) return res.status(503).json({ success: false, error: "Database not ready" });
		const name = String(req.query?.applierName || "").trim();
		if (!name) return res.status(400).json({ success: false, error: "applierName query required" });
		const acc = await findAccountByApplierName(name, { name: 1, resumeCatalog: 1, resumeCatalogUpdatedAt: 1 });
		if (!acc) {
			return res.json({
				success: true,
				accountExists: false,
				catalog: emptyResumeCatalog(),
				updatedAt: null,
			});
		}
		const catalog = acc.resumeCatalog && typeof acc.resumeCatalog === "object" && !Array.isArray(acc.resumeCatalog)
			? acc.resumeCatalog
			: emptyResumeCatalog();
		return res.json({
			success: true,
			accountExists: true,
			catalog,
			updatedAt: acc.resumeCatalogUpdatedAt || null,
		});
	} catch (err) {
		console.error("GET /api/personal/resume-catalog error", err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function validateResumeCatalogHandler(req, res) {
	try {
		const body = req.body || {};
		const validation = validateResumeCatalog(body.catalog ?? body);
		return res.json({
			success: true,
			valid: validation.valid,
			errors: validation.errors,
			warnings: validation.warnings,
			stats: validation.stats,
			catalog: validation.catalog,
		});
	} catch (err) {
		console.error("POST /api/personal/resume-catalog/validate error", err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function upsertResumeCatalog(req, res) {
	try {
		if (!accountInfoCollection) return res.status(503).json({ success: false, error: "Database not ready" });
		const body = req.body || {};
		const name = String(body.applierName || "").trim();
		if (!name) return res.status(400).json({ success: false, error: "applierName required in body" });

		const validation = validateResumeCatalog(body.catalog ?? body);
		if (!validation.valid || !validation.catalog) {
			return res.status(400).json({
				success: false,
				error: validation.errors[0] || "Invalid resume catalog",
				errors: validation.errors,
				warnings: validation.warnings,
			});
		}

		const acc = await findAccountByApplierName(name, { _id: 1, name: 1 });
		if (!acc) {
			return res.status(404).json({
				success: false,
				error: `No account named "${name}". Add it under Applier accounts in the sidebar first.`,
			});
		}

		const updatedAt = new Date().toISOString();
		const r = await updateAccountInfoById(
			acc._id,
			acc.name,
			{ $set: { resumeCatalog: validation.catalog, resumeCatalogUpdatedAt: updatedAt } },
		);
		if (r.matchedCount === 0) {
			return res.status(404).json({
				success: false,
				error: `No account named "${name}". Add it under Applier accounts in the sidebar first.`,
			});
		}

		return res.json({
			success: true,
			catalog: validation.catalog,
			updatedAt,
			stats: validation.stats,
			warnings: validation.warnings,
		});
	} catch (err) {
		console.error("PUT /api/personal/resume-catalog error", err);
		return res.status(500).json({ success: false, error: err.message });
	}
}
