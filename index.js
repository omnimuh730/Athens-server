import dotenv from "dotenv";
dotenv.config();

import http from "http";
import express from "express";
import cors from 'cors';

import { initMongo } from "./src/db/mongo.js";
import { initRedis } from "./src/db/redis.js";
import { initSocket } from "./src/socketHub.js";
import { startJobAnalysisWorker } from "./src/services/jobAnalysis/index.js";
import { initQdrantCollections } from "./src/services/vectorStore/qdrantClient.js";
import { checkOllamaEmbeddingReady } from "./src/services/embeddings/embeddingService.js";

import openTabsRoutes from "./src/routes/openTabsRoutes.js";
import jobRoutes from "./src/routes/jobRoutes.js";
import personalInfoRoutes from "./src/routes/personalInfoRoutes.js";
import skillCategoryRoutes from "./src/routes/skillCategoryRoutes.js";
import skillGraphRoutes from "./src/routes/skillGraphRoutes.js";
import reportRoutes from "./src/routes/reportRoutes.js";
import accountInfoRoutes from "./src/routes/accountInfoRoutes.js";
import foxRoutes from "./src/routes/foxRoutes.js";
import ruleRoutes from "./src/routes/ruleRoutes.js";
import vendorMonitorRoutes from "./src/routes/vendorMonitorRoutes.js";
import mailRoutes from "./src/routes/mailRoutes.js";
import settingsRoutes from "./src/routes/settingsRoutes.js";
import agentRoutes from "./src/routes/agentRoutes.js";
import connectorInternalRoutes from "./src/routes/connectorInternalRoutes.js";
import { errorHandler } from "./src/middleware/errorHandler.js";
import {
	getAutoBidProfile,
	upsertAutoBidProfile,
	getResumeCatalog,
	upsertResumeCatalog,
	validateResumeCatalogHandler,
} from "./src/controllers/personalInfoController.js";

const app = express();
const port = Number.parseInt(String(process.env.PORT || "7979"), 10) || 7979;
const host = process.env.HOST !== undefined && process.env.HOST !== "" ? process.env.HOST : "0.0.0.0";

app.use(express.json({ limit: '50mb' }));
app.use(cors({ origin: '*' }));

async function bootstrap() {
	await initMongo();
	await initRedis();
	startJobAnalysisWorker();
	try {
		await initQdrantCollections();
	} catch (err) {
		console.error('Qdrant init failed — optional similar-jobs feature disabled:', err.message);
	}
	const ollamaCheck = await checkOllamaEmbeddingReady();
	if (!ollamaCheck.ok) {
		console.warn('[embeddings] Ollama not ready:', ollamaCheck.error);
	} else if (ollamaCheck.model) {
		console.log(`[embeddings] Ollama ready — model ${ollamaCheck.model}`);
	}
}

bootstrap().catch(err => {
	console.error('Failed to start server', err);
	process.exit(1);
});

app.use('/api', openTabsRoutes);
app.use('/api', jobRoutes);
app.use('/api', personalInfoRoutes);
app.use('/api', skillCategoryRoutes);
app.use('/api', skillGraphRoutes);
app.use('/api', connectorInternalRoutes);
app.use('/api', reportRoutes);
app.use('/api', accountInfoRoutes);
app.use('/api', foxRoutes);
app.use('/api', ruleRoutes);
app.use('/api', vendorMonitorRoutes);
app.use('/api', mailRoutes);
app.use('/api', settingsRoutes);
app.use('/api/agents', agentRoutes);

app.get("/personal/auto-bid-profile", getAutoBidProfile);
app.put("/personal/auto-bid-profile", upsertAutoBidProfile);
app.get("/personal/resume-catalog", getResumeCatalog);
app.put("/personal/resume-catalog", upsertResumeCatalog);
app.post("/personal/resume-catalog/validate", validateResumeCatalogHandler);

app.use(errorHandler);

app.use((req, res) => {
	if (req.originalUrl.startsWith("/api") || req.originalUrl.startsWith("/personal")) {
		return res.status(404).json({
			success: false,
			error: "API route not found",
			path: req.originalUrl,
		});
	}
	res.status(404).type("text/plain").send("Not found");
});

const server = http.createServer(app);
initSocket(server);

server.listen(port, host, () => {
	console.log(`Server running on http://${host}:${port}`);
	console.log(`Socket.IO on ws://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});
