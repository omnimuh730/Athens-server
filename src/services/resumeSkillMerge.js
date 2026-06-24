import { toCanonical } from "../services/skillNormalize.js";

const SKILL_ALIASES = [
	["go", "golang"],
	["nodejs", "node.js"],
	["postgres", "postgresql"],
	["k8s", "kubernetes"],
	["githubactions", "github actions"],
];

function skillKey(name) {
	return toCanonical(String(name ?? "").trim()) || String(name).toLowerCase();
}

/** Parse explicit Skills section bullets and comma lists from resume text. */
export function parseSkillsSectionFromResume(text) {
	const raw = String(text || "");
	const start = raw.search(/\bSkills?\s*\n/i);
	if (start < 0) return [];

	const tail = raw.slice(start);
	const endRel = tail.search(/\n(?:Experience|Education)\b/i);
	const section = endRel >= 0 ? tail.slice(0, endRel) : tail.slice(0, 5000);

	const found = [];
	const lines = section.split("\n").slice(1);

	for (const line of lines) {
		const cleaned = line.replace(/^[\s●\-*•]+/, "").trim();
		if (!cleaned || /^skills?\b/i.test(cleaned)) continue;

		const payload = cleaned.includes(":")
			? cleaned.split(":").slice(1).join(":").trim()
			: cleaned;

		for (const part of payload.split(/[,;|•·]/)) {
			const name = part.trim().replace(/\s{2,}/g, " ");
			if (name.length < 2 || name.length > 80) continue;
			if (/^(skills?|languages?|education)$/i.test(name)) continue;
			found.push(name);
		}
	}

	return [...new Set(found)];
}

function mentionCount(text, name) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(escaped, "gi");
	return (text.match(re) || []).length;
}

function defaultStrengthForSectionSkill(text, name) {
	const mentions = mentionCount(text, name);
	if (mentions >= 8) return 7.5;
	if (mentions >= 4) return 6;
	if (mentions >= 2) return 4.5;
	return 3.5;
}

function applyAliasMerges(map) {
	for (const [aliasKey, canonicalName] of SKILL_ALIASES) {
		const canonKey = skillKey(canonicalName);
		const alias = map.get(aliasKey);
		const canon = map.get(canonKey);

		if (alias && canon) {
			if (alias.strength > canon.strength) {
				map.set(canonKey, { name: canonicalName, strength: alias.strength });
			}
			map.delete(aliasKey);
		} else if (alias && !canon) {
			map.set(canonKey, { name: canonicalName, strength: alias.strength });
			map.delete(aliasKey);
		}
	}
}

/**
 * Merge LLM output with parsed Skills section — section items are never dropped.
 */
export function mergeSkillProfiles(llmSkills, resumeText) {
	const text = String(resumeText || "");
	const sectionSkills = parseSkillsSectionFromResume(text);
	const map = new Map();

	for (const item of llmSkills || []) {
		const name = String(item?.name ?? "").trim();
		if (!name) continue;
		let strength = Number(item?.strength ?? 0);
		if (!Number.isFinite(strength)) strength = 5;
		strength = Math.max(0.1, Math.min(10, strength));
		const key = skillKey(name);
		const prev = map.get(key);
		if (!prev || strength > prev.strength) {
			map.set(key, { name, strength });
		}
	}

	for (const name of sectionSkills) {
		const key = skillKey(name);
		if (!map.has(key)) {
			map.set(key, {
				name,
				strength: defaultStrengthForSectionSkill(text, name),
			});
		}
	}

	applyAliasMerges(map);

	return [...map.values()].sort((a, b) => b.strength - a.strength).slice(0, 100);
}
