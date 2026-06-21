import { isNeo4jReady } from '../../db/neo4j.js';
import { normalizeSkillKey, stringSimilarity } from '../skillGraph/normalize.js';
import { findExactMatch, searchCandidates } from '../skillGraph/search.js';
import { applyEnrichmentResult, linkAlias } from '../skillGraph/apply.js';
import { suggestSearchKeywords } from './keywordSuggest.js';
import { enrichAgainstCandidates } from './enrich.js';
import { claimNextBatch, markDone, markFailed } from './queue.js';
import { getEnrichmentModel, isEnrichmentEnabled, getWorkerIntervalMs, getWorkerBatchSize } from './config.js';
import { recordCooccurrenceForJob, syncCooccurrenceToGraph } from '../skillCooccurrence/index.js';
import { refreshSkillScoresForSkills } from '../skillScoreService.js';

const AUTO_ALIAS_THRESHOLD = 0.95;
const SKIP_KEYWORD_THRESHOLD = 0.95;

/**
 * Process one queued raw skill through normalize → search → enrich → apply.
 */
export async function processEnrichmentItem(item) {
	const { surfaceForm, normalizedKey, cooccurringSkills = [] } = item;

	// 1. Exact match — free, no LLM
	const exact = await findExactMatch(normalizedKey);
	if (exact) {
		await linkAlias({
			surfaceForm,
			normalizedKey,
			skillId: exact.id,
			confidence: 1,
			source: 'exact',
		});
		return { skillId: exact.id, path: 'exact' };
	}

	// 2. Local fuzzy search on raw key first (may skip LLM call 1)
	let candidates = await searchCandidates({
		rawSkill: surfaceForm,
		normalizedKey,
		searchKeywords: [],
		limit: 10,
	});

	if (candidates.length === 1 && candidates[0].score >= AUTO_ALIAS_THRESHOLD
		&& stringSimilarity(surfaceForm, candidates[0].label) >= AUTO_ALIAS_THRESHOLD) {
		await linkAlias({
			surfaceForm,
			normalizedKey,
			skillId: candidates[0].id,
			confidence: candidates[0].score,
			source: 'fuzzy_auto',
		});
		return { skillId: candidates[0].id, path: 'fuzzy_auto' };
	}

	const topScore = candidates[0]?.score ?? 0;
	let keywordUsage = null;

	// 3. LLM keyword suggestion (skip if fuzzy already strong)
	if (topScore < SKIP_KEYWORD_THRESHOLD && isEnrichmentEnabled()) {
		const { searchKeywords, usage } = await suggestSearchKeywords(surfaceForm);
		keywordUsage = usage;
		if (searchKeywords.length) {
			candidates = await searchCandidates({
				rawSkill: surfaceForm,
				normalizedKey,
				searchKeywords,
				limit: 10,
			});
		}
	}

	// 4. LLM enrichment against candidates
	const { result, usage: enrichUsage } = await enrichAgainstCandidates({
		rawSkill: surfaceForm,
		normalizedKey,
		candidates,
		cooccurringSkills,
	});

	const applied = await applyEnrichmentResult({
		surfaceForm,
		normalizedKey,
		result,
		modelVersion: getEnrichmentModel('enrich'),
	});

	return {
		...applied,
		path: 'enriched',
		tokenUsage: { keyword: keywordUsage, enrich: enrichUsage },
	};
}

export async function runEnrichmentBatch(batchSize = 3) {
	if (!isNeo4jReady() || !isEnrichmentEnabled()) return { processed: 0 };

	const batch = await claimNextBatch(batchSize);
	let processed = 0;

	for (const item of batch) {
		try {
			await processEnrichmentItem(item);
			await markDone(item.normalizedKey);
			await syncCooccurrenceToGraph(20);
			refreshSkillScoresForSkills([item.surfaceForm]).catch(err =>
				console.error('[skill-enrichment] score refresh failed', err.message),
			);
			processed += 1;
		} catch (err) {
			console.error('[skill-enrichment] failed', item.normalizedKey, err.message);
			await markFailed(item.normalizedKey, err);
		}
	}

	return { processed };
}

let workerTimer = null;

export function startEnrichmentWorker() {
	if (workerTimer) return;
	const intervalMs = getWorkerIntervalMs();
	const batchSize = getWorkerBatchSize();

	const tick = async () => {
		try {
			const { processed } = await runEnrichmentBatch(batchSize);
			if (processed > 0) {
				console.log(`[skill-enrichment] processed ${processed} skill(s)`);
			}
		} catch (err) {
			console.error('[skill-enrichment] worker tick error', err.message);
		}
	};

	workerTimer = setInterval(tick, intervalMs);
	void tick();
	console.log(`[skill-enrichment] worker started (interval ${intervalMs}ms, batch ${batchSize})`);
}

export function stopEnrichmentWorker() {
	if (workerTimer) {
		clearInterval(workerTimer);
		workerTimer = null;
	}
}

/** Called on job ingest — enqueue skills and record co-occurrence pairs. */
export async function ingestJobSkills(rawSkills = []) {
	const skills = [...new Set(rawSkills.map(String).map(s => s.trim()).filter(Boolean))];
	if (!skills.length) return;

	const { enqueueSkills } = await import('./queue.js');
	await enqueueSkills(skills, skills);
	await recordCooccurrenceForJob(skills);
}
