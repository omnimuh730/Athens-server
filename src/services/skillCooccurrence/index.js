import { skillCooccurrenceCollection } from '../../db/mongo.js';
import {
	getCoocWeightBase,
	getCoocWeightCap,
	getCoocWeightLogFactor,
} from '../../config/graphAndVectorConfig.js';
import { normalizeSkillKey } from '../skillGraph/normalize.js';
import { resolveRawSkills } from '../skillGraph/search.js';
import { upsertUsedWith } from '../skillGraph/apply.js';
import { isNeo4jReady } from '../../db/neo4j.js';
import { traceCooccurrence } from '../skillEnrichment/trace.js';

const COOC_THRESHOLD = Number(process.env.SKILL_COOC_THRESHOLD) || 3;

/** Increment pair counts for raw skills on the same job. */
export async function recordCooccurrenceForJob(rawSkills = [], ctx = {}) {
	if (!skillCooccurrenceCollection || rawSkills.length < 2) {
		return { pairsUpdated: 0, usedWithCreated: 0, threshold: COOC_THRESHOLD };
	}

	const keys = [...new Set(rawSkills.map(normalizeSkillKey).filter(Boolean))];
	const now = new Date().toISOString();
	let pairsUpdated = 0;
	let usedWithCreated = 0;

	traceCooccurrence('job_pairs_start', {
		jobId: ctx.jobId,
		keys,
		pairCount: (keys.length * (keys.length - 1)) / 2,
		threshold: COOC_THRESHOLD,
		note: `USED_WITH edges in Neo4j are created when the same pair co-occurs on ≥${COOC_THRESHOLD} jobs`,
	});

	for (let i = 0; i < keys.length; i++) {
		for (let j = i + 1; j < keys.length; j++) {
			const a = keys[i] < keys[j] ? keys[i] : keys[j];
			const b = keys[i] < keys[j] ? keys[j] : keys[i];
			const pairKey = `${a}|${b}`;

			const updated = await skillCooccurrenceCollection.findOneAndUpdate(
				{ pairKey },
				{
					$setOnInsert: { pairKey, keyA: a, keyB: b, createdAt: now },
					$inc: { count: 1 },
					$set: { updatedAt: now },
				},
				{ upsert: true, returnDocument: 'after' },
			);

			pairsUpdated += 1;
			const count = updated?.count ?? 1;

			traceCooccurrence('pair_incremented', {
				jobId: ctx.jobId,
				pairKey,
				keyA: a,
				keyB: b,
				count,
				threshold: COOC_THRESHOLD,
				promoted: count >= COOC_THRESHOLD,
			});

			if (count >= COOC_THRESHOLD && isNeo4jReady()) {
				const promoted = await promoteCooccurrenceToGraph(a, b, count);
				if (promoted) usedWithCreated += 1;
			}
		}
	}

	traceCooccurrence('job_pairs_done', { jobId: ctx.jobId, pairsUpdated, usedWithCreated, threshold: COOC_THRESHOLD });
	return { pairsUpdated, usedWithCreated, threshold: COOC_THRESHOLD };
}

async function promoteCooccurrenceToGraph(keyA, keyB, count) {
	const resolved = await resolveRawSkills([keyA, keyB]);
	const idA = resolved.get(keyA)?.id;
	const idB = resolved.get(keyB)?.id;
	if (!idA || !idB || idA === idB) {
		traceCooccurrence('promote_skipped_unresolved', { keyA, keyB, idA, idB, count });
		return false;
	}

	const weight = Math.min(
		getCoocWeightCap(),
		getCoocWeightBase() + Math.log1p(count) * getCoocWeightLogFactor(),
	);
	await upsertUsedWith(idA, idB, weight, 'cooccurrence');
	traceCooccurrence('promoted_used_with', { keyA, keyB, idA, idB, count, weight });
	return true;
}

/** Process pending co-occurrence pairs that crossed threshold (maintenance). */
export async function syncCooccurrenceToGraph(limit = 100) {
	if (!skillCooccurrenceCollection || !isNeo4jReady()) return 0;

	const pairs = await skillCooccurrenceCollection
		.find({ count: { $gte: COOC_THRESHOLD }, synced: { $ne: true } })
		.limit(limit)
		.toArray();

	let synced = 0;
	for (const pair of pairs) {
		const promoted = await promoteCooccurrenceToGraph(pair.keyA, pair.keyB, pair.count);
		if (promoted) {
			await skillCooccurrenceCollection.updateOne({ _id: pair._id }, { $set: { synced: true } });
			synced += 1;
		}
	}
	return synced;
}

/** Re-promote co-occurrence pairs involving a newly enriched skill key. */
export async function retryCooccurrenceForKey(normalizedKey, limit = 100) {
	if (!skillCooccurrenceCollection || !isNeo4jReady() || !normalizedKey) {
		return { promoted: 0, scanned: 0 };
	}

	const key = String(normalizedKey).trim();
	const pairs = await skillCooccurrenceCollection
		.find({
			count: { $gte: COOC_THRESHOLD },
			$or: [{ keyA: key }, { keyB: key }],
			synced: { $ne: true },
		})
		.limit(limit)
		.toArray();

	let promoted = 0;
	for (const pair of pairs) {
		const ok = await promoteCooccurrenceToGraph(pair.keyA, pair.keyB, pair.count);
		if (ok) {
			await skillCooccurrenceCollection.updateOne({ _id: pair._id }, { $set: { synced: true } });
			promoted += 1;
		}
	}

	traceCooccurrence('retry_for_key', { normalizedKey: key, scanned: pairs.length, promoted });
	return { promoted, scanned: pairs.length };
}
