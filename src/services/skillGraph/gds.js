/**
 * Neo4j Graph Data Science integration — weighted path scoring + projection lifecycle.
 * Falls back to weighted Cypher path scoring when GDS plugin is unavailable.
 */
import { isNeo4jReady, runRead } from '../../db/neo4j.js';
import {
	getGdsGraphName,
	getGdsRefreshDebounceMs,
	getKgConfidenceDefaultEdgeWeight,
	getKgGdsFallbackToCypher,
	getKgPathHopDecay,
	getKgPathScoreMode,
	getRelationMultipliers,
	getDirectMatchWeights,
} from '../../config/graphAndVectorConfig.js';
import { RELATION_TYPES } from './search.js';

const GDS_REL_TYPES = RELATION_TYPES;
const MAX_PATH_HOPS = 4;
const COST_PROPERTY = 'cost';

let gdsAvailable = null;
let projectionReady = false;
let refreshTimer = null;

function num(v) {
	return typeof v?.toNumber === 'function' ? v.toNumber() : Number(v ?? 0);
}

/** Edge traversal cost — lower = stronger relationship (Dijkstra minimizes). */
export function computeEdgeCost(relType, weight) {
	const multipliers = getRelationMultipliers();
	const mult = multipliers[relType] ?? getKgConfidenceDefaultEdgeWeight();
	const w = Number.isFinite(Number(weight)) ? Number(weight) : getKgConfidenceDefaultEdgeWeight();
	return Math.max(0.01, (1 - w) / Math.max(0.01, mult));
}

/** Convert path cost to 0–1 similarity for match scoring. */
export function pathCostToSimilarity(totalCost, hops = 1) {
	const decay = getKgPathHopDecay();
	const mode = getKgPathScoreMode();
	const hopPenalty = hops > 1 ? decay ** (hops - 1) : 1;

	if (mode === 'exp') {
		return Math.min(1, Math.exp(-totalCost) * hopPenalty);
	}
	return Math.min(1, (1 / (1 + totalCost)) * hopPenalty);
}

export async function isGdsReady() {
	if (!isNeo4jReady()) return false;
	if (gdsAvailable !== null) return gdsAvailable;
	try {
		const records = await runRead('RETURN gds.version() AS version');
		gdsAvailable = Boolean(records[0]?.get('version'));
	} catch {
		gdsAvailable = false;
	}
	return gdsAvailable;
}

function buildRelationshipProjectionCypher() {
	const relList = GDS_REL_TYPES.join('|');
	const m = getRelationMultipliers();
	const defaultW = getKgConfidenceDefaultEdgeWeight();
	return `
		MATCH (a:Skill)-[r:${relList}]->(b:Skill)
		WITH a, b, r,
			CASE type(r)
				WHEN 'PREREQUISITE_OF' THEN ${m.PREREQUISITE_OF}
				WHEN 'BUILDS_ON' THEN ${m.BUILDS_ON}
				WHEN 'USED_WITH' THEN ${m.USED_WITH}
				WHEN 'RELATED_TO' THEN ${m.RELATED_TO}
				WHEN 'PART_OF' THEN ${m.PART_OF}
				WHEN 'ALTERNATIVE_TO' THEN ${m.ALTERNATIVE_TO}
				WHEN 'SPECIALIZATION_OF' THEN ${m.SPECIALIZATION_OF}
				ELSE ${defaultW}
			END AS mult
		RETURN id(a) AS source, id(b) AS target,
			(1.0 - coalesce(r.weight, ${defaultW})) / mult AS ${COST_PROPERTY}
	`;
}

/** Drop and recreate the in-memory GDS projection. */
export async function refreshGdsProjection() {
	if (!(await isGdsReady())) {
		projectionReady = false;
		return false;
	}

	const graphName = getGdsGraphName();
	try {
		const exists = await runRead(
			'CALL gds.graph.exists($name) YIELD exists RETURN exists',
			{ name: graphName },
		);
		if (exists[0]?.get('exists')) {
			await runRead('CALL gds.graph.drop($name)', { name: graphName });
		}

		await runRead(
			`
			CALL gds.graph.project.cypher(
				$name,
				'MATCH (n:Skill) RETURN id(n) AS id',
				$relationshipQuery,
				{ validateRelationships: false }
			)
			YIELD graphName, nodeCount, relationshipCount
			RETURN graphName, nodeCount, relationshipCount
			`,
			{ name: graphName, relationshipQuery: buildRelationshipProjectionCypher() },
		);
		projectionReady = true;
		return true;
	} catch (err) {
		console.warn('[gds] projection refresh failed:', err.message);
		projectionReady = false;
		return false;
	}
}

export async function ensureGdsProjection() {
	if (!(await isGdsReady())) return false;
	if (projectionReady) return true;
	return refreshGdsProjection();
}

