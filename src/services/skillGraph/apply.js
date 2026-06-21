import { runWrite } from '../../db/neo4j.js';
import { normalizeSkillKey, normalizeSurfaceForm, slugifySkillId } from './normalize.js';

const VALID_RELATIONS = new Set([
	'PREREQUISITE_OF',
	'BUILDS_ON',
	'RELATED_TO',
	'ALTERNATIVE_TO',
	'PART_OF',
	'USED_WITH',
	'SPECIALIZATION_OF',
]);

function nowIso() {
	return new Date().toISOString();
}

/** Link a raw surface form to an existing canonical skill. */
export async function linkAlias({ surfaceForm, normalizedKey, skillId, confidence = 1, source = 'exact' }) {
	const form = normalizeSurfaceForm(surfaceForm);
	const key = normalizedKey || normalizeSkillKey(form);
	if (!key || !skillId) throw new Error('linkAlias requires normalizedKey and skillId');

	await runWrite(
		`
		MATCH (s:Skill { id: $skillId })
		MERGE (a:RawAlias { normalizedKey: $key })
		ON CREATE SET a.surfaceForm = $form, a.firstSeenAt = datetime($now)
		ON MATCH SET a.surfaceForm = coalesce(a.surfaceForm, $form)
		MERGE (a)-[r:ALIAS_OF]->(s)
		SET r.confidence = $confidence, r.source = $source, r.createdAt = coalesce(r.createdAt, datetime($now))
		`,
		{ key, form, skillId, confidence, source, now: nowIso() },
	);

	return { skillId, normalizedKey: key };
}

/** Create a new canonical Skill node and link alias. */
export async function createSkillWithAlias({
	surfaceForm,
	normalizedKey,
	label,
	category = 'concept',
	skillType = 'TECHNOLOGY',
	modelVersion = 'enrichment-v1',
	source = 'llm',
}) {
	const form = normalizeSurfaceForm(surfaceForm);
	const key = normalizedKey || normalizeSkillKey(form);
	const id = slugifySkillId(label || form || key);
	if (!id) throw new Error('Cannot derive skill id');

	await runWrite(
		`
		MERGE (s:Skill { id: $id })
		ON CREATE SET
		  s.label = $label,
		  s.category = $category,
		  s.skillType = $skillType,
		  s.createdAt = datetime($now),
		  s.enrichedAt = datetime($now),
		  s.modelVersion = $modelVersion
		ON MATCH SET
		  s.enrichedAt = datetime($now),
		  s.modelVersion = coalesce(s.modelVersion, $modelVersion)
		MERGE (a:RawAlias { normalizedKey: $key })
		ON CREATE SET a.surfaceForm = $form, a.firstSeenAt = datetime($now)
		MERGE (a)-[r:ALIAS_OF]->(s)
		SET r.confidence = 1.0, r.source = $source, r.createdAt = coalesce(r.createdAt, datetime($now))
		`,
		{
			id,
			label: label || form,
			category,
			skillType,
			key,
			form,
			modelVersion,
			source,
			now: nowIso(),
		},
	);

	return { skillId: id, normalizedKey: key };
}

const REL_CYPHER = {
	PREREQUISITE_OF: 'MERGE (a)-[r:PREREQUISITE_OF]->(b)',
	BUILDS_ON: 'MERGE (a)-[r:BUILDS_ON]->(b)',
	RELATED_TO: 'MERGE (a)-[r:RELATED_TO]->(b)',
	ALTERNATIVE_TO: 'MERGE (a)-[r:ALTERNATIVE_TO]->(b)',
	PART_OF: 'MERGE (a)-[r:PART_OF]->(b)',
	USED_WITH: 'MERGE (a)-[r:USED_WITH]->(b)',
	SPECIALIZATION_OF: 'MERGE (a)-[r:SPECIALIZATION_OF]->(b)',
};

