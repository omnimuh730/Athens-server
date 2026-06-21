/**
 * Graph activation boost for job ↔ resume ranking (enhancement layer after vector retrieval).
 */
import { isNeo4jReady } from '../../db/neo4j.js';
import { normalizeSkillKey, toComparable } from '../skillGraph/normalize.js';
import { resolveMany } from '../skillGraph/resolve.js';
import { fetchSubgraph } from '../skillGraph/search.js';
import { computeActivation, DIRECT_MATCH_WEIGHTS } from '../skillGraph/activation.js';
import { runRead } from '../../db/neo4j.js';

function clampPercentage(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function uniqueNormalizedSkills(skills = []) {
	const seen = new Set();
	const result = [];
	for (const skill of skills) {
		if (!skill || typeof skill !== 'string') continue;
		const normalized = skill.trim();
		if (!normalized) continue;
		const key = toComparable(normalized);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

function collectUserSeeds(userGraphSkills = []) {
	const canonicalIds = new Set();
	const rawKeys = new Set();

	for (const s of userGraphSkills) {
		if (s.canonicalId) canonicalIds.add(s.canonicalId);
		const key = s.normalizedKey || toComparable(s.surfaceForm || s.name || '');
		if (key) rawKeys.add(key);
	}

	return { canonicalIds, rawKeys };
}

async function directGraphMatchWeight(jobCanonicalId, userCanonicalIds) {
	if (!jobCanonicalId || !userCanonicalIds.size) return 0;
	if (userCanonicalIds.has(jobCanonicalId)) return DIRECT_MATCH_WEIGHTS.direct;
	if (!isNeo4jReady()) return 0;

	const records = await runRead(
		`
		MATCH (j:Skill { id: $jobId })
		MATCH (u:Skill) WHERE u.id IN $userIds
		OPTIONAL MATCH path = shortestPath((j)-[*..3]-(u))
		WHERE ALL(rel IN relationships(path) WHERE type(rel) IN [
		  'BUILDS_ON','PREREQUISITE_OF','SPECIALIZATION_OF','RELATED_TO','USED_WITH','ALTERNATIVE_TO','PART_OF'
		])
		WITH j, u, path,
		     [r IN relationships(path) | type(r)] AS relTypes
		RETURN u.id AS userId, relTypes
		LIMIT 20
		`,
		{ jobId: jobCanonicalId, userIds: [...userCanonicalIds] },
	);

	let best = 0;
	for (const r of records) {
		const relTypes = r.get('relTypes') || [];
		for (const t of relTypes) {
			const w = DIRECT_MATCH_WEIGHTS[t] ?? 0.3;
			best = Math.max(best, w);
		}
	}
	return best;
}

async function scoreWithActivation(jobCanonicalIds, userCanonicalIds, userGraphSkills = []) {
	const allIds = [...new Set([...jobCanonicalIds, ...userCanonicalIds])];
	if (!allIds.length || !userCanonicalIds.size) return null;

	const graph = await fetchSubgraph(allIds);
	if (!graph.nodes.length) return null;

	const expandedIds = new Set(allIds);
	for (const e of graph.edges) {
		expandedIds.add(e.from);
		expandedIds.add(e.to);
	}
	const expanded = expandedIds.size > allIds.length
		? await fetchSubgraph([...expandedIds])
		: graph;

	const strengthById = new Map();
	for (const s of userGraphSkills) {
		if (!s.canonicalId) continue;
		const prev = strengthById.get(s.canonicalId) ?? 0;
		const str = Number(s.strength ?? s.proficiency ?? 8) / 10;
		strengthById.set(s.canonicalId, Math.max(prev, str));
	}

	const evidenceItems = [...userCanonicalIds].map((id) => ({
		id,
		proficiency: strengthById.get(id) ?? 1,
		ageYears: 0,
		freq: 1,
		sources: ['user'],
	}));

	const { activation } = computeActivation(expanded, evidenceItems);

	let total = 0;
	let count = 0;
	for (const jobId of jobCanonicalIds) {
		total += activation[jobId] ?? 0;
		count += 1;
	}

	if (count === 0) return null;
	return clampPercentage((total / count) * 100);
}

/**
 * Compute graph-based match boost (0–100) between job skills and a user resume graph.
 * @param {string[]} jobSkills
 * @param {object[]} userGraphSkills — from user_knowledge_graphs.skills
 */
export async function computeGraphBoost(jobSkills = [], userGraphSkills = []) {
	const normalizedJobSkills = uniqueNormalizedSkills(jobSkills);
	if (!normalizedJobSkills.length || !userGraphSkills.length) return 0;

	const { canonicalIds, rawKeys } = collectUserSeeds(userGraphSkills);
	if (!canonicalIds.size && !rawKeys.size) return 0;

	const resolved = await resolveMany(normalizedJobSkills, { enqueueIfMissing: false });
	const jobCanonicalIds = [];
	let totalWeight = 0;

	for (const raw of normalizedJobSkills) {
		const key = normalizeSkillKey(raw);
		const entry = [...resolved.values()].find((v) => v.normalizedKey === key);
		const canonicalId = entry?.canonicalId;

		if (rawKeys.has(key)) {
			totalWeight += DIRECT_MATCH_WEIGHTS.direct;
			if (canonicalId) jobCanonicalIds.push(canonicalId);
			continue;
		}

		if (canonicalId) {
			jobCanonicalIds.push(canonicalId);
			const w = await directGraphMatchWeight(canonicalId, canonicalIds);
			if (w > 0) totalWeight += w;
		} else if (rawKeys.has(key)) {
			totalWeight += DIRECT_MATCH_WEIGHTS.unresolved;
		}
	}

	if (isNeo4jReady() && jobCanonicalIds.length && canonicalIds.size) {
		const activationScore = await scoreWithActivation(
			[...new Set(jobCanonicalIds)],
			canonicalIds,
			userGraphSkills,
		);
		if (activationScore !== null && activationScore > 0) return activationScore;
	}

	return clampPercentage((totalWeight / normalizedJobSkills.length) * 100);
}
