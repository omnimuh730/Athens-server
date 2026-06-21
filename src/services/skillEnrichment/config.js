/** OpenAI config for skill graph enrichment worker. */

export function getEnrichmentApiKey() {
	return process.env.SKILL_GRAPH_OPENAI_API_KEY?.trim()
		|| process.env.OPENAI_API_KEY?.trim()
		|| '';
}

export function getEnrichmentModel(purpose = 'keyword') {
	if (purpose === 'enrich_escalated') {
		return process.env.SKILL_GRAPH_ENRICH_MODEL_ESCALATED?.trim() || 'gpt-4o';
	}
	if (purpose === 'enrich') {
		return process.env.SKILL_GRAPH_ENRICH_MODEL?.trim() || 'gpt-4o-mini';
	}
	return process.env.SKILL_GRAPH_KEYWORD_MODEL?.trim() || 'gpt-4o-mini';
}

export function isEnrichmentEnabled() {
	return process.env.SKILL_GRAPH_ENRICHMENT_ENABLED !== 'false';
}

export function getWorkerIntervalMs() {
	return Number(process.env.SKILL_GRAPH_WORKER_INTERVAL_MS) || 5000;
}

export function getWorkerBatchSize() {
	return Number(process.env.SKILL_GRAPH_WORKER_BATCH_SIZE) || 3;
}
