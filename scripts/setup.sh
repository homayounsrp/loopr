#!/usr/bin/env bash
# One-command setup: backend venv + deps, frontend deps, and a .env.
# Run from anywhere:  bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # → project root

echo "→ backend: virtualenv + dependencies"
python3 -m venv backend/.venv
backend/.venv/bin/pip install -q --upgrade pip
backend/.venv/bin/pip install -q -r backend/requirements.txt

echo "→ frontend: npm dependencies"
( cd frontend && npm install --silent )

if [ ! -f .env ]; then
  cp .env.example .env
  echo "→ wrote .env (client mode — no API key needed)"
fi

echo ""
echo "✓ setup complete."
echo "  Start both servers:   bash scripts/start.sh"
echo "  Then open:            http://localhost:3000/loopr"
echo "  The 'loopr' MCP is auto-detected from .mcp.json — approve it when Claude Code asks."
