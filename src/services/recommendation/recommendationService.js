import {
	jobsCollection,
	userKnowledgeGraphsCollection,
	userResumesCollection,
} from '../../db/mongo.js';
import { embedText } from '../embeddings/embeddingService.js';
import { buildResumeEmbeddingText } from '../embeddings/embeddingText.js';
import { getResumeVector, isQdrantReady } from '../vectorStore/qdrantClient.js';
import {
	upsertResumeEmbedding,
	upsertProfileEmbedding,
	getProfileVector,
	PROFILE_GRAPH_ID,
} from '../embeddings/embeddingIngest.js';
import { isNeo4jReady } from '../../db/neo4j.js';
import { computeGraphBoost } from './graphRankBoost.js';
import { applyScoreFilters, composeJobScores } from './scoreComposer.js';
import { buildQdrantFilterFromBody } from './qdrantFilter.js';
import { fetchVectorRankedPage } from './ringPagination.js';
import { mergeMultiVectorScores } from './vectorRetrieval.js';

const VECTOR_CACHE_TTL_MS = 3 * 60 * 1000;
const vectorEntryCache = new Map();

function vectorCacheKey(applierName) {
	return String(applierName || '').trim();
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
					const result = await embedText(text, { applierName, role: 'query' });
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

	let withVectors = entries.filter((e) => e.vector?.length);

	let profileVector = (await getProfileVector(applierName))?.vector;
	if (!profileVector?.length) {
		const profileResult = await upsertProfileEmbedding(applierName, { applierName });
		if (profileResult.ok) {
			profileVector = (await getProfileVector(applierName))?.vector;
		}
	}
	if (profileVector?.length) {
		withVectors.unshift({
			resumeId: PROFILE_GRAPH_ID,
			techStack: 'Profile',
			vector: profileVector,
		});
	}

	return withVectors;
}

async function getCachedResumeVectors(applierName) {
	const key = vectorCacheKey(applierName);
	const cached = vectorEntryCache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.entries;
	}
	const entries = await buildResumeVectorEntries(await loadAnalyzedResumes(applierName), applierName);
	vectorEntryCache.set(key, { entries, expiresAt: Date.now() + VECTOR_CACHE_TTL_MS });
	return entries;
}

/** Primary query vector for Qdrant pagination (profile preferred, else first resume). */
function pickPrimaryQueryVector(resumeVectors) {
	const profile = resumeVectors.find((e) => e.resumeId === PROFILE_GRAPH_ID);
	if (profile?.vector?.length) return profile;
	return resumeVectors.find((e) => e.vector?.length) || null;
}

async function applyGraphBoostToPage(pageRows, applierName) {
	if (!isNeo4jReady() || !pageRows.length) {
		return pageRows.map(({ job, vectorScore, bestResumeId, bestResumeTechStack }) => ({
			...job,
			...composeJobScores(job, { vectorScore, graphBoost: 0 }),
			bestResumeId: bestResumeId || null,
			bestResumeTechStack: bestResumeTechStack || null,
			recommendationRanked: true,
		}));
	}

	const graphCache = new Map();
	const scored = [];

	for (const row of pageRows) {
		const { job, vectorScore, bestResumeId, bestResumeTechStack } = row;
		let graphBoost = 0;
		const graphKey = bestResumeId;
		if (graphKey && graphKey !== PROFILE_GRAPH_ID && userKnowledgeGraphsCollection) {
			if (!graphCache.has(graphKey)) {
				const graph = await loadResumeGraph(graphKey, applierName);
				graphCache.set(graphKey, graph?.skills || []);
			}
			try {
				graphBoost = await computeGraphBoost(job.skills || [], graphCache.get(graphKey));
			} catch (err) {
				console.warn(`[recommendation] graph boost job ${job._id}:`, err.message);
			}
		}

		scored.push({
			...job,
			...composeJobScores(job, { vectorScore, graphBoost }),
			bestResumeId: bestResumeId || null,
			bestResumeTechStack: bestResumeTechStack || null,
			recommendationRanked: true,
		});
	}

	scored.sort(
		(a, b) => b.scoreOverall - a.scoreOverall
			|| String(b.postedAt).localeCompare(String(a.postedAt))
			|| String(b._id).localeCompare(String(a._id)),
	);
	return scored;
}

/**
 * Recommend and rank jobs for an applier using Qdrant ring pagination.
 * O(pageSize) per request — no full-catalog scan or 500-job graph boost loop.
 */
export async function recommendJobsForApplier({
	applierName,
	mongoQuery,
	scoreFilters,
	listBody,
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

	const resumeVectors = await getCachedResumeVectors(name);
	if (!resumeVectors.length) {
		return { docs: [], total: 0, recommendationFallback: true, reason: 'embedding_failed' };
	}

	const primary = pickPrimaryQueryVector(resumeVectors);
	if (!primary?.vector?.length) {
		return { docs: [], total: 0, recommendationFallback: true, reason: 'embedding_failed' };
	}

	const qdrantFilter = buildQdrantFilterFromBody(listBody || {});

	const pageRows = await fetchVectorRankedPage({
		queryVector: primary.vector,
		skip,
		limit,
		mongoQuery: mongoQuery || {},
		qdrantFilter,
	});

	if (!pageRows.length) {
		const catalogTotal = mongoQuery && jobsCollection
			? await jobsCollection.countDocuments(mongoQuery)
			: 0;
		return {
			docs: [],
			total: catalogTotal,
			catalogTotal,
			recommendationFallback: false,
		};
	}

	const merged = mergeMultiVectorScores(pageRows, resumeVectors);

	let docs = await applyGraphBoostToPage(merged, name);
	docs = applyScoreFilters(docs, scoreFilters);

	const catalogTotal = mongoQuery && jobsCollection
		? await jobsCollection.countDocuments(mongoQuery)
		: docs.length;

	return {
		docs,
		total: catalogTotal,
		catalogTotal,
		recommendationFallback: false,
	};
}

export function invalidateRecommendationCache(applierName) {
	const key = vectorCacheKey(applierName);
	vectorEntryCache.delete(key);
}
