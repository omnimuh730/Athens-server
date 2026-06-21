import crypto from 'crypto';
import { accountInfoCollection } from '../../db/mongo.js';
import { getProvider } from '../llm/llmService.js';

const textHashCache = new Map();

export function getEmbeddingConfig() {
	return {
		provider: process.env.EMBEDDING_PROVIDER || 'openai',
		model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
		dimensions: Number(process.env.EMBEDDING_DIMENSIONS) || 1536,
	};
}

export function hashEmbeddingText(text) {
	return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export async function loadOpenaiApiKey(applierName) {
	if (!accountInfoCollection) return '';

	const filter = { 'autoBidProfile.openaiApiKey': { $exists: true, $nin: ['', null] } };
	if (applierName?.trim()) filter.name = applierName.trim();

	let acc = await accountInfoCollection.findOne(filter, {
		projection: { 'autoBidProfile.openaiApiKey': 1, name: 1 },
	});

	if (!acc && applierName?.trim()) {
		acc = await accountInfoCollection.findOne(
			{ 'autoBidProfile.openaiApiKey': { $exists: true, $nin: ['', null] } },
			{ projection: { 'autoBidProfile.openaiApiKey': 1, name: 1 } },
		);
	}

	return acc?.autoBidProfile?.openaiApiKey?.trim() || '';
}

async function callOpenAiEmbeddings({ apiKey, model, dimensions, text }) {
	const provider = getProvider('openai');
	const body = {
		model,
		input: text,
	};
	if (dimensions) body.dimensions = dimensions;

	const res = await fetch(`${provider.baseUrl}/embeddings`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw new Error(`Embedding API error ${res.status}: ${errText.slice(0, 300)}`);
	}

	const data = await res.json();
	const vector = data?.data?.[0]?.embedding;
	if (!Array.isArray(vector) || !vector.length) {
		throw new Error('Embedding API returned no vector');
	}
	return vector;
}

/**
 * Generate embedding vector for text. Uses in-memory cache keyed by text hash.
 */
export async function embedText(text, { applierName } = {}) {
	const normalized = String(text || '').trim();
	if (!normalized) throw new Error('Cannot embed empty text');

	const textHash = hashEmbeddingText(normalized);
	const cached = textHashCache.get(textHash);
	if (cached) return { vector: cached, textHash, cached: true };

	const { provider, model, dimensions } = getEmbeddingConfig();
	if (provider !== 'openai') {
		throw new Error(`Unsupported embedding provider: ${provider}`);
	}

	const apiKey = await loadOpenaiApiKey(applierName);
	if (!apiKey) {
		throw new Error('No OpenAI API key configured (autoBidProfile.openaiApiKey)');
	}

	const vector = await callOpenAiEmbeddings({ apiKey, model, dimensions, text: normalized });
	textHashCache.set(textHash, vector);
	return { vector, textHash, cached: false, model };
}

export function cosineSimilarity(a, b) {
	if (!a?.length || !b?.length || a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i += 1) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Map cosine similarity [-1,1] to 0–100 percentage. */
export function cosineToScore(similarity) {
	const clamped = Math.max(-1, Math.min(1, similarity));
	return Math.round(((clamped + 1) / 2) * 100);
}
