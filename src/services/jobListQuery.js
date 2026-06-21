import { accountInfoCollection } from '../db/mongo.js';
import { JobSourceTitles } from '../config/jobSources.js';
import { buildMongoCaseInsensitiveRegexFilter, buildSafeRegExp } from '../utils/safeRegex.js';

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

export function extractScoreFilters(body) {
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

function applyStatusFilter(query, { appliedBool, status, applierId }) {
	if (appliedBool === false) {
		if (applierId) {
			query.$and.push({
				$or: [
					{ status: { $exists: false } },
					{ status: { $not: { $elemMatch: { applier: applierId } } } },
				],
			});
		} else {
			query.$and.push({ status: { $exists: false } });
		}
	} else if (appliedBool === true) {
		if (applierId) {
			if (status === 'Applied') {
				query.$and.push({
					status: {
						$elemMatch: {
							applier: applierId,
							appliedDate: { $exists: true },
							scheduledDate: { $exists: false },
							declinedDate: { $exists: false },
						},
					},
				});
			} else if (status === 'Scheduled') {
				query.$and.push({
					status: { $elemMatch: { applier: applierId, scheduledDate: { $exists: true } } },
				});
			} else if (status === 'Declined') {
				query.$and.push({
					status: { $elemMatch: { applier: applierId, declinedDate: { $exists: true } } },
				});
			} else {
				query.$and.push({ status: { $elemMatch: { applier: applierId } } });
			}
		} else {
			query.$and.push({ status: { $exists: true } });
			if (status === 'Applied') {
				query.$and.push({
					status: {
						$elemMatch: {
							appliedDate: { $exists: true },
							scheduledDate: { $exists: false },
							declinedDate: { $exists: false },
						},
					},
				});
			} else if (status === 'Scheduled') {
				query.$and.push({ status: { $elemMatch: { scheduledDate: { $exists: true } } } });
			} else if (status === 'Declined') {
				query.$and.push({ status: { $elemMatch: { declinedDate: { $exists: true } } } });
			}
		}
	}
}

function finalizeQuery(query) {
	if (query.$and.length === 1) {
		Object.assign(query, query.$and[0]);
		delete query.$and;
	} else if (query.$and.length === 0) {
		delete query.$and;
	}
	return query;
}

/**
 * Build a Mongo filter for POST /jobs/list from the request body.
 * Pass statusTab to override applied/status: all | new | applied | scheduled | declined
 */
export async function buildJobsListQuery(body, { statusTab } = {}) {
	const {
		q,
		postedAtFrom,
		jobSources,
		postedAtTo,
		applied,
		status,
		applierName,
		...filters
	} = body;

	const scoreFilters = extractScoreFilters(body);
	const hasScoreFilters = Object.keys(scoreFilters).length > 0;

	let applierId = null;
	if (applierName && accountInfoCollection) {
		const applierDoc = await accountInfoCollection.findOne({ name: applierName });
		applierId = applierDoc?._id || null;
	}

	const query = { $and: [] };

	const titleFilter = buildMongoCaseInsensitiveRegexFilter(q);
	if (titleFilter) query.$and.push({ title: titleFilter });

	for (const key in filters) {
		if (!Object.hasOwnProperty.call(filters, key)) continue;
		if (key.startsWith('$')) continue;
		const value = filters[key];
		if (!value) continue;

		if (key === 'company.tags' && typeof value === 'string') {
			const tags = value.split(',').map((s) => s.trim()).filter(Boolean);
			if (tags.length) {
				const tagRegexes = tags.map((tag) => buildSafeRegExp(tag)).filter(Boolean);
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

	const jobSourceItem = (jobSources !== undefined ? jobSources.split(',') : JobSourceTitles)
		.map((s) => s.trim())
		.filter(Boolean);
	const knownSources = JobSourceTitles.filter((s) => s !== 'Other');
	const allSourcesSelected =
		jobSourceItem.includes('Other') && knownSources.every((s) => jobSourceItem.includes(s));

	if (!allSourcesSelected) {
		query.$and.push({ source: { $in: jobSourceItem } });
	}

	let appliedBool =
		applied === true || applied === 'true'
			? true
			: applied === false || applied === 'false'
				? false
				: undefined;
	let statusFilter = status;

	if (statusTab) {
		if (statusTab === 'new') {
			appliedBool = false;
			statusFilter = undefined;
		} else if (statusTab === 'applied') {
			appliedBool = true;
			statusFilter = 'Applied';
		} else if (statusTab === 'scheduled') {
			appliedBool = true;
			statusFilter = 'Scheduled';
		} else if (statusTab === 'declined') {
			appliedBool = true;
			statusFilter = 'Declined';
		} else {
			appliedBool = undefined;
			statusFilter = undefined;
		}
	}

	applyStatusFilter(query, { appliedBool, status: statusFilter, applierId });

	if (postedAtFrom || postedAtTo) {
		const postedAtQuery = {};
		if (postedAtFrom) postedAtQuery.$gte = postedAtFrom;
		if (postedAtTo) {
			const toDate = new Date(postedAtTo);
			toDate.setDate(toDate.getDate() + 1);
			postedAtQuery.$lt = toDate.toISOString().split('T')[0];
		}
		query.$and.push({ postedAt: postedAtQuery });
	}

	finalizeQuery(query);

	return { query, applierId, scoreFilters, hasScoreFilters };
}

/** Status tab keys aligned with the Athens frontend. */
export const STATUS_TABS = ['all', 'new', 'applied', 'scheduled', 'declined'];

/** Fields omitted from list responses to reduce payload size. */
export const JOB_LIST_PROJECTION = { description: 0, jobDescription: 0 };
