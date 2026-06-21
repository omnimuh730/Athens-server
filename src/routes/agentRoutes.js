import express from "express";
import { proxyToAgentBff } from "../controllers/agentProxyController.js";

const router = express.Router();

router.get("/health", proxyToAgentBff);
router.get("/dashboard", proxyToAgentBff);
router.get("/runs", proxyToAgentBff);
router.get("/runs/:runId/events", proxyToAgentBff);
router.get("/runs/:runId/screenshots/:file", proxyToAgentBff);
router.get("/stream/:runId", proxyToAgentBff);
router.get("/activity", proxyToAgentBff);
router.get("/job-sources", proxyToAgentBff);
router.get("/jobs", proxyToAgentBff);
router.get("/models", proxyToAgentBff);
router.post("/deploy", proxyToAgentBff);
router.post("/runs/:runId/resume", proxyToAgentBff);

export default router;
