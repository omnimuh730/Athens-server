import { runRead } from '../../db/neo4j.js';
import { normalizeSkillKey, stringSimilarity } from './normalize.js';

const RELATION_TYPES = [
	'PREREQUISITE_OF',
	'BUILDS_ON',
	'RELATED_TO',
	'ALTERNATIVE_TO',
	'PART_OF',
	'USED_WITH',
	'SPECIALIZATION_OF',
];

/**
 * Exact lookup: RawAlias.normalizedKey, Skill.id, or Skill.label normalized key.
 */
export async function findExactMatch(normalizedKey) {
	if (!normalizedKey) return null;

	const records = await runRead(
		`
		OPTIONAL MATCH (a:RawAlias { normalizedKey: $key })-[:ALIAS_OF]->(s1:Skill)
		OPTIONAL MATCH (s2:Skill { id: $key })
		WITH coalesce(s1, s2) AS skill
		WHERE skill IS NOT NULL
		RETURN skill.id AS id, skill.label AS label, skill.category AS category,
		       skill.skillType AS skillType
		LIMIT 1
		`,
		{ key: normalizedKey },
	);

	if (!records.length) return null;
	const r = records[0];
	return {
		id: r.get('id'),
		label: r.get('label'),
		category: r.get('category'),
		skillType: r.get('skillType'),
		matchType: 'exact',
		score: 1,
	};
}

/**
 * Batch exact lookup for many normalized keys in one Neo4j round trip.
 * Returns Map normalizedKey -> match result (or null if not found).
 */
export async function findExactMatches(normalizedKeys = []) {
	const keys = [...new Set(normalizedKeys.filter(Boolean))];
	const map = new Map(keys.map(k => [k, null]));
	if (!keys.length) return map;

	const records = await runRead(
		`
		UNWIND $keys AS key
		OPTIONAL MATCH (a:RawAlias { normalizedKey: key })-[:ALIAS_OF]->(s1:Skill)
		OPTIONAL MATCH (s2:Skill { id: key })
		WITH key, coalesce(s1, s2) AS skill
		WHERE skill IS NOT NULL
		RETURN key AS normalizedKey, skill.id AS id, skill.label AS label,
		       skill.category AS category, skill.skillType AS skillType
		`,
		{ keys },
	);

	for (const r of records) {
		const key = r.get('normalizedKey');
		map.set(key, {
			id: r.get('id'),
			label: r.get('label'),
			category: r.get('category'),
			skillType: r.get('skillType'),
			matchType: 'exact',
			score: 1,
		});
	}

	return map;
}

/**
 * Search graph for candidate Skill nodes using keywords + fuzzy on raw key.
 * Returns top `limit` deduped candidates sorted by score.
 */
export async function searchCandidates({ rawSkill, normalizedKey, searchKeywords = [], limit = 10 }) {
	const keywords = [...new Set([
		normalizedKey,
		...searchKeywords.map(normalizeSkillKey).filter(Boolean),
	])].filter(Boolean);

	const keywordSet = new Set(keywords);
	const exactHits = [];

	for (const kw of keywords) {
		const records = await runRead(
			`
			OPTIONAL MATCH (a:RawAlias { normalizedKey: $kw })-[:ALIAS_OF]->(s1:Skill)
			OPTIONAL MATCH (s2:Skill)
			WHERE s2.id = $kw OR toLower(s2.label) CONTAINS $kwContains
			WITH collect(DISTINCT coalesce(s1, s2)) AS skills
			UNWIND [s IN skills WHERE s IS NOT NULL] AS skill
			RETURN skill.id AS id, skill.label AS label, skill.category AS category,
			       skill.skillType AS skillType
			LIMIT 5
			`,
			{ kw, kwContains: kw.slice(0, Math.max(3, kw.length)) },
		);

		for (const r of records) {
			exactHits.push({
				id: r.get('id'),
				label: r.get('label'),
				category: r.get('category'),
				skillType: r.get('skillType'),
				matchType: keywordSet.has(kw) ? 'keyword_exact' : 'keyword',
				score: kw === normalizedKey ? 0.98 : 0.9,
			});
		}
	}

	// Fuzzy: scan all skills if graph is small, or label-contains for larger graphs
	const fuzzyRecords = await runRead(
		`
		MATCH (s:Skill)
		WHERE toLower(s.label) CONTAINS $prefix
		   OR s.id CONTAINS $prefix
		RETURN s.id AS id, s.label AS label, s.category AS category, s.skillType AS skillType
		LIMIT 50
		`,
		{ prefix: normalizedKey.slice(0, Math.min(6, normalizedKey.length)) || normalizedKey },
	);

	const seen = new Map();
	const add = (c) => {
		if (!c?.id) return;
		const fuzzyScore = stringSimilarity(rawSkill, c.label);
		const combined = Math.max(c.score ?? 0, fuzzyScore);
		const prev = seen.get(c.id);
		if (!prev || combined > prev.score) {
			seen.set(c.id, { ...c, score: combined, matchType: c.matchType || 'fuzzy' });
		}
	};

	for (const c of exactHits) add(c);
	for (const r of fuzzyRecords) {
		add({
			id: r.get('id'),
			label: r.get('label'),
			category: r.get('category'),
			skillType: r.get('skillType'),
		});
	}

	return [...seen.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

/** Fetch subgraph around skill ids for scoring. */
export async function fetchSubgraph(skillIds) {
	if (!skillIds?.length) return { nodes: [], edges: [] };

	const records = await runRead(
		`
		MATCH (s:Skill)
		WHERE s.id IN $ids
		OPTIONAL MATCH (s)-[r]-(t:Skill)
		WHERE type(r) IN $relTypes
		RETURN collect(DISTINCT s) AS sources,
		       collect(DISTINCT t) AS targets,
		       collect(DISTINCT {
		         from: startNode(r).id,
		         to: endNode(r).id,
		         type: type(r),
		         weight: r.weight
		       }) AS rels
		`,
		{ ids: skillIds, relTypes: RELATION_TYPES },
	);

	if (!records.length) return { nodes: [], edges: [] };

	const nodeMap = new Map();
	const addNode = (n) => {
		if (!n) return;
		const props = n.properties;
		nodeMap.set(props.id, {
			id: props.id,
			label: props.label,
			category: props.category,
			skillType: props.skillType,
		});
	};

	for (const r of records) {
		for (const n of r.get('sources') || []) addNode(n);
		for (const n of r.get('targets') || []) addNode(n);
	}

	const edges = [];
	const rels = records[0].get('rels') || [];
	for (const rel of rels) {
		if (!rel?.from || !rel?.to) continue;
		edges.push({
			from: rel.from,
			to: rel.to,
			type: rel.type,
			weight: rel.weight ?? 0.5,
		});
	}

	return { nodes: [...nodeMap.values()], edges };
}

/** Resolve many raw skill strings to canonical ids (best effort). */
export async function resolveRawSkills(rawSkills = []) {
	const results = new Map();
	for (const raw of rawSkills) {
		const key = normalizeSkillKey(raw);
		if (!key || results.has(key)) continue;
		const exact = await findExactMatch(key);
		results.set(key, exact ? { raw, normalizedKey: key, ...exact } : { raw, normalizedKey: key, id: null });
	}
	return results;
}

export { RELATION_TYPES };
