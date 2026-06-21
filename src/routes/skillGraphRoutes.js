import express from 'express';
import {
	resolveSkillHandler,
	getSubgraphHandler,
	runEnrichmentHandler,
	getPendingSkillsHandler,
	getEnrichmentStatusHandler,
	startEnrichmentHandler,
	stopEnrichmentHandler,
	getWorldGraphHandler,
	listSkillsHandler,
	enhanceRelationsHandler,
} from '../controllers/skillGraphController.js';
import { listUserGraphsHandler, buildUserGraphHandler } from '../controllers/userGraphController.js';

const router = express.Router();

router.get('/skills/resolve', resolveSkillHandler);
router.get('/skills/graph/subgraph', getSubgraphHandler);
router.get('/skills/graph/world', getWorldGraphHandler);
router.get('/skills/list', listSkillsHandler);

router.get('/skills/enrichment/pending', getPendingSkillsHandler);
router.post('/skills/enrichment/enhance-relations', enhanceRelationsHandler);
router.get('/skills/enrichment/status', getEnrichmentStatusHandler);
router.post('/skills/enrichment/start', startEnrichmentHandler);
router.post('/skills/enrichment/stop', stopEnrichmentHandler);
router.post('/skills/enrichment/run', runEnrichmentHandler);

router.get('/user-graph', listUserGraphsHandler);
router.post('/user-graph/from-resume', buildUserGraphHandler);

export default router;
