import { getKgConfidenceCooccurrenceEdge } from '../../config/graphAndVectorConfig.js';
import { normalizeSkillKey } from '../skillGraph/normalize.js';
import { findExactMatch } from '../skillGraph/search.js';
import { upsertUsedWith } from '../skillGraph/apply.js';
import { traceSkill } from './trace.js';

/**
 * Create USED_WITH bridges between a skill and its co-occurring job/resume mates.
 * Runs in fast mode without LLM — fixes java↔backend when enriched in separate batches.
 */
export async function bridgeCooccurringSkills(skillId, normalizedKey, cooccurringSkills = []) {
	if (!skillId || !cooccurringSkills?.length) return 0;

	const selfKey = normalizeSkillKey(normalizedKey);
	const weight = getKgConfidenceCooccurrenceEdge();
	let bridged = 0;

	for (const raw of cooccurringSkills) {
		const mateKey = normalizeSkillKey(String(raw));
		if (!mateKey || mateKey === selfKey) continue;

		const mate = await findExactMatch(mateKey);
		if (!mate?.id || mate.id === skillId) continue;

		await upsertUsedWith(skillId, mate.id, weight, 'cooccurring');
		bridged += 1;
	}

	if (bridged > 0) {
		traceSkill('cooc_bridge', { skillId, normalizedKey: selfKey, bridged, weight });
	}

	return bridged;
}
