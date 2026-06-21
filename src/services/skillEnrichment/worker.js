/**
 * Skill enrichment session — parallel pending-queue processor with stop support.
 * Primary entry point for Knowledge Graph "Analyze pending" button.
 */
import { randomUUID } from 'crypto';
import { isNeo4jReady } from '../../db/neo4j.js';
import {
	claimNextBatch,
	markDoneWithMeta,
	markFailed,
	markCancelled,
	countQueueStats,
	resetProcessingToPending,
} from './queue.js';
import { processEnrichmentItem } from './processSkill.js';
import {
	resolveLlmConfig,
	isEnrichmentEnabled,
	getEnrichmentConcurrency,
	getEnrichmentMode,
} from './config.js';
import { addUsage, EMPTY_USAGE } from '../llm/llmService.js';
import { syncCooccurrenceToGraph } from '../skillCooccurrence/index.js';
import { invalidateWorldGraphCache } from '../skillGraph/worldGraph.js';

let activeSession = null;
let cancelRequested = false;

async function mapPool(items, concurrency, fn) {
	let index = 0;
	async function worker() {
		while (index < items.length) {
			if (cancelRequested) return;
			const i = index++;
			await fn(items[i]);
		}
	}
	const workers = Math.min(concurrency, items.length);
	if (workers === 0) return;
	await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function runSessionLoop(session) {
	const concurrency = getEnrichmentConcurrency();
	const llmConfig = session.mode === 'smart' ? await resolveLlmConfig(session.applierName) : null;
	const claimSize = concurrency * 2;

	try {
		while (!cancelRequested) {
			if (session.limit != null && session.processed >= session.limit) break;

			const batch = await claimNextBatch(claimSize);
			if (!batch.length) break;

			const toProcess = session.limit != null
				? batch.slice(0, Math.max(0, session.limit - session.processed))
				: batch;

			await mapPool(toProcess, concurrency, async (item) => {
				if (cancelRequested) {
					await markCancelled(item.normalizedKey);
					return;
				}
				try {
					const result = await processEnrichmentItem(item, llmConfig, {
						mode: session.mode,
						applierName: session.applierName,
					});
					await markDoneWithMeta(item.normalizedKey, {
						skillId: result.skillId,
						enrichmentPath: result.enrichmentPath ?? result.path,
						path: result.path,
						action: result.action,
						relationshipCount: result.relationshipCount ?? 0,
						usage: result.usage,
					});
					session.processed += 1;
					session.usage = addUsage(session.usage, result.usage);
					if (result.skillId) {
						session.updatedSkillIds.add(result.skillId);
					}
					session.relationshipsUpdated += result.relationshipCount ?? 0;
					session.lastSkill = {
						normalizedKey: item.normalizedKey,
						surfaceForm: item.surfaceForm,
						skillId: result.skillId,
						path: result.path,
					};
				} catch (err) {
					console.error('[skill-enrichment] failed', item.normalizedKey, err.message);
					await markFailed(item.normalizedKey, err);
					session.failed += 1;
				}
			});

			await syncCooccurrenceToGraph(20).catch(() => undefined);

			const stats = await countQueueStats();
			session.remaining = stats.pending;
		}
	} finally {
		session.running = false;
		session.finishedAt = new Date().toISOString();
		session.status = cancelRequested ? 'cancelled' : 'completed';
		if (cancelRequested) {
			await resetProcessingToPending();
		}
		const stats = await countQueueStats();
		session.remaining = stats.pending;
		if (session.updatedSkillIds.size > 0) {
			invalidateWorldGraphCache();
		}
	}
}

export function getEnrichmentSessionStatus() {
	if (!activeSession) {
		return { running: false, status: 'idle' };
	}
	return {
		running: activeSession.running,
		status: activeSession.status,
		sessionId: activeSession.id,
		mode: activeSession.mode,
		processed: activeSession.processed,
		failed: activeSession.failed,
		remaining: activeSession.remaining,
		nodesUpdated: activeSession.updatedSkillIds?.size ?? 0,
		relationshipsUpdated: activeSession.relationshipsUpdated ?? 0,
		updatedSkillIds: [...(activeSession.updatedSkillIds || [])].slice(-80),
		usage: activeSession.usage,
		lastSkill: activeSession.lastSkill ?? null,
		startedAt: activeSession.startedAt,
		finishedAt: activeSession.finishedAt ?? null,
		cancelled: activeSession.status === 'cancelled',
	};
}

export async function startEnrichmentSession({ applierName = null, mode = null, limit = null } = {}) {
	if (!isNeo4jReady()) throw new Error('Neo4j is not connected');
	if (!isEnrichmentEnabled()) throw new Error('Skill graph enrichment is disabled');

	if (activeSession?.running) {
		throw new Error('Enrichment session already running');
	}

	cancelRequested = false;
	const stats = await countQueueStats();
	const resolvedMode = mode === 'smart' ? 'smart' : mode === 'fast' ? 'fast' : getEnrichmentMode();

	activeSession = {
		id: randomUUID(),
		running: true,
		status: 'running',
		mode: resolvedMode,
		applierName: applierName?.trim() || null,
		limit: limit != null ? Number(limit) : null,
		processed: 0,
		failed: 0,
		remaining: stats.pending,
		usage: EMPTY_USAGE(),
		lastSkill: null,
		updatedSkillIds: new Set(),
		relationshipsUpdated: 0,
		startedAt: new Date().toISOString(),
		finishedAt: null,
	};

	void runSessionLoop(activeSession).catch((err) => {
		console.error('[skill-enrichment] session error', err);
		if (activeSession) {
			activeSession.running = false;
			activeSession.status = 'failed';
			activeSession.error = err.message;
		}
	});

	return {
		sessionId: activeSession.id,
		mode: activeSession.mode,
		pending: stats.pending,
	};
}

export function stopEnrichmentSession() {
	if (!activeSession?.running) {
		return { stopped: false, message: 'No active session' };
	}
	cancelRequested = true;
	return { stopped: true, sessionId: activeSession.id };
}

export async function runEnrichmentBatch(batchSize = 3) {
	return startEnrichmentSession({ limit: batchSize });
}

export { enrichSkillList, processEnrichmentItem } from './processSkill.js';
