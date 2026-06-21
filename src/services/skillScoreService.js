/**
 * Graph-aware skill scoring (replaces flat string overlap).
 * Re-exports from graphSkillScoreService for backward-compatible imports.
 */
export {
	computeSkillScoreValue,
	getMissingSkills,
	refreshSkillScoresForSkills,
	invalidatePersonalSkillCache,
	getPersonalSkillList,
	uniqueNormalizedSkills,
	SKILL_SCORE_VERSION,
	recalculateAllSkillScores,
} from './graphSkillScoreService.js';
