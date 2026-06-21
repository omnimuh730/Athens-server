import { runRead } from '../../db/neo4j.js';
import { chatCompletion, EMPTY_USAGE } from '../llm/llmService.js';
import { upsertRelationships } from '../skillGraph/apply.js';
import { resolveLlmConfig, getEnrichmentModel } from './config.js';
import { traceLlm, clip } from './trace.js';

const MAX_SKILLS_PER_CALL = 25;

const SYSTEM = `You enhance a software skill knowledge graph by proposing relationships between a given set of skills.

Return JSON only:
{
  "relationships": [
    { "fromId": string, "toId": string, "type": "BUILDS_ON"|"PREREQUISITE_OF"|"RELATED_TO"|"ALTERNATIVE_TO"|"PART_OF"|"USED_WITH"|"SPECIALIZATION_OF", "confidence": number }
  ]
}

Rules:
- Only use fromId and toId from the provided skill ids.
- Propose meaningful relationships that strengthen the graph (prerequisites, builds-on, specializations, ecosystem pairs).
- Prefer specific typed relations over generic RELATED_TO when appropriate.
- confidence in [0.5, 1.0].
- Do not propose self-loops or duplicate pairs.`;

async function fetchSkillsByIds(skillIds) {
	const records = await runRead(
		`
		MATCH (s:Skill)
		WHERE s.id IN $ids
		RETURN s.id AS id, s.label AS label, s.category AS category, s.skillType AS skillType
		ORDER BY s.label
		`,
		{ ids: skillIds },
	);

	return records.map(r => ({
		id: r.get('id'),
		label: r.get('label'),
		category: r.get('category'),
		skillType: r.get('skillType'),
	}));
}

async function llmProposeRelationships(skills, llmConfig) {
	const model = getEnrichmentModel('enrich', llmConfig);
	const skillIds = new Set(skills.map(s => s.id));

	traceLlm('enhance_relations_request', {
		skillCount: skills.length,
		model,
		skillIds: [...skillIds],
	});

	const { content, usage } = await chatCompletion({
		provider: llmConfig.provider,
		apiKey: llmConfig.apiKey,
		model,
		messages: [
			{ role: 'system', content: SYSTEM },
			{ role: 'user', content: JSON.stringify({ skills }) },
		],
		jsonMode: true,
		cacheKey: 'skill-graph-enhance-relations-v1',
		timeoutMs: 90_000,
	});

	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch {
		traceLlm('enhance_relations_parse_failed', { contentSnippet: clip(content) });
		return { relationships: [], usage };
	}

	const relationships = (parsed.relationships || []).filter(rel => {
		const fromId = rel.fromId;
		const toId = rel.toId;
		return fromId && toId && fromId !== toId && skillIds.has(fromId) && skillIds.has(toId);
	});

	traceLlm('enhance_relations_response', {
		proposed: relationships.length,
		usage,
	});

	return { relationships, usage };
}

/**
 * Use LLM to propose and apply new relationships among selected graph skills.
 */
export async function enhanceRelationsAmongSkills(skillIds = [], { applierName, llmConfig = null } = {}) {
	const uniqueIds = [...new Set(skillIds.map(String).filter(Boolean))];
	if (uniqueIds.length < 2) {
		throw new Error('Select at least 2 skills to enhance relations');
	}

	const config = llmConfig ?? await resolveLlmConfig(applierName);
	if (!config?.apiKey) {
		throw new Error('DeepSeek API key required — add it in account settings');
	}

	const skills = await fetchSkillsByIds(uniqueIds);
	if (skills.length < 2) {
		throw new Error('Fewer than 2 selected skills exist in the graph');
	}

	let totalUsage = EMPTY_USAGE();
	let applied = 0;
	const allRelationships = [];

	for (let i = 0; i < skills.length; i += MAX_SKILLS_PER_CALL) {
		const chunk = skills.slice(i, i + MAX_SKILLS_PER_CALL);
		if (chunk.length < 2) continue;

		const { relationships, usage } = await llmProposeRelationships(chunk, config);
		if (usage) {
			totalUsage = {
				inputTokens: totalUsage.inputTokens + (usage.inputTokens ?? 0),
				outputTokens: totalUsage.outputTokens + (usage.outputTokens ?? 0),
				totalTokens: totalUsage.totalTokens + (usage.totalTokens ?? 0),
				cost: (totalUsage.cost ?? 0) + (usage.cost ?? 0),
				cachedTokens: (totalUsage.cachedTokens ?? 0) + (usage.cachedTokens ?? 0),
			};
		}

		const byFrom = new Map();
		for (const rel of relationships) {
			const list = byFrom.get(rel.fromId) || [];
			list.push(rel);
			byFrom.set(rel.fromId, list);
		}

		for (const [fromId, rels] of byFrom) {
			const count = await upsertRelationships(fromId, rels, {
				source: 'llm_enhance',
				modelVersion: getEnrichmentModel('enrich', config),
			});
			applied += count;
		}

		allRelationships.push(...relationships);
	}

	return {
		skillsProcessed: skills.length,
		relationshipsProposed: allRelationships.length,
		relationshipsApplied: applied,
		usage: totalUsage,
	};
}
