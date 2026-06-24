import { toCanonical } from '../../../../packages/shared/src/skill-normalize.js';
import {
	userKnowledgeGraphsCollection,
	personalInfoCollection,
	userResumesCollection,
} from '../../db/mongo.js';

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
		const key = toCanonical(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push({ name, strength });
	}
	return out.slice(0, 200);
}

/**
 * Build or update a per-resume user knowledge graph (Mongo only).
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
	const resolvedSkills = normalizedInputs.map(({ name: raw, strength }) => {
		const canonical = toCanonical(raw);
		return {
			surfaceForm: raw,
			name: raw,
			normalizedKey: canonical,
			canonicalId: canonical,
			strength,
			proficiency: strength / 10,
			sources: ['resume'],
		};
	});

	const now = new Date().toISOString();
	const doc = {
		applierName: name,
		resumeId: rId,
		resumeName: resumeName?.trim() || rId,
		skills: resolvedSkills,
		edges: [],
		updatedAt: now,
	};

	await userKnowledgeGraphsCollection.updateOne(
		{ applierName: name, resumeId: rId },
		{ $set: doc, $setOnInsert: { createdAt: now } },
		{ upsert: true },
	);

	return doc;
}

export async function listUserGraphs(applierName) {
	if (!userKnowledgeGraphsCollection) return [];
	const name = String(applierName || '').trim();
	if (!name) return [];
	return userKnowledgeGraphsCollection
		.find({ applierName: name })
		.sort({ updatedAt: -1 })
		.toArray();
}

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

export async function mergeSkillsIntoPersonalInfo(skillNames = []) {
	if (!personalInfoCollection) return;
	const names = [...new Set(skillNames.map((s) => String(s).trim()).filter(Boolean))];
	for (const raw of names) {
		const canonical = toCanonical(raw);
		const doc = {
			name: raw,
			normalizedKey: canonical,
			canonicalId: canonical,
			createdAt: new Date().toISOString(),
		};
		await personalInfoCollection.updateOne({ name: raw }, { $set: doc }, { upsert: true });
	}
}

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
			const key = toCanonical(skillName);
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

export function extractSeedCanonicalIds(graphs = []) {
	const ids = new Set();
	for (const g of graphs) {
		for (const s of g.skills || []) {
			const id = s.canonicalId || s.normalizedKey;
			if (id) ids.add(id);
		}
	}
	return [...ids];
}
