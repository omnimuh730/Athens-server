import { ObjectId } from 'mongodb';
import { jobsCollection } from '../../db/mongo.js';
import { attachStaticScoreFields } from '../jobListPipeline.js';
import { upsertJobEmbeddingAsync } from '../embeddings/embeddingIngest.js';
import { normalizeJobSkills, indexJobInRedis } from '../matching/skillIndex.js';

const TERMINAL = new Set(['analyzed']);
const WORKER_INTERVAL_MS = Number(process.env.SKILL_JOB_ANALYSIS_INTERVAL_MS || 5000);
const BATCH_SIZE = Number(process.env.SKILL_JOB_ANALYSIS_BATCH_SIZE || 2);

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
		{ projection: { skillAnalysis: 1, skills: 1, skillsNormalized: 1 } },
	);
	if (!job) throw new Error('Job not found');

	return {
		jobId: String(objectId),
		skillAnalysis: job.skillAnalysis || { status: 'pending' },
		skills: job.skills || [],
		skillsNormalized: job.skillsNormalized || [],
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
	const skills = Array.isArray(job.skills) ? job.skills.map((s) => String(s).trim()).filter(Boolean) : [];
	const applierName = job.skillAnalysis?.applierName || null;
	const jobId = String(job._id);
	const skillsNormalized = normalizeJobSkills(skills);
	const staticScores = attachStaticScoreFields({ ...job, skills, skillsNormalized });
	const now = new Date().toISOString();

	await jobsCollection.updateOne(
		{ _id: job._id },
		{
			$set: {
				...staticScores,
				skillsNormalized,
				skillAnalysis: {
					status: 'analyzed',
					applierName: applierName || null,
					queuedAt: job.skillAnalysis?.queuedAt || now,
					startedAt: job.skillAnalysis?.startedAt || now,
					analyzedAt: now,
					skillsProcessed: skillsNormalized.length,
					error: null,
				},
			},
		},
	);

	await indexJobInRedis(jobId, skillsNormalized).catch(() => {});
	upsertJobEmbeddingAsync(jobId, { applierName });

	return { skillsProcessed: skillsNormalized.length };
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
	if (!jobsCollection) return { processed: 0 };

	const batch = await claimQueuedJobs(batchSize);
	let processed = 0;

	for (const job of batch) {
		try {
			const result = await runJobAnalysis(job);
			processed += 1;
			console.log(
				`[job-analysis] analyzed job ${job._id} (${job.title || 'untitled'}) — ${result.skillsProcessed} skill(s)`,
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

	const tick = async () => {
		try {
			await runJobAnalysisBatch(BATCH_SIZE);
		} catch (err) {
			console.error('[job-analysis] worker tick error', err.message);
		}
	};

	workerTimer = setInterval(tick, WORKER_INTERVAL_MS);
	void tick();
	console.log(`[job-analysis] worker started (interval ${WORKER_INTERVAL_MS}ms, batch ${BATCH_SIZE})`);
}

export function stopJobAnalysisWorker() {
	if (workerTimer) {
		clearInterval(workerTimer);
		workerTimer = null;
	}
}
