import 'dotenv/config';
import { initMongo, closeMongo, jobsCollection } from '../db/mongo.js';
import { initNeo4j, closeNeo4j } from '../db/neo4j.js';
import { computeSkillScoreValue, SKILL_SCORE_VERSION } from '../services/skillScoreService.js';

async function backfillSkillScores() {
	await initMongo();
	try {
		await initNeo4j();
	} catch (err) {
		console.warn('[backfill] Neo4j unavailable:', err.message);
	}
	if (!jobsCollection) {
		console.error('Jobs collection is not available. Check Mongo configuration.');
		process.exit(1);
	}

	const cursor = jobsCollection.find({}, { projection: { _id: 1, skills: 1 } });

	let processed = 0;
	while (await cursor.hasNext()) {
		const job = await cursor.next();
		const score = await computeSkillScoreValue(job.skills || []);
		await jobsCollection.updateOne(
			{ _id: job._id },
			{
				$set: {
					skillScore: score,
					skillScoreVersion: SKILL_SCORE_VERSION,
				}
			}
		);
		processed += 1;
		if (processed % 200 === 0) {
			console.log(`Updated ${processed} job documents with skillScore.`);
		}
	}

	console.log(`Backfill completed. Updated ${processed} job documents.`);
	await closeNeo4j().catch(() => {});
	await closeMongo();
}

backfillSkillScores().catch(err => {
	console.error('Backfill skillScore script failed', err);
	process.exit(1);
});
