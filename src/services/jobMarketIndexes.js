import { inferJobSource, SOURCE_MAP_VERSION } from '../config/jobSources.js';

export async function ensureJobMarketIndexes(jobsCollection) {
	if (!jobsCollection) return;
	await Promise.all([
		jobsCollection.createIndex({ postedAt: -1 }),
		jobsCollection.createIndex({ scoreSalary: -1 }),
		jobsCollection.createIndex({ scoreApplicant: -1 }),
		jobsCollection.createIndex({ url: 1 }),
		jobsCollection.createIndex({ 'status.applier': 1 }),
		jobsCollection.createIndex({ source: 1, postedAt: -1 }),
	]);
}

/** Backfill denormalized `source` for older jobs missing it. */
export async function backfillMissingJobSourceFields(jobsCollection) {
	if (!jobsCollection) return { updated: 0 };
	const cursor = jobsCollection.find(
		{
			$or: [{ source: { $exists: false } }, { sourceVersion: { $ne: SOURCE_MAP_VERSION } }],
		},
		{ projection: { applyLink: 1 } },
	);

	let updated = 0;
	const batch = [];
	const flush = async () => {
		if (!batch.length) return;
		await jobsCollection.bulkWrite(batch, { ordered: false });
		updated += batch.length;
		batch.length = 0;
	};

	for await (const job of cursor) {
		batch.push({
			updateOne: {
				filter: { _id: job._id },
				update: {
					$set: {
						source: inferJobSource(job.applyLink),
						sourceVersion: SOURCE_MAP_VERSION,
					},
				},
			},
		});
		if (batch.length >= 200) await flush();
	}
	await flush();
	if (updated) console.log(`[job_market] backfilled source on ${updated} job(s)`);
	return { updated };
}
