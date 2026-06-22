import { ObjectId } from 'mongodb';
import { jobsCollection } from '../../db/mongo.js';
import { isNeo4jReady } from '../../db/neo4j.js';
import { normalizeSkillKey, normalizeSurfaceForm } from '../skillGraph/normalize.js';
import { enrichSkillList, getGraphCounts } from '../skillEnrichment/processSkill.js';
import { recordCooccurrenceForJob, retryCooccurrenceForKey } from '../skillCooccurrence/index.js';
import { attachStaticScoreFields } from '../jobListPipeline.js';
import { upsertJobEmbeddingAsync } from '../embeddings/embeddingIngest.js';
import {
	resolveLlmConfig,
	isEnrichmentEnabled,
	getWorkerIntervalMs,
	getJobAnalysisBatchSize,
} from '../skillEnrichment/config.js';
import { summarizeEnrichmentResults, traceJobAnalysis } from '../skillEnrichment/trace.js';
import { formatCostUsd, formatUsageSummary } from '../llm/llmService.js';

const TERMINAL = new Set(['analyzed']);

export async function queueJobAnalysis(jobId, applierName) {
	if (!jobsCollection) throw new Error('Database not ready');

	let objectId;
	try {
		objectId = new ObjectId(jobId);
	} catch {
		throw new Error('Invalid job id');
	}

	const job = await jobsCollection.findOne({ _id: objectId });
	if (!job) throw new Error('Job not found');

	if (TERMINAL.has(job.skillAnalysis?.status)) {
		return { status: 'analyzed', alreadyAnalyzed: true, jobId: String(objectId) };
	}

	if (job.skillAnalysis?.status === 'queued' || job.skillAnalysis?.status === 'analyzing') {
		return { status: job.skillAnalysis.status, jobId: String(objectId) };
	}

	const now = new Date().toISOString();
	await jobsCollection.updateOne(
		{ _id: objectId },
		{
			$set: {
				skillAnalysis: {
					status: 'queued',
					queuedAt: now,
					applierName: applierName?.trim() || null,
					error: null,
				},
			},
		},
	);

	return { status: 'queued', jobId: String(objectId), queuedAt: now };
}

export async function getJobAnalysisStatus(jobId) {
	if (!jobsCollection) throw new Error('Database not ready');

	let objectId;
	try {
		objectId = new ObjectId(jobId);
	} catch {
		throw new Error('Invalid job id');
	}

	const job = await jobsCollection.findOne(
		{ _id: objectId },
		{ projection: { skillAnalysis: 1, skills: 1 } },
	);
	if (!job) throw new Error('Job not found');

	return {
		jobId: String(objectId),
		skillAnalysis: job.skillAnalysis || { status: 'pending' },
		skills: job.skills || [],
	};
}

async function claimQueuedJobs(limit = 2) {
	if (!jobsCollection) return [];

	const now = new Date().toISOString();
	const queued = await jobsCollection
		.find({ 'skillAnalysis.status': 'queued' })
		.sort({ 'skillAnalysis.queuedAt': 1 })
		.limit(limit)
		.toArray();

	const claimed = [];
	for (const job of queued) {
		const r = await jobsCollection.findOneAndUpdate(
			{ _id: job._id, 'skillAnalysis.status': 'queued' },
			{ $set: { 'skillAnalysis.status': 'analyzing', 'skillAnalysis.startedAt': now } },
			{ returnDocument: 'after' },
		);
		if (r) claimed.push(r);
	}
	return claimed;
}

