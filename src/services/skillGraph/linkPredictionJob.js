/**
 * GDS link prediction — proposes missing skill edges from shared neighbors (offline batch).
 */
import { isNeo4jReady, runRead } from '../../db/neo4j.js';
import {
	getGdsGraphName,
	getKgConfidenceCooccurrenceEdge,
	getKgLinkPredictionMinScore,
} from '../../config/graphAndVectorConfig.js';
import { upsertRelationships } from '../skillGraph/apply.js';
import { ensureGdsProjection, refreshGdsProjection } from './gds.js';

const BATCH_LIMIT = 100;

async function edgeExists(fromId, toId) {
	const records = await runRead(
		`
		MATCH (a:Skill { id: $fromId })-[r]-(b:Skill { id: $toId })
		WHERE type(r) IN [
		  'PREREQUISITE_OF','BUILDS_ON','RELATED_TO','ALTERNATIVE_TO',
		  'PART_OF','USED_WITH','SPECIALIZATION_OF'
		]
		RETURN count(r) AS n
		`,
		{ fromId, toId },
	);
	const n = records[0]?.get('n');
	return (typeof n?.toNumber === 'function' ? n.toNumber() : Number(n ?? 0)) > 0;
}

/**
 * Run Adamic-Adar link prediction and create RELATED_TO edges above threshold.
 */
export async function runLinkPredictionBatch(limit = BATCH_LIMIT) {
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
		records = await runRead(
			`
			CALL gds.linkprediction.adamicAdar.stream($graphName, { topK: $limit })
			YIELD node1, node2, score
			WHERE score >= $minScore
			RETURN gds.util.asNode(node1).id AS fromId,
			       gds.util.asNode(node2).id AS toId,
			       score
			ORDER BY score DESC
			LIMIT $limit
			`,
			{ graphName, limit, minScore },
		);
	} catch (err) {
		console.warn('[link-prediction] GDS call failed, refreshing projection:', err.message);
		await refreshGdsProjection();
		return { candidates: 0, edgesCreated: 0, skipped: 'gds_error' };
	}

	let edgesCreated = 0;
	for (const r of records) {
		const fromId = r.get('fromId');
		const toId = r.get('toId');
		const score = Number(r.get('score') ?? 0);
		if (!fromId || !toId || fromId === toId) continue;
		if (await edgeExists(fromId, toId)) continue;

		const confidence = Math.min(0.95, Math.max(defaultWeight, score));
		await upsertRelationships(fromId, [{
			toId,
			type: 'RELATED_TO',
			confidence,
			weight: confidence,
		}], { source: 'link_prediction', modelVersion: 'gds-adamic-adar' });
		edgesCreated += 1;
	}

	return { candidates: records.length, edgesCreated };
}
