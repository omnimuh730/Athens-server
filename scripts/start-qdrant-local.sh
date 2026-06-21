#!/usr/bin/env bash
# Run Qdrant locally without Docker (macOS Linux x86_64/aarch64).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="$ROOT/.local/qdrant"
BIN="$INSTALL_DIR/qdrant"
STORAGE="$INSTALL_DIR/storage"
PID_FILE="$INSTALL_DIR/qdrant.pid"
LOG_FILE="$INSTALL_DIR/qdrant.log"

arch="$(uname -m)"
case "$arch" in
  arm64|aarch64) ARCHIVE="qdrant-aarch64-apple-darwin" ;;
  x86_64) ARCHIVE="qdrant-x86_64-apple-darwin" ;;
  *)
    echo "Unsupported CPU: $arch. Use Docker or see https://qdrant.tech/documentation/installation/"
    exit 1
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This helper targets macOS. On Linux use Docker or the .deb from GitHub releases."
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$STORAGE"

if [[ ! -x "$BIN" ]]; then
  echo "Downloading Qdrant ($ARCHIVE)..."
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/qdrant/qdrant/releases/latest/download/${ARCHIVE}.tar.gz" -o "$tmp/qdrant.tar.gz"
  tar -xzf "$tmp/qdrant.tar.gz" -C "$tmp"
  cp "$tmp/qdrant" "$BIN"
  chmod +x "$BIN"
  rm -rf "$tmp"
  echo "Installed $BIN"
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE")"
  if kill -0 "$old_pid" 2>/dev/null; then
    echo "Qdrant already running (pid $old_pid) — http://127.0.0.1:6333"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

export QDRANT__STORAGE__STORAGE_PATH="$STORAGE"
nohup "$BIN" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://127.0.0.1:6333/" >/dev/null; then
    echo "Qdrant started — http://127.0.0.1:6333 (log: $LOG_FILE)"
    exit 0
  fi
  sleep 1
done

echo "Qdrant failed to start. Check $LOG_FILE"
exit 1
