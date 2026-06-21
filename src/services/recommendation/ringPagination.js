import { ObjectId } from 'mongodb';
import { jobsCollection } from '../../db/mongo.js';
import { searchJobVectors } from '../vectorStore/qdrantClient.js';
import { JOB_LIST_PROJECTION } from '../jobListQuery.js';

/** Score at 1-based rank in Qdrant order (for ring boundary discovery). */
export async function scoreAtRank(queryVector, rank, qdrantFilter) {
	if (rank <= 0 || !queryVector?.length) return null;
	const hits = await searchJobVectors(queryVector, {
		offset: rank - 1,
		limit: 1,
		filter: qdrantFilter,
	});
	return hits[0]?.score ?? null;
}

function toObjectId(id) {
	try {
		return new ObjectId(id);
	} catch {
		return null;
	}
}

function inScoreRing(score, sInner, sOuter) {
	if (sOuter !== null && score < sOuter) return false;
	if (sInner !== null && score >= sInner) return false;
	return true;
}

function hasMongoOnlyFilters(mongoQuery) {
	const raw = JSON.stringify(mongoQuery || {});
	return raw.includes('status') || raw.includes('title') || raw.includes('company');
}

/**
 * Fetch one page of vector-ranked jobs.
 * Uses Qdrant offset pagination + Mongo hydration on small ID batches.
 * Ring boundaries used when filters are Qdrant-compatible (source/postedAt only).
 */
export async function fetchVectorRankedPage({
	queryVector,
	skip,
	limit,
	mongoQuery,
	qdrantFilter,
}) {
	if (!queryVector?.length || limit <= 0 || !jobsCollection) {
		return [];
	}

	const useRing = !hasMongoOnlyFilters(mongoQuery);
	const sInner = useRing && skip > 0 ? await scoreAtRank(queryVector, skip, qdrantFilter) : null;
	const sOuter = useRing ? await scoreAtRank(queryVector, skip + limit, qdrantFilter) : null;

	const maxScan = skip + limit + Math.max(limit * 12, 400);
	let qdrantOffset = useRing ? 0 : skip;
	const collected = [];

	while (collected.length < limit && qdrantOffset < maxScan) {
		const batchSize = Math.max(limit * 3, 50);
		const searchOpts = {
			offset: qdrantOffset,
			limit: batchSize,
			filter: qdrantFilter,
		};
		if (useRing && sOuter !== null) {
			searchOpts.scoreThreshold = sOuter;
		}

		const hits = await searchJobVectors(queryVector, searchOpts);
		if (!hits.length) break;

		const candidateHits = useRing
			? hits.filter((h) => inScoreRing(h.score, sInner, sOuter))
			: hits;

		const idOrder = candidateHits.map((h) => h.jobId).filter(Boolean);

		if (idOrder.length) {
			const objectIds = idOrder.map(toObjectId).filter(Boolean);
			const scoreById = new Map(candidateHits.map((h) => [h.jobId, h.score]));

			const jobs = await jobsCollection
				.find(
					{ $and: [mongoQuery, { _id: { $in: objectIds } }] },
					{ projection: JOB_LIST_PROJECTION },
				)
				.toArray();

			const jobById = new Map(jobs.map((j) => [String(j._id), j]));

			for (const jobId of idOrder) {
				const job = jobById.get(jobId);
				if (!job) continue;
				const rawScore = scoreById.get(jobId) ?? 0;
				collected.push({
					job,
					vectorScore: Math.round(Math.max(0, Math.min(1, rawScore)) * 100),
					qdrantScore: rawScore,
				});
				if (collected.length >= limit) break;
			}
		}

		qdrantOffset += hits.length;
		if (hits.length < batchSize) break;
	}

	return collected.slice(0, limit);
}
