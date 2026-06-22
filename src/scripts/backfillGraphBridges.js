#!/usr/bin/env node
/**
 * One-time catch-up: drain pending enrichment queue, backfill co-occurrence, refresh GDS, run link prediction.
 *
 * Usage: node src/scripts/backfillGraphBridges.js [--limit=500] [--link-prediction]
 */
import dotenv from 'dotenv';
dotenv.config();

import { initMongo } from '../db/mongo.js';
import { initNeo4j, closeNeo4j } from '../db/neo4j.js';
import { processMaintenanceBatch } from '../services/skillGraph/maintenanceWorker.js';
import { syncCooccurrenceToGraph } from '../services/skillCooccurrence/index.js';
import { refreshGdsProjection } from '../services/skillGraph/gds.js';
import { runLinkPredictionBatch } from '../services/skillGraph/linkPredictionJob.js';
import { countQueueStats } from '../services/skillEnrichment/queue.js';

function parseArgs() {
	const limitArg = process.argv.find((a) => a.startsWith('--limit='));
	const limit = limitArg ? Number.parseInt(limitArg.split('=')[1], 10) : 500;
	const linkPrediction = process.argv.includes('--link-prediction');
	return { limit: Number.isFinite(limit) ? limit : 500, linkPrediction };
}

async function main() {
	const { limit, linkPrediction } = parseArgs();

	await initMongo();
	await initNeo4j();

	console.log('[backfill] starting graph bridge catch-up...');
	const statsBefore = await countQueueStats();
	console.log('[backfill] queue before:', statsBefore);

	let totalProcessed = 0;
	while (totalProcessed < limit) {
		const { processed } = await processMaintenanceBatch();
		if (!processed) break;
		totalProcessed += processed;
		console.log(`[backfill] processed ${totalProcessed} skill(s)...`);
	}

	const coocSynced = await syncCooccurrenceToGraph(500);
	console.log(`[backfill] co-occurrence synced: ${coocSynced}`);

	const gdsOk = await refreshGdsProjection();
	console.log(`[backfill] GDS projection: ${gdsOk ? 'ready' : 'skipped (install GDS plugin)'}`);

	if (linkPrediction && gdsOk) {
		const lp = await runLinkPredictionBatch(200);
		console.log('[backfill] link prediction:', lp);
	}

	const statsAfter = await countQueueStats();
	console.log('[backfill] queue after:', statsAfter);
	console.log('[backfill] done.');
}

main()
	.catch((err) => {
		console.error('[backfill] failed:', err);
		process.exitCode = 1;
	})
	.finally(async () => {
		await closeNeo4j().catch(() => undefined);
	});
