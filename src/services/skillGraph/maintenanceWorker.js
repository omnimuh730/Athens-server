/**
 * Background graph maintenance — drains pending queue, syncs co-occurrence, refreshes GDS.
 * Runs independently of manual "Analyze pending" sessions.
 */
import { isNeo4jReady } from '../../db/neo4j.js';
import {
	getSkillGraphMaintenanceBatchSize,
	getSkillGraphMaintenanceEnabled,
	getSkillGraphMaintenanceIntervalMs,
	getSkillGraphLinkPredictionIntervalMs,
} from '../../config/graphAndVectorConfig.js';
import {
	claimNextBatch,
	markDoneWithMeta,
	markFailed,
	requeueFailed,
} from '../skillEnrichment/queue.js';
import { processEnrichmentItem } from '../skillEnrichment/processSkill.js';
import { getEnrichmentMode, isEnrichmentEnabled } from '../skillEnrichment/config.js';
import { syncCooccurrenceToGraph, retryCooccurrenceForKey } from '../skillCooccurrence/index.js';
import { refreshGdsProjection } from './gds.js';
import { invalidateWorldGraphCache } from './worldGraph.js';
import { runLinkPredictionBatch } from './linkPredictionJob.js';
import { bridgeCooccurringGroupsBatch } from '../skillEnrichment/bridgeCooccurringGroups.js';
import { getEnrichmentSessionStatus } from '../skillEnrichment/worker.js';

let maintenanceTimer = null;
let linkPredictionTimer = null;
let tickInProgress = false;

async function processMaintenanceBatch() {
	if (!isNeo4jReady() || !isEnrichmentEnabled()) return { processed: 0 };

	const session = getEnrichmentSessionStatus();
	if (session.running) return { processed: 0, skipped: 'enrichment_session_active' };

	const batchSize = getSkillGraphMaintenanceBatchSize();
	const batch = await claimNextBatch(batchSize);
	if (!batch.length) return { processed: 0 };

	let processed = 0;
	let graphUpdated = false;

	for (const item of batch) {
		try {
			const result = await processEnrichmentItem(item, null, { mode: getEnrichmentMode() });
			await markDoneWithMeta(item.normalizedKey, {
				skillId: result.skillId,
				enrichmentPath: result.enrichmentPath ?? result.path,
				path: result.path,
				action: result.action,
				relationshipCount: result.relationshipCount ?? 0,
				usage: result.usage,
			});
			await retryCooccurrenceForKey(item.normalizedKey).catch(() => undefined);
			if (result.skillId) graphUpdated = true;
			processed += 1;
		} catch (err) {
			console.error('[graph-maintenance] failed', item.normalizedKey, err.message);
			await markFailed(item.normalizedKey, err);
		}
	}

	await syncCooccurrenceToGraph(50).catch(() => undefined);
	await requeueFailed().catch(() => undefined);

	if (graphUpdated) {
		invalidateWorldGraphCache();
	}

	return { processed };
}

async function maintenanceTick() {
	if (tickInProgress) return;
	tickInProgress = true;
	try {
		const result = await processMaintenanceBatch();
		if (result.processed > 0) {
			console.log(`[graph-maintenance] processed ${result.processed} pending skill(s)`);
		}
	} catch (err) {
		console.error('[graph-maintenance] tick error', err.message);
	} finally {
		tickInProgress = false;
	}
}

async function linkPredictionTick() {
	if (!isNeo4jReady()) return;
	const session = getEnrichmentSessionStatus();
	if (session.running) return;

	try {
		const result = await runLinkPredictionBatch();
		if (result.edgesCreated > 0) {
			console.log(`[link-prediction] created ${result.edgesCreated} edge(s) from ${result.candidates} candidates`);
			invalidateWorldGraphCache();
		}
		await bridgeCooccurringGroupsBatch().catch(() => undefined);
	} catch (err) {
		console.error('[link-prediction] tick error', err.message);
	}
}

export function startSkillGraphMaintenanceWorker() {
	if (!getSkillGraphMaintenanceEnabled()) {
		console.log('[graph-maintenance] disabled (SKILL_GRAPH_MAINTENANCE_ENABLED=false)');
		return;
	}

	if (maintenanceTimer) return;

	const intervalMs = getSkillGraphMaintenanceIntervalMs();
	maintenanceTimer = setInterval(() => void maintenanceTick(), intervalMs);
	void maintenanceTick();

	const linkIntervalMs = getSkillGraphLinkPredictionIntervalMs();
	linkPredictionTimer = setInterval(() => void linkPredictionTick(), linkIntervalMs);

	void refreshGdsProjection().catch(() => undefined);

	console.log(
		`[graph-maintenance] worker started (interval ${intervalMs}ms, link-prediction ${linkIntervalMs}ms)`,
	);
}

export function stopSkillGraphMaintenanceWorker() {
	if (maintenanceTimer) {
		clearInterval(maintenanceTimer);
		maintenanceTimer = null;
	}
	if (linkPredictionTimer) {
		clearInterval(linkPredictionTimer);
		linkPredictionTimer = null;
	}
}

export { processMaintenanceBatch };
