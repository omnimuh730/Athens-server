import crypto from 'crypto';
import {
	JOB_VECTORS_COLLECTION,
	RESUME_VECTORS_COLLECTION,
	getVectorDimensions,
} from './collections.js';

let collectionsReady = false;

export function isQdrantConfigured() {
	return Boolean(process.env.QDRANT_URL);
}

function baseUrl() {
	return (process.env.QDRANT_URL || '').replace(/\/$/, '');
}

async function qdrantFetch(path, { method = 'GET', body } = {}) {
	const url = `${baseUrl()}${path}`;
	const headers = { 'Content-Type': 'application/json' };
	if (process.env.QDRANT_API_KEY) {
		headers['api-key'] = process.env.QDRANT_API_KEY;
	}

	const res = await fetch(url, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw new Error(`Qdrant ${method} ${path} → ${res.status}: ${errText.slice(0, 300)}`);
	}

	if (res.status === 204) return null;
	return res.json();
}

/** Deterministic UUID from Mongo id string for Qdrant point ids. */
export function toPointId(mongoId) {
	const hash = crypto.createHash('sha256').update(String(mongoId)).digest('hex');
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function ensureCollection(name) {
	if (!isQdrantConfigured()) return false;

	const dim = getVectorDimensions();
	const list = await qdrantFetch('/collections');
	const exists = list?.result?.collections?.some((c) => c.name === name);
	if (!exists) {
		await qdrantFetch(`/collections/${encodeURIComponent(name)}`, {
			method: 'PUT',
			body: {
				vectors: { size: dim, distance: 'Cosine' },
			},
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
		await ensureJobPayloadIndexes();
		collectionsReady = true;
		console.log('[qdrant] collections ready');
		return true;
	} catch (err) {
		const url = process.env.QDRANT_URL || '(not set)';
		console.error(
			`[qdrant] init failed: ${err.message}. `
			+ `Is Qdrant running at ${url}? Try: cd Athens-server && npm run qdrant:start`,
		);
		return false;
	}
}

/** Payload indexes for pre-filtering job vectors (source, postedAt). */
async function ensureJobPayloadIndexes() {
	if (!isQdrantConfigured()) return;
	const indexes = [
		{ field_name: 'source', field_schema: 'keyword' },
		{ field_name: 'postedAt', field_schema: 'keyword' },
	];
	for (const index of indexes) {
		try {
			await qdrantFetch(
				`/collections/${encodeURIComponent(JOB_VECTORS_COLLECTION)}/index`,
				{ method: 'PUT', body: index },
			);
		} catch (err) {
			const msg = String(err.message || err);
			if (!msg.includes('already exists')) {
				console.warn(`[qdrant] payload index ${index.field_name}:`, msg);
			}
		}
	}
}

export function isQdrantReady() {
	return collectionsReady && isQdrantConfigured();
}

export async function upsertJobVector(jobId, vector, payload = {}) {
	if (!isQdrantReady()) return false;

	await qdrantFetch(`/collections/${encodeURIComponent(JOB_VECTORS_COLLECTION)}/points?wait=true`, {
		method: 'PUT',
		body: {
			points: [{
				id: toPointId(jobId),
				vector,
				payload: { jobId: String(jobId), ...payload },
			}],
		},
	});
	return true;
}

export async function upsertResumeVector(resumeId, vector, payload = {}) {
	if (!isQdrantReady()) return false;

	await qdrantFetch(`/collections/${encodeURIComponent(RESUME_VECTORS_COLLECTION)}/points?wait=true`, {
		method: 'PUT',
		body: {
			points: [{
				id: toPointId(resumeId),
				vector,
				payload: { resumeId: String(resumeId), ...payload },
			}],
		},
	});
	return true;
}

export async function deleteResumeVector(resumeId) {
	if (!isQdrantReady()) return false;
	try {
		await qdrantFetch(`/collections/${encodeURIComponent(RESUME_VECTORS_COLLECTION)}/points/delete?wait=true`, {
			method: 'POST',
			body: { points: [toPointId(resumeId)] },
		});
	} catch {
		// Point may not exist
	}
	return true;
}

export async function deleteJobVector(jobId) {
	if (!isQdrantReady()) return false;
	try {
		await qdrantFetch(`/collections/${encodeURIComponent(JOB_VECTORS_COLLECTION)}/points/delete?wait=true`, {
			method: 'POST',
			body: { points: [toPointId(jobId)] },
		});
	} catch {
		// Point may not exist
	}
	return true;
}

export async function searchJobVectors(queryVector, options = {}) {
	if (!isQdrantReady() || !queryVector?.length) return [];

	const limit = Number(options.limit) || 200;
	const offset = Math.max(0, Number(options.offset) || 0);
	const body = {
		vector: queryVector,
		limit,
		offset,
		with_payload: true,
	};
	if (options.filter) body.filter = options.filter;
	if (options.scoreThreshold !== undefined && options.scoreThreshold !== null) {
		body.score_threshold = options.scoreThreshold;
	}

	const data = await qdrantFetch(`/collections/${encodeURIComponent(JOB_VECTORS_COLLECTION)}/points/search`, {
		method: 'POST',
		body,
	});

	return (data?.result || []).map((hit) => ({
		jobId: hit.payload?.jobId || null,
		score: hit.score ?? 0,
		payload: hit.payload || {},
	}));
}

/** Count job vectors matching an optional Qdrant filter. */
export async function countJobVectors(filter) {
	if (!isQdrantReady()) return 0;
	const body = filter ? { filter, exact: true } : { exact: true };
	const data = await qdrantFetch(
		`/collections/${encodeURIComponent(JOB_VECTORS_COLLECTION)}/points/count`,
		{ method: 'POST', body },
	);
	return data?.result?.count ?? 0;
}

export async function getResumeVector(resumeId) {
	if (!isQdrantReady()) return null;

	const data = await qdrantFetch(`/collections/${encodeURIComponent(RESUME_VECTORS_COLLECTION)}/points`, {
		method: 'POST',
		body: {
			ids: [toPointId(resumeId)],
			with_vector: true,
			with_payload: true,
		},
	});

	const point = data?.result?.[0];
	if (!point?.vector) return null;
	return { vector: point.vector, payload: point.payload || {} };
}

export function profilePointId(ownerName) {
	return toPointId(`profile:${String(ownerName || '').trim()}`);
}

export async function upsertProfileVector(ownerName, vector, payload = {}) {
	if (!isQdrantReady()) return false;

	const name = String(ownerName || '').trim();
	await qdrantFetch(`/collections/${encodeURIComponent(RESUME_VECTORS_COLLECTION)}/points?wait=true`, {
		method: 'PUT',
		body: {
			points: [{
				id: profilePointId(name),
				vector,
				payload: {
					ownerName: name,
					resumeId: '__profile__',
					kind: 'profile',
					...payload,
				},
			}],
		},
	});
	return true;
}

export async function getProfileVector(ownerName) {
	if (!isQdrantReady()) return null;

	const data = await qdrantFetch(`/collections/${encodeURIComponent(RESUME_VECTORS_COLLECTION)}/points`, {
		method: 'POST',
		body: {
			ids: [profilePointId(ownerName)],
			with_vector: true,
			with_payload: true,
		},
	});

	const point = data?.result?.[0];
	if (!point?.vector) return null;
	return { vector: point.vector, payload: point.payload || {} };
}

export async function deleteProfileVector(ownerName) {
	if (!isQdrantReady()) return false;
	try {
		await qdrantFetch(`/collections/${encodeURIComponent(RESUME_VECTORS_COLLECTION)}/points/delete?wait=true`, {
			method: 'POST',
			body: { points: [profilePointId(ownerName)] },
		});
	} catch {
		// Point may not exist
	}
	return true;
}
