import express from 'express';
import { resolveSkillHandler, getSubgraphHandler, runEnrichmentHandler } from '../controllers/skillGraphController.js';

const router = express.Router();

router.get('/skills/resolve', resolveSkillHandler);
router.get('/skills/graph/subgraph', getSubgraphHandler);
router.post('/skills/enrichment/run', runEnrichmentHandler);

export default router;
