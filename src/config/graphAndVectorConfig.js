/**
 * Central configuration for knowledge graph, embeddings, Qdrant, and recommendation scoring.
 * All tunables read from process.env with documented defaults — avoid hardcoding in services.
 */

function envFloat(name, fallback) {
	const n = Number(process.env[name]);
	return Number.isFinite(n) ? n : fallback;
}

function envInt(name, fallback) {
	const n = Number.parseInt(String(process.env[name] ?? ''), 10);
	return Number.isFinite(n) ? n : fallback;
}

function envString(name, fallback) {
	const v = process.env[name];
	return v !== undefined && v !== '' ? v : fallback;
}

function envJsonObject(name, fallback) {
	const raw = process.env[name];
	if (!raw?.trim()) return { ...fallback };
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? { ...fallback, ...parsed }
			: { ...fallback };
	} catch {
		return { ...fallback };
	}
}

// ── Knowledge graph confidence ───────────────────────────────────────────────

export function getKgConfidenceAliasExact() {
	return envFloat('KG_CONFIDENCE_ALIAS_EXACT', 1.0);
}

export function getKgConfidenceAliasLlmDefault() {
	return envFloat('KG_CONFIDENCE_ALIAS_LLM_DEFAULT', 0.85);
}

export function getKgConfidenceRelationDefault() {
	return envFloat('KG_CONFIDENCE_RELATION_DEFAULT', 0.8);
}

export function getKgConfidenceEnrichHeuristic() {
	return envFloat('KG_CONFIDENCE_ENRICH_HEURISTIC', 0.5);
}

export function getKgConfidenceEnrichHeuristicRelated() {
	return envFloat('KG_CONFIDENCE_ENRICH_HEURISTIC_RELATED', 0.4);
}

export function getKgConfidenceEnhanceMin() {
	return envFloat('KG_CONFIDENCE_ENHANCE_MIN', 0.5);
}

export function getKgConfidenceEnhanceMax() {
	return envFloat('KG_CONFIDENCE_ENHANCE_MAX', 1.0);
}

export function getKgConfidenceCooccurrenceEdge() {
	return envFloat('KG_CONFIDENCE_COOCURRENCE_EDGE', 0.3);
}

export function getKgConfidenceDefaultEdgeWeight() {
	return envFloat('KG_CONFIDENCE_DEFAULT_EDGE_WEIGHT', 0.5);
}

export function getKgConfidenceUnknownRelation() {
	return envFloat('KG_CONFIDENCE_UNKNOWN_RELATION', 0.3);
}

export function getKgSearchKeywordExactScore() {
	return envFloat('KG_SEARCH_KEYWORD_EXACT_SCORE', 0.98);
}

export function getKgSearchKeywordPartialScore() {
	return envFloat('KG_SEARCH_KEYWORD_PARTIAL_SCORE', 0.9);
}

export function getKgAmbiguousScoreMin() {
	return envFloat('KG_AMBIGUOUS_SCORE_MIN', 0.5);
}

// ── Spreading activation (PageRank) ──────────────────────────────────────────

export function getActivationParams() {
	return {
		alpha: envFloat('KG_ACTIVATION_ALPHA', 0.82),
		lambda: envFloat('KG_ACTIVATION_LAMBDA', 0.35),
		eta: envFloat('KG_ACTIVATION_ETA', 0.6),
		maxIterations: envInt('KG_ACTIVATION_MAX_ITERATIONS', 100),
		tolerance: envFloat('KG_ACTIVATION_TOLERANCE', 1e-6),
	};
}

const DEFAULT_RELATION_MULTIPLIERS = {
	PREREQUISITE_OF: 1.0,
	BUILDS_ON: 0.95,
	USED_WITH: 0.8,
	RELATED_TO: 0.6,
	PART_OF: 0.7,
	ALTERNATIVE_TO: 0.5,
	SPECIALIZATION_OF: 0.75,
};

export function getRelationMultipliers() {
	return envJsonObject('KG_RELATION_MULTIPLIERS', DEFAULT_RELATION_MULTIPLIERS);
}

const DEFAULT_DIRECT_MATCH_WEIGHTS = {
	direct: 1.0,
	BUILDS_ON: 0.85,
	PREREQUISITE_OF: 0.85,
	SPECIALIZATION_OF: 0.75,
	RELATED_TO: 0.55,
	USED_WITH: 0.55,
	ALTERNATIVE_TO: 0.4,
	PART_OF: 0.2,
	unresolved: 0.5,
	ROLE: 0.3,
	SOFT_SKILL: 0.3,
};

export function getDirectMatchWeights() {
	return envJsonObject('KG_DIRECT_MATCH_WEIGHTS', DEFAULT_DIRECT_MATCH_WEIGHTS);
}

// ── Co-occurrence → USED_WITH ────────────────────────────────────────────────

export function getCoocWeightCap() {
	return envFloat('KG_COOC_WEIGHT_CAP', 0.85);
}

export function getCoocWeightBase() {
	return envFloat('KG_COOC_WEIGHT_BASE', 0.3);
}

