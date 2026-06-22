import { ObjectId } from 'mongodb';
import {
	jobsCollection,
	userKnowledgeGraphsCollection,
	userResumesCollection,
} from '../db/mongo.js';
import { isNeo4jReady } from '../db/neo4j.js';
import { normalizeSkillKey, toComparable } from '../services/skillGraph/normalize.js';
import { resolveMany } from '../services/skillGraph/resolve.js';
import { computeBestPathMatch } from '../services/skillGraph/gds.js';
import { PROFILE_GRAPH_ID } from '../services/userKnowledgeGraph/index.js';
import { rankResumesForJob } from '../services/recommendation/vectorRetrieval.js';
import { loadResumeVectorEntries, cosineSimilarity } from '../services/recommendation/vectorRetrieval.js';
import { getJobVector } from '../services/vectorStore/qdrantClient.js';
import { upsertJobEmbedding } from '../services/embeddings/embeddingIngest.js';
import { computeGraphBoost } from '../services/recommendation/graphRankBoost.js';
import { getMatchScoreWeights } from '../config/graphAndVectorConfig.js';
import { queueJobAnalysis } from '../services/jobAnalysis/index.js';

const MAX_RADAR_AXES = 12;
const REQUIRED_SCORE = 100;

function clampScore(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}

function userSkillStrength(skill) {
	let raw = Number(skill.strength);
	if (!Number.isFinite(raw)) {
		raw = (Number(skill.proficiency) || 0.5) * 10;
	}
	return clampScore(raw * 10);
}

function findDirectUserMatch(jobNormalizedKey, jobCanonicalId, userSkills = []) {
	for (const skill of userSkills) {
		const userKey = skill.normalizedKey || toComparable(skill.surfaceForm || skill.name || '');
		if (jobNormalizedKey && userKey === jobNormalizedKey) {
			return {
				userScore: userSkillStrength(skill),
				matchType: 'direct',
				matchedVia: skill.surfaceForm || skill.name || userKey,
			};
		}
		if (jobCanonicalId && skill.canonicalId === jobCanonicalId) {
			return {
				userScore: userSkillStrength(skill),
				matchType: 'direct',
				matchedVia: skill.surfaceForm || skill.name || jobCanonicalId,
			};
		}
	}
	return null;
}

async function findGraphUserMatch(jobCanonicalId, userSkills = []) {
	if (!jobCanonicalId || !isNeo4jReady()) return null;

	const userWithCanonical = userSkills.filter((s) => s.canonicalId);
	if (!userWithCanonical.length) return null;

	const userIds = userWithCanonical.map((s) => s.canonicalId);
	const pathMatch = await computeBestPathMatch(jobCanonicalId, userIds);
	if (!pathMatch?.userSkillId) return null;

	const userSkill = userWithCanonical.find((s) => s.canonicalId === pathMatch.userSkillId);
	if (!userSkill) return null;

	const userScore = clampScore(userSkillStrength(userSkill) * pathMatch.similarity);
	return {
		userScore,
		matchType: 'graph',
		matchedVia: userSkill.surfaceForm || userSkill.name || pathMatch.userSkillId,
		weight: pathMatch.similarity,
		pathCost: pathMatch.pathCost,
		pathHops: pathMatch.hops,
		pathSkills: pathMatch.pathSkills,
		pathRelTypes: pathMatch.pathRelTypes,
	};
}

async function scoreJobSkillAxis(jobSkillLabel, resolved, userSkills) {
	const normalizedKey = resolved?.normalizedKey || normalizeSkillKey(jobSkillLabel);
	const canonicalId = resolved?.canonicalId || null;

	const direct = findDirectUserMatch(normalizedKey, canonicalId, userSkills);
	if (direct) {
		return {
			skill: jobSkillLabel,
			required: REQUIRED_SCORE,
			user: direct.userScore,
			matchType: direct.matchType,
			matchedVia: direct.matchedVia,
		};
	}

	const graph = await findGraphUserMatch(canonicalId, userSkills);
	if (graph) {
		return {
			skill: jobSkillLabel,
			required: REQUIRED_SCORE,
			user: graph.userScore,
			matchType: graph.matchType,
			matchedVia: graph.matchedVia,
			pathCost: graph.pathCost,
			pathHops: graph.pathHops,
			pathSkills: graph.pathSkills,
			pathRelTypes: graph.pathRelTypes,
		};
	}

	return {
		skill: jobSkillLabel,
		required: REQUIRED_SCORE,
		user: 0,
		matchType: 'none',
	};
}

