import dotenv from "dotenv";
dotenv.config();

import http from "http";
import express from "express";
import cors from 'cors';

import { initMongo } from "./src/db/mongo.js";
import { initNeo4j } from "./src/db/neo4j.js";
import { initSocket } from "./src/socketHub.js";
import { startEnrichmentWorker } from "./src/services/skillEnrichment/worker.js";

import openTabsRoutes from "./src/routes/openTabsRoutes.js";
import jobRoutes from "./src/routes/jobRoutes.js";
import personalInfoRoutes from "./src/routes/personalInfoRoutes.js";
import skillCategoryRoutes from "./src/routes/skillCategoryRoutes.js";
import skillGraphRoutes from "./src/routes/skillGraphRoutes.js";
import reportRoutes from "./src/routes/reportRoutes.js";
import accountInfoRoutes from "./src/routes/accountInfoRoutes.js";
import foxRoutes from "./src/routes/foxRoutes.js";
import ruleRoutes from "./src/routes/ruleRoutes.js";
import skillScoreRoutes from "./src/routes/skillScoreRoutes.js";
import vendorMonitorRoutes from "./src/routes/vendorMonitorRoutes.js";
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
	try {
		await initNeo4j();
		startEnrichmentWorker();
	} catch (err) {
		console.error('Neo4j connection failed — skill graph enrichment disabled until fixed:', err.message);
		if (process.env.NEO4J_REQUIRED === 'true') {
			process.exit(1);
		}
	}
}

bootstrap().catch(err => {
	console.error('Failed to start server', err);
	process.exit(1);
});

// `/api/*` - default for SPA / Fox / direct fetches with API_BASE ending in `/api`.
app.use('/api', openTabsRoutes);
app.use('/api', jobRoutes);
app.use('/api', personalInfoRoutes);
app.use('/api', skillCategoryRoutes);
app.use('/api', skillGraphRoutes);
app.use('/api', reportRoutes);
app.use('/api', accountInfoRoutes);
app.use('/api', foxRoutes);
app.use('/api', ruleRoutes);
app.use('/api', skillScoreRoutes);
app.use('/api', vendorMonitorRoutes);

// Aliases without `/api` (reverse proxies that strip `/api` before forwarding to Node).
app.get("/personal/auto-bid-profile", getAutoBidProfile);
app.put("/personal/auto-bid-profile", upsertAutoBidProfile);
app.get("/personal/resume-catalog", getResumeCatalog);
app.put("/personal/resume-catalog", upsertResumeCatalog);
app.post("/personal/resume-catalog/validate", validateResumeCatalogHandler);

app.use((req, res) => {
	if (req.originalUrl.startsWith("/api") || req.originalUrl.startsWith("/personal")) {
		return res.status(404).json({
			success: false,
			error: "API route not found",
			path: req.originalUrl,
			hint: "If you expected a profile route, deploy the latest lancer-backend (GET/PUT /api/personal/auto-bid-profile).",
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
