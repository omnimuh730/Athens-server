import { skillEnrichmentQueueCollection } from '../../db/mongo.js';
import { normalizeSkillKey, normalizeSurfaceForm } from '../skillGraph/normalize.js';
import { findExactMatch } from '../skillGraph/search.js';
import { isNeo4jReady } from '../../db/neo4j.js';

export async function enqueueSkills(rawSkills = [], cooccurringSkills = []) {
	if (!skillEnrichmentQueueCollection || !rawSkills?.length) return [];

	const cooc = [...new Set(rawSkills.concat(cooccurringSkills).map(normalizeSurfaceForm).filter(Boolean))];
	const enqueued = [];

	for (const raw of rawSkills) {
		const surfaceForm = normalizeSurfaceForm(raw);
		const normalizedKey = normalizeSkillKey(surfaceForm);
		if (!normalizedKey) continue;

		if (isNeo4jReady()) {
			const existing = await findExactMatch(normalizedKey);
			if (existing?.id) continue;
		}

		const now = new Date().toISOString();
		const result = await skillEnrichmentQueueCollection.updateOne(
			{ normalizedKey, status: { $in: ['pending', 'processing', 'failed'] } },
			{
				$setOnInsert: {
					normalizedKey,
					surfaceForm,
					cooccurringSkills: cooc.filter(s => normalizeSkillKey(s) !== normalizedKey),
					status: 'pending',
					attempts: 0,
					createdAt: now,
				},
				$set: { updatedAt: now },
			},
			{ upsert: true },
		);

		if (result.upsertedCount > 0) {
			enqueued.push({ normalizedKey, surfaceForm });
		}
	}

	return enqueued;
}

export async function claimNextBatch(limit = 5) {
	if (!skillEnrichmentQueueCollection) return [];

	const now = new Date().toISOString();
	const pending = await skillEnrichmentQueueCollection
		.find({ status: 'pending' })
		.sort({ createdAt: 1 })
		.limit(limit)
		.toArray();

	const claimed = [];
	for (const doc of pending) {
		const r = await skillEnrichmentQueueCollection.findOneAndUpdate(
			{ _id: doc._id, status: 'pending' },
			{ $set: { status: 'processing', updatedAt: now }, $inc: { attempts: 1 } },
			{ returnDocument: 'after' },
		);
		if (r) claimed.push(r);
	}
	return claimed;
}

export async function markDone(normalizedKey) {
	if (!skillEnrichmentQueueCollection) return;
	await skillEnrichmentQueueCollection.updateOne(
		{ normalizedKey },
		{ $set: { status: 'done', updatedAt: new Date().toISOString(), error: null } },
	);
}

export async function markFailed(normalizedKey, error) {
	if (!skillEnrichmentQueueCollection) return;
	await skillEnrichmentQueueCollection.updateOne(
		{ normalizedKey },
		{
			$set: {
				status: 'failed',
				error: String(error?.message || error).slice(0, 500),
				updatedAt: new Date().toISOString(),
			},
		},
	);
}

export async function requeueFailed(maxAttempts = 3) {
	if (!skillEnrichmentQueueCollection) return 0;
	const r = await skillEnrichmentQueueCollection.updateMany(
		{ status: 'failed', attempts: { $lt: maxAttempts } },
		{ $set: { status: 'pending', updatedAt: new Date().toISOString() } },
	);
	return r.modifiedCount;
}
