import {
	getJobListScoreWeights,
	getMatchScoreWeights,
} from '../../config/graphAndVectorConfig.js';
import {
	applicantScoreFromJob,
	salaryScoreFromJob,
} from '../jobListPipeline.js';

function clampScore(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}

function freshnessScoreFromJob(job) {
	const postedRaw = job?.postedAt || job?._createdAt;
	if (!postedRaw) return 50;
	const postedMs = new Date(postedRaw).getTime();
	if (Number.isNaN(postedMs)) return 50;
	const ageDays = Math.max(0, (Date.now() - postedMs) / 86400000);
	return clampScore(100 - Math.min(ageDays, 30) * 3);
}

function secondarySignalsScore(job) {
	const salary = salaryScoreFromJob(job);
	const applicant = applicantScoreFromJob(job);
	const freshness = freshnessScoreFromJob(job);
	const secondaryWeights = getMatchScoreWeights();

	if (salary === null) {
		return clampScore(
			applicant * secondaryWeights.secondaryNoSalaryApplicant
				+ freshness * secondaryWeights.secondaryNoSalaryFreshness,
		);
	}
	return clampScore(
		salary * secondaryWeights.secondaryWithSalarySalary
			+ applicant * secondaryWeights.secondaryWithSalaryApplicant
			+ freshness * secondaryWeights.secondaryWithSalaryFreshness,
	);
}

/**
 * Compose final match and overall scores for a job.
 */
export function composeJobScores(job, { vectorScore = 0, graphBoost = 0 } = {}) {
	const matchWeights = getMatchScoreWeights();
	const scoreWeights = getJobListScoreWeights();
	const secondary = secondarySignalsScore(job);
	const matchScore = clampScore(
		vectorScore * matchWeights.vector
			+ graphBoost * matchWeights.graph
			+ secondary * matchWeights.secondary,
	);

	const scoreSkill = matchScore;
	const scoreSalary = salaryScoreFromJob(job);
	const scoreApplicant = applicantScoreFromJob(job);
	const scoreFreshness = freshnessScoreFromJob(job);

	let scoreOverall;
	if (scoreSalary === null) {
		const base = scoreSkill * scoreWeights.skill
			+ scoreApplicant * scoreWeights.applicant
			+ scoreFreshness * scoreWeights.freshness;
		scoreOverall = clampScore(base / (1 - scoreWeights.salary));
	} else {
		scoreOverall = clampScore(
			scoreSkill * scoreWeights.skill
			+ scoreApplicant * scoreWeights.applicant
			+ scoreFreshness * scoreWeights.freshness
			+ scoreSalary * scoreWeights.salary,
		);
	}

	return {
		matchScore,
		scoreSkill,
		scoreSalary,
		scoreApplicant,
		scoreFreshness,
		scoreOverall,
		vectorScore,
		graphBoost,
		_score: scoreOverall,
	};
}

export function applyScoreFilters(scoredJobs, scoreFilters) {
	if (!scoreFilters || !Object.keys(scoreFilters).length) return scoredJobs;

	const fieldMap = {
		overallScore: 'scoreOverall',
		skillMatch: 'scoreSkill',
		salaryScore: 'scoreSalary',
		applicantScore: 'scoreApplicant',
		postedDateScore: 'scoreFreshness',
	};

	return scoredJobs.filter((job) => {
		for (const [scoreKey, bounds] of Object.entries(scoreFilters)) {
			const field = fieldMap[scoreKey];
			if (!field) continue;
			const val = job[field];
			if (val === null || val === undefined) continue;
			if (bounds.min !== null && val < bounds.min) return false;
			if (bounds.max !== null && val > bounds.max) return false;
		}
		return true;
	});
}
