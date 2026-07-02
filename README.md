# Loopr

A live dashboard for **loop engineering**: a **maker → checker loop** builds an
artifact, grades it against a rubric you define, and iterates until every
criterion clears your target — while every step streams to the screen.

It runs in **Mode B (client-driven)**: the backend makes **zero LLM calls**. A
connected Claude client (the *orchestrator*) does the work with its own tools and
subscription and pushes results in over the `loopr` MCP server. Anyone watching
the dashboard sees the loop run live — the orchestrator's output, each subagent it
spawns, the convergence trend, findings, and the graded artifact.

> There's also an autonomous **Mode A (`LOOPR_MODE=api`)** where the backend
> runs the maker/checker agents itself on an Anthropic API key.

## Quick start

Needs **Python 3.11+** and **Node 18+**.

```bash
git clone <your-repo-url> loopr && cd loopr
bash scripts/setup.sh      # backend venv + deps, frontend deps, writes .env
bash scripts/start.sh      # backend :8000  +  frontend :3000
```

Open **http://localhost:3000/loopr**.

## Add it to Claude (so Claude can drive the dashboard)

The repo ships a project-scoped **`.mcp.json`**, so **Claude Code auto-detects the
`loopr` server** — just open the project folder in Claude Code and approve it
when prompted (`/mcp` lists it). It points at the backend on `http://localhost:8000`.

Prefer to register it by hand, or on a different machine/port?

```bash
claude mcp add loopr \
  -e LOOPR_URL=http://localhost:8000 \
  -- ./backend/.venv/bin/python ./backend/app/mcp_server.py
```

> **Windows:** the interpreter is `backend\.venv\Scripts\python.exe` — edit
> `.mcp.json`'s `command` accordingly.

Once connected, ask Claude to drive it — e.g. *"research the last 3 days of AI-agent
news and land it on the dashboard."* Claude reads the job with `get_workspace`, does
the work, and pushes it back with the tools below.

### What the MCP server exposes
`get_workspace` · `save_build` · `save_scores` · `save_critique` · `emit_output`
(orchestrator + per-subagent panes) · `save_findings` · `set_gate` (human
checkpoint) · `set_schedule` · `set_plan` (decomposition) · `export_state` /
`resume_state` · plus config: `set_rubric` · `set_target` · `set_loop_cap` · `reset`.

The backend must be running — the MCP server is a thin proxy to its REST plane.

## Architecture

All logic lives in the Python backend; the frontend is a thin viewer that streams
state over a WebSocket and renders it.

```
backend/app/
  domain/models.py   Pydantic models (Snapshot, EvalResult, Finding, …) — snake→camelCase on the wire
  state.py           FactoryState — the shared mutable state (rubric, builds, history, findings, gate, …)
  engine.py          LooprEngine — applies pushes, derives status, broadcasts snapshots
  main.py            FastAPI: /ws/factory WebSocket + /api/* REST control plane
  mcp_server.py      the `loopr` MCP server (stdio) — proxies /api/* for a Claude client
  sanitize.py        strips <script> from pushed HTML
frontend/src/
  lib/types.ts       wire types mirroring the Snapshot
  lib/useFactory.ts  the single auto-reconnecting WebSocket hook
  app/loopr/page.tsx   the dashboard at /loopr
scripts/
  setup.sh · start.sh    one-command setup / run
  dashctl.py             shell driver for the same REST plane (used when the MCP isn't connected)
```

## Config

`.env` (created from `.env.example` by setup):

| var | default | meaning |
|-----|---------|---------|
| `LOOPR_MODE` | `client` | `client` = backend makes no LLM calls (Mode B). `api` = backend runs the agents. |
| `ANTHROPIC_API_KEY` | — | only needed for `api` mode |

The frontend talks to `ws://localhost:8000/ws/factory`; override with
`NEXT_PUBLIC_WS_URL`. The MCP server reads `LOOPR_URL` (default
`http://localhost:8000`).