async function loadAvailableResumes(applierName) {
	if (!userResumesCollection) return [];
	const rows = await userResumesCollection
		.find({ ownerName: applierName, analyzed: true })
		.project({ _id: 1, techStack: 1, fileName: 1 })
		.toArray();

	const options = rows.map((doc) => ({
		resumeId: String(doc._id),
		label: String(doc.techStack || doc.fileName || 'Resume').trim() || 'Resume',
	}));

	if (userKnowledgeGraphsCollection) {
		const profileGraph = await userKnowledgeGraphsCollection.findOne({
			applierName,
			resumeId: PROFILE_GRAPH_ID,
		});
		if (profileGraph?.skills?.length) {
			options.unshift({
				resumeId: PROFILE_GRAPH_ID,
				label: 'Profile (aggregated)',
			});
		}
	}

	return options;
}

async function loadUserGraphSkills(applierName, resumeId) {
	if (!userKnowledgeGraphsCollection) return [];
	const graph = await userKnowledgeGraphsCollection.findOne({
		applierName,
		resumeId: String(resumeId),
	});
	return graph?.skills || [];
}

function pickDefaultResumeId(requestedResumeId, recommendedResumeId, recommendedTechStack, availableResumes) {
	const availableIds = new Set(availableResumes.map((r) => r.resumeId));

	if (requestedResumeId && availableIds.has(String(requestedResumeId))) {
		return String(requestedResumeId);
	}

	if (recommendedResumeId && availableIds.has(String(recommendedResumeId))) {
		return String(recommendedResumeId);
	}

	if (recommendedTechStack) {
		const norm = String(recommendedTechStack).trim().toLowerCase();
		const exact = availableResumes.find((r) => r.label.trim().toLowerCase() === norm);
		if (exact) return exact.resumeId;

		const partial = availableResumes.find(
			(r) =>
				r.label.toLowerCase().includes(norm) ||
				norm.includes(r.label.trim().toLowerCase()),
		);
		if (partial) return partial.resumeId;
	}

	const concrete = availableResumes.find((r) => r.resumeId !== PROFILE_GRAPH_ID);
	return concrete?.resumeId ?? availableResumes[0]?.resumeId ?? PROFILE_GRAPH_ID;
}

/**
 * Fast vector + graph resume pick for a job (JD header).
 */
export async function buildJobResumeRank({ jobId, applierName }) {
	const name = String(applierName || '').trim();
	if (!name) throw new Error('applierName is required');
	if (!ObjectId.isValid(jobId)) throw new Error('Invalid job id');

	const availableResumes = await loadAvailableResumes(name);
	if (!availableResumes.length) {
		return {
			availableResumes,
			recommendedResumeId: null,
			recommendedResumeTechStack: null,
		};
	}

	const job = jobsCollection
		? await jobsCollection.findOne(
			{ _id: new ObjectId(jobId) },
			{ projection: { skills: 1 } },
		)
		: null;
	const jobSkills = Array.isArray(job?.skills) ? job.skills : [];

	let jobVector = (await getJobVector(String(jobId)))?.vector;
	if (!jobVector?.length) {
		const embed = await upsertJobEmbedding(String(jobId), { applierName: name });
		if (embed.ok) {
			jobVector = (await getJobVector(String(jobId)))?.vector;
		}
	}

	const resumeEntries = jobVector?.length ? await loadResumeVectorEntries(name) : [];
	const weights = getMatchScoreWeights();

	let bestResumeId = null;
	let bestScore = -1;
	let bestLabel = null;

	for (const resume of availableResumes) {
		if (resume.resumeId === PROFILE_GRAPH_ID) continue;

		const vectorEntry = resumeEntries.find((e) => e.resumeId === resume.resumeId);
		const vectorScore = vectorEntry && jobVector?.length
			? cosineSimilarity(jobVector, vectorEntry.vector)
			: 0;

		let graphBoost = 0;
		if (jobSkills.length && isNeo4jReady()) {
			const userSkills = await loadUserGraphSkills(name, resume.resumeId);
			if (userSkills.length) {
				graphBoost = await computeGraphBoost(jobSkills, userSkills);
			}
		}

		const combined = vectorScore * weights.vector + (graphBoost / 100) * weights.graph;
		if (combined > bestScore) {
			bestScore = combined;
			bestResumeId = resume.resumeId;
			bestLabel = resume.label;
		}
	}

	const vectorRank = await rankResumesForJob(String(jobId), name);

	const recommendedResumeId = bestResumeId
		?? vectorRank?.resumeId
		?? availableResumes.find((r) => r.resumeId !== PROFILE_GRAPH_ID)?.resumeId
		?? availableResumes[0]?.resumeId
		?? null;

	return {
		availableResumes,
		recommendedResumeId,
		recommendedResumeTechStack: bestLabel
			?? vectorRank?.techStack
			?? availableResumes.find((r) => r.resumeId === recommendedResumeId)?.label
			?? null,
	};
}

