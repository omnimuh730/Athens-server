import { isNeo4jReady, runReadBatch, toNeo4jInt } from '../../db/neo4j.js';
import { getKgConfidenceDefaultEdgeWeight } from '../../config/graphAndVectorConfig.js';
import { RELATION_TYPES } from '../skillGraph/search.js';
import { mapToSkillCategory } from './categoryMap.js';
import { scheduleGdsRefresh } from './gds.js';

const DEFAULT_NODE_LIMIT = 2000;
const DEFAULT_EDGE_LIMIT = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const graphCache = new Map();

function intParam(n) {
	return toNeo4jInt(n);
}

function num(v) {
	return typeof v?.toNumber === 'function' ? v.toNumber() : Number(v ?? 0);
}

function cacheKey(nodeLimit, edgeLimit) {
	return `${nodeLimit}:${edgeLimit}`;
}

/** Map Neo4j skillType/category to frontend SkillCategory slug. */
export { mapToSkillCategory } from './categoryMap.js';

/**
 * Fetch the shared world skill graph for the Knowledge Graph UI.
 * Results are cached in memory for CACHE_TTL_MS.
 */
export async function fetchWorldGraph({ nodeLimit = DEFAULT_NODE_LIMIT, edgeLimit = DEFAULT_EDGE_LIMIT } = {}) {
	if (!isNeo4jReady()) {
		throw new Error('Neo4j is not connected');
	}

	const key = cacheKey(nodeLimit, edgeLimit);
	const cached = graphCache.get(key);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
		return cached.data;
	}

	const [nodeRecords, edgeRecords, countRecords] = await runReadBatch([
		{
			cypher: `
				MATCH (s:Skill)
				RETURN s.id AS id, s.label AS label, s.category AS category, s.skillType AS skillType
				ORDER BY s.label
				LIMIT $limit
			`,
			params: { limit: intParam(nodeLimit) },
		},
		{
			cypher: `
				MATCH (a:Skill)-[r]->(b:Skill)
				WHERE type(r) IN $relTypes
				RETURN a.id AS from, b.id AS to, type(r) AS type, coalesce(r.weight, $defaultWeight) AS weight
				LIMIT $limit
			`,
			params: {
				relTypes: RELATION_TYPES,
				limit: intParam(edgeLimit),
				defaultWeight: getKgConfidenceDefaultEdgeWeight(),
			},
		},
		{
			cypher: 'MATCH (s:Skill) RETURN count(s) AS total',
		},
	]);

	const nodes = nodeRecords.map(r => {
		const skillType = r.get('skillType');
		const category = r.get('category');
		return {
			id: r.get('id'),
			label: r.get('label'),
			category: mapToSkillCategory(skillType, category),
			skillType,
			rawCategory: category,
		};
	});

	const nodeIds = new Set(nodes.map(n => n.id));
	const edges = edgeRecords
		.map(r => ({
			from: r.get('from'),
			to: r.get('to'),
			type: r.get('type'),
			weight: num(r.get('weight')) || getKgConfidenceDefaultEdgeWeight(),
		}))
		.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

	const totalNodes = num(countRecords[0]?.get('total'));

	const data = {
		nodes,
		edges,
		totalNodes,
		truncated: totalNodes > nodes.length,
	};

	graphCache.set(key, { at: Date.now(), data });
	return data;
}

/** Invalidate cached world graph (e.g. after enrichment writes). */
export function invalidateWorldGraphCache() {
	graphCache.clear();
	scheduleGdsRefresh();
}
