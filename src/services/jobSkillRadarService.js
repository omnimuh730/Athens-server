import { ObjectId } from 'mongodb';
import {
	jobsCollection,
	userKnowledgeGraphsCollection,
	userResumesCollection,
} from '../db/mongo.js';
import { PROFILE_GRAPH_ID } from '../services/userKnowledgeGraph/index.js';
import { loadProfileSkillSet } from './matching/profileSkills.js';
import { computeCoverageScore } from './matching/coverageScore.js';
import { normalizeJobSkills, toCanonical } from './matching/skillIndex.js';
import { queueJobAnalysis } from '../services/jobAnalysis/index.js';

const MAX_RADAR_AXES = 12;
const REQUIRED_SCORE = 100;

function userSkillStrength(skill) {
	let raw = Number(skill.strength);
	if (!Number.isFinite(raw)) {
		raw = (Number(skill.proficiency) || 0.5) * 10;
	}
	return Math.max(0, Math.min(100, Math.round(raw * 10)));
}

function buildAxesFromCoverage(jobSkills, profileSkills, userGraphSkills = []) {
	const strengthByCanonical = new Map();
	for (const s of userGraphSkills) {
		const key = toCanonical(s.surfaceForm || s.name || '');
		if (!key) continue;
		strengthByCanonical.set(key, Math.max(strengthByCanonical.get(key) ?? 0, userSkillStrength(s)));
	}

	const axes = [];
	for (const label of jobSkills.slice(0, MAX_RADAR_AXES)) {
		const canonical = toCanonical(label);
		const hasSkill = profileSkills.has(canonical);
		axes.push({
			skill: label,
			required: REQUIRED_SCORE,
			user: hasSkill ? (strengthByCanonical.get(canonical) ?? 80) : 0,
			matchType: hasSkill ? 'direct' : 'none',
			matchedVia: hasSkill ? label : undefined,
		});
	}
	return axes;
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
			options.unshift({ resumeId: PROFILE_GRAPH_ID, label: 'Profile (aggregated)' });
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
	if (requestedResumeId && availableIds.has(String(requestedResumeId))) return String(requestedResumeId);
	if (recommendedResumeId && availableIds.has(String(recommendedResumeId))) return String(recommendedResumeId);
	if (recommendedTechStack) {
		const norm = String(recommendedTechStack).trim().toLowerCase();
		const exact = availableResumes.find((r) => r.label.trim().toLowerCase() === norm);
		if (exact) return exact.resumeId;
	}
	const concrete = availableResumes.find((r) => r.resumeId !== PROFILE_GRAPH_ID);
	return concrete?.resumeId ?? availableResumes[0]?.resumeId ?? PROFILE_GRAPH_ID;
}

/**
 * Recommend best resume for a job using per-resume skill coverage.
 */
export async function buildJobResumeRank({ jobId, applierName }) {
	const name = String(applierName || '').trim();
	if (!name) throw new Error('applierName is required');
	if (!ObjectId.isValid(jobId)) throw new Error('Invalid job id');

	const availableResumes = await loadAvailableResumes(name);
	if (!availableResumes.length) {
		return { availableResumes, recommendedResumeId: null, recommendedResumeTechStack: null };
	}

	const job = jobsCollection
		? await jobsCollection.findOne({ _id: new ObjectId(jobId) }, { projection: { skills: 1, skillsNormalized: 1 } })
		: null;
	const jobSkills = job?.skillsNormalized?.length
		? job.skillsNormalized
		: normalizeJobSkills(job?.skills || []);

	let bestResumeId = null;
	let bestScore = -1;
	let bestLabel = null;

	for (const resume of availableResumes) {
		if (resume.resumeId === PROFILE_GRAPH_ID) continue;
		const userSkills = await loadUserGraphSkills(name, resume.resumeId);
		const profileSet = new Set();
		for (const s of userSkills) {
			const c = toCanonical(s.surfaceForm || s.name || '');
			if (c) profileSet.add(c);
		}
		if (!profileSet.size) {
			const global = await loadProfileSkillSet(name);
			for (const g of global) profileSet.add(g);
		}
		const { matchScore } = computeCoverageScore(jobSkills, profileSet);
		if (matchScore > bestScore) {
			bestScore = matchScore;
			bestResumeId = resume.resumeId;
			bestLabel = resume.label;
		}
	}

	const recommendedResumeId = bestResumeId
		?? availableResumes.find((r) => r.resumeId !== PROFILE_GRAPH_ID)?.resumeId
		?? availableResumes[0]?.resumeId
		?? null;

	return {
		availableResumes,
		recommendedResumeId,
		recommendedResumeTechStack: bestLabel
			?? availableResumes.find((r) => r.resumeId === recommendedResumeId)?.label
			?? null,
	};
}

/**
 * Skill-match radar for a job vs selected resume profile skills.
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
			matchScore: 0,
			skillsCovered: 0,
			skillsRequired: 0,
		};
	}

	const rank = await buildJobResumeRank({ jobId, applierName });
	const chosenResumeId = pickDefaultResumeId(
		resumeId,
		rank.recommendedResumeId ?? recommendedResumeId,
		rank.recommendedResumeTechStack ?? recommendedTechStack,
		availableResumes,
	);
	const resumeMeta = availableResumes.find((r) => r.resumeId === chosenResumeId) || availableResumes[0];

	const userSkills = await loadUserGraphSkills(name, resumeMeta.resumeId);
	const profileSkills = await loadProfileSkillSet(name);
	for (const s of userSkills) {
		const c = toCanonical(s.surfaceForm || s.name || '');
		if (c) profileSkills.add(c);
	}

	const jobSkillLabels = (Array.isArray(job.skills) ? job.skills : [])
		.map(String)
		.map((s) => s.trim())
		.filter(Boolean);

	const jobSkillsNorm = job.skillsNormalized?.length
		? job.skillsNormalized
		: normalizeJobSkills(jobSkillLabels);

	const coverage = computeCoverageScore(jobSkillsNorm, profileSkills);
	const axes = buildAxesFromCoverage(jobSkillLabels, profileSkills, userSkills);

	const summary = axes.reduce(
		(acc, axis) => {
			if (axis.matchType === 'direct') acc.direct += 1;
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
		recommendedResumeId: rank.recommendedResumeId,
		recommendedResumeTechStack: rank.recommendedResumeTechStack,
		matchScore: coverage.matchScore,
		skillsCovered: coverage.covered.length,
		skillsRequired: coverage.required,
		skillsMissing: coverage.missing,
		skillAnalysisStatus: job.skillAnalysis?.status ?? 'pending',
	};
}
