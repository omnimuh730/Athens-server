import { jobsCollection } from '../db/mongo.js';
import { recalculateAllSkillScores } from '../services/graphSkillScoreService.js';

let runningRecalc = null;

export async function recalculateSkillScore(req, res) {
	try {
		if (!jobsCollection) {
			return res.status(503).json({ success: false, error: 'Database not ready' });
		}

		if (runningRecalc) {
			return res.status(409).json({ success: false, error: 'Skill score recalculation is already running' });
		}

		runningRecalc = recalculateAllSkillScores();
		const result = await runningRecalc;

		return res.json({
			success: true,
			message: 'Skill score recalculation completed.',
			result,
		});
	} catch (err) {
		console.error('POST /api/skillscore/recalculate error', err);
		return res.status(500).json({ success: false, error: err.message });
	} finally {
		runningRecalc = null;
	}
}
