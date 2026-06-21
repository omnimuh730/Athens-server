import { resolveSkillToCanonical, listGraphSkills } from '../services/skillGraph/resolve.js';
import { enhanceRelationsAmongSkills } from '../services/skillEnrichment/enhanceRelations.js';
import { fetchSubgraph, fetchInternalSubgraph } from '../services/skillGraph/search.js';
import { fetchWorldGraph } from '../services/skillGraph/worldGraph.js';
import {
	startEnrichmentSession,
	stopEnrichmentSession,
	getEnrichmentSessionStatus,
} from '../services/skillEnrichment/worker.js';
import { listPendingSkills, countQueueStats } from '../services/skillEnrichment/queue.js';
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

		const internal = req.query.internal === 'true' || req.query.internal === '1';
		const capped = ids.slice(0, 80);
		const graph = internal ? await fetchInternalSubgraph(capped) : await fetchSubgraph(capped);
		return res.json({ success: true, graph });
	} catch (err) {
		console.error('GET /api/skills/graph/subgraph error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function getWorldGraphHandler(req, res) {
	try {
		if (!isNeo4jReady()) return res.status(503).json({ success: false, error: 'Neo4j not ready' });
		const nodeLimit = Number(req.query.nodeLimit) || 2000;
		const edgeLimit = Number(req.query.edgeLimit) || 5000;
		const includeQueueStats = req.query.includeQueueStats === 'true';
		const graph = await fetchWorldGraph({ nodeLimit, edgeLimit });
		const payload = { success: true, graph };
		if (includeQueueStats) {
			payload.queueStats = await countQueueStats();
		}
		return res.json(payload);
	} catch (err) {
		console.error('GET /api/skills/graph/world error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function getPendingSkillsHandler(req, res) {
	try {
		const limit = Math.min(500, Number(req.query.limit) || 200);
		const [pending, stats] = await Promise.all([
			listPendingSkills({ limit }),
			countQueueStats(),
		]);
		return res.json({
			success: true,
			pending,
			stats,
			count: pending.length,
		});
	} catch (err) {
		console.error('GET /api/skills/enrichment/pending error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function getEnrichmentStatusHandler(req, res) {
	try {
		const session = getEnrichmentSessionStatus();
		const stats = await countQueueStats();
		return res.json({ success: true, session, stats });
	} catch (err) {
		console.error('GET /api/skills/enrichment/status error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function startEnrichmentHandler(req, res) {
	try {
		if (!isNeo4jReady()) return res.status(503).json({ success: false, error: 'Neo4j not ready' });
		const { applierName, mode, limit } = req.body || {};
		const result = await startEnrichmentSession({ applierName, mode, limit });
		return res.status(202).json({ success: true, ...result });
	} catch (err) {
		const status = err.message.includes('already running') ? 409 : 500;
		console.error('POST /api/skills/enrichment/start error', err);
		return res.status(status).json({ success: false, error: err.message });
	}
}

export async function stopEnrichmentHandler(req, res) {
	try {
		const result = stopEnrichmentSession();
		return res.json({ success: true, ...result });
	} catch (err) {
		console.error('POST /api/skills/enrichment/stop error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

/** Legacy manual batch trigger — forwards to session start. */
export async function runEnrichmentHandler(req, res) {
	try {
		const limit = Number(req.body?.batchSize) || 5;
		const result = await startEnrichmentSession({ limit });
		const cooc = await syncCooccurrenceToGraph(50);
		return res.json({ success: true, enrichment: result, cooccurrenceSynced: cooc });
	} catch (err) {
		console.error('POST /api/skills/enrichment/run error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function listSkillsHandler(req, res) {
	try {
		if (!isNeo4jReady()) return res.status(503).json({ success: false, error: 'Neo4j not ready' });
		const page = Math.max(1, parseInt(req.query.page, 10) || 1);
		const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 30));
		const q = String(req.query.q || '');
		const idsOnly = req.query.idsOnly === 'true' || req.query.idsOnly === '1';
		const maxIds = Math.min(500, parseInt(req.query.maxIds, 10) || 200);

		if (idsOnly) {
			const { skills, total } = await listGraphSkills({ q, skip: 0, limit: maxIds });
			return res.json({
				success: true,
				ids: skills.map(s => s.id),
				total,
			});
		}

		const { skills, total } = await listGraphSkills({ q, skip: (page - 1) * limit, limit });
		return res.json({ success: true, skills, pagination: { total, page, limit } });
	} catch (err) {
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function enhanceRelationsHandler(req, res) {
	try {
		if (!isNeo4jReady()) return res.status(503).json({ success: false, error: 'Neo4j not ready' });
		const { skillIds, applierName } = req.body || {};
		if (!Array.isArray(skillIds) || skillIds.length < 2) {
			return res.status(400).json({ success: false, error: 'skillIds array with at least 2 entries required' });
		}

		const result = await enhanceRelationsAmongSkills(skillIds, { applierName });
		return res.json({ success: true, ...result });
	} catch (err) {
		console.error('POST /api/skills/enrichment/enhance-relations error', err);
		const status = err.message.includes('API key') ? 400 : 500;
		return res.status(status).json({ success: false, error: err.message });
	}
}
