#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose stop qdrant 2>/dev/null || true
echo "Qdrant (Docker) stopped."
