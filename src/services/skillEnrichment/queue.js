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
				$set: { updatedAt: now, surfaceForm },
			},
			{ upsert: true },
		);

		if (result.upsertedCount > 0 || result.modifiedCount > 0) {
			enqueued.push({ normalizedKey, surfaceForm });
		}
	}

	return enqueued;
}

export async function claimNextBatch(limit = 5) {
	if (!skillEnrichmentQueueCollection) return [];

	const now = new Date().toISOString();
	const pending = await skillEnrichmentQueueCollection
		.find({ status: { $in: ['pending', 'failed'] } })
		.sort({ createdAt: 1 })
		.limit(limit)
		.toArray();

	const claimed = [];
	for (const doc of pending) {
		const r = await skillEnrichmentQueueCollection.findOneAndUpdate(
			{ _id: doc._id, status: { $in: ['pending', 'failed'] } },
			{ $set: { status: 'processing', updatedAt: now }, $inc: { attempts: 1 } },
			{ returnDocument: 'after' },
		);
		if (r) claimed.push(r);
	}
	return claimed;
}

export async function markDoneWithMeta(normalizedKey, meta = {}) {
	if (!skillEnrichmentQueueCollection) return;
	const now = new Date().toISOString();
	await skillEnrichmentQueueCollection.updateOne(
		{ normalizedKey },
		{
			$set: {
				status: 'done',
				updatedAt: now,
				analyzedAt: now,
				error: null,
				enrichmentPath: meta.enrichmentPath ?? meta.path ?? null,
				skillId: meta.skillId ?? null,
				action: meta.action ?? null,
				relationshipCount: meta.relationshipCount ?? 0,
				usage: meta.usage ?? null,
			},
		},
	);
}

export async function markDone(normalizedKey) {
	return markDoneWithMeta(normalizedKey, {});
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

export async function markCancelled(normalizedKey) {
	if (!skillEnrichmentQueueCollection) return;
	await skillEnrichmentQueueCollection.updateOne(
		{ normalizedKey, status: 'processing' },
		{ $set: { status: 'pending', updatedAt: new Date().toISOString() } },
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

export async function listPendingSkills({ limit = 200, statuses = ['pending', 'failed'] } = {}) {
	if (!skillEnrichmentQueueCollection) return [];
	return skillEnrichmentQueueCollection
		.find({ status: { $in: statuses } })
		.sort({ createdAt: 1 })
		.limit(limit)
		.project({
			normalizedKey: 1,
			surfaceForm: 1,
			status: 1,
			createdAt: 1,
			attempts: 1,
			error: 1,
		})
		.toArray();
}

export async function countQueueStats() {
	if (!skillEnrichmentQueueCollection) {
		return { pending: 0, processing: 0, done: 0, failed: 0, total: 0 };
	}
	const [pending, processing, done, failed] = await Promise.all([
		skillEnrichmentQueueCollection.countDocuments({ status: { $in: ['pending', 'failed'] } }),
		skillEnrichmentQueueCollection.countDocuments({ status: 'processing' }),
		skillEnrichmentQueueCollection.countDocuments({ status: 'done' }),
		skillEnrichmentQueueCollection.countDocuments({ status: 'failed' }),
	]);
	return { pending, processing, done, failed, total: pending + processing + done };
}

export async function resetProcessingToPending() {
	if (!skillEnrichmentQueueCollection) return 0;
	const r = await skillEnrichmentQueueCollection.updateMany(
		{ status: 'processing' },
		{ $set: { status: 'pending', updatedAt: new Date().toISOString() } },
	);
	return r.modifiedCount;
}
