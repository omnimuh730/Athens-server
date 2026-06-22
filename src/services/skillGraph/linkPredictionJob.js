/**
 * GDS link prediction — proposes missing skill edges from shared neighbors (offline batch).
 * Uses gds.nodeSimilarity.stream (Adamic-Adar is pairwise-only in modern GDS, no .stream).
 */
import { isNeo4jReady, runRead, toNeo4jInt } from '../../db/neo4j.js';
import {
	getGdsGraphName,
	getKgConfidenceCooccurrenceEdge,
	getKgLinkPredictionMinScore,
} from '../../config/graphAndVectorConfig.js';
import { upsertRelationships } from '../skillGraph/apply.js';
import { ensureGdsProjection, refreshGdsProjection } from './gds.js';

const BATCH_LIMIT = 100;
const TOP_K_PER_NODE = 20;

async function filterNewPairs(candidates) {
	if (!candidates.length) return [];

	const pairs = candidates.map((c) => ({ fromId: c.fromId, toId: c.toId }));
	const records = await runRead(
		`
		UNWIND $pairs AS pair
		MATCH (a:Skill { id: pair.fromId })
		MATCH (b:Skill { id: pair.toId })
		WHERE NOT (a)-[:PREREQUISITE_OF|BUILDS_ON|RELATED_TO|ALTERNATIVE_TO|PART_OF|USED_WITH|SPECIALIZATION_OF]-(b)
		RETURN pair.fromId AS fromId, pair.toId AS toId
		`,
		{ pairs },
	);

	const existing = new Set(
		records.map((r) => `${r.get('fromId')}|${r.get('toId')}`),
	);

	return candidates.filter((c) => existing.has(`${c.fromId}|${c.toId}`));
}

async function fetchSimilarityCandidates(graphName, minScore, limit) {
	const topK = toNeo4jInt(TOP_K_PER_NODE);
	const rowLimit = toNeo4jInt(limit);
	const degreeCutoff = toNeo4jInt(1);

	return runRead(
		`
		CALL gds.nodeSimilarity.stream($graphName, {
			topK: $topK,
			similarityCutoff: $minScore,
			degreeCutoff: $degreeCutoff
		})
		YIELD node1, node2, similarity
		RETURN gds.util.asNode(node1).id AS fromId,
		       gds.util.asNode(node2).id AS toId,
		       similarity AS score
		ORDER BY similarity DESC
		LIMIT $rowLimit
		`,
		{
			graphName,
			topK,
			minScore,
			degreeCutoff,
			rowLimit,
		},
	);
}

/**
 * Run node-similarity link prediction and create RELATED_TO edges above threshold.
 */
export async function runLinkPredictionBatch(limit = BATCH_LIMIT) {
	const batchLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || BATCH_LIMIT)));
	if (!isNeo4jReady()) {
		return { candidates: 0, edgesCreated: 0, skipped: 'neo4j_unavailable' };
	}

	const projected = await ensureGdsProjection();
	if (!projected) {
		return { candidates: 0, edgesCreated: 0, skipped: 'gds_unavailable' };
	}

	const graphName = getGdsGraphName();
	const minScore = getKgLinkPredictionMinScore();
	const defaultWeight = getKgConfidenceCooccurrenceEdge();

	let records;
	try {
		records = await fetchSimilarityCandidates(graphName, minScore, batchLimit);
	} catch (err) {
		console.warn('[link-prediction] nodeSimilarity failed, refreshing projection:', err.message);
		await refreshGdsProjection();
		try {
			records = await fetchSimilarityCandidates(graphName, minScore, batchLimit);
		} catch (retryErr) {
			console.warn('[link-prediction] retry failed:', retryErr.message);
			return { candidates: 0, edgesCreated: 0, skipped: 'gds_error', error: retryErr.message };
		}
	}

	let edgesCreated = 0;
	const candidates = records.map((r) => ({
		fromId: r.get('fromId'),
		toId: r.get('toId'),
		score: Number(r.get('score') ?? 0),
	})).filter((c) => c.fromId && c.toId && c.fromId !== c.toId);

	const newPairs = await filterNewPairs(candidates);

	for (const { fromId, toId, score } of newPairs) {
		const confidence = Math.min(0.95, Math.max(defaultWeight, score));
		await upsertRelationships(fromId, [{
			toId,
			type: 'RELATED_TO',
			confidence,
			weight: confidence,
		}], { source: 'link_prediction', modelVersion: 'gds-node-similarity' });
		edgesCreated += 1;
	}

	return { candidates: records.length, edgesCreated, method: 'nodeSimilarity' };
}
