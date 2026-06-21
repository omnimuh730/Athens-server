import {
	jobsCollection,
	personalInfoCollection,
} from '../db/mongo.js';
import { isNeo4jReady } from '../db/neo4j.js';
import { normalizeSkillKey, toComparable } from './skillGraph/normalize.js';
import { resolveMany } from './skillGraph/resolve.js';
import { fetchSubgraph } from './skillGraph/search.js';
import { computeActivation, DIRECT_MATCH_WEIGHTS } from './skillGraph/activation.js';
import { runRead } from '../db/neo4j.js';

export const SKILL_SCORE_VERSION = 2;

const normalizeSkill = (skill) => {
	if (!skill || typeof skill !== 'string') return '';
	return skill.trim();
};

const uniqueNormalizedSkillsExport = (skills = []) => {
	const seen = new Set();
	const result = [];
	for (const skill of skills) {
		const normalized = normalizeSkill(skill);
		if (!normalized) continue;
		const key = toComparable(normalized);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
};

export { uniqueNormalizedSkillsExport as uniqueNormalizedSkills };

const clampPercentage = (value) => {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value)));
};

let cachedPersonalSkills = null;
let cachedPersonalLoadedAt = 0;
const SKILL_CACHE_TTL_MS = 5 * 60 * 1000;

async function getPersonalSkillRecords(forceReload = false) {
	if (!personalInfoCollection) return [];
	const isCacheStale = Date.now() - cachedPersonalLoadedAt > SKILL_CACHE_TTL_MS;
	if (!cachedPersonalSkills || forceReload || isCacheStale) {
		cachedPersonalSkills = await personalInfoCollection
			.find({}, { projection: { name: 1, canonicalId: 1, normalizedKey: 1 } })
			.toArray();
		cachedPersonalLoadedAt = Date.now();
	}
	return cachedPersonalSkills;
}

export function invalidatePersonalSkillCache() {
	cachedPersonalSkills = null;
	cachedPersonalLoadedAt = 0;
}

export async function getPersonalSkillList() {
	const docs = await getPersonalSkillRecords();
	return docs.map(d => d.name);
}

async function getUserCanonicalIds(forceReload = false) {
	const docs = await getPersonalSkillRecords(forceReload);
	const ids = new Set();
	const rawKeys = new Set();

	for (const doc of docs) {
		if (doc.canonicalId) ids.add(doc.canonicalId);
		const key = doc.normalizedKey || toComparable(doc.name);
		if (key) rawKeys.add(key);
	}

	return { canonicalIds: ids, rawKeys, docs };
}

/** BFS match weight between job canonical id and user canonical set via graph edges. */
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

async function scoreWithActivation(jobCanonicalIds, userCanonicalIds) {
	const allIds = [...new Set([...jobCanonicalIds, ...userCanonicalIds])];
	if (!allIds.length || !userCanonicalIds.size) return null;

	const graph = await fetchSubgraph(allIds);
	if (!graph.nodes.length) return null;

	// Expand graph with one-hop neighbors for activation
	const expandedIds = new Set(allIds);
	for (const e of graph.edges) {
		expandedIds.add(e.from);
		expandedIds.add(e.to);
	}
	const expanded = expandedIds.size > allIds.length
		? await fetchSubgraph([...expandedIds])
		: graph;

	const evidenceItems = [...userCanonicalIds].map(id => ({
		id,
		proficiency: 1,
		ageYears: 0,
		freq: 1,
		sources: ['user'],
	}));

	const { activation } = computeActivation(expanded, evidenceItems);

	let total = 0;
	let count = 0;
	for (const jobId of jobCanonicalIds) {
		const act = activation[jobId] ?? 0;
		total += act;
		count += 1;
	}

	if (count === 0) return null;
	return clampPercentage((total / count) * 100);
}

