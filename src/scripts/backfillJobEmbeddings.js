import dotenv from 'dotenv';
dotenv.config();

import { initMongo, jobsCollection } from '../src/db/mongo.js';
import { initQdrantCollections } from '../src/services/vectorStore/qdrantClient.js';
import { upsertJobEmbedding } from '../src/services/embeddings/embeddingIngest.js';

async function main() {
	await initMongo();
	await initQdrantCollections();

	if (!jobsCollection) {
		console.error('Database not ready');
		process.exit(1);
	}

	let processed = 0;
	let ok = 0;
	let skipped = 0;

	const cursor = jobsCollection.find({}, { projection: { _id: 1, title: 1 } });
	for await (const job of cursor) {
		processed += 1;
		const result = await upsertJobEmbedding(String(job._id));
		if (result.ok) ok += 1;
		else skipped += 1;
		if (processed % 50 === 0) {
			console.log(`Processed ${processed} jobs (${ok} embedded, ${skipped} skipped)`);
		}
	}

	console.log(`Done. ${processed} jobs processed — ${ok} embedded, ${skipped} skipped.`);
	process.exit(0);
}

main().catch((err) => {
	console.error('backfill-job-embeddings failed', err);
	process.exit(1);
});