/** Debounced projection refresh after graph writes. */
export function scheduleGdsRefresh() {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		void refreshGdsProjection();
	}, getGdsRefreshDebounceMs());
}

async function gdsBestPath(jobSkillId, userSkillIds) {
	await ensureGdsProjection();
	if (!projectionReady) return null;

	const graphName = getGdsGraphName();
	const sourceRecords = await runRead(
		'MATCH (s:Skill { id: $id }) RETURN id(s) AS internalId',
		{ id: jobSkillId },
	);
	const sourceInternalId = num(sourceRecords[0]?.get('internalId'));
	if (!sourceInternalId) return null;

	const targetSet = new Set(userSkillIds.map(String));
	const records = await runRead(
		`
		CALL gds.shortestPath.dijkstra.stream($graphName, {
			sourceNode: $sourceNode,
			relationshipWeightProperty: $costProperty
		})
		YIELD targetNode, totalCost, nodeIds
		RETURN gds.util.asNode(targetNode).id AS targetSkillId,
		       totalCost,
		       [nid IN nodeIds | gds.util.asNode(nid).id] AS pathSkills
		`,
		{
			graphName,
			sourceNode: sourceInternalId,
			costProperty: COST_PROPERTY,
		},
	);

	let best = null;
	for (const r of records) {
		const targetSkillId = r.get('targetSkillId');
		if (!targetSet.has(String(targetSkillId))) continue;

		const totalCost = num(r.get('totalCost'));
		const pathSkills = (r.get('pathSkills') || []).map(String);
		const hops = Math.max(0, pathSkills.length - 1);
		const similarity = pathCostToSimilarity(totalCost, hops);

		if (!best || similarity > best.similarity) {
			best = {
				userSkillId: targetSkillId,
				similarity,
				pathCost: totalCost,
				hops,
				pathSkills,
				pathRelTypes: [],
			};
		}
	}
	return best;
}

async function cypherWeightedBestPath(jobSkillId, userSkillIds) {
	const defaultWeight = getKgConfidenceDefaultEdgeWeight();
	const records = await runRead(
		`
		MATCH (j:Skill { id: $jobId })
		MATCH (u:Skill) WHERE u.id IN $userIds
		OPTIONAL MATCH path = shortestPath((j)-[*..${MAX_PATH_HOPS}]-(u))
		WHERE ALL(rel IN relationships(path) WHERE type(rel) IN $relTypes)
		WITH u, path, relationships(path) AS rels, nodes(path) AS pathNodes
		WHERE path IS NOT NULL
		RETURN u.id AS userId,
			[r IN rels | { type: type(r), weight: coalesce(r.weight, $defaultWeight) }] AS edges,
			[n IN pathNodes | n.id] AS pathSkills
		`,
		{
			jobId: jobSkillId,
			userIds: userSkillIds,
			relTypes: GDS_REL_TYPES,
			defaultWeight,
		},
	);

	let best = null;
	for (const r of records) {
		const userId = r.get('userId');
		const edges = r.get('edges') || [];
		const pathSkills = r.get('pathSkills') || [];
		let totalCost = 0;
		const pathRelTypes = [];
		for (const edge of edges) {
			totalCost += computeEdgeCost(edge.type, edge.weight);
			pathRelTypes.push(edge.type);
		}
		const hops = Math.max(0, pathSkills.length - 1);
		const similarity = pathCostToSimilarity(totalCost, hops);

		if (!best || similarity > best.similarity) {
			best = {
				userSkillId: userId,
				similarity,
				pathCost: totalCost,
				hops,
				pathSkills,
				pathRelTypes,
			};
		}
	}
	return best;
}

/**
 * Best weighted path match from job skill to any user skill.
 * @returns {{ userSkillId, similarity, pathCost, hops, pathSkills, pathRelTypes } | null}
 */
export async function computeBestPathMatch(jobSkillId, userSkillIds) {
	if (!jobSkillId || !userSkillIds?.length || !isNeo4jReady()) return null;

	const userIds = [...new Set(userSkillIds.map(String).filter(Boolean))];
	if (userIds.includes(String(jobSkillId))) {
		const directMatchWeights = getDirectMatchWeights();
		return {
			userSkillId: jobSkillId,
			similarity: directMatchWeights.direct,
			pathCost: 0,
			hops: 0,
			pathSkills: [jobSkillId],
			pathRelTypes: [],
		};
	}

	if (await isGdsReady()) {
		const gdsResult = await gdsBestPath(jobSkillId, userIds);
		if (gdsResult) return gdsResult;
	}

	if (getKgGdsFallbackToCypher()) {
		return cypherWeightedBestPath(jobSkillId, userIds);
	}

	return null;
}

/** Reset cached GDS availability (e.g. after reconnect). */
export function resetGdsCache() {
	gdsAvailable = null;
	projectionReady = false;
}