/** Upsert typed relationships between skills. */
export async function upsertRelationships(fromId, relationships = [], { source = 'llm', modelVersion = 'enrichment-v1' } = {}) {
	for (const rel of relationships) {
		const type = rel.type || rel.relation;
		if (!VALID_RELATIONS.has(type)) continue;
		const mergeRel = REL_CYPHER[type];
		if (!mergeRel) continue;
		const toId = rel.toId || rel.id;
		if (!toId || toId === fromId) continue;
		const confidence = Number(rel.confidence ?? 0.8);
		const weight = Number(rel.weight ?? confidence);

		await runWrite(
			`
			MATCH (a:Skill { id: $fromId })
			MERGE (b:Skill { id: $toId })
			ON CREATE SET b.label = $toId, b.category = 'concept', b.skillType = 'TECHNOLOGY',
			              b.createdAt = datetime($now), b.enrichedAt = datetime($now), b.modelVersion = $modelVersion
			${mergeRel}
			SET r.weight = $weight,
			    r.confidence = $confidence,
			    r.source = $source,
			    r.modelVersion = $modelVersion,
			    r.createdAt = coalesce(r.createdAt, datetime($now))
			`,
			{ fromId, toId, weight, confidence, source, modelVersion, now: nowIso() },
		);
	}
}

/** Apply enrichment LLM output to the graph. */
export async function applyEnrichmentResult({
	surfaceForm,
	normalizedKey,
	result,
	modelVersion = 'enrichment-v1',
}) {
	const action = result.action || 'new_node';
	const confidence = Number(result.confidence ?? 0.85);

	if (action === 'alias' && result.targetId) {
		await linkAlias({
			surfaceForm,
			normalizedKey,
			skillId: result.targetId,
			confidence,
			source: 'llm',
		});
		if (result.relationships?.length) {
			await upsertRelationships(result.targetId, result.relationships, { source: 'llm', modelVersion });
		}
		return { skillId: result.targetId, action: 'alias' };
	}

	if (action === 'extend_existing' && result.targetId) {
		await linkAlias({
			surfaceForm,
			normalizedKey,
			skillId: result.targetId,
			confidence,
			source: 'llm',
		});
		await upsertRelationships(result.targetId, result.relationships || [], { source: 'llm', modelVersion });
		return { skillId: result.targetId, action: 'extend_existing' };
	}

	const newNode = result.newNode || {};
	const created = await createSkillWithAlias({
		surfaceForm,
		normalizedKey,
		label: newNode.label || surfaceForm,
		category: newNode.category || result.category || 'concept',
		skillType: newNode.skillType || result.skillType || 'TECHNOLOGY',
		modelVersion,
		source: 'llm',
	});

	const rels = result.relationships || [];
	if (rels.length) {
		await upsertRelationships(created.skillId, rels, { source: 'llm', modelVersion });
	}

	return { skillId: created.skillId, action: 'new_node' };
}

/** Strengthen or create USED_WITH edge from co-occurrence. */
export async function upsertUsedWith(fromId, toId, weight, source = 'cooccurrence') {
	if (!fromId || !toId || fromId === toId) return;
	await runWrite(
		`
		MATCH (a:Skill { id: $fromId }), (b:Skill { id: $toId })
		MERGE (a)-[r:USED_WITH]->(b)
		SET r.weight = CASE WHEN r.weight IS NULL OR r.weight < $weight THEN $weight ELSE r.weight END,
		    r.confidence = coalesce(r.confidence, $weight),
		    r.source = $source,
		    r.createdAt = coalesce(r.createdAt, datetime($now))
		MERGE (b)-[r2:USED_WITH]->(a)
		SET r2.weight = CASE WHEN r2.weight IS NULL OR r2.weight < $weight THEN $weight ELSE r2.weight END,
		    r2.confidence = coalesce(r2.confidence, $weight),
		    r2.source = $source,
		    r2.createdAt = coalesce(r2.createdAt, datetime($now))
		`,
		{ fromId, toId, weight, source, now: nowIso() },
	);
}
