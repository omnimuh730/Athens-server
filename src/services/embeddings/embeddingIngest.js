import { ObjectId } from 'mongodb';
import { jobsCollection, userResumesCollection } from '../../db/mongo.js';
import { PROFILE_GRAPH_ID } from '../userKnowledgeGraph/index.js';
import {
	buildJobEmbeddingText,
	buildProfileEmbeddingText,
	buildResumeEmbeddingText,
} from '../embeddings/embeddingText.js';
import { embedText } from '../embeddings/embeddingService.js';
import {
	deleteJobVector,
	deleteProfileVector,
	deleteResumeVector,
	getProfileVector,
	isQdrantReady,
	upsertJobVector,
	upsertProfileVector,
	upsertResumeVector,
} from '../vectorStore/qdrantClient.js';

async function aggregateProfileSkills(ownerName) {
	const name = String(ownerName || '').trim();
	if (!name || !userResumesCollection) return [];

	const analyzed = await userResumesCollection
		.find({ ownerName: name, analyzed: true })
		.project({ skillProfile: 1 })
		.toArray();

	const strengthByKey = new Map();
	for (const resume of analyzed) {
		for (const entry of resume.skillProfile || []) {
			const skillName = String(entry?.name ?? '').trim();
			if (!skillName) continue;
			let strength = Number(entry?.strength ?? 0);
			if (!Number.isFinite(strength)) strength = 5;
			strength = Math.max(0, Math.min(10, strength));
			if (strength <= 0) continue;
			const key = skillName.toLowerCase();
			const prev = strengthByKey.get(key);
			if (!prev || strength > prev.strength) {
				strengthByKey.set(key, { name: skillName, strength });
			}
		}
	}
	return [...strengthByKey.values()];
}

export async function upsertJobEmbedding(jobId, { applierName } = {}) {
	if (!jobsCollection || !isQdrantReady()) return { skipped: true, reason: 'qdrant_not_ready' };

	let objectId;
	try {
		objectId = new ObjectId(jobId);
	} catch {
		return { skipped: true, reason: 'invalid_id' };
	}

	const job = await jobsCollection.findOne({ _id: objectId });
	if (!job) return { skipped: true, reason: 'not_found' };

	const text = buildJobEmbeddingText(job);
	if (!text) return { skipped: true, reason: 'empty_text' };

	try {
		const { vector, textHash, model } = await embedText(text, { applierName, role: 'document' });
		await upsertJobVector(String(job._id), vector, {
			title: job.title || '',
			skills: (job.skills || []).slice(0, 50),
		});

		await jobsCollection.updateOne(
			{ _id: objectId },
			{
				$set: {
					embedding: {
						model: model || process.env.EMBEDDING_MODEL || 'mxbai-embed-large',
						updatedAt: new Date().toISOString(),
						textHash,
					},
				},
			},
		);

		return { ok: true, jobId: String(job._id) };
	} catch (err) {
		console.warn(`[embedding] job ${jobId} failed:`, err.message);
		return { skipped: true, reason: err.message };
	}
}

/**
 * Embed a single analyzed resume (requires LLM skillProfile from analyze step).
 * Not called on upload — only after analyze or backfill.
 */
export async function upsertResumeEmbedding(resumeId, ownerName, { applierName } = {}) {
	if (!userResumesCollection || !isQdrantReady()) return { skipped: true, reason: 'qdrant_not_ready' };

	let objectId;
	try {
		objectId = new ObjectId(resumeId);
	} catch {
		return { skipped: true, reason: 'invalid_id' };
	}

	const name = String(ownerName || '').trim();
	const doc = await userResumesCollection.findOne({ _id: objectId, ownerName: name });
	if (!doc) return { skipped: true, reason: 'not_found' };
	if (!doc.analyzed || !Array.isArray(doc.skillProfile) || !doc.skillProfile.length) {
		return { skipped: true, reason: 'not_analyzed' };
	}

	const text = buildResumeEmbeddingText(doc);
	if (!text) return { skipped: true, reason: 'empty_text' };

	try {
		const { vector, textHash, model } = await embedText(text, {
			applierName: applierName || name,
			role: 'query',
		});
		await upsertResumeVector(String(doc._id), vector, {
			ownerName: name,
			techStack: doc.techStack || '',
			analyzedAt: doc.analyzedAt || null,
			kind: 'resume',
		});

		await userResumesCollection.updateOne(
			{ _id: objectId },
			{
				$set: {
					embedding: {
						model: model || process.env.EMBEDDING_MODEL || 'mxbai-embed-large',
						updatedAt: new Date().toISOString(),
						textHash,
					},
				},
			},
		);

		return { ok: true, resumeId: String(doc._id) };
	} catch (err) {
		console.warn(`[embedding] resume ${resumeId} failed:`, err.message);
		return { skipped: true, reason: err.message };
	}
}

/**
 * Embed aggregated profile skills (max strength per skill across analyzed resumes).
 */
export async function upsertProfileEmbedding(ownerName, { applierName } = {}) {
	if (!isQdrantReady()) return { skipped: true, reason: 'qdrant_not_ready' };

	const name = String(ownerName || '').trim();
	if (!name) return { skipped: true, reason: 'no_owner' };

	const skillProfile = await aggregateProfileSkills(name);
	if (!skillProfile.length) {
		await deleteProfileVector(name);
		return { skipped: true, reason: 'no_analyzed_skills' };
	}

	const text = buildProfileEmbeddingText(name, skillProfile);
	if (!text) return { skipped: true, reason: 'empty_text' };

	try {
		const { vector, textHash, model } = await embedText(text, {
			applierName: applierName || name,
			role: 'query',
		});
		await upsertProfileVector(name, vector, {
			skillCount: skillProfile.length,
			updatedAt: new Date().toISOString(),
		});

		if (userResumesCollection) {
			await userResumesCollection.updateMany(
				{ ownerName: name },
				{
					$set: {
						profileEmbedding: {
							model: model || process.env.EMBEDDING_MODEL || 'mxbai-embed-large',
							updatedAt: new Date().toISOString(),
							textHash,
						},
					},
				},
			);
		}

		return { ok: true, ownerName: name, skillCount: skillProfile.length };
	} catch (err) {
		console.warn(`[embedding] profile ${name} failed:`, err.message);
		return { skipped: true, reason: err.message };
	}
}

/** After resume analyze: refresh this resume vector + aggregated profile vector. */
export async function syncEmbeddingsAfterResumeAnalysis(resumeId, ownerName, { applierName } = {}) {
	const resumeResult = await upsertResumeEmbedding(resumeId, ownerName, { applierName });
	const profileResult = await upsertProfileEmbedding(ownerName, { applierName });
	return { resume: resumeResult, profile: profileResult };
}

export function upsertJobEmbeddingAsync(jobId, opts = {}) {
	void upsertJobEmbedding(jobId, opts).catch((err) =>
		console.warn(`[embedding] async job ${jobId}:`, err.message),
	);
}

export function syncEmbeddingsAfterResumeAnalysisAsync(resumeId, ownerName, opts = {}) {
	void syncEmbeddingsAfterResumeAnalysis(resumeId, ownerName, opts).catch((err) =>
		console.warn(`[embedding] async sync resume ${resumeId}:`, err.message),
	);
}

export async function removeResumeEmbedding(resumeId) {
	await deleteResumeVector(resumeId);
}

export async function removeJobEmbedding(jobId) {
	await deleteJobVector(jobId);
}

export { getProfileVector, PROFILE_GRAPH_ID };
