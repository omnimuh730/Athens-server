import { isNeo4jReady, runRead } from '../../db/neo4j.js';
import { normalizeSkillKey, stringSimilarity } from '../skillGraph/normalize.js';
import { findExactMatch, searchCandidates } from '../skillGraph/search.js';
import { applyEnrichmentResult, linkAlias } from '../skillGraph/apply.js';
import { suggestSearchKeywords } from './keywordSuggest.js';
import { enrichAgainstCandidates, buildHeuristicResult } from './enrich.js';
import {
	getEnrichmentModel,
	getEnrichmentMode,
	getFuzzyAliasThreshold,
	getAmbiguousScoreRange,
	isSmartEnrichmentMode,
} from './config.js';
import { traceSkill } from './trace.js';
import { addUsage, EMPTY_USAGE } from '../llm/llmService.js';

function isAmbiguous(candidates, fuzzyThreshold) {
	if (!candidates.length) return false;
	const { min, max } = getAmbiguousScoreRange();
	const top = candidates[0]?.score ?? 0;
	if (top >= fuzzyThreshold) return false;
	if (top < min) return false;
	return candidates.filter(c => c.score >= min && c.score < max).length >= 1
		&& (candidates.length >= 2 || top >= min);
}

/**
 * Process one raw skill through normalize → search → enrich → apply.
 * Only the skills[] surface form is analyzed — job description is never sent to the LLM.
 */
export async function processEnrichmentItem(item, llmConfig = null, ctx = {}) {
	const { surfaceForm, normalizedKey, cooccurringSkills = [] } = item;
	const mode = ctx.mode || getEnrichmentMode();
	const fuzzyThreshold = getFuzzyAliasThreshold();
	let usage = EMPTY_USAGE();

	traceSkill('start', {
		jobId: ctx.jobId,
		surfaceForm,
		normalizedKey,
		cooccurringSkills,
		mode,
	});

	const exact = await findExactMatch(normalizedKey);
	if (exact) {
		traceSkill('exact_match', { normalizedKey, skillId: exact.id, label: exact.label });
		await linkAlias({
			surfaceForm,
			normalizedKey,
			skillId: exact.id,
			confidence: 1,
			source: 'exact',
		});
		return {
			skillId: exact.id,
			path: 'exact',
			enrichmentPath: 'exact',
			action: 'alias',
			relationshipCount: 0,
			usage,
		};
	}

	let candidates = await searchCandidates({
		rawSkill: surfaceForm,
		normalizedKey,
		searchKeywords: [],
		limit: 10,
	});

	traceSkill('search_candidates', {
		normalizedKey,
		candidateCount: candidates.length,
		top: candidates.slice(0, 3).map(c => ({ id: c.id, label: c.label, score: c.score, matchType: c.matchType })),
	});

	if (candidates.length === 1 && candidates[0].score >= fuzzyThreshold
		&& stringSimilarity(surfaceForm, candidates[0].label) >= fuzzyThreshold) {
		traceSkill('fuzzy_auto_alias', { normalizedKey, skillId: candidates[0].id, score: candidates[0].score });
		await linkAlias({
			surfaceForm,
			normalizedKey,
			skillId: candidates[0].id,
			confidence: candidates[0].score,
			source: 'fuzzy_auto',
		});
		return {
			skillId: candidates[0].id,
			path: 'fuzzy_auto',
			enrichmentPath: 'fuzzy_auto',
			action: 'alias',
			relationshipCount: 0,
			usage,
		};
	}

	const topScore = candidates[0]?.score ?? 0;

	if (topScore < fuzzyThreshold) {
		const { searchKeywords, usage: kwUsage } = await suggestSearchKeywords(surfaceForm, null);
		if (kwUsage) usage = addUsage(usage, kwUsage);
		traceSkill('keyword_suggest', { normalizedKey, searchKeywords, llmUsage: kwUsage, heuristic: true });
		if (searchKeywords.length) {
			candidates = await searchCandidates({
				rawSkill: surfaceForm,
				normalizedKey,
				searchKeywords,
				limit: 10,
			});
			traceSkill('search_after_keywords', {
				normalizedKey,
				candidateCount: candidates.length,
				top: candidates.slice(0, 3).map(c => ({ id: c.id, label: c.label, score: c.score })),
			});
		}
	}

	const useLlm = mode === 'smart'
		&& isSmartEnrichmentMode()
		&& isAmbiguous(candidates, fuzzyThreshold)
		&& llmConfig?.apiKey;

	let result;
	let enrichUsage = null;
	let enrichmentPath = 'heuristic';

	if (useLlm) {
		const enriched = await enrichAgainstCandidates({
			rawSkill: surfaceForm,
			normalizedKey,
			candidates,
			cooccurringSkills,
			llmConfig,
		});
		result = enriched.result;
		enrichUsage = enriched.usage;
		usage = addUsage(usage, enrichUsage);
		enrichmentPath = 'llm';
		traceSkill('llm_decision', {
			normalizedKey,
			action: result.action,
			targetId: result.targetId,
			confidence: result.confidence,
			skillType: result.skillType,
			category: result.category,
			newNodeLabel: result.newNode?.label,
			relationships: result.relationships,
			llmUsage: usage,
		});
	} else {
		const heuristic = buildHeuristicResult(surfaceForm, normalizedKey, candidates, fuzzyThreshold);
		result = heuristic.result;
		traceSkill('heuristic_decision', {
			normalizedKey,
			action: result.action,
			targetId: result.targetId,
			candidateCount: candidates.length,
		});
	}

	const applied = await applyEnrichmentResult({
		surfaceForm,
		normalizedKey,
		result,
		modelVersion: useLlm ? getEnrichmentModel('enrich', llmConfig) : 'heuristic-v1',
	});

	const path = enrichmentPath === 'llm' ? 'enriched' : 'heuristic';

	traceSkill('applied', {
		normalizedKey,
		surfaceForm,
		...applied,
		path,
		enrichmentPath,
		usage,
	});

	return { ...applied, path, enrichmentPath, usage };
}

