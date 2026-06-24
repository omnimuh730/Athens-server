import { normalizeSkillSet } from '../../../../packages/shared/src/skill-normalize.js';
import { clampScore } from '../../../../packages/shared/src/score.js';

export { clampScore };

/**
 * Asymmetric containment: |job ∩ profile| / |job|.
 * Profile extras never dilute the score.
 *
 * @param {string[]|Set<string>} jobSkills - canonical job skills
 * @param {string[]|Set<string>} profileSkills - canonical profile skills
 * @returns {{ matchScore: number, covered: string[], missing: string[], required: number }}
 */
export function computeCoverageScore(jobSkills, profileSkills) {
  const jobSet = jobSkills instanceof Set ? jobSkills : normalizeSkillSet(jobSkills);
  const profileSet = profileSkills instanceof Set ? profileSkills : normalizeSkillSet(profileSkills);

  const required = jobSet.size;
  if (required === 0) {
    return { matchScore: 0, covered: [], missing: [], required: 0 };
  }

  const covered = [];
  const missing = [];
  for (const skill of jobSet) {
    if (profileSet.has(skill)) covered.push(skill);
    else missing.push(skill);
  }

  const matchScore = clampScore((covered.length / required) * 100);
  return { matchScore, covered, missing, required };
}

/**
 * Compose list-time job scores from coverage result.
 */
export function composeJobScores(_job, coverage) {
  const matchScore = clampScore(coverage?.matchScore ?? 0);
  return {
    matchScore,
    scoreSkill: matchScore,
    scoreOverall: matchScore,
    skillsCovered: coverage?.covered?.length ?? 0,
    skillsRequired: coverage?.required ?? 0,
    skillsMissing: coverage?.missing ?? [],
    recommendationRanked: true,
    _score: matchScore,
  };
}

export function applyScoreFilters(scoredJobs, scoreFilters) {
  if (!scoreFilters || !Object.keys(scoreFilters).length) return scoredJobs;
  const fieldMap = {
    overallScore: 'scoreOverall',
    skillMatch: 'scoreSkill',
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
