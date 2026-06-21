# Athens-server

Backend for **Athens** (NextOffer job search, resume analysis, skill graph, and multi-vector job recommendations). Default API base: `http://127.0.0.1:7979/api`.

## Features

- **Job market** — ingest, list, filter, and sort jobs (`POST /api/jobs/list`)
- **Multi-vector job recommendations** — per-applier ranking from analyzed resumes (not a single global profile score)
- **Resume upload & analysis** — LLM skill extraction, per-resume knowledge graphs
- **Skill knowledge graph** — Neo4j world graph + MongoDB user graphs; graph boost during ranking
- **Real-time** — Socket.io for extension / frontend events
- **Mail, accounts, rules, FoxHire integration** — see routes under `src/routes/`

## Stack

| Service | Purpose |
|---------|---------|
| **MongoDB** | Jobs, resumes, accounts, user knowledge graphs |
| **Neo4j** | Shared skill ontology (enrichment, graph re-rank) |
| **Qdrant** | Vector index for job + resume embeddings |
| **Ollama** | Local embeddings (`mxbai-embed-large`, no API key) |
| **Node.js + Express** | HTTP API and background workers |

## Job recommendation (overview)

Each applier can have **multiple analyzed resumes** (e.g. Frontend vs Backend). Each resume gets its own embedding in Qdrant.

When Job Search uses **Best match** (`sort=recommended`):

1. Load all analyzed resume vectors for the applier
2. Search job vectors in Qdrant (multi-vector **max** merge — identities are not averaged)
3. Re-rank top candidates with Neo4j graph activation
4. Return jobs with `matchScore`, `scoreSkill`, `bestResumeTechStack`, etc.

If Qdrant, Ollama, or analyzed resumes are missing, the API falls back to newest-first and sets `recommendationFallback: true`.

See [`idea.md`](../idea.md) in the repo root for the full design.

---

## Prerequisites

