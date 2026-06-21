import { resolveSkillToCanonical, listGraphSkills } from '../services/skillGraph/resolve.js';
import { fetchSubgraph } from '../services/skillGraph/search.js';
import { runEnrichmentBatch } from '../services/skillEnrichment/worker.js';
import { isNeo4jReady } from '../db/neo4j.js';
import { syncCooccurrenceToGraph } from '../services/skillCooccurrence/index.js';

export async function resolveSkillHandler(req, res) {
	try {
		if (!isNeo4jReady()) return res.status(503).json({ success: false, error: 'Neo4j not ready' });
		const q = String(req.query.q || '').trim();
		if (!q) return res.status(400).json({ success: false, error: 'q query required' });

		const resolved = await resolveSkillToCanonical(q, { enqueueIfMissing: false });
		let neighbors = [];
		if (resolved.canonicalId) {
			const sub = await fetchSubgraph([resolved.canonicalId]);
			neighbors = sub.edges.map(e => ({ from: e.from, to: e.to, type: e.type, weight: e.weight }));
		}

		return res.json({ success: true, resolved, neighbors });
	} catch (err) {
		console.error('GET /api/skills/resolve error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function getSubgraphHandler(req, res) {
	try {
		if (!isNeo4jReady()) return res.status(503).json({ success: false, error: 'Neo4j not ready' });
		const ids = String(req.query.ids || '')
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);
		if (!ids.length) return res.status(400).json({ success: false, error: 'ids query required' });

		const graph = await fetchSubgraph(ids);
		return res.json({ success: true, graph });
	} catch (err) {
		console.error('GET /api/skills/graph/subgraph error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function runEnrichmentHandler(req, res) {
	try {
		const batchSize = Number(req.body?.batchSize) || 5;
		const enrichment = await runEnrichmentBatch(batchSize);
		const cooc = await syncCooccurrenceToGraph(50);
		return res.json({ success: true, enrichment, cooccurrenceSynced: cooc });
	} catch (err) {
		console.error('POST /api/skills/enrichment/run error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function listSkillsHandler(req, res) {
	try {
		if (!isNeo4jReady()) return res.status(503).json({ success: false, error: 'Neo4j not ready' });
		const page = Math.max(1, parseInt(req.query.page, 10) || 1);
		const limit = Math.max(1, parseInt(req.query.limit, 10) || 30);
		const q = String(req.query.q || '');
		const { skills, total } = await listGraphSkills({ q, skip: (page - 1) * limit, limit });
		return res.json({ success: true, skills, pagination: { total, page, limit } });
	} catch (err) {
		return res.status(500).json({ success: false, error: err.message });
	}
}
