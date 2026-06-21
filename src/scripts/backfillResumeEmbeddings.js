import dotenv from 'dotenv';
dotenv.config();

import { initMongo, userResumesCollection } from '../src/db/mongo.js';
import { initQdrantCollections } from '../src/services/vectorStore/qdrantClient.js';
import { upsertResumeEmbedding } from '../src/services/embeddings/embeddingIngest.js';

async function main() {
	await initMongo();
	await initQdrantCollections();

	if (!userResumesCollection) {
		console.error('Database not ready');
		process.exit(1);
	}

	let processed = 0;
	let ok = 0;
	let skipped = 0;

	const cursor = userResumesCollection.find(
		{ analyzed: true },
		{ projection: { _id: 1, ownerName: 1, fileName: 1 } },
	);

	for await (const resume of cursor) {
		processed += 1;
		const result = await upsertResumeEmbedding(String(resume._id), resume.ownerName, {
			applierName: resume.ownerName,
		});
		if (result.ok) ok += 1;
		else skipped += 1;
		if (processed % 20 === 0) {
			console.log(`Processed ${processed} resumes (${ok} embedded, ${skipped} skipped)`);
		}
	}

	console.log(`Done. ${processed} resumes processed — ${ok} embedded, ${skipped} skipped.`);
	process.exit(0);
}

main().catch((err) => {
	console.error('backfill-resume-embeddings failed', err);
	process.exit(1);
});