export function getCoocWeightLogFactor() {
	return envFloat('KG_COOC_WEIGHT_LOG_FACTOR', 0.15);
}

export function getProfileGraphCoocEdgeWeight() {
	return envFloat('KG_PROFILE_COOC_EDGE_WEIGHT', 0.3);
}

// ── Job list & recommendation score weights ──────────────────────────────────

export function getJobListScoreWeights() {
	return {
		skill: envFloat('JOB_SCORE_WEIGHT_SKILL', 0.45),
		applicant: envFloat('JOB_SCORE_WEIGHT_APPLICANT', 0.2),
		freshness: envFloat('JOB_SCORE_WEIGHT_FRESHNESS', 0.2),
		salary: envFloat('JOB_SCORE_WEIGHT_SALARY', 0.15),
	};
}

export function getMatchScoreWeights() {
	return {
		vector: envFloat('RECOMMENDATION_MATCH_VECTOR_WEIGHT', 0.55),
		graph: envFloat('RECOMMENDATION_MATCH_GRAPH_WEIGHT', 0.30),
		secondary: envFloat('RECOMMENDATION_MATCH_SECONDARY_WEIGHT', 0.15),
		secondaryNoSalaryApplicant: envFloat('RECOMMENDATION_SECONDARY_NO_SALARY_APPLICANT', 0.5),
		secondaryNoSalaryFreshness: envFloat('RECOMMENDATION_SECONDARY_NO_SALARY_FRESHNESS', 0.5),
		secondaryWithSalaryApplicant: envFloat('RECOMMENDATION_SECONDARY_SALARY_APPLICANT', 0.34),
		secondaryWithSalaryFreshness: envFloat('RECOMMENDATION_SECONDARY_SALARY_FRESHNESS', 0.33),
		secondaryWithSalarySalary: envFloat('RECOMMENDATION_SECONDARY_SALARY_SALARY', 0.33),
	};
}

// ── Qdrant & embeddings ──────────────────────────────────────────────────────

export function getQdrantUrl() {
	return envString('QDRANT_URL', '');
}

export function getQdrantApiKey() {
	return envString('QDRANT_API_KEY', '');
}

export function getVectorDimensions() {
	return envInt('EMBEDDING_DIMENSIONS', 1024);
}

export function getVectorTopK() {
	return envInt('RECOMMENDATION_VECTOR_TOP_K', 200);
}

export function getCandidatePoolSize() {
	return envInt('RECOMMENDATION_CANDIDATE_POOL', 500);
}

export function getEmbeddingProvider() {
	return envString('EMBEDDING_PROVIDER', 'ollama').toLowerCase();
}

export function getOllamaUrl() {
	return envString('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/$/, '');
}

export function getEmbeddingModel() {
	const provider = getEmbeddingProvider();
	if (provider === 'openai') {
		return envString('EMBEDDING_MODEL', 'text-embedding-3-small');
	}
	return envString('EMBEDDING_MODEL', 'mxbai-embed-large');
}

export function getEmbeddingMaxInputChars() {
	return envInt('EMBEDDING_MAX_INPUT_CHARS', 1800);
}

export function getEmbeddingDimensionsForProvider() {
	const provider = getEmbeddingProvider();
	if (provider === 'openai') {
		return envInt('EMBEDDING_DIMENSIONS', 1536);
	}
	return envInt('EMBEDDING_DIMENSIONS', 1024);
}

// ── Neo4j GDS (path scoring + link prediction) ───────────────────────────────

export function getGdsGraphName() {
	return envString('NEO4J_GDS_GRAPH_NAME', 'skill-graph');
}

export function getKgLinkPredictionMinScore() {
	return envFloat('KG_LINK_PREDICTION_MIN_SCORE', 0.6);
}

export function getKgPathScoreMode() {
	return envString('KG_PATH_SCORE_MODE', 'inverse_cost');
}

export function getKgPathHopDecay() {
	return envFloat('KG_PATH_HOP_DECAY', 0.85);
}

export function getKgGdsFallbackToCypher() {
	return process.env.KG_GDS_FALLBACK_TO_CYPHER !== 'false';
}

export function getGdsRefreshDebounceMs() {
	return envInt('NEO4J_GDS_REFRESH_DEBOUNCE_MS', 30_000);
}

export function getSkillGraphMaintenanceEnabled() {
	return process.env.SKILL_GRAPH_MAINTENANCE_ENABLED !== 'false';
}

export function getSkillGraphMaintenanceIntervalMs() {
	return envInt('SKILL_GRAPH_MAINTENANCE_INTERVAL_MS', 15_000);
}

export function getSkillGraphLinkPredictionIntervalMs() {
	return envInt('SKILL_GRAPH_LINK_PREDICTION_INTERVAL_MS', 300_000);
}

export function getSkillGraphBridgeLlmEnabled() {
	return process.env.SKILL_GRAPH_BRIDGE_LLM_ENABLED === 'true';
}

export function getSkillGraphMaintenanceBatchSize() {
	return envInt('SKILL_GRAPH_MAINTENANCE_BATCH_SIZE', 5);
}
