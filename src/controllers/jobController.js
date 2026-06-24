import { ObjectId } from "mongodb";
import {
	jobsCollection,
	personalInfoCollection,
	companyCategoryCollection,
	accountInfoCollection,
	rulesCollection
} from "../db/mongo.js";
import { isJobBlocked, buildMongoQueryForRule, isMatchNoneQuery } from '../utils/ruleMatcher.js';
import { attachStaticScoreFields } from '../services/jobListPipeline.js';
import {
	buildJobsListQuery,
	STATUS_TABS,
	JOB_LIST_PROJECTION,
	JOB_DETAIL_PROJECTION,
} from '../services/jobListQuery.js';
import { queueJobAnalysis, getJobAnalysisStatus } from '../services/jobAnalysis/index.js';
import { matchJobsForApplier } from '../services/matching/matchingService.js';
import { normalizeJobSkills, indexJobInRedis } from '../services/matching/skillIndex.js';
import { upsertJobEmbeddingAsync } from '../services/embeddings/embeddingIngest.js';
import {
	getJobEmbeddingStatus,
	startJobEmbeddingSession,
	stopJobEmbeddingSession,
} from '../services/embeddings/jobEmbeddingWorker.js';
import { buildJobSkillRadar } from '../services/jobSkillRadarService.js';

const DUPLICATE_LOOKBACK_DAYS = 30;
const LOOKBACK_WINDOW_MS = DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

const toValidDate = (value) => {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
};

const resolvePostedAt = (job, now) => {
	if (job.postedAt) {
		const explicitPostedAt = toValidDate(job.postedAt);
		if (explicitPostedAt) {
			return explicitPostedAt.toISOString();
		}
	}

	let postedAtDate = new Date(now);
	if (job.postedAgo && typeof job.postedAgo === 'string') {
		const match = job.postedAgo.match(/(\d+)\s+(minute|hour|day)/);
		if (match) {
			const value = parseInt(match[1], 10);
			const unit = match[2];
			if (unit === 'minute') {
				postedAtDate.setMinutes(postedAtDate.getMinutes() - value);
			} else if (unit === 'hour') {
				postedAtDate.setHours(postedAtDate.getHours() - value);
			} else if (unit === 'day') {
				postedAtDate.setDate(postedAtDate.getDate() - value);
			}
		}
	}
	return postedAtDate.toISOString();
};

const extractJobTimestamp = (jobDoc) => {
	return toValidDate(jobDoc?.postedAt) || toValidDate(jobDoc?._createdAt) || toValidDate(jobDoc?.createdAt);
};

