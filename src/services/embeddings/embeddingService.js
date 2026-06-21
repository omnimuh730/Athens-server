import crypto from 'crypto';
import { accountInfoCollection } from '../../db/mongo.js';
import { getProvider } from '../llm/llmService.js';

/** Ollama model — top MTEB English retrieval model in the Ollama library. */
export const DEFAULT_OLLAMA_EMBED_MODEL = 'mxbai-embed-large';

/** Required prefix for mxbai query-side embeddings (resumes searching jobs). */
export const MXBAI_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

const textHashCache = new Map();

export function getOllamaUrl() {
	return (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

export function getEmbeddingConfig() {
	const provider = (process.env.EMBEDDING_PROVIDER || 'ollama').toLowerCase();
	if (provider === 'openai') {
		return {
			provider: 'openai',
			model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
			dimensions: Number(process.env.EMBEDDING_DIMENSIONS) || 1536,
		};
	}
	return {
		provider: 'ollama',
		model: process.env.EMBEDDING_MODEL || DEFAULT_OLLAMA_EMBED_MODEL,
		dimensions: Number(process.env.EMBEDDING_DIMENSIONS) || 1024,
	};
}

export function hashEmbeddingText(text) {
	return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** Prepare input for the active model (mxbai query vs document asymmetry). */
export function prepareEmbeddingInput(text, { role = 'document', model } = {}) {
	const normalized = String(text || '').trim();
	if (!normalized) return '';

	const modelName = model || getEmbeddingConfig().model;
	const useMxbaiPrefix = modelName.startsWith('mxbai-embed') && role === 'query';
	if (useMxbaiPrefix) {
		return `${MXBAI_QUERY_PREFIX}${normalized}`;
	}
	return normalized;
}

/** mxbai-embed-large has a 512-token context window — truncate to stay safe. */
export function truncateForEmbeddingModel(text, model) {
	const modelName = model || getEmbeddingConfig().model;
	if (!modelName.startsWith('mxbai-embed')) return text;
	const max = Number(process.env.EMBEDDING_MAX_INPUT_CHARS) || 1800;
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[truncated]`;
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

async function callOllamaEmbeddings({ model, input }) {
	const baseUrl = getOllamaUrl();
	const res = await fetch(`${baseUrl}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model, input }),
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw new Error(
			`Ollama embed error ${res.status}: ${errText.slice(0, 300)}. `
			+ `Is Ollama running? Try: ollama pull ${model}`,
		);
	}

	const data = await res.json();
	const vector = data?.embeddings?.[0];
	if (!Array.isArray(vector) || !vector.length) {
		throw new Error('Ollama returned no embedding vector');
	}
	return vector;
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
		throw new Error(`OpenAI embedding error ${res.status}: ${errText.slice(0, 300)}`);
	}

	const data = await res.json();
	const vector = data?.data?.[0]?.embedding;
	if (!Array.isArray(vector) || !vector.length) {
		throw new Error('OpenAI embedding API returned no vector');
	}
	return vector;
}

/**
 * Generate embedding vector for text.
 * @param {object} options
 * @param {'document'|'query'} [options.role] — `query` for resume-side (search); `document` for jobs
 */
export async function embedText(text, { applierName, role = 'document' } = {}) {
	const { provider, model, dimensions } = getEmbeddingConfig();
	const prepared = prepareEmbeddingInput(text, { role, model });
	if (!prepared) throw new Error('Cannot embed empty text');

	const input = truncateForEmbeddingModel(prepared, model);

	const cacheKey = `${provider}:${model}:${role}:${hashEmbeddingText(input)}`;
	const cached = textHashCache.get(cacheKey);
	if (cached) return { vector: cached, textHash: hashEmbeddingText(input), cached: true, model };

	let vector;
	if (provider === 'ollama') {
		vector = await callOllamaEmbeddings({ model, input });
	} else if (provider === 'openai') {
		const apiKey = await loadOpenaiApiKey(applierName);
		if (!apiKey) {
			throw new Error('No OpenAI API key configured (autoBidProfile.openaiApiKey)');
		}
		vector = await callOpenAiEmbeddings({ apiKey, model, dimensions, text: input });
	} else {
		throw new Error(`Unsupported embedding provider: ${provider}`);
	}

	textHashCache.set(cacheKey, vector);
	return { vector, textHash: hashEmbeddingText(input), cached: false, model };
}

/** Verify Ollama is reachable and the embedding model is pulled. */
export async function checkOllamaEmbeddingReady() {
	const { model } = getEmbeddingConfig();
	if (getEmbeddingConfig().provider !== 'ollama') return { ok: true };

	try {
		const res = await fetch(`${getOllamaUrl()}/api/tags`);
		if (!res.ok) return { ok: false, error: `Ollama tags HTTP ${res.status}` };
		const data = await res.json();
		const names = (data?.models || []).map((m) => m.name?.split(':')[0] || m.name);
		const base = model.split(':')[0];
		if (!names.some((n) => n === base || n === model)) {
			return { ok: false, error: `Model "${model}" not found. Run: ollama pull ${model}` };
		}
		return { ok: true, model };
	} catch (err) {
		return { ok: false, error: err.message };
	}
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