async function scoreJobSkillsGraph(jobSkills, userCanonicalIds, userRawKeys) {
	const resolved = await resolveMany(jobSkills, { enqueueIfMissing: false });
	const normalizedJobSkills = uniqueNormalizedSkillsExport(jobSkills);

	if (!normalizedJobSkills.length) return 0;
	if (!userCanonicalIds.size && !userRawKeys.size) return 0;

	const jobCanonicalIds = [];
	let matched = 0;
	let totalWeight = 0;

	for (const raw of normalizedJobSkills) {
		const key = normalizeSkillKey(raw);
		const entry = [...resolved.values()].find(v => v.normalizedKey === key);
		const canonicalId = entry?.canonicalId;

		if (userRawKeys.has(key)) {
			matched += 1;
			totalWeight += DIRECT_MATCH_WEIGHTS.direct;
			if (canonicalId) jobCanonicalIds.push(canonicalId);
			continue;
		}

		if (canonicalId) {
			jobCanonicalIds.push(canonicalId);
			const w = await directGraphMatchWeight(canonicalId, userCanonicalIds);
			if (w > 0) {
				totalWeight += w;
				matched += w;
			}
		} else if (userRawKeys.has(key)) {
			totalWeight += DIRECT_MATCH_WEIGHTS.unresolved;
			matched += DIRECT_MATCH_WEIGHTS.unresolved;
		}
	}

	// Try activation-based score when we have graph connectivity
	if (isNeo4jReady() && jobCanonicalIds.length && userCanonicalIds.size) {
		const activationScore = await scoreWithActivation([...new Set(jobCanonicalIds)], userCanonicalIds);
		if (activationScore !== null && activationScore > 0) {
			return activationScore;
		}
	}

	return clampPercentage((totalWeight / normalizedJobSkills.length) * 100);
}

export async function computeSkillScoreValue(skills = []) {
	if (!Array.isArray(skills) || !skills.length) return 0;
	const { canonicalIds, rawKeys } = await getUserCanonicalIds();
	return scoreJobSkillsGraph(skills, canonicalIds, rawKeys);
}

export async function getMissingSkills(skills = []) {
	// Legacy no-op: skills_category removed; enrichment queue handles new skills.
	return uniqueNormalizedSkillsExport(skills);
}

export async function refreshSkillScoresForSkills(skills = []) {
	if (!jobsCollection || !skills.length) return;
	const normalizedTargets = uniqueNormalizedSkillsExport(skills);
	if (!normalizedTargets.length) return;

	const { canonicalIds, rawKeys } = await getUserCanonicalIds(true);
	const cursor = jobsCollection.find(
		{ skills: { $in: normalizedTargets } },
		{ projection: { _id: 1, skills: 1 } },
	);

	let batch = [];
	const flush = async () => {
		if (!batch.length) return;
		await jobsCollection.bulkWrite(batch, { ordered: false });
		batch = [];
	};

	for await (const job of cursor) {
		const score = await scoreJobSkillsGraph(job.skills || [], canonicalIds, rawKeys);
		batch.push({
			updateOne: {
				filter: { _id: job._id },
				update: {
					$set: {
						skillScore: score,
						skillScoreVersion: SKILL_SCORE_VERSION,
					},
				},
			},
		});
		if (batch.length >= 200) await flush();
	}
	await flush();
}

/** Recompute all job skill scores (used by recalculate endpoint). */
export async function recalculateAllSkillScores() {
	if (!jobsCollection) return { processed: 0, updated: 0 };

	const { canonicalIds, rawKeys } = await getUserCanonicalIds(true);
	const cursor = jobsCollection.find({}, { projection: { _id: 1, skills: 1, skillScore: 1 } });

	let processed = 0;
	let updated = 0;
	let batch = [];

	const flush = async () => {
		if (!batch.length) return;
		const r = await jobsCollection.bulkWrite(batch, { ordered: false });
		updated += r.modifiedCount;
		batch = [];
	};

	for await (const job of cursor) {
		const score = await scoreJobSkillsGraph(job.skills || [], canonicalIds, rawKeys);
		processed += 1;
		if (job.skillScore !== score) {
			batch.push({
				updateOne: {
					filter: { _id: job._id },
					update: { $set: { skillScore: score, skillScoreVersion: SKILL_SCORE_VERSION } },
				},
			});
		}
		if (batch.length >= 200) await flush();
	}
	await flush();
	return { processed, updated };
}
