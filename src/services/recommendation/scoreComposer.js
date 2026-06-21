import {
	SCORE_WEIGHTS,
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

	if (salary === null) {
		return clampScore(applicant * 0.5 + freshness * 0.5);
	}
	return clampScore(salary * 0.34 + applicant * 0.33 + freshness * 0.33);
}

/**
 * Compose final match and overall scores for a job.
 */
export function composeJobScores(job, { vectorScore = 0, graphBoost = 0 } = {}) {
	const secondary = secondarySignalsScore(job);
	const matchScore = clampScore(
		vectorScore * 0.55 + graphBoost * 0.30 + secondary * 0.15,
	);

	const scoreSkill = matchScore;
	const scoreSalary = salaryScoreFromJob(job);
	const scoreApplicant = applicantScoreFromJob(job);
	const scoreFreshness = freshnessScoreFromJob(job);

	let scoreOverall;
	if (scoreSalary === null) {
		const base = scoreSkill * SCORE_WEIGHTS.skill
			+ scoreApplicant * SCORE_WEIGHTS.applicant
			+ scoreFreshness * SCORE_WEIGHTS.freshness;
		scoreOverall = clampScore(base / (1 - SCORE_WEIGHTS.salary));
	} else {
		scoreOverall = clampScore(
			scoreSkill * SCORE_WEIGHTS.skill
			+ scoreApplicant * SCORE_WEIGHTS.applicant
			+ scoreFreshness * SCORE_WEIGHTS.freshness
			+ scoreSalary * SCORE_WEIGHTS.salary,
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
