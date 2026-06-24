import express from 'express';
import { listUserGraphsHandler, buildUserGraphHandler } from '../controllers/userGraphController.js';

const router = express.Router();

router.get('/user-graph', listUserGraphsHandler);
router.post('/user-graph/from-resume', buildUserGraphHandler);

export default router;