async function runJobAnalysis(job) {
	const skills = Array.isArray(job.skills) ? job.skills.map(s => String(s).trim()).filter(Boolean) : [];
	const applierName = job.skillAnalysis?.applierName || null;
	const jobId = String(job._id);

	traceJobAnalysis('start', {
		jobId,
		title: job.title,
		applierName,
		skillCount: skills.length,
		skills,
		note: 'Enrichment uses job.skills[] only — description is not sent to LLM',
	});

	const llmConfig = await resolveLlmConfig(applierName);

	if (!isNeo4jReady()) {
		throw new Error('Neo4j is not connected');
	}

	if (!llmConfig?.apiKey && isEnrichmentEnabled()) {
		throw new Error('No DeepSeek API key in account_info.autoBidProfile.deepseekApiKey');
	}

	let enrichmentResults = [];
	let llmUsage = null;
	let coocStats = { pairsUpdated: 0, usedWithCreated: 0 };

	if (skills.length) {
		const enriched = await enrichSkillList(skills, llmConfig, { jobId });
		enrichmentResults = enriched.results;
		llmUsage = enriched.usage;
		coocStats = await recordCooccurrenceForJob(skills, { jobId });
		for (const r of enrichmentResults) {
			if (r.normalizedKey) {
				await retryCooccurrenceForKey(r.normalizedKey).catch(() => undefined);
			}
		}
	}

	const staticScores = attachStaticScoreFields({ ...job, skills });
	const graphCounts = await getGraphCounts();
	const now = new Date().toISOString();

	summarizeEnrichmentResults(jobId, job.title, skills, enrichmentResults, coocStats, llmUsage);
	traceJobAnalysis('graph_snapshot', { jobId, graphCounts });
	if (llmUsage) {
		traceJobAnalysis('llm_cost', {
			jobId,
			model: llmUsage.model,
			inputTokens: llmUsage.inputTokens,
			outputTokens: llmUsage.outputTokens,
			totalTokens: llmUsage.totalTokens,
			costUsd: llmUsage.cost,
			costFormatted: formatCostUsd(llmUsage.cost),
			summary: formatUsageSummary(llmUsage),
			pricingNote: 'deepseek-v4-flash: $0.09/1M input · $0.18/1M output',
		});
	}

	await jobsCollection.updateOne(
		{ _id: job._id },
		{
			$set: {
				...staticScores,
				skillAnalysis: {
					status: 'analyzed',
					provider: 'deepseek',
					model: llmConfig?.model || 'deepseek-v4-flash',
					applierName: applierName || null,
					queuedAt: job.skillAnalysis?.queuedAt || now,
					startedAt: job.skillAnalysis?.startedAt || now,
					analyzedAt: now,
					skillsProcessed: enrichmentResults.length,
					enrichmentResults: enrichmentResults.map(r => ({
						surfaceForm: r.surfaceForm,
						normalizedKey: r.normalizedKey,
						skillId: r.skillId,
						path: r.path,
						action: r.action,
						relationshipCount: r.relationshipCount ?? 0,
					})),
					graphSnapshot: graphCounts,
					usage: llmUsage
						? {
							model: llmUsage.model,
							inputTokens: llmUsage.inputTokens,
							cachedTokens: llmUsage.cachedTokens,
							outputTokens: llmUsage.outputTokens,
							totalTokens: llmUsage.totalTokens,
							cost: llmUsage.cost,
							savings: llmUsage.savings,
						}
						: null,
					error: null,
				},
			},
		},
	);

	traceJobAnalysis('complete', {
		jobId,
		skillsEnriched: enrichmentResults.length,
		llmCost: formatCostUsd(llmUsage?.cost),
	});

	upsertJobEmbeddingAsync(jobId, { applierName });

	return {
		skillsProcessed: enrichmentResults.length,
		enrichmentResults,
		usage: llmUsage,
		provider: 'deepseek',
		model: llmConfig?.model,
	};
}

async function markJobAnalysisFailed(jobId, error) {
	if (!jobsCollection) return;
	await jobsCollection.updateOne(
		{ _id: jobId },
		{
			$set: {
				'skillAnalysis.status': 'failed',
				'skillAnalysis.error': String(error?.message || error).slice(0, 500),
				'skillAnalysis.failedAt': new Date().toISOString(),
			},
		},
	);
}

export async function runJobAnalysisBatch(batchSize = 2) {
	if (!isEnrichmentEnabled() || !jobsCollection) return { processed: 0 };

	const batch = await claimQueuedJobs(batchSize);
	let processed = 0;

		for (const job of batch) {
		try {
			const result = await runJobAnalysis(job);
			processed += 1;
			console.log(
				`[job-analysis] analyzed job ${job._id} (${job.title || 'untitled'}) — `
				+ `${result.skillsProcessed} skill(s) enriched`
				+ (result.usage?.cost != null ? `, AI cost=${formatCostUsd(result.usage.cost)} (${formatUsageSummary(result.usage)})` : ''),
			);
		} catch (err) {
			console.error(`[job-analysis] failed job ${job._id}`, err.message);
			await markJobAnalysisFailed(job._id, err);
		}
	}

	return { processed };
}

let workerTimer = null;

export function startJobAnalysisWorker() {
	if (workerTimer) return;
	const intervalMs = getWorkerIntervalMs();
	const batchSize = getJobAnalysisBatchSize();

	const tick = async () => {
		try {
			await runJobAnalysisBatch(batchSize);
		} catch (err) {
			console.error('[job-analysis] worker tick error', err.message);
		}
	};

	workerTimer = setInterval(tick, intervalMs);
	void tick();
	console.log(`[job-analysis] worker started (interval ${intervalMs}ms, batch ${batchSize})`);
}

export function stopJobAnalysisWorker() {
	if (workerTimer) {
		clearInterval(workerTimer);
		workerTimer = null;
	}
}
