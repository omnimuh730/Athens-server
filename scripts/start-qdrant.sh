#!/usr/bin/env bash
# Start Qdrant via Docker on http://127.0.0.1:6333 (persistent docker volume).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Stop embedded binary if it was used before — only one process can bind :6333.
if [[ -f "$ROOT/.local/qdrant/qdrant.pid" ]]; then
  bash "$ROOT/scripts/stop-qdrant-local.sh" 2>/dev/null || true
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop, then run: npm run qdrant:start"
  exit 1
fi

echo "Starting Qdrant (Docker) on http://127.0.0.1:6333 ..."
docker compose up -d qdrant

for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -sf "http://127.0.0.1:6333/" >/dev/null; then
    echo "Qdrant ready — dashboard: http://127.0.0.1:6333/dashboard"
    curl -sf "http://127.0.0.1:6333/collections" | head -c 200 || true
    echo
    exit 0
  fi
  sleep 1
done

echo "Qdrant did not become ready. Check: docker compose logs qdrant"
exit 1
