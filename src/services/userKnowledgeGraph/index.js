import { resolveSkillToCanonical, resolvePersonalSkill } from '../skillGraph/resolve.js';
import { findExactMatches } from '../skillGraph/search.js';
import { normalizeSkillKey, normalizeSurfaceForm } from '../skillGraph/normalize.js';
import {
	userKnowledgeGraphsCollection,
	personalInfoCollection,
	userResumesCollection,
} from '../../db/mongo.js';
import { enqueueSkills } from '../skillEnrichment/queue.js';

export const PROFILE_GRAPH_ID = '__profile__';

function normalizeSkillInputs(skills = []) {
	const out = [];
	const seen = new Set();
	for (const item of skills) {
		let name;
		let strength;
		if (typeof item === 'string') {
			name = item.trim();
			strength = 8.5;
		} else if (item && typeof item === 'object') {
			name = String(item.name || item.skill || '').trim();
			strength = Number(item.strength);
			if (!Number.isFinite(strength)) strength = 8.5;
			strength = Math.max(0, Math.min(10, strength));
		} else {
			continue;
		}
		if (!name) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name, strength });
	}
	return out.slice(0, 200);
}

async function buildPersonalSkillDoc(name) {
	const resolved = await resolvePersonalSkill(name);
	return {
		name: resolved.raw || name.trim(),
		normalizedKey: resolved.normalizedKey || normalizeSkillKey(name),
		canonicalId: resolved.canonicalId || null,
		createdAt: new Date().toISOString(),
	};
}

/**
 * Build or update a per-resume user knowledge graph.
 * Skills reference world graph canonicalIds; missing skills are enqueued (not LLM-enriched).
 */
export async function buildUserGraphFromResume({
	applierName,
	resumeId,
	resumeName,
	skills = [],
}) {
	if (!userKnowledgeGraphsCollection) throw new Error('Database not ready');

	const name = String(applierName || '').trim();
	const rId = String(resumeId || 'default').trim();
	if (!name) throw new Error('applierName is required');

	const normalizedInputs = normalizeSkillInputs(skills);
	const cooc = normalizedInputs.map((s) => s.name);

	await enqueueSkills(cooc, cooc);

	const normalizedInputsWithKeys = normalizedInputs
		.map(({ name: raw, strength }) => {
			const surfaceForm = normalizeSurfaceForm(raw);
			const normalizedKey = normalizeSkillKey(surfaceForm);
			return normalizedKey ? { raw, strength, surfaceForm, normalizedKey } : null;
		})
		.filter(Boolean);

	const matchMap = await findExactMatches(normalizedInputsWithKeys.map((item) => item.normalizedKey));

	const missingForEnqueue = [];
	const resolvedSkills = [];
	for (const { raw, strength, surfaceForm, normalizedKey } of normalizedInputsWithKeys) {
		const exact = matchMap.get(normalizedKey);
		if (!exact?.id) {
			missingForEnqueue.push(surfaceForm);
		}

		const proficiency = strength / 10;
		resolvedSkills.push({
			surfaceForm: surfaceForm || raw,
			normalizedKey,
			canonicalId: exact?.id || null,
			strength,
			proficiency,
			sources: ['resume'],
		});
	}

	if (missingForEnqueue.length) {
		await enqueueSkills(missingForEnqueue, cooc);
	}

	const edges = [];
	const edgeCap = Math.min(resolvedSkills.length, 40);
	for (let i = 0; i < edgeCap; i++) {
		for (let j = i + 1; j < edgeCap; j++) {
			const a = resolvedSkills[i].canonicalId;
			const b = resolvedSkills[j].canonicalId;
			if (a && b && a !== b) {
				edges.push({ fromId: a, toId: b, type: 'USED_WITH', weight: 0.3 });
			}
		}
	}

	const now = new Date().toISOString();
	const doc = {
		applierName: name,
		resumeId: rId,
		resumeName: resumeName?.trim() || rId,
		skills: resolvedSkills,
		edges,
		updatedAt: now,
	};

	await userKnowledgeGraphsCollection.updateOne(
		{ applierName: name, resumeId: rId },
		{ $set: doc, $setOnInsert: { createdAt: now } },
		{ upsert: true },
	);

	return doc;
}

/** List user graphs for an applier. */
export async function listUserGraphs(applierName) {
	if (!userKnowledgeGraphsCollection) return [];
	const name = String(applierName || '').trim();
	if (!name) return [];

	return userKnowledgeGraphsCollection
		.find({ applierName: name })
		.sort({ updatedAt: -1 })
		.toArray();
}

/** Build a default user graph from personal_info skills (interim bridge). */
export async function ensureDefaultUserGraphFromPersonal(applierName, personalSkills = []) {
	const skills = personalSkills.filter(Boolean);
	if (!skills.length) return null;

	return buildUserGraphFromResume({
		applierName,
		resumeId: 'personal-default',
		resumeName: 'Personal skills',
		skills,
	});
}

/** Upsert skill names into personal_info profile knowledge. */
export async function mergeSkillsIntoPersonalInfo(skillNames = []) {
	if (!personalInfoCollection) return;
	const names = [...new Set(skillNames.map((s) => String(s).trim()).filter(Boolean))];
	for (const name of names) {
		const doc = await buildPersonalSkillDoc(name);
		await personalInfoCollection.updateOne({ name: doc.name }, { $set: doc }, { upsert: true });
	}
}

/** Rebuild aggregate profile graph from all analyzed resumes (max strength per skill). */
export async function rebuildProfileGraph(applierName) {
	const name = String(applierName || '').trim();
	if (!name || !userResumesCollection || !userKnowledgeGraphsCollection) return null;

	const analyzedResumes = await userResumesCollection
		.find({ ownerName: name, analyzed: true })
		.toArray();

	const strengthByKey = new Map();

	for (const resume of analyzedResumes) {
		for (const entry of resume.skillProfile || []) {
			const skillName = String(entry.name || '').trim();
			let strength = Number(entry.strength);
			if (!Number.isFinite(strength)) strength = 5;
			strength = Math.max(0, Math.min(10, strength));
			if (!skillName || strength <= 0) continue;

			const key = normalizeSkillKey(normalizeSurfaceForm(skillName));
			if (!key) continue;
			const prev = strengthByKey.get(key);
			if (!prev || strength > prev.strength) {
				strengthByKey.set(key, { name: skillName, strength });
			}
		}
	}

	const aggregatedSkills = [...strengthByKey.values()];
	if (!aggregatedSkills.length) {
		await userKnowledgeGraphsCollection.deleteOne({
			applierName: name,
			resumeId: PROFILE_GRAPH_ID,
		});
		return null;
	}

	return buildUserGraphFromResume({
		applierName: name,
		resumeId: PROFILE_GRAPH_ID,
		resumeName: 'Profile knowledge',
		skills: aggregatedSkills,
	});
}

/** Seed canonicalIds for activation — from selected resume graphs. */
export function extractSeedCanonicalIds(graphs = []) {
	const ids = new Set();
	for (const g of graphs) {
		for (const s of g.skills || []) {
			if (s.canonicalId) ids.add(s.canonicalId);
		}
	}
	return [...ids];
}
