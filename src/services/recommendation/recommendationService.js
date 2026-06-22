import {
	jobsCollection,
	userResumesCollection,
	userKnowledgeGraphsCollection,
} from '../../db/mongo.js';
import { isQdrantReady } from '../vectorStore/qdrantClient.js';
import {
	upsertProfileEmbedding,
	getProfileVector,
} from '../embeddings/embeddingIngest.js';
import { applyScoreFilters, composeJobScores } from './scoreComposer.js';
import { buildQdrantFilterFromBody } from './qdrantFilter.js';
import { fetchVectorRankedPage } from './ringPagination.js';
import { computeGraphBoost } from './graphRankBoost.js';
import { PROFILE_GRAPH_ID } from '../userKnowledgeGraph/index.js';
import { isNeo4jReady } from '../../db/neo4j.js';

const PROFILE_VECTOR_CACHE_TTL_MS = 3 * 60 * 1000;
const profileVectorCache = new Map();

function profileCacheKey(applierName) {
	return String(applierName || '').trim();
}

async function loadAnalyzedResumes(applierName) {
	if (!userResumesCollection) return [];
	const name = String(applierName || '').trim();
	if (!name) return [];

	return userResumesCollection
		.find({ ownerName: name, analyzed: true })
		.project({ _id: 1 })
		.toArray();
}

async function getCachedProfileVector(applierName) {
	const key = profileCacheKey(applierName);
	const cached = profileVectorCache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.vector;
	}

	let vector = (await getProfileVector(applierName))?.vector;
	if (!vector?.length) {
		const result = await upsertProfileEmbedding(applierName, { applierName });
		if (result.ok) {
			vector = (await getProfileVector(applierName))?.vector;
		}
	}

	if (vector?.length) {
		profileVectorCache.set(key, {
			vector,
			expiresAt: Date.now() + PROFILE_VECTOR_CACHE_TTL_MS,
		});
	}

	return vector || null;
}

async function loadProfileGraphSkills(applierName) {
	if (!userKnowledgeGraphsCollection) return [];
	const name = String(applierName || '').trim();
	if (!name) return [];

	const graph = await userKnowledgeGraphsCollection.findOne({
		applierName: name,
		resumeId: PROFILE_GRAPH_ID,
	});
	return graph?.skills || [];
}

async function enrichPageRowsWithGraphBoost(pageRows, profileGraphSkills) {
	if (!isNeo4jReady() || !profileGraphSkills.length || !pageRows.length) {
		return pageRows.map((row) => ({ ...row, graphBoost: 0 }));
	}

	return Promise.all(
		pageRows.map(async (row) => {
			const jobSkills = Array.isArray(row.job?.skills) ? row.job.skills : [];
			const graphBoost = jobSkills.length
				? await computeGraphBoost(jobSkills, profileGraphSkills)
				: 0;
			return { ...row, graphBoost };
		}),
	);
}

function composePageDocs(pageRows) {
	return pageRows.map((row) => ({
		...row.job,
		...composeJobScores(row.job, {
			vectorScore: row.vectorScore,
			graphBoost: row.graphBoost ?? 0,
		}),
		recommendationRanked: true,
	}));
}

/**
 * Recommend and rank jobs for an applier using one aggregated profile vector.
 * Resume-level matching runs only when viewing a job (skill-radar endpoint).
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

	const profileVector = await getCachedProfileVector(name);
	if (!profileVector?.length) {
		return { docs: [], total: 0, recommendationFallback: true, reason: 'embedding_failed' };
	}

	const qdrantFilter = buildQdrantFilterFromBody(listBody || {});

	const pageRows = await fetchVectorRankedPage({
		queryVector: profileVector,
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

	const profileGraphSkills = await loadProfileGraphSkills(name);
	const boostedRows = await enrichPageRowsWithGraphBoost(pageRows, profileGraphSkills);
	let docs = composePageDocs(boostedRows);
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
	profileVectorCache.delete(profileCacheKey(applierName));
}
