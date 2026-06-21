import { ObjectId } from "mongodb";
import {
	jobsCollection,
	personalInfoCollection,
	companyCategoryCollection,
	accountInfoCollection,
	rulesCollection
} from "../db/mongo.js";
import { JobSourceTitles } from '../../../configs/pub.js';
import { isJobBlocked, buildMongoQueryForRule, isMatchNoneQuery } from '../utils/ruleMatcher.js';
import { computeSkillScoreValue, refreshSkillScoresForSkills, SKILL_SCORE_VERSION } from '../services/skillScoreService.js';
import { ingestJobSkills } from '../services/skillEnrichment/worker.js';
import { buildMongoCaseInsensitiveRegexFilter, buildSafeRegExp } from '../utils/safeRegex.js';
import { attachStaticScoreFields, needsScorePipeline, runJobListAggregation } from '../services/jobListPipeline.js';

const SCORE_DIMENSIONS = {
	overall: 'overallScore',
	skill: 'skillMatch',
	salary: 'salaryScore',
	bidEst: 'applicantScore',
	freshness: 'postedDateScore',
};

function parseScoreBound(value) {
	if (value === undefined || value === null || value === '') return null;
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	return Math.max(0, Math.min(100, Math.round(n)));
}

function extractScoreFilters(body) {
	const result = {};
	for (const [dim, scoreKey] of Object.entries(SCORE_DIMENSIONS)) {
		const cap = dim.charAt(0).toUpperCase() + dim.slice(1);
		const min = parseScoreBound(body[`score${cap}Min`]);
		const max = parseScoreBound(body[`score${cap}Max`]);
		if (min !== null || max !== null) {
			result[scoreKey] = { min, max };
		}
	}
	return result;
}

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

			if (skills.length) {
				await ingestJobSkills(skills);
			}
		} catch (e) {
			console.warn('Failed to ingest job skills into graph pipeline', e);
		}

		job.skillScore = await computeSkillScoreValue(skills);
		job.skillScoreVersion = SKILL_SCORE_VERSION;
		Object.assign(job, attachStaticScoreFields({ ...job, skills }));

		const result = jobsCollection ? await jobsCollection.insertOne(job) : null;

		if (skills.length) {
			refreshSkillScoresForSkills(skills).catch(err => console.error('Failed to refresh skill scores', err));
		}

		return res.status(201).json({ success: true, created: true, insertedId: result ? result.insertedId : null });
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

