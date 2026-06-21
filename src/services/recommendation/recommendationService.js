import { ObjectId } from 'mongodb';
import {
	jobsCollection,
	userKnowledgeGraphsCollection,
	userResumesCollection,
} from '../../db/mongo.js';
import { embedText } from '../embeddings/embeddingService.js';
import { buildResumeEmbeddingText } from '../embeddings/embeddingText.js';
import { getResumeVector, isQdrantReady } from '../vectorStore/qdrantClient.js';
import { upsertResumeEmbedding } from '../embeddings/embeddingIngest.js';
import { getCandidatePoolSize } from '../vectorStore/collections.js';
import { retrieveJobCandidates } from './vectorRetrieval.js';
import { computeGraphBoost } from './graphRankBoost.js';
import { applyScoreFilters, composeJobScores } from './scoreComposer.js';

const CACHE_TTL_MS = 3 * 60 * 1000;
const scoreCache = new Map();

function cacheKey(applierName, queryHash) {
	return `${applierName}::${queryHash}`;
}

function simpleQueryHash(query) {
	return JSON.stringify(query);
}

async function loadAnalyzedResumes(applierName) {
	if (!userResumesCollection) return [];
	const name = String(applierName || '').trim();
	if (!name) return [];

	return userResumesCollection
		.find({ ownerName: name, analyzed: true })
		.project({
			_id: 1,
			techStack: 1,
			skillProfile: 1,
			extractedText: 1,
			embedding: 1,
		})
		.toArray();
}

async function loadResumeGraph(resumeId, applierName) {
	if (!userKnowledgeGraphsCollection) return null;
	return userKnowledgeGraphsCollection.findOne({
		applierName,
		resumeId: String(resumeId),
	});
}

async function buildResumeVectorEntries(resumes, applierName) {
	const entries = [];
	for (const doc of resumes) {
		const resumeId = String(doc._id);
		let vector = null;

		const stored = await getResumeVector(resumeId);
		vector = stored?.vector;

		if (!vector?.length) {
			const result = await upsertResumeEmbedding(resumeId, applierName, { applierName });
			if (result.ok) {
				const refreshed = await getResumeVector(resumeId);
				vector = refreshed?.vector;
			}
		}

		if (!vector?.length) {
			const text = buildResumeEmbeddingText(doc);
			if (text) {
				try {
					const result = await embedText(text, { applierName });
					vector = result.vector;
				} catch (err) {
					console.warn(`[recommendation] embed resume ${resumeId}:`, err.message);
				}
			}
		}

		entries.push({
			resumeId,
			techStack: doc.techStack || '',
			vector,
		});
	}
	return entries.filter((e) => e.vector?.length);
}

async function scoreCandidates(candidateMap, applierName) {
	const poolSize = getCandidatePoolSize();
	const sorted = [...candidateMap.entries()]
		.sort((a, b) => b[1].vectorScore - a[1].vectorScore)
		.slice(0, poolSize);

	const jobIds = sorted.map(([id]) => {
		try {
			return new ObjectId(id);
		} catch {
			return null;
		}
	}).filter(Boolean);

	if (!jobIds.length || !jobsCollection) return [];

	const jobs = await jobsCollection.find({ _id: { $in: jobIds } }).toArray();
	const jobById = new Map(jobs.map((j) => [String(j._id), j]));
	const graphCache = new Map();

	const scored = [];
	for (const [jobId, matchInfo] of sorted) {
		const job = jobById.get(jobId);
		if (!job) continue;

		let graphBoost = 0;
		const graphKey = matchInfo.bestResumeId;
		if (graphKey && userKnowledgeGraphsCollection) {
			if (!graphCache.has(graphKey)) {
				const graph = await loadResumeGraph(graphKey, applierName);
				graphCache.set(graphKey, graph?.skills || []);
			}
			const skills = graphCache.get(graphKey);
			try {
				graphBoost = await computeGraphBoost(job.skills || [], skills);
			} catch (err) {
				console.warn(`[recommendation] graph boost job ${jobId}:`, err.message);
			}
		}

		const scores = composeJobScores(job, {
			vectorScore: matchInfo.vectorScore,
			graphBoost,
		});

		scored.push({
			...job,
			...scores,
			bestResumeId: matchInfo.bestResumeId,
			bestResumeTechStack: matchInfo.bestResumeTechStack,
		});
	}

	return scored.sort((a, b) => b.scoreOverall - a.scoreOverall || String(b.postedAt).localeCompare(String(a.postedAt)));
}

/**
 * Recommend and rank jobs for an applier using multi-vector retrieval.
 */
export async function recommendJobsForApplier({
	applierName,
	mongoQuery,
	scoreFilters,
	skip = 0,
	limit = 25,
}) {
	const name = String(applierName || '').trim();
	if (!name) {
		return { docs: [], total: 0, recommendationFallback: true, reason: 'no_applier' };
	}

	if (!isQdrantReady()) {
		return { docs: [], total: 0, recommendationFallback: true, reason: 'qdrant_not_ready' };
	}

	const resumes = await loadAnalyzedResumes(name);
	if (!resumes.length) {
		return { docs: [], total: 0, recommendationFallback: true, reason: 'no_analyzed_resumes' };
	}

	const qHash = simpleQueryHash(mongoQuery);
	const ck = cacheKey(name, qHash);
	const cached = scoreCache.get(ck);
	if (cached && cached.expiresAt > Date.now()) {
		const filtered = applyScoreFilters(cached.scored, scoreFilters);
		const page = filtered.slice(skip, skip + limit);
		return { docs: page, total: filtered.length, recommendationFallback: false };
	}

	const resumeVectors = await buildResumeVectorEntries(resumes, name);
	if (!resumeVectors.length) {
		return { docs: [], total: 0, recommendationFallback: true, reason: 'embedding_failed' };
	}

	const candidateMap = await retrieveJobCandidates(resumeVectors);
	if (!candidateMap.size) {
		return { docs: [], total: 0, recommendationFallback: true, reason: 'no_candidates' };
	}

	let scored = await scoreCandidates(candidateMap, name);

	if (mongoQuery && jobsCollection) {
		const matchingIds = new Set(
			(await jobsCollection.find(mongoQuery, { projection: { _id: 1 } }).toArray())
				.map((d) => String(d._id)),
		);
		scored = scored.filter((j) => matchingIds.has(String(j._id)));
	}

	scored = applyScoreFilters(scored, scoreFilters);
	scoreCache.set(ck, { scored, expiresAt: Date.now() + CACHE_TTL_MS });

	const page = scored.slice(skip, skip + limit);
	return {
		docs: page,
		total: scored.length,
		recommendationFallback: false,
	};
}

export function invalidateRecommendationCache(applierName) {
	const prefix = `${String(applierName || '').trim()}::`;
	for (const key of scoreCache.keys()) {
		if (key.startsWith(prefix)) scoreCache.delete(key);
	}
}
