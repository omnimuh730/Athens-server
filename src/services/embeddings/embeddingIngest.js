import { ObjectId } from 'mongodb';
import { jobsCollection, userResumesCollection } from '../../db/mongo.js';
import { buildJobEmbeddingText, buildResumeEmbeddingText } from '../embeddings/embeddingText.js';
import { embedText } from '../embeddings/embeddingService.js';
import {
	deleteJobVector,
	deleteResumeVector,
	isQdrantReady,
	upsertJobVector,
	upsertResumeVector,
} from '../vectorStore/qdrantClient.js';

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
		const { vector, textHash, model } = await embedText(text, { applierName });
		await upsertJobVector(String(job._id), vector, {
			title: job.title || '',
			skills: (job.skills || []).slice(0, 50),
		});

		await jobsCollection.updateOne(
			{ _id: objectId },
			{
				$set: {
					embedding: {
						model: model || process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
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

	const text = buildResumeEmbeddingText(doc);
	if (!text) return { skipped: true, reason: 'empty_text' };

	try {
		const { vector, textHash, model } = await embedText(text, { applierName: applierName || name });
		await upsertResumeVector(String(doc._id), vector, {
			ownerName: name,
			techStack: doc.techStack || '',
			analyzedAt: doc.analyzedAt || null,
		});

		await userResumesCollection.updateOne(
			{ _id: objectId },
			{
				$set: {
					embedding: {
						model: model || process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
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

export function upsertJobEmbeddingAsync(jobId, opts = {}) {
	void upsertJobEmbedding(jobId, opts).catch((err) =>
		console.warn(`[embedding] async job ${jobId}:`, err.message),
	);
}

export function upsertResumeEmbeddingAsync(resumeId, ownerName, opts = {}) {
	void upsertResumeEmbedding(resumeId, ownerName, opts).catch((err) =>
		console.warn(`[embedding] async resume ${resumeId}:`, err.message),
	);
}

export async function removeResumeEmbedding(resumeId) {
	await deleteResumeVector(resumeId);
}

export async function removeJobEmbedding(jobId) {
	await deleteJobVector(jobId);
}
