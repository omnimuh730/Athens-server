import { inferJobSource, SOURCE_MAP_VERSION } from '../config/jobSources.js';

/** Weights for list sort/filter aggregation (skill match is computed per-request for recommended sort). */
export const SCORE_WEIGHTS = {
	skill: 0.45,
	applicant: 0.2,
	freshness: 0.2,
	salary: 0.15,
};

/** Map API / filter keys to aggregation field names on each job doc. */
export const SCORE_FIELD_MAP = {
	overallScore: 'scoreOverall',
	skillMatch: 'scoreSkill',
	salaryScore: 'scoreSalary',
	applicantScore: 'scoreApplicant',
	postedDateScore: 'scoreFreshness',
};

function clampScore(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}

export function applicantScoreFromJob(job) {
	const count = job?.applicants?.count ?? job?.applicantCount ?? job?.estimateApplicantNumber;
	let n = typeof count === 'number' ? count : NaN;
	if (!Number.isFinite(n)) {
		const text = String(job?.applicants?.text ?? job?.applicants ?? '');
		const match = text.match(/(\d+)/);
		n = match ? Number(match[1]) : 50;
	}
	return clampScore(100 - (Math.min(n, 200) / 200) * 100);
}

export function salaryScoreFromJob(job) {
	const salary = String(job?.details?.money ?? job?.salary ?? '');
	const matches = salary.match(/(\d+(?:\.\d+)?)\s*K/gi);
	if (!matches?.length) return null;
	const high = Math.max(...matches.map((m) => Number(m.match(/\d+(?:\.\d+)?/)?.[0] ?? 0)));
	if (!Number.isFinite(high) || high <= 0) return null;
	if (high >= 200) return 100;
	if (high >= 95) return clampScore(91 + ((high - 95) / 105) * 9);
	return clampScore(91 * Math.pow(high / 95, 3));
}

/** Denormalized fields stored on ingest for list filtering/sorting. */
export function attachStaticScoreFields(job) {
	return {
		scoreSalary: salaryScoreFromJob(job),
		scoreApplicant: applicantScoreFromJob(job),
		source: inferJobSource(job.applyLink),
		sourceVersion: SOURCE_MAP_VERSION,
	};
}

/**
 * Mongo stages: derive score* fields used for filter/sort (freshness from postedAt).
 * Skill defaults to neutral 45 when not injected by the recommendation pipeline.
 */
export function scoreDerivationStages() {
	return [
		{
			$addFields: {
				scoreSkill: { $ifNull: ['$scoreSkill', 45] },
				scoreSalary: { $cond: [{ $isNumber: '$scoreSalary' }, '$scoreSalary', null] },
				scoreApplicant: { $ifNull: ['$scoreApplicant', 50] },
				scoreFreshness: {
					$let: {
						vars: {
							postedMs: {
								$convert: {
									input: { $ifNull: ['$postedAt', '$_createdAt'] },
									to: 'date',
									onError: new Date(0),
									onNull: new Date(0),
								},
							},
						},
						in: {
							$let: {
								vars: {
									ageDays: {
										$max: [
											0,
											{
												$divide: [{ $subtract: [new Date(), '$$postedMs'] }, 86400000],
											},
										],
									},
								},
								in: {
									$round: {
										$max: [
											0,
											{
												$min: [
													100,
													{
														$subtract: [
															100,
															{ $multiply: [{ $min: ['$$ageDays', 30] }, 3] },
														],
													},
												],
											},
										],
									},
								},
							},
						},
					},
				},
			},
		},
		{
			$addFields: {
				scoreOverall: {
					$round: {
						$max: [
							0,
							{
								$min: [
									100,
									{
										$let: {
											vars: {
												base: {
													$add: [
														{ $multiply: ['$scoreSkill', SCORE_WEIGHTS.skill] },
														{ $multiply: ['$scoreApplicant', SCORE_WEIGHTS.applicant] },
														{ $multiply: ['$scoreFreshness', SCORE_WEIGHTS.freshness] },
													],
												},
											},
											in: {
												$cond: [
													{ $isNumber: '$scoreSalary' },
													{ $add: ['$$base', { $multiply: ['$scoreSalary', SCORE_WEIGHTS.salary] }] },
													{ $divide: ['$$base', 1 - SCORE_WEIGHTS.salary] },
												],
											},
										},
									},
								],
							},
						],
					},
				},
			},
		},
		{
			$addFields: {
				_score: '$scoreOverall',
			},
		},
	];
}

export function buildScoreFilterStage(scoreFilters) {
	if (!scoreFilters || !Object.keys(scoreFilters).length) return null;
	const match = {};
	for (const [scoreKey, bounds] of Object.entries(scoreFilters)) {
		const field = SCORE_FIELD_MAP[scoreKey];
		if (!field) continue;
		if (bounds.min !== null) {
			match[field] = { ...(match[field] || {}), $gte: bounds.min };
		}
		if (bounds.max !== null) {
			match[field] = { ...(match[field] || {}), $lte: bounds.max };
		}
	}
	return Object.keys(match).length ? { $match: match } : null;
}

export function sortStageForApiSort(sort) {
	if (sort === 'recommended') return { scoreOverall: -1, postedAt: -1, _id: -1 };
	if (sort === 'scoreSkill_desc') return { scoreSkill: -1, postedAt: -1, _id: -1 };
	if (sort === 'score_asc') return { scoreOverall: 1, postedAt: -1, _id: -1 };
	if (sort === 'salary_desc') return { scoreSalary: -1, postedAt: -1, _id: -1 };
	if (sort === 'salary_asc') return { scoreSalary: 1, postedAt: -1, _id: -1 };
	if (sort === 'postedAt_asc') return { postedAt: 1, _id: -1 };
	return { postedAt: -1, _id: -1 };
}

export function needsScorePipeline(sort, hasScoreFilters) {
	return hasScoreFilters || ['recommended', 'scoreSkill_desc', 'score_asc', 'salary_desc', 'salary_asc'].includes(sort);
}

export async function runJobListAggregation(jobsCollection, query, { sort, skip, limit, scoreFilters }) {
	const pipeline = [
		{ $match: query },
		{ $project: { scoreSalary: 1, scoreApplicant: 1, postedAt: 1, _createdAt: 1 } },
		...scoreDerivationStages(),
	];
	const scoreFilterStage = buildScoreFilterStage(scoreFilters);
	if (scoreFilterStage) pipeline.push(scoreFilterStage);

	const sortDoc = sortStageForApiSort(sort);
	const dataPipeline = [
		{ $sort: sortDoc },
		{ $skip: skip },
		{ $limit: limit },
		{ $project: { _id: 1, _score: 1 } },
	];

	pipeline.push({
		$facet: {
			total: [{ $count: 'count' }],
			data: dataPipeline,
		},
	});

	const [result] = await jobsCollection.aggregate(pipeline).toArray();
	const total = result?.total?.[0]?.count ?? 0;
	const pageRows = result?.data ?? [];
	if (!pageRows.length) return { docs: [], total };

	const ids = pageRows.map((row) => row._id);
	const fullDocs = await jobsCollection.find({ _id: { $in: ids } }).toArray();
	const byId = new Map(fullDocs.map((doc) => [String(doc._id), doc]));
	const docs = pageRows
		.map((row) => {
			const doc = byId.get(String(row._id));
			return doc ? { ...doc, _score: row._score } : null;
		})
		.filter(Boolean);
	return { docs, total };
}