/**
 * Build skill-match radar axes for a job vs a user resume graph.
 */
export async function buildJobSkillRadar({
	jobId,
	applierName,
	resumeId,
	recommendedResumeId,
	recommendedTechStack,
	rankOnly = false,
}) {
	const name = String(applierName || '').trim();
	if (!name) throw new Error('applierName is required');
	if (!ObjectId.isValid(jobId)) throw new Error('Invalid job id');
	if (!jobsCollection) throw new Error('Database not ready');

	if (rankOnly) {
		return buildJobResumeRank({ jobId, applierName });
	}

	const job = await jobsCollection.findOne({ _id: new ObjectId(jobId) });
	if (!job) throw new Error('Job not found');

	const analysisStatus = job.skillAnalysis?.status;
	if (analysisStatus !== 'analyzed' && analysisStatus !== 'queued' && analysisStatus !== 'analyzing') {
		void queueJobAnalysis(String(jobId), name).catch(() => undefined);
	}

	const availableResumes = await loadAvailableResumes(name);
	if (!availableResumes.length) {
		return {
			resumeId: null,
			resumeLabel: '',
			axes: [],
			summary: { direct: 0, graph: 0, missing: 0 },
			availableResumes,
			recommendedResumeId: null,
			recommendedResumeTechStack: null,
			neo4jReady: isNeo4jReady(),
		};
	}

	const vectorRank = await rankResumesForJob(String(jobId), name);
	const vectorRecommendedId = vectorRank?.resumeId ?? null;
	const vectorRecommendedLabel = vectorRank?.techStack ?? null;

	const resolvedRecommendedId = pickDefaultResumeId(
		undefined,
		vectorRecommendedId ?? recommendedResumeId,
		vectorRecommendedLabel ?? recommendedTechStack,
		availableResumes,
	);

	const chosenResumeId = pickDefaultResumeId(
		resumeId,
		vectorRecommendedId ?? recommendedResumeId,
		vectorRecommendedLabel ?? recommendedTechStack,
		availableResumes,
	);
	const resumeMeta = availableResumes.find((r) => r.resumeId === chosenResumeId)
		|| availableResumes[0];

	const userSkills = await loadUserGraphSkills(name, resumeMeta.resumeId);
	const jobSkills = (Array.isArray(job.skills) ? job.skills : [])
		.map(String)
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, MAX_RADAR_AXES);

	const resolvedMap = await resolveMany(jobSkills, { enqueueIfMissing: false });

	const axes = [];
	for (const skill of jobSkills) {
		const key = normalizeSkillKey(skill);
		const resolved = [...resolvedMap.values()].find((v) => v.normalizedKey === key)
			|| resolvedMap.get(key);
		axes.push(await scoreJobSkillAxis(skill, resolved, userSkills));
	}

	const summary = axes.reduce(
		(acc, axis) => {
			if (axis.matchType === 'direct') acc.direct += 1;
			else if (axis.matchType === 'graph') acc.graph += 1;
			else acc.missing += 1;
			return acc;
		},
		{ direct: 0, graph: 0, missing: 0 },
	);

	return {
		resumeId: resumeMeta.resumeId,
		resumeLabel: resumeMeta.label,
		axes,
		summary,
		availableResumes,
		recommendedResumeId: resolvedRecommendedId,
		recommendedResumeTechStack: vectorRecommendedLabel
			?? availableResumes.find((r) => r.resumeId === resolvedRecommendedId)?.label
			?? null,
		neo4jReady: isNeo4jReady(),
		skillAnalysisStatus: job.skillAnalysis?.status ?? 'pending',
	};
}
