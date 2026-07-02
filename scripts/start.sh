#!/usr/bin/env bash
# Start the backend (:8000) and frontend (:3000) together. Ctrl-C stops both.
# Run from anywhere:  bash scripts/start.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # → project root

if [ ! -x backend/.venv/bin/uvicorn ]; then
  echo "backend/.venv not found — run: bash scripts/setup.sh" >&2
  exit 1
fi

echo "→ backend  http://localhost:8000"
backend/.venv/bin/uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000 --reload &
BACK=$!

echo "→ frontend http://localhost:3000/loopr"
( cd frontend && npm run dev ) &
FRONT=$!

trap 'kill "$BACK" "$FRONT" 2>/dev/null || true' EXIT INT TERM
wait
