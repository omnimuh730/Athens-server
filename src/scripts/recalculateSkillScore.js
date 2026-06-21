import 'dotenv/config';
import { fileURLToPath } from 'url';
import { initMongo, closeMongo } from '../db/mongo.js';
import { initNeo4j, closeNeo4j } from '../db/neo4j.js';
import { recalculateAllSkillScores } from '../services/graphSkillScoreService.js';

export async function recalculateSkillScores({ ensureMongo = true, closeWhenDone = false } = {}) {
	if (ensureMongo) {
		await initMongo();
		try {
			await initNeo4j();
		} catch (err) {
			console.warn('[recalculate] Neo4j unavailable, using fallback scoring:', err.message);
		}
	}

	try {
		const result = await recalculateAllSkillScores();
		console.log(`SkillScore recalculation finished. Jobs scanned: ${result.processed}. SkillScores updated: ${result.updated}.`);
		return result;
	} finally {
		if (closeWhenDone) {
			await closeNeo4j().catch(() => {});
			await closeMongo();
		}
	}
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	recalculateSkillScores({ ensureMongo: true, closeWhenDone: true }).catch(err => {
		console.error('SkillScore recalculation script failed', err);
		process.exit(1);
	});
}