export async function getJobs(req, res) {
	try {
		if (!jobsCollection) {
			return res.status(503).json({ success: false, error: 'Database not ready' });
		}

		const {
			q,
			sort,
			page = 1,
			limit = 10,
			skip: skipRaw,
			scoreOverallMin,
			scoreOverallMax,
			scoreSkillMin,
			scoreSkillMax,
			scoreSalaryMin,
			scoreSalaryMax,
			scoreBidEstMin,
			scoreBidEstMax,
			scoreFreshnessMin,
			scoreFreshnessMax,
			showLinkedInOnly = 'true',
			postedAtFrom,
			jobSources,
			postedAtTo,
			applied,
			status,
			applierName,
			...filters
		} = req.body;

		const scoreFilters = extractScoreFilters({
			scoreOverallMin,
			scoreOverallMax,
			scoreSkillMin,
			scoreSkillMax,
			scoreSalaryMin,
			scoreSalaryMax,
			scoreBidEstMin,
			scoreBidEstMax,
			scoreFreshnessMin,
			scoreFreshnessMax,
		});
		const hasScoreFilters = Object.keys(scoreFilters).length > 0;

		// Resolve applier (optional)
		let applierId = null;
		if (applierName && accountInfoCollection) {
			const applierDoc = await accountInfoCollection.findOne({ name: applierName });
			applierId = applierDoc?._id || null;
		}
		const query = { $and: [] };

		const titleFilter = buildMongoCaseInsensitiveRegexFilter(q);
		if (titleFilter) query.$and.push({ title: titleFilter });

		for (const key in filters) {
			if (Object.hasOwnProperty.call(filters, key)) {
				if (key.startsWith('$')) continue;
				const value = filters[key];
				if (!value) continue;

				if (key === 'company.tags' && typeof value === 'string') {
					const tags = value.split(',').map(s => s.trim()).filter(Boolean);
					if (tags.length) {
						const tagRegexes = tags.map(tag => buildSafeRegExp(tag)).filter(Boolean);
						if (tagRegexes.length) {
							query.$and.push({ [key]: { $all: tagRegexes } });
						}
					}
				} else if (key === 'details.remote' || key === 'details.time') {
					query.$and.push({ [key]: value });
				} else if (typeof value === 'string') {
					const filter = buildMongoCaseInsensitiveRegexFilter(value);
					if (filter) query.$and.push({ [key]: filter });
				}
			}
		}

		// Job source: match the denormalized `source` field (set at insert / backfill
		// from the apply-link hostname) — indexed equality instead of per-doc regexes.
		// Omitted `jobSources` means "all sources" (no filter), not "none".
		const jobSourceItem = (jobSources !== undefined ? jobSources.split(',') : JobSourceTitles)
			.map((s) => s.trim())
			.filter(Boolean);
		const knownSources = JobSourceTitles.filter((s) => s !== 'Other');
		const allSourcesSelected =
		jobSourceItem.includes('Other') && knownSources.every((s) => jobSourceItem.includes(s));

		// When every source (including Other) is selected the filter is a tautology — skip it.
		if (!allSourcesSelected) {
			query.$and.push({ source: { $in: jobSourceItem } });
		}

		// Normalize boolean-like flags that may arrive as booleans or strings
		const appliedBool = applied === true || applied === 'true'
			? true
			: applied === false || applied === 'false'
				? false
				: undefined;

		if (appliedBool === false) {
			// Posted: no status entry for this applier
			if (applierId) {
				query.$and.push({ $or: [{ status: { $exists: false } }, { status: { $not: { $elemMatch: { applier: applierId } } } }] });
			} else {
				// Without applier, fallback to no status at all
				query.$and.push({ status: { $exists: false } });
			}
		} else if (appliedBool === true) {
			// Applied filters for this applier
			if (applierId) {
				if (status === 'Applied') {
					query.$and.push({ status: { $elemMatch: { applier: applierId, appliedDate: { $exists: true }, scheduledDate: { $exists: false }, declinedDate: { $exists: false } } } });
				} else if (status === 'Scheduled') {
					query.$and.push({ status: { $elemMatch: { applier: applierId, scheduledDate: { $exists: true } } } });
				} else if (status === 'Declined') {
					query.$and.push({ status: { $elemMatch: { applier: applierId, declinedDate: { $exists: true } } } });
				} else {
					query.$and.push({ status: { $elemMatch: { applier: applierId } } });
				}
			} else {
				// No applier specified: keep previous behavior
				query.$and.push({ status: { $exists: true } });
				if (status === 'Applied') {
					query.$and.push({ status: { $elemMatch: { appliedDate: { $exists: true }, scheduledDate: { $exists: false }, declinedDate: { $exists: false } } } });
				} else if (status === 'Scheduled') {
					query.$and.push({ status: { $elemMatch: { scheduledDate: { $exists: true } } } });
				} else if (status === 'Declined') {
					query.$and.push({ status: { $elemMatch: { declinedDate: { $exists: true } } } });
				}
			}
		}

		if (postedAtFrom || postedAtTo) {
			const postedAtQuery = {};
			if (postedAtFrom) {
				postedAtQuery.$gte = postedAtFrom;
			}
			if (postedAtTo) {
				const toDate = new Date(postedAtTo);
				toDate.setDate(toDate.getDate() + 1);
				postedAtQuery.$lt = toDate.toISOString().split('T')[0];
			}
			query.$and.push({ postedAt: postedAtQuery });
		}

		if (query.$and.length === 1) {
			Object.assign(query, query.$and[0]);
			delete query.$and;
		} else if (query.$and.length === 0) {
			delete query.$and;
		}

		const pageNum = Math.max(1, parseInt(page, 10) || 1);
		const limitNum = Math.max(1, Math.min(5000, parseInt(limit, 10) || 10));
		const skip =
			skipRaw !== undefined && skipRaw !== null && skipRaw !== ''
				? Math.max(0, parseInt(skipRaw, 10) || 0)
				: (pageNum - 1) * limitNum;

		let docs;
		let total;
		const useScorePipeline = needsScorePipeline(sort, hasScoreFilters);

		if (useScorePipeline) {
			// Aggregation computes the total in its $facet — no separate countDocuments needed.
			const result = await runJobListAggregation(jobsCollection, query, {
				sort,
				skip,
				limit: limitNum,
				scoreFilters,
			});
			docs = result.docs;
			total = result.total;
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
				jobsCollection.find(query).sort(sortOption).skip(skip).limit(limitNum).toArray(),
				jobsCollection.countDocuments(query),
			]);
		}

		return res.json({
			success: true,
			data: docs,
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
