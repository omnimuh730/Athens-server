import { chatCompletion } from '../llm/llmService.js';
import { getEnrichmentApiKey, getEnrichmentModel } from './config.js';

const SYSTEM = `You suggest search keywords to find an existing software skill in a knowledge graph.
Return JSON only: { "searchKeywords": string[] }
Provide 3-5 short keywords (lowercase, no sentences). Include canonical tech names and parent technologies.`;

export async function suggestSearchKeywords(rawSkill) {
	const apiKey = getEnrichmentApiKey();
	if (!apiKey) {
		// Fallback: derive keywords from the raw string without LLM
		const parts = String(rawSkill).toLowerCase().split(/[^a-z0-9+#.]+/).filter(p => p.length > 1);
		return { searchKeywords: [...new Set(parts)].slice(0, 5), usage: null };
	}

	const { content, usage } = await chatCompletion({
		provider: 'openai',
		apiKey,
		model: getEnrichmentModel('keyword'),
		messages: [
			{ role: 'system', content: SYSTEM },
			{ role: 'user', content: JSON.stringify({ rawSkill }) },
		],
		jsonMode: true,
		cacheKey: 'skill-graph-keywords-v1',
		timeoutMs: 30_000,
	});

	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch {
		parsed = { searchKeywords: [] };
	}

	const searchKeywords = Array.isArray(parsed.searchKeywords)
		? parsed.searchKeywords.map(String).filter(Boolean).slice(0, 5)
		: [];

	return { searchKeywords, usage };
}
