import { chatCompletion } from '../llm/llmService.js';
import { getEnrichmentApiKey, getEnrichmentModel } from './config.js';

const SYSTEM = `You enrich a software skill knowledge graph. Given a raw skill name and candidate nodes already in the graph, decide how to integrate it.

Return JSON only:
{
  "action": "alias" | "new_node" | "extend_existing",
  "targetId": string | null,
  "confidence": number,
  "skillType": "TECHNOLOGY" | "CONCEPT" | "ROLE" | "SOFT_SKILL",
  "category": string,
  "newNode": { "label": string, "category": string, "skillType": string } | null,
  "relationships": [{ "toId": string, "type": "BUILDS_ON"|"PREREQUISITE_OF"|"RELATED_TO"|"ALTERNATIVE_TO"|"PART_OF"|"USED_WITH"|"SPECIALIZATION_OF", "confidence": number }]
}

Rules:
- targetId MUST be one of the candidate ids, or null for new_node.
- React.js and Reactjs are aliases of react, not new nodes.
- PostgreSQL vs Postgres Tuning are DIFFERENT nodes; Postgres Tuning should SPECIALIZATION_OF postgresql.
- Software Engineer is ROLE; Software Engineering Principles is CONCEPT.
- Only propose relationships to candidate ids or ids you are creating via new_node label slug.`;

export async function enrichAgainstCandidates({
	rawSkill,
	normalizedKey,
	candidates = [],
	cooccurringSkills = [],
}) {
	const apiKey = getEnrichmentApiKey();
	const candidateIds = new Set(candidates.map(c => c.id));

	if (!apiKey) {
		return buildHeuristicResult(rawSkill, normalizedKey, candidates);
	}

	const model = getEnrichmentModel('enrich');
	const useEscalated = candidates.length === 0;

	const { content, usage } = await chatCompletion({
		provider: 'openai',
		apiKey,
		model: useEscalated ? getEnrichmentModel('enrich_escalated') : model,
		messages: [
			{ role: 'system', content: SYSTEM },
			{
				role: 'user',
				content: JSON.stringify({
					rawSkill,
					normalizedKey,
					candidates: candidates.map(c => ({
						id: c.id,
						label: c.label,
						category: c.category,
						skillType: c.skillType,
						score: c.score,
					})),
					cooccurringSkills: cooccurringSkills.slice(0, 10),
				}),
			},
		],
		jsonMode: true,
		cacheKey: 'skill-graph-enrich-v1',
		timeoutMs: 60_000,
	});

	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch {
		return buildHeuristicResult(rawSkill, normalizedKey, candidates);
	}

	if (parsed.targetId && !candidateIds.has(parsed.targetId) && parsed.action !== 'new_node') {
		parsed.action = 'new_node';
		parsed.targetId = null;
	}

	return { result: parsed, usage };
}

function buildHeuristicResult(rawSkill, normalizedKey, candidates) {
	if (candidates.length === 1 && candidates[0].score >= 0.95) {
		return {
			result: {
				action: 'alias',
				targetId: candidates[0].id,
				confidence: candidates[0].score,
				relationships: [],
			},
			usage: null,
		};
	}

	return {
		result: {
			action: 'new_node',
			targetId: null,
			confidence: 0.5,
			skillType: 'TECHNOLOGY',
			category: 'concept',
			newNode: { label: rawSkill, category: 'concept', skillType: 'TECHNOLOGY' },
			relationships: candidates.slice(0, 2).map(c => ({
				toId: c.id,
				type: 'RELATED_TO',
				confidence: 0.4,
			})),
		},
		usage: null,
	};
}