/** Enrich every distinct entry in job.skills[] (not job.description). */
export async function enrichSkillList(rawSkills = [], llmConfig = null, ctx = {}) {
	if (!isNeo4jReady()) {
		throw new Error('Neo4j is not connected');
	}

	const skills = [...new Set(rawSkills.map(String).map(s => s.trim()).filter(Boolean))];
	const seen = new Set();
	const results = [];
	let usage = EMPTY_USAGE();

	traceSkill('batch_start', {
		jobId: ctx.jobId,
		inputSkills: skills,
		count: skills.length,
		note: 'Only skills[] is enriched; job description is excluded',
	});

	for (const surfaceForm of skills) {
		const normalizedKey = normalizeSkillKey(surfaceForm);
		if (!normalizedKey || seen.has(normalizedKey)) {
			traceSkill('skip_duplicate', { surfaceForm, normalizedKey });
			continue;
		}
		seen.add(normalizedKey);

		const applied = await processEnrichmentItem({
			surfaceForm,
			normalizedKey,
			cooccurringSkills: skills,
		}, llmConfig, ctx);
		usage = addUsage(usage, applied.usage);
		const { usage: _u, ...rest } = applied;
		results.push({ surfaceForm, normalizedKey, ...rest });
	}

	return { results, usage };
}

/** Count nodes/relationships in Neo4j for post-job verification logs. */
export async function getGraphCounts() {
	if (!isNeo4jReady()) return null;
	const [skills, aliases, rels] = await Promise.all([
		runRead('MATCH (s:Skill) RETURN count(s) AS n'),
		runRead('MATCH (a:RawAlias) RETURN count(a) AS n'),
		runRead('MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS n ORDER BY type'),
	]);
	const num = (v) => (typeof v?.toNumber === 'function' ? v.toNumber() : Number(v ?? 0));
	return {
		skillNodes: num(skills[0]?.get('n')),
		rawAliasNodes: num(aliases[0]?.get('n')),
		relationships: rels.map(r => ({ type: r.get('type'), count: num(r.get('n')) })),
	};
}
