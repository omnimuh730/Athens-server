/**
 * Batch LLM enhance-relations for co-occurring skill groups (Tier 3 precision layer).
 */
import { skillEnrichmentQueueCollection } from '../../db/mongo.js';
import { isNeo4jReady } from '../../db/neo4j.js';
import { getSkillGraphBridgeLlmEnabled } from '../../config/graphAndVectorConfig.js';
import { enhanceRelationsAmongSkills } from './enhanceRelations.js';
import { resolveLlmConfig } from './config.js';
import { findExactMatch } from '../skillGraph/search.js';
import { normalizeSkillKey } from '../skillGraph/normalize.js';

const MAX_GROUP_SIZE = 25;
const BATCH_GROUPS = 3;

function groupKey(cooccurringSkills) {
	return [...cooccurringSkills].map(normalizeSkillKey).filter(Boolean).sort().join('|');
}

async function resolveGroupSkillIds(cooccurringSkills) {
	const ids = [];
	for (const raw of cooccurringSkills) {
		const key = normalizeSkillKey(String(raw));
		if (!key) continue;
		const match = await findExactMatch(key);
		if (match?.id) ids.push(match.id);
	}
	return [...new Set(ids)];
}

/**
 * Find recent queue batches with shared co-occurring groups and run LLM enhance-relations.
 */
export async function bridgeCooccurringGroupsBatch() {
	if (!getSkillGraphBridgeLlmEnabled() || !isNeo4jReady() || !skillEnrichmentQueueCollection) {
		return { groupsProcessed: 0, relationshipsApplied: 0 };
	}

	const llmConfig = await resolveLlmConfig(null);
	if (!llmConfig?.apiKey) {
		return { groupsProcessed: 0, relationshipsApplied: 0, skipped: 'no_llm_key' };
	}

	const recentDone = await skillEnrichmentQueueCollection
		.find({
			status: 'done',
			cooccurringSkills: { $exists: true, $ne: [] },
			bridgeLlmProcessed: { $ne: true },
		})
		.sort({ analyzedAt: -1 })
		.limit(50)
		.toArray();

	const groups = new Map();
	for (const doc of recentDone) {
		const cooc = Array.isArray(doc.cooccurringSkills) ? doc.cooccurringSkills : [];
		if (!cooc.length) continue;
		const all = [doc.surfaceForm, ...cooc];
		const key = groupKey(all);
		if (!groups.has(key)) {
			groups.set(key, { skills: all, docIds: [] });
		}
		groups.get(key).docIds.push(doc._id);
	}

	let groupsProcessed = 0;
	let relationshipsApplied = 0;
	let groupIndex = 0;

	for (const [, group] of groups) {
		if (groupIndex >= BATCH_GROUPS) break;

		const skillIds = await resolveGroupSkillIds(group.skills);
		if (skillIds.length < 2) {
			await markBridgeProcessed(group.docIds);
			continue;
		}

		const chunks = [];
		for (let i = 0; i < skillIds.length; i += MAX_GROUP_SIZE) {
			chunks.push(skillIds.slice(i, i + MAX_GROUP_SIZE));
		}

		for (const chunk of chunks) {
			if (chunk.length < 2) continue;
			try {
				const result = await enhanceRelationsAmongSkills(chunk, { llmConfig });
				relationshipsApplied += result.relationshipsApplied ?? 0;
				groupsProcessed += 1;
			} catch (err) {
				console.warn('[bridge-llm] enhance failed:', err.message);
			}
		}

		await markBridgeProcessed(group.docIds);
		groupIndex += 1;
	}

	return { groupsProcessed, relationshipsApplied };
}

async function markBridgeProcessed(docIds) {
	if (!skillEnrichmentQueueCollection || !docIds?.length) return;
	await skillEnrichmentQueueCollection.updateMany(
		{ _id: { $in: docIds } },
		{ $set: { bridgeLlmProcessed: true, bridgeLlmAt: new Date().toISOString() } },
	);
}
