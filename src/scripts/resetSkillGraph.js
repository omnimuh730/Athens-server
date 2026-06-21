import dotenv from 'dotenv';
dotenv.config();

import { MongoClient } from 'mongodb';
import { initNeo4j, runWrite, closeNeo4j } from '../db/neo4j.js';

/**
 * Fresh-start reset for skill graph collections (Mongo) and Neo4j graph.
 * Does NOT drop job_market or other unrelated collections.
 *
 * Usage: node src/scripts/resetSkillGraph.js
 */
async function main() {
	const mongoUrl = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
	const dbName = process.env.MONGO_DB || 'AIMS_local';

	const client = new MongoClient(mongoUrl);
	await client.connect();
	const db = client.db(dbName);

	const collections = ['skills_category', 'skill_enrichment_queue', 'skill_cooccurrence', 'personal_info'];
	for (const name of collections) {
		try {
			await db.collection(name).drop();
			console.log(`Dropped collection: ${name}`);
		} catch {
			console.log(`Collection not found (skipped): ${name}`);
		}
	}

	await client.close();

	await initNeo4j();
	await runWrite('MATCH (n) DETACH DELETE n');
	console.log('Neo4j graph cleared');
	await closeNeo4j();

	console.log('Skill graph fresh reset complete.');
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