- **Node.js** 18+ and npm
- **MongoDB** running locally or remote
- **Neo4j** (skill graph enrichment)
- **Qdrant** (vector search) — Docker or binary
- **Ollama** (embeddings) — [native macOS app](https://ollama.com) or Docker

---

## Quick start

### 1. Install dependencies

```bash
cd Athens-server
npm install
cp .env.example .env
# Edit .env — at minimum MONGO_URL, NEO4J_*, QDRANT_URL, Ollama settings
```

### 2. Ollama (embeddings)

**Recommended on macOS:** install the [Ollama app](https://ollama.com) (no Docker required).

```bash
# Pull the embedding model once (~670MB)
npm run ollama-pull-embed
# or: ollama pull mxbai-embed-large

# Verify
ollama list
curl http://127.0.0.1:11434/api/tags
```

**Alternative:** Docker (requires Docker Desktop running):

```bash
docker compose up -d ollama
docker compose exec ollama ollama pull mxbai-embed-large
```

Default env (no API key):

```env
EMBEDDING_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
EMBEDDING_MODEL=mxbai-embed-large
EMBEDDING_DIMENSIONS=1024
```

`mxbai-embed-large` uses asymmetric retrieval: **jobs** are embedded as documents; **resumes** use a query prefix for better search quality. Inputs are truncated to ~1800 characters (`EMBEDDING_MAX_INPUT_CHARS`) because the model has a 512-token context window.

### 3. Qdrant (vector store)

Qdrant must be listening on `http://127.0.0.1:6333` before recommendations work.

**macOS without Docker (recommended if Docker Desktop is off):**

```bash
cd Athens-server
npm run qdrant:start    # downloads binary to .local/qdrant/ on first run
npm run qdrant:stop     # stop background process
```

**With Docker** (run from `Athens-server/`, not the repo root):

```bash
cd Athens-server
docker compose up -d qdrant
```

```env
QDRANT_URL=http://127.0.0.1:6333
```

Collections `job_vectors` and `resume_vectors` are created automatically on server start (1024 dimensions with default Ollama settings).

### 4. Backfill embeddings

After Ollama and Qdrant are up, embed existing jobs and analyzed resumes:

```bash
npm run backfill-job-embeddings
npm run backfill-resume-embeddings
```

New jobs and newly analyzed resumes are embedded automatically in the background.

### 5. Start the server

```bash
npm start
```

On startup you should see logs for MongoDB, Neo4j, Qdrant collections, and Ollama model readiness.

---

## Environment variables

Copy from [`.env.example`](.env.example). Key groups:

| Variable | Description |
|----------|-------------|
| `PORT`, `HOST` | HTTP server (default `7979`) |
| `MONGO_URL`, `MONGO_DB` | Primary database |
| `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` | Skill graph |
| `QDRANT_URL` | Vector database |
| `EMBEDDING_PROVIDER` | `ollama` (default) or `openai` |
| `OLLAMA_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | Local embeddings |
| `RECOMMENDATION_VECTOR_TOP_K`, `RECOMMENDATION_CANDIDATE_POOL` | Retrieval tuning |

**Optional OpenAI embeddings** (requires `openaiApiKey` in `account_info.autoBidProfile`):

```env
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

Switching embedding provider or dimensions requires **re-backfilling** all vectors. If you change dimensions, reset the Qdrant volume or delete collections before re-backfilling.

---

## NPM scripts

| Script | Description |
|--------|-------------|
| `npm start` | Dev server (nodemon) |
| `npm run migrate` | Mongo migrations |
| `npm run qdrant:start` | Download & start local Qdrant (macOS, no Docker) |
| `npm run qdrant:stop` | Stop local Qdrant |
| `npm run backfill-job-embeddings` | Embed all jobs into Qdrant |
| `npm run backfill-resume-embeddings` | Embed all analyzed resumes into Qdrant |
| `npm run reset-skill-graph` | Reset Neo4j skill graph (destructive) |

---

## Recommendation-related API

| Method | Path | Notes |
|--------|------|--------|
| `POST` | `/api/jobs/list` | Body: `sort: "recommended"`, `applierName`, filters. Returns ranked jobs. |
| `POST` | `/api/personal/user-resumes/:id/analyze` | Extract skills + upsert resume embedding |
| `POST` | `/api/jobs` | Create job + async job embedding |
| `GET` | `/api/user-graph` | Per-resume / profile knowledge graphs |

Frontend (Athens) maps **Best match** sort to `sort=recommended` and sends the current applier name.

---

## Project layout

```
Athens-server/
├── index.js                 # Entry: Express, Socket.io, workers
├── docker-compose.yml       # Qdrant + Ollama (optional)
├── src/
│   ├── controllers/         # HTTP handlers
│   ├── routes/
│   ├── services/
│   │   ├── embeddings/      # Ollama/OpenAI embed + ingest
│   │   ├── vectorStore/     # Qdrant client
│   │   ├── recommendation/  # Multi-vector search + graph re-rank
│   │   ├── skillGraph/      # Neo4j world graph
│   │   ├── userKnowledgeGraph/
│   │   └── jobAnalysis/
│   └── scripts/             # Backfill & maintenance
└── .env.example
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `docker.sock: connect: no such file` | Docker Desktop is not running. Use `npm run qdrant:start` from **Athens-server/** instead of Docker. |
| `no configuration file provided: not found` | Run `docker compose` from **Athens-server/** (where `docker-compose.yml` lives), not the repo root. |
| `[embeddings] Ollama not ready` | Start Ollama app or run `ollama serve`; then `npm run ollama-pull-embed`. |
| `[qdrant] QDRANT_URL not set` | Set `QDRANT_URL` and start Qdrant (`docker compose up -d qdrant`). |
| Job Search shows fallback banner | Analyze at least one resume; run both backfill scripts; confirm Qdrant + Ollama. |
| Wrong vector dimension errors | Model/dimension changed — reset Qdrant data and re-run backfills. |
| Neo4j errors | Check `NEO4J_*` in `.env`; skill enrichment disabled until Neo4j is up unless `NEO4J_REQUIRED=true`. |

---

## Docker Compose

[`docker-compose.yml`](docker-compose.yml) defines **Qdrant** and **Ollama**. You can run either service alone:

```bash
docker compose up -d qdrant          # vectors only
docker compose up -d ollama          # embeddings only (if not using native Ollama)
docker compose up -d                 # both
```

Native Ollama on macOS is usually simpler than running Ollama in Docker.
