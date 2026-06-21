import { skillCooccurrenceCollection } from '../../db/mongo.js';
import { normalizeSkillKey } from '../skillGraph/normalize.js';
import { resolveRawSkills } from '../skillGraph/search.js';
import { upsertUsedWith } from '../skillGraph/apply.js';
import { isNeo4jReady } from '../../db/neo4j.js';

const COOC_THRESHOLD = Number(process.env.SKILL_COOC_THRESHOLD) || 3;
const COOC_WEIGHT_CAP = 0.85;

/** Increment pair counts for raw skills on the same job. */
export async function recordCooccurrenceForJob(rawSkills = []) {
	if (!skillCooccurrenceCollection || rawSkills.length < 2) return;

	const keys = [...new Set(rawSkills.map(normalizeSkillKey).filter(Boolean))];
	const now = new Date().toISOString();

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

			if (updated?.count >= COOC_THRESHOLD && isNeo4jReady()) {
				await promoteCooccurrenceToGraph(a, b, updated.count);
			}
		}
	}
}

async function promoteCooccurrenceToGraph(keyA, keyB, count) {
	const resolved = await resolveRawSkills([keyA, keyB]);
	const idA = resolved.get(keyA)?.id;
	const idB = resolved.get(keyB)?.id;
	if (!idA || !idB || idA === idB) return;

	const weight = Math.min(COOC_WEIGHT_CAP, 0.3 + Math.log1p(count) * 0.15);
	await upsertUsedWith(idA, idB, weight, 'cooccurrence');
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
		await promoteCooccurrenceToGraph(pair.keyA, pair.keyB, pair.count);
		await skillCooccurrenceCollection.updateOne({ _id: pair._id }, { $set: { synced: true } });
		synced += 1;
	}
	return synced;
}
