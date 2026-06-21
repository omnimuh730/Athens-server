import crypto from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
	JOB_VECTORS_COLLECTION,
	RESUME_VECTORS_COLLECTION,
	getVectorDimensions,
} from './collections.js';

let client = null;
let collectionsReady = false;

export function isQdrantConfigured() {
	return Boolean(process.env.QDRANT_URL);
}

function getClient() {
	if (!isQdrantConfigured()) return null;
	if (!client) {
		client = new QdrantClient({
			url: process.env.QDRANT_URL,
			apiKey: process.env.QDRANT_API_KEY || undefined,
		});
	}
	return client;
}

/** Deterministic UUID from Mongo id string for Qdrant point ids. */
export function toPointId(mongoId) {
	const hash = crypto.createHash('sha256').update(String(mongoId)).digest('hex');
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function ensureCollection(name) {
	const qdrant = getClient();
	if (!qdrant) return false;

	const dim = getVectorDimensions();
	const collections = await qdrant.getCollections();
	const exists = collections.collections?.some((c) => c.name === name);
	if (!exists) {
		await qdrant.createCollection(name, {
			vectors: { size: dim, distance: 'Cosine' },
		});
	}
	return true;
}

export async function initQdrantCollections() {
	if (!isQdrantConfigured()) {
		console.warn('[qdrant] QDRANT_URL not set — vector recommendations disabled');
		return false;
	}
	try {
		await ensureCollection(JOB_VECTORS_COLLECTION);
		await ensureCollection(RESUME_VECTORS_COLLECTION);
		collectionsReady = true;
		console.log('[qdrant] collections ready');
		return true;
	} catch (err) {
		console.error('[qdrant] init failed:', err.message);
		return false;
	}
}

export function isQdrantReady() {
	return collectionsReady && isQdrantConfigured();
}

export async function upsertJobVector(jobId, vector, payload = {}) {
	const qdrant = getClient();
	if (!qdrant || !collectionsReady) return false;

	await qdrant.upsert(JOB_VECTORS_COLLECTION, {
		wait: true,
		points: [{
			id: toPointId(jobId),
			vector,
			payload: { jobId: String(jobId), ...payload },
		}],
	});
	return true;
}

export async function upsertResumeVector(resumeId, vector, payload = {}) {
	const qdrant = getClient();
	if (!qdrant || !collectionsReady) return false;

	await qdrant.upsert(RESUME_VECTORS_COLLECTION, {
		wait: true,
		points: [{
			id: toPointId(resumeId),
			vector,
			payload: { resumeId: String(resumeId), ...payload },
		}],
	});
	return true;
}

export async function deleteResumeVector(resumeId) {
	const qdrant = getClient();
	if (!qdrant || !collectionsReady) return false;
	try {
		await qdrant.delete(RESUME_VECTORS_COLLECTION, {
			wait: true,
			points: [toPointId(resumeId)],
		});
	} catch {
		// Point may not exist
	}
	return true;
}

export async function deleteJobVector(jobId) {
	const qdrant = getClient();
	if (!qdrant || !collectionsReady) return false;
	try {
		await qdrant.delete(JOB_VECTORS_COLLECTION, {
			wait: true,
			points: [toPointId(jobId)],
		});
	} catch {
		// Point may not exist
	}
	return true;
}

export async function searchJobVectors(queryVector, limit = 200) {
	const qdrant = getClient();
	if (!qdrant || !collectionsReady) return [];

	const result = await qdrant.search(JOB_VECTORS_COLLECTION, {
		vector: queryVector,
		limit,
		with_payload: true,
	});
	return (result || []).map((hit) => ({
		jobId: hit.payload?.jobId || null,
		score: hit.score ?? 0,
		payload: hit.payload || {},
	}));
}

export async function getResumeVector(resumeId) {
	const qdrant = getClient();
	if (!qdrant || !collectionsReady) return null;

	const result = await qdrant.retrieve(RESUME_VECTORS_COLLECTION, {
		ids: [toPointId(resumeId)],
		with_vector: true,
		with_payload: true,
	});
	const point = result?.[0];
	if (!point?.vector) return null;
	return { vector: point.vector, payload: point.payload || {} };
}
