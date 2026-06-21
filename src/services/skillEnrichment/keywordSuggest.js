import { chatCompletion } from '../llm/llmService.js';
import { getEnrichmentModel } from './config.js';

const SYSTEM = `You suggest search keywords to find an existing software skill in a knowledge graph.
Return JSON only: { "searchKeywords": string[] }
Provide 3-5 short keywords (lowercase, no sentences). Include canonical tech names and parent technologies.`;

/** Free tokenization — no LLM. Used in fast mode and as first pass in smart mode. */
export function heuristicSearchKeywords(rawSkill) {
	const parts = String(rawSkill).toLowerCase().split(/[^a-z0-9+#.]+/).filter(p => p.length > 1);
	return [...new Set(parts)].slice(0, 5);
}

export async function suggestSearchKeywords(rawSkill, llmConfig = null) {
	if (!llmConfig?.apiKey) {
		return { searchKeywords: heuristicSearchKeywords(rawSkill), usage: null };
	}

	const { content, usage } = await chatCompletion({
		provider: llmConfig.provider,
		apiKey: llmConfig.apiKey,
		model: getEnrichmentModel('keyword', llmConfig),
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