export async function createJob(req, res) {
	try {
		const job = req.body;
		if (!job) return res.status(400).json({ error: 'Missing job in request body' });

		// Requirement 2: if title is empty(""), not create.
		if (!job.title) {
			return res.status(400).json({ error: 'Job title cannot be empty' });
		}

		// Check if the job is blocked by any rule
		const blockingRule = await isJobBlocked(job);
		if (blockingRule) {
			console.log(`Job "${job.title}" from "${job.company?.name}" blocked by rule: "${blockingRule}"`);
			return res.status(200).json({ success: false, created: false, reason: `Blocked by rule: ${blockingRule}` });
		}

		const now = new Date();
		const createdAt = now.toISOString();
		const postedAt = resolvePostedAt(job, now);

		// Requirement 1: prevent duplicates for jobs posted within the last 30 days.
		if (job.url) {
			const existingJob = await jobsCollection.findOne(
				{ url: job.url },
				{ sort: { postedAt: -1, _createdAt: -1 } }
			);

			if (existingJob) {
				const existingTimestamp = extractJobTimestamp(existingJob);
				const newJobTimestamp = toValidDate(postedAt);

				if (!existingTimestamp || !newJobTimestamp || (newJobTimestamp.getTime() - existingTimestamp.getTime()) < LOOKBACK_WINDOW_MS) {
					return res.status(400).json({ error: 'Job with this URL has been posted recently' });
				}
			}
		}

		job._createdAt = createdAt;
		job.postedAt = postedAt;
		job.modelVersion = '1.12.8';
		// Company page URL scraped by the extension; normalize to a trimmed string
		// (default "") so the field is always present and consistent in storage.
		job.companyLink = typeof job.companyLink === 'string' ? job.companyLink.trim() : '';

		const skills = Array.isArray(job.skills) ? job.skills.map(s => String(s).trim()).filter(Boolean) : [];
		job.skillsNormalized = normalizeJobSkills(skills);
		try {
			const companyTags = Array.isArray(job.company?.tags) ? job.company.tags.map(t => String(t).trim()).filter(Boolean) : [];
			if (companyCategoryCollection && companyTags.length) {
				const ops = companyTags.map(tag => ({
					updateOne: {
						filter: { name: tag },
						update: { $setOnInsert: { name: tag, createdAt: new Date().toISOString() } },
						upsert: true,
					}
				}));
				await companyCategoryCollection.bulkWrite(ops, { ordered: false });
			}
		} catch (e) {
			console.warn('Failed to upsert company categories', e);
		}

		// MongoDB only on ingest — world graph enrichment runs from Knowledge Graph page.
		job.skillAnalysis = { status: 'pending' };
		Object.assign(job, attachStaticScoreFields({ ...job, skills }));

		const result = jobsCollection ? await jobsCollection.insertOne(job) : null;

		if (result?.insertedId) {
			upsertJobEmbeddingAsync(String(result.insertedId));
			void indexJobInRedis(String(result.insertedId), job.skillsNormalized).catch(() => {});
		}

		return res.status(201).json({
			success: true,
			created: true,
			insertedId: result ? result.insertedId : null,
			skillAnalysis: job.skillAnalysis,
		});
	} catch (err) {
		console.error('POST /api/jobs error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function getJobsForRule(req, res) {
	try {
		const { name } = req.params;
		if (!name) {
			return res.status(400).json({ error: 'Rule name is required' });
		}

		const ruleSet = await rulesCollection.findOne({ name });
		if (!ruleSet) {
			return res.status(404).json({ error: 'Rule not found' });
		}

		const query = buildMongoQueryForRule(ruleSet);

		// A query that finds nothing
		if (isMatchNoneQuery(query)) {
			return res.json({
				success: true,
				data: [],
				message: "Search for this rule is not supported due to its complexity (e.g., mixed logical operators or XOR)."
			});
		}

		const jobs = await jobsCollection.find(query).limit(100).toArray(); // Limit to 100 results for now

		res.status(200).json({ success: true, data: jobs });

	} catch (err) {
		console.error(`GET /api/jobs/rule/${req.params.name} error`, err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function removeJobsForRule(req, res) {
	try {
		if (!jobsCollection) {
			return res.status(503).json({ success: false, error: 'Database not ready' });
		}

		const { name } = req.params;
		if (!name) {
			return res.status(400).json({ success: false, error: 'Rule name is required' });
		}

		const ruleSet = await rulesCollection.findOne({ name });
		if (!ruleSet) {
			return res.status(404).json({ success: false, error: 'Rule not found' });
		}

		const query = buildMongoQueryForRule(ruleSet);
		if (isMatchNoneQuery(query)) {
			return res.status(400).json({
				success: false,
				error: 'Cannot remove jobs for this rule due to unsupported logic (e.g., mixed operators or XOR).',
			});
		}

		const result = await jobsCollection.deleteMany(query);
		return res.json({ success: true, deletedCount: result.deletedCount });
	} catch (err) {
		console.error(`DELETE /api/jobs/rule/${req.params.name} error`, err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

/** Cheap count-only path — single aggregation with $facet per status tab. */
export async function getJobStatusCounts(req, res) {
	try {
		if (!jobsCollection) {
			return res.status(503).json({ success: false, error: 'Database not ready' });
		}

		const facet = {};
		for (const tab of STATUS_TABS) {
			const { query } = await buildJobsListQuery(req.body, { statusTab: tab });
			facet[tab] = [{ $match: query }, { $count: 'count' }];
		}

		const [result] = await jobsCollection.aggregate([{ $facet: facet }]).toArray();
		const counts = {};
		for (const tab of STATUS_TABS) {
			counts[tab] = result?.[tab]?.[0]?.count ?? 0;
		}

		return res.json({
			success: true,
			counts,
		});
	} catch (err) {
		console.error('POST /api/jobs/list/counts error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function getJobs(req, res) {
	try {
		if (!jobsCollection) {
			return res.status(503).json({ success: false, error: 'Database not ready' });
		}

		const {
			sort,
			page = 1,
			limit = 10,
			skip: skipRaw,
			applierName,
			countsOnly,
		} = req.body;

		const { query, scoreFilters } = await buildJobsListQuery(req.body);

		const pageNum = Math.max(1, parseInt(page, 10) || 1);
		const limitNum = Math.max(1, Math.min(5000, parseInt(limit, 10) || 10));
		const skip =
			skipRaw !== undefined && skipRaw !== null && skipRaw !== ''
				? Math.max(0, parseInt(skipRaw, 10) || 0)
				: (pageNum - 1) * limitNum;

		if (countsOnly === true || countsOnly === 'true') {
			const total = await jobsCollection.countDocuments(query);
			return res.json({
				success: true,
				data: [],
				pagination: {
					total,
					page: pageNum,
					limit: limitNum,
					totalPages: Math.ceil(total / limitNum),
				},
			});
		}

		let docs;
		let total;
		let recommendationFallback = false;
		let recommendationReason = null;
		let catalogTotal = null;
		const useRecommendation = sort === 'recommended' && applierName;

		if (useRecommendation) {
			const result = await matchJobsForApplier({
				applierName,
				mongoQuery: query,
				scoreFilters,
				listBody: req.body,
				skip,
				limit: limitNum,
			});
			if (!result.recommendationFallback) {
				docs = result.docs;
				total = result.total;
				catalogTotal = result.catalogTotal ?? total;
			} else {
				recommendationFallback = true;
				recommendationReason = result.reason || 'unknown';
				const sortOption = { postedAt: -1, _id: -1 };
				[docs, total] = await Promise.all([
					jobsCollection
						.find(query, { projection: JOB_LIST_PROJECTION })
						.sort(sortOption)
						.skip(skip)
						.limit(limitNum)
						.toArray(),
					jobsCollection.countDocuments(query),
				]);
			}
		} else {
			const sortOption = {};
			if (sort && typeof sort === 'string') {
				let sortField = '', sortOrder;
				[sortField, sortOrder] = sort.split('_');
				if (sortField === 'postedAt') {
					sortOption.postedAt = sortOrder === 'asc' ? 1 : -1;
				} else if (sortField && sortField.trim().length > 0) {
					sortOption[sortField] = sortOrder === 'desc' ? -1 : 1;
				} else {
					sortOption.postedAt = -1;
				}
			} else {
				sortOption.postedAt = -1;
			}
			[docs, total] = await Promise.all([
				jobsCollection
					.find(query, { projection: JOB_LIST_PROJECTION })
					.sort(sortOption)
					.skip(skip)
					.limit(limitNum)
					.toArray(),
				jobsCollection.countDocuments(query),
			]);
		}

		return res.json({
			success: true,
			data: docs,
			recommendationFallback,
			recommendationReason,
			catalogTotal,
			pagination: {
				total,
				page: pageNum,
				limit: limitNum,
				totalPages: Math.ceil(total / limitNum),
			}
		});

	} catch (err) {
		console.error('GET /api/jobs error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function applyToJob(req, res) {
	try {
		if (!jobsCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const { id } = req.params;
		const { applierName = 'Jeffrey Yuan' } = req.body;

		let objectId;
		try {
			objectId = new ObjectId(id);
		} catch {
			return res.status(400).json({ success: false, error: 'Invalid id' });
		}

		const applier = await accountInfoCollection.findOne({ name: applierName });
		if (!applier) {
			return res.status(404).json({ success: false, error: `User ${applierName} not found` });
		}

		const existingApplication = await jobsCollection.findOne({ _id: objectId, "status.applier": applier._id });

		if (existingApplication) {
			return res.json({ success: true, data: existingApplication, message: "User has already applied" });
		}

		const now = new Date().toISOString();
		const newApplication = {
			applier: applier._id,
			appliedDate: now
		};

		const update = {
			$push: {
				status: newApplication
			}
		};

		await jobsCollection.updateOne({ _id: objectId }, update);
		const updatedJob = await jobsCollection.findOne({ _id: objectId });

		return res.json({ success: true, data: updatedJob });
	} catch (err) {
		console.error('POST /api/jobs/:id/apply error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function updateJobStatus(req, res) {
	try {
		if (!jobsCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const { id } = req.params;
		const { status, applierName = 'Jeffrey Yuan' } = req.body;

		let objectId;
		try {
			objectId = new ObjectId(id);
		} catch {
			return res.status(400).json({ success: false, error: 'Invalid id' });
		}

		const applier = await accountInfoCollection.findOne({ name: applierName });
		if (!applier) {
			return res.status(404).json({ success: false, error: `User ${applierName} not found` });
		}

		const now = new Date().toISOString();
		let update;

		if (status === 'Declined') {
			update = {
				$set: { 'status.$[elem].declinedDate': now },
				$unset: { 'status.$[elem].scheduledDate': "" }
			};
		} else if (status === 'Scheduled') {
			update = {
				$set: { 'status.$[elem].scheduledDate': now },
				$unset: { 'status.$[elem].declinedDate': "" }
			};
		} else if (status === 'Applied') { // This is our "Cancel" action
			update = {
				$unset: {
					'status.$[elem].declinedDate': "",
					'status.$[elem].scheduledDate': ""
				}
			};
		} else {
			return res.status(400).json({ success: false, error: 'Invalid status' });
		}

		const options = {
			arrayFilters: [{ "elem.applier": applier._id }]
		};

		await jobsCollection.updateOne({ _id: objectId }, update, options);
		const updatedJob = await jobsCollection.findOne({ _id: objectId });

		return res.json({ success: true, data: updatedJob });
	} catch (err) {
		console.error('POST /api/jobs/:id/status error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function removeJobs(req, res) {
	try {
		if (!jobsCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const { ids } = req.body;
		if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'Missing ids array' });

		const objectIds = ids.map(id => {
			try {
				return new ObjectId(id);
			} catch {
				return null;
			}
		}).filter(Boolean);

		const result = await jobsCollection.deleteMany({ _id: { $in: objectIds } });
		return res.json({ success: true, deletedCount: result.deletedCount });
	} catch (err) {
		console.error('POST /api/jobs/remove error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function unapplyFromJob(req, res) {
	try {
		if (!jobsCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const { id } = req.params;
		const { applierName = 'Jeffrey Yuan' } = req.body;

		let objectId;
		try {
			objectId = new ObjectId(id);
		} catch {
			return res.status(400).json({ success: false, error: 'Invalid id' });
		}

		const applier = await accountInfoCollection.findOne({ name: applierName });
		if (!applier) {
			return res.status(404).json({ success: false, error: `User ${applierName} not found` });
		}

		const update = {
			$pull: { status: { applier: applier._id } }
		};

		await jobsCollection.updateOne({ _id: objectId }, update);
		const updatedJob = await jobsCollection.findOne({ _id: objectId });

		return res.json({ success: true, data: updatedJob });
	} catch (err) {
		console.error('POST /api/jobs/:id/unapply error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

/** Queue skill graph + LLM analysis for a job (Neo4j writes happen in background worker). */
export async function analyzeJob(req, res) {
	try {
		if (!jobsCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const { id } = req.params;
		const applierName = req.body?.applierName || null;

		const result = await queueJobAnalysis(id, applierName);
		const statusCode = result.alreadyAnalyzed ? 200 : 202;
		return res.status(statusCode).json({ success: true, ...result });
	} catch (err) {
		const status = err.message === 'Job not found' ? 404 : err.message === 'Invalid job id' ? 400 : 500;
		console.error('POST /api/jobs/:id/analyze error', err);
		return res.status(status).json({ success: false, error: err.message });
	}
}

/** Full job document for View JD (description, skills, etc.). */
export async function getJobById(req, res) {
	try {
		if (!jobsCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const { id } = req.params;
		if (!id || !ObjectId.isValid(id)) {
			return res.status(400).json({ success: false, error: 'Invalid job id' });
		}
		const doc = await jobsCollection.findOne(
			{ _id: new ObjectId(id) },
			{ projection: JOB_DETAIL_PROJECTION },
		);
		if (!doc) return res.status(404).json({ success: false, error: 'Job not found' });
		return res.json({ success: true, data: doc });
	} catch (err) {
		console.error(`GET /api/jobs/${req.params.id} error`, err);
		return res.status(500).json({ success: false, error: 'Failed to fetch job' });
	}
}

/** Skill-match radar data for job vs user resume graph. */
export async function getJobSkillRadar(req, res) {
	try {
		const { id } = req.params;
		const applierName = String(req.query.applierName || '').trim();
		const resumeId = req.query.resumeId ? String(req.query.resumeId) : undefined;
		const recommendedResumeId = req.query.recommendedResumeId
			? String(req.query.recommendedResumeId)
			: undefined;
		const recommendedTechStack = req.query.recommendedTechStack
			? String(req.query.recommendedTechStack)
			: undefined;
		const rankOnly = req.query.rankOnly === 'true' || req.query.rankOnly === '1';

		if (!applierName) {
			return res.status(400).json({ success: false, error: 'applierName query required' });
		}

		const data = await buildJobSkillRadar({
			jobId: id,
			applierName,
			resumeId,
			recommendedResumeId,
			recommendedTechStack,
			rankOnly,
		});
		return res.json({ success: true, ...data });
	} catch (err) {
		const status = err.message === 'Job not found'
			? 404
			: err.message === 'Invalid job id' || err.message === 'applierName is required'
				? 400
				: 500;
		console.error(`GET /api/jobs/${req.params.id}/skill-radar error`, err);
		return res.status(status).json({ success: false, error: err.message });
	}
}

/** Count jobs missing embeddings + optional active backfill session. */
export async function getJobEmbeddingsStatus(req, res) {
	try {
		if (!jobsCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const status = await getJobEmbeddingStatus();
		return res.json({ success: true, ...status });
	} catch (err) {
		console.error('GET /api/jobs/embeddings/status error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

/** Embed all jobs that are not yet indexed in Qdrant. */
export async function startJobEmbeddings(req, res) {
	try {
		if (!jobsCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const limit = req.body?.limit;
		const result = await startJobEmbeddingSession({ limit });
		const statusCode = result.started ? 202 : 200;
		return res.status(statusCode).json({ success: true, ...result });
	} catch (err) {
		const status = err.message.includes('already running') ? 409 : 503;
		console.error('POST /api/jobs/embeddings/start error', err);
		return res.status(status).json({ success: false, error: err.message });
	}
}

/** Stop an in-progress job embedding session. */
export async function stopJobEmbeddings(req, res) {
	try {
		const result = stopJobEmbeddingSession();
		return res.json({ success: true, ...result });
	} catch (err) {
		console.error('POST /api/jobs/embeddings/stop error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

/** Poll skill analysis status for a job. */
export async function getJobSkillAnalysis(req, res) {
	try {
		if (!jobsCollection) return res.status(503).json({ success: false, error: 'Database not ready' });
		const { id } = req.params;
		const result = await getJobAnalysisStatus(id);
		return res.json({ success: true, ...result });
	} catch (err) {
		const status = err.message === 'Job not found' ? 404 : err.message === 'Invalid job id' ? 400 : 500;
		return res.status(status).json({ success: false, error: err.message });
	}
}
