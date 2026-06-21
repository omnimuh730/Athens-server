#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.local/qdrant/qdrant.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No local Qdrant pid file."
  exit 0
fi

pid="$(cat "$PID_FILE")"
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid"
  echo "Stopped Qdrant (pid $pid)"
else
  echo "Qdrant not running (stale pid $pid)"
fi
rm -f "$PID_FILE"
