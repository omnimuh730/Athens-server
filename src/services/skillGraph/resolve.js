import { runRead } from '../../db/neo4j.js';
import { normalizeSkillKey, normalizeSurfaceForm, toComparable } from './normalize.js';
import { findExactMatch } from './search.js';
import { linkAlias, createSkillWithAlias } from './apply.js';
import { enqueueSkills } from '../skillEnrichment/queue.js';

/** Resolve raw skill string to canonical Skill id, enqueue if unknown. */
export async function resolveSkillToCanonical(raw, { enqueueIfMissing = true, cooccurringSkills = [] } = {}) {
	const surfaceForm = normalizeSurfaceForm(raw);
	const normalizedKey = normalizeSkillKey(surfaceForm);
	if (!normalizedKey) return { raw, normalizedKey: '', canonicalId: null };

	const exact = await findExactMatch(normalizedKey);
	if (exact?.id) {
		return { raw: surfaceForm, normalizedKey, canonicalId: exact.id, skillType: exact.skillType };
	}

	if (enqueueIfMissing) {
		await enqueueSkills([surfaceForm], cooccurringSkills);
	}

	return { raw: surfaceForm, normalizedKey, canonicalId: null };
}

/** Resolve many skills; returns Map normalizedKey -> { canonicalId, raw, ... } */
export async function resolveMany(rawSkills = [], options = {}) {
	const map = new Map();
	for (const raw of rawSkills) {
		const key = normalizeSkillKey(raw);
		if (!key || map.has(key)) continue;
		map.set(key, await resolveSkillToCanonical(raw, options));
	}
	return map;
}

/** Ensure personal skill row has canonicalId (may create pending graph node). */
export async function resolvePersonalSkill(name) {
	const resolved = await resolveSkillToCanonical(name, { enqueueIfMissing: true });
	if (resolved.canonicalId) {
		return resolved;
	}

	// Cold start: create standalone node immediately so scoring works before worker runs
	const created = await createSkillWithAlias({
		surfaceForm: resolved.raw,
		normalizedKey: resolved.normalizedKey,
		label: resolved.raw,
		category: 'concept',
		skillType: 'TECHNOLOGY',
		source: 'ingest',
	});

	return { ...resolved, canonicalId: created.skillId };
}

/** List skills from graph for API (paginated). */
export async function listGraphSkills({ q = '', skip = 0, limit = 30 } = {}) {
	const records = await runRead(
		`
		MATCH (s:Skill)
		WHERE $q = '' OR toLower(s.label) CONTAINS toLower($q) OR toLower(s.id) CONTAINS toLower($q)
		RETURN s.id AS id, s.label AS label, s.category AS category, s.skillType AS skillType
		ORDER BY s.label
		SKIP $skip LIMIT $limit
		`,
		{ q: q.trim(), skip: Number(skip), limit: Number(limit) },
	);

	const countRecords = await runRead(
		`
		MATCH (s:Skill)
		WHERE $q = '' OR toLower(s.label) CONTAINS toLower($q) OR toLower(s.id) CONTAINS toLower($q)
		RETURN count(s) AS total
		`,
		{ q: q.trim() },
	);

	const skills = records.map(r => ({
		id: r.get('id'),
		label: r.get('label'),
		category: r.get('category'),
		skillType: r.get('skillType'),
	}));

	const totalRaw = countRecords[0]?.get('total');
	const total = typeof totalRaw?.toNumber === 'function' ? totalRaw.toNumber() : Number(totalRaw ?? 0);

	return { skills, total };
}

export { toComparable, normalizeSkillKey, normalizeSurfaceForm };
