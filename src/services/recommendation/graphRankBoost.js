/**
 * Graph activation boost for job ↔ resume ranking (enhancement layer after vector retrieval).
 */
import { isNeo4jReady } from '../../db/neo4j.js';
import { normalizeSkillKey, toComparable } from '../skillGraph/normalize.js';
import { resolveMany } from '../skillGraph/resolve.js';
import { computeBestPathMatch } from '../skillGraph/gds.js';
import { fetchSubgraph } from '../skillGraph/search.js';
import { computeActivation, getDirectMatchWeights } from '../skillGraph/activation.js';

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
	const directMatchWeights = getDirectMatchWeights();
	if (userCanonicalIds.has(jobCanonicalId)) return directMatchWeights.direct;
	if (!isNeo4jReady()) return 0;

	const pathMatch = await computeBestPathMatch(jobCanonicalId, [...userCanonicalIds]);
	return pathMatch?.similarity ?? 0;
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
	if (!isNeo4jReady()) return 0;

	const normalizedJobSkills = uniqueNormalizedSkills(jobSkills);
	if (!normalizedJobSkills.length || !userGraphSkills.length) return 0;

	const { canonicalIds, rawKeys } = collectUserSeeds(userGraphSkills);
	if (!canonicalIds.size && !rawKeys.size) return 0;

	const resolved = await resolveMany(normalizedJobSkills, { enqueueIfMissing: false });
	const directMatchWeights = getDirectMatchWeights();
	const jobCanonicalIds = [];
	let totalWeight = 0;

	for (const raw of normalizedJobSkills) {
		const key = normalizeSkillKey(raw);
		const entry = [...resolved.values()].find((v) => v.normalizedKey === key);
		const canonicalId = entry?.canonicalId;

		if (rawKeys.has(key)) {
			totalWeight += directMatchWeights.direct;
			if (canonicalId) jobCanonicalIds.push(canonicalId);
			continue;
		}

		if (canonicalId) {
			jobCanonicalIds.push(canonicalId);
			const w = await directGraphMatchWeight(canonicalId, canonicalIds);
			if (w > 0) totalWeight += w;
		} else if (rawKeys.has(key)) {
			totalWeight += directMatchWeights.unresolved;
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
