"""FastAPI entrypoint.

One **shared** factory (a single LooprEngine) that any number of clients drive
and observe together:

  * Browsers connect over the WebSocket at /ws/factory — they subscribe to the
    shared snapshot stream and can send command messages.
  * An orchestrator (a Claude client via the MCP server) drives the same factory
    over the REST control plane under /api/* — set the agent pipeline, the goal,
    the rubric, the target; read the results.

Because both act on the same engine, whatever the orchestrator does shows up live
in every open browser. The inner maker/checker agents run on the configured
Anthropic API key.
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

# Load the project-root .env before importing anything that reads env at import
# time (the agents' model defaults, the Anthropic client).
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from .domain.models import Snapshot  # noqa: E402
from .engine import LooprEngine  # noqa: E402

app = FastAPI(title="Loopr", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# -- the single shared factory --------------------------------------------------

_subscribers: set[WebSocket] = set()


async def _broadcast(snap: Snapshot) -> None:
    payload = snap.model_dump(by_alias=True, mode="json")
    dead = []
    for ws in _subscribers:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _subscribers.discard(ws)


engine = LooprEngine(_broadcast)


def _snap_dict() -> dict:
    return engine.state.to_snapshot().model_dump(by_alias=True, mode="json")


# -- health ---------------------------------------------------------------------


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


# -- browser WebSocket (subscribe + send commands) ------------------------------


@app.websocket("/ws/factory")
async def factory(ws: WebSocket) -> None:
    await ws.accept()
    _subscribers.add(ws)
    await ws.send_json(_snap_dict())  # push the current shared state
    try:
        while True:
            msg = await ws.receive_json()
            match msg.get("type"):
                case "start":
                    await engine.start()
                case "stop":
                    await engine.stop()
                case "setSpeed":
                    await engine.set_speed(float(msg.get("value", 1)))
                case "chat":
                    await engine.chat(str(msg.get("text", "")), list(msg.get("files", [])))
                case "reset":
                    await engine.reset()
                case "setEvals":
                    await engine.set_evals(list(msg.get("evals", [])))
                case "setMaxLoops":
                    await engine.set_max_loops(
                        int(msg.get("value", 12)), bool(msg.get("enabled", True))
                    )
                case "setTargetAccuracy":
                    await engine.set_target_accuracy(int(msg.get("value", 85)))
                case "setGoal":
                    await engine.set_goal(str(msg.get("text", "")))
                case "setPerCriterionTargets":
                    await engine.set_per_criterion_targets(bool(msg.get("enabled", False)))
                case "setCriterionTargets":
                    await engine.set_criterion_targets(dict(msg.get("targets", {})))
                case "setLocked":
                    await engine.set_locked(bool(msg.get("value", False)))
                case "setAgents":
                    await engine.set_agents(list(msg.get("agents", [])))
                case "resolveGate":
                    await engine.resolve_gate(bool(msg.get("approve", False)))
                case "loadState":
                    await engine.import_loop_state(dict(msg.get("state", {})))
    except WebSocketDisconnect:
        pass
    finally:
        _subscribers.discard(ws)  # never shut the shared engine down on one leave


# -- REST control plane (the MCP server / orchestrator drives these) ------------


@app.get("/api/state")
async def api_state() -> dict:
    """The full shared snapshot (includes the built HTML)."""
    return _snap_dict()


@app.post("/api/chat")
async def api_chat(payload: dict = Body(default={})) -> dict:
    await engine.chat(str(payload.get("text", "")), list(payload.get("files", [])))
    return {"ok": True}


@app.post("/api/agents")
async def api_agents(payload: dict = Body(default={})) -> dict:
    await engine.set_agents(list(payload.get("agents", [])))
    return {"agents": _snap_dict()["agents"]}


@app.post("/api/rubric")
async def api_rubric(payload: dict = Body(default={})) -> dict:
    """Set the rubric. Each item is a plain string (LLM-judged criterion) OR an
    object {criterion, kind, command} — kind="command" is a test/command check the
    client runs against the user's own files."""
    items: list[dict] = []
    for c in payload.get("criteria", []):
        if isinstance(c, dict):
            it = {
                "criterion": str(c.get("criterion", "")),
                "kind": str(c.get("kind", "llm")),
                "command": str(c.get("command", "")),
            }
        else:
            it = {"criterion": str(c)}
        if it.get("criterion", "").strip() or it.get("command", "").strip():
            items.append(it)
    await engine.set_evals(items)
    return {"rubric": [{"criterion": e["label"], "kind": e.get("kind", "llm")} for e in _snap_dict()["evals"]]}


@app.post("/api/target")
async def api_target(payload: dict = Body(default={})) -> dict:
    await engine.set_target_accuracy(int(payload.get("percent", 85)))
    return {"targetAccuracy": engine.state.target_accuracy}


@app.post("/api/goal")
async def api_goal(payload: dict = Body(default={})) -> dict:
    await engine.set_goal(str(payload.get("text", payload.get("goal", ""))))
    return {"goal": engine.state.vision.brief}


@app.post("/api/per_criterion_targets")
async def api_per_criterion_targets(payload: dict = Body(default={})) -> dict:
    await engine.set_per_criterion_targets(bool(payload.get("enabled", False)))
    return {"perCriterionTargets": engine.state.per_criterion_targets}


@app.post("/api/criterion_targets")
async def api_criterion_targets(payload: dict = Body(default={})) -> dict:
    await engine.set_criterion_targets(dict(payload.get("targets", {})))
    return {"ok": True}


@app.post("/api/locked")
async def api_locked(payload: dict = Body(default={})) -> dict:
    await engine.set_locked(bool(payload.get("value", True)))
    return {"locked": engine.state.locked, "seq": engine.state.run_request_seq}


@app.get("/api/nextjob")
async def api_nextjob() -> dict:
    """Durable job queue: the orchestrator polls this. `pending` is true when the
    human submitted a job that hasn't been claimed yet. The job survives restarts
    and reconnects until claimed via /api/nextjob/claim."""
    s = engine.state
    pending = s.run_request_seq > s.run_ack_seq
    return {
        "pending": pending,
        "seq": s.run_request_seq,
        "goal": s.vision.brief if pending else "",
        "target": s.target_accuracy,
        "cap": (s.max_loops if s.max_loops_enabled else None),
        "criteria": [{"id": c.id, "criterion": c.criterion} for c in s.eval_specs] if pending else [],
    }


@app.post("/api/nextjob/claim")
async def api_nextjob_claim(payload: dict = Body(default={})) -> dict:
    return await engine.claim_job(int(payload.get("seq", engine.state.run_request_seq)))


@app.post("/api/loop_cap")
async def api_loop_cap(payload: dict = Body(default={})) -> dict:
    await engine.set_max_loops(int(payload.get("loops", 12)), bool(payload.get("enabled", True)))
    return {"maxLoops": engine.state.max_loops, "maxLoopsEnabled": engine.state.max_loops_enabled}


# -- client-driven work (Mode B): the Claude client pushes results here --------


@app.post("/api/build")
async def api_build(payload: dict = Body(default={})) -> dict:
    content = payload.get("content", payload.get("html", ""))
    return await engine.save_build(str(content), str(payload.get("summary", "")))


@app.post("/api/change")
async def api_change(payload: dict = Body(default={})) -> dict:
    """Code-mode build: files changed in a real project, with per-file notes and
    an optional pushed branch / PR link."""
    return await engine.save_change(
        str(payload.get("summary", "")),
        list(payload.get("files", [])),
        str(payload.get("branch", "")),
        str(payload.get("prUrl", payload.get("pr_url", ""))),
    )


@app.post("/api/scores")
async def api_scores(payload: dict = Body(default={})) -> dict:
    return await engine.save_scores(list(payload.get("scores", [])))


@app.post("/api/critique")
async def api_critique(payload: dict = Body(default={})) -> dict:
    return await engine.save_critique(str(payload.get("notes", "")))


@app.post("/api/output")
async def api_output(payload: dict = Body(default={})) -> dict:
    """Mode B: the orchestrator streams its own / a subagent's live output here."""
    return await engine.push_output(
        str(payload.get("id", "main")),
        str(payload.get("text", "")),
        label=(str(payload["label"]) if payload.get("label") else None),
        role=str(payload.get("role", "subagent")),
        append=bool(payload.get("append", True)),
        status=str(payload.get("status", "streaming")),
        worktree=(str(payload["worktree"]) if payload.get("worktree") is not None else None),
        tokens=int(payload.get("tokens", -1)),
    )


@app.post("/api/output/clear")
async def api_output_clear() -> dict:
    return await engine.clear_outputs()


# -- loop monitoring: findings / gate / schedule / decomposition / memory ------


@app.post("/api/findings")
async def api_findings(payload: dict = Body(default={})) -> dict:
    return await engine.set_findings(list(payload.get("findings", [])))


@app.post("/api/gate")
async def api_gate(payload: dict = Body(default={})) -> dict:
    return await engine.set_gate(str(payload.get("action", "")), str(payload.get("detail", "")))


@app.post("/api/gate/resolve")
async def api_gate_resolve(payload: dict = Body(default={})) -> dict:
    return await engine.resolve_gate(bool(payload.get("approve", False)))


@app.post("/api/schedule")
async def api_schedule(payload: dict = Body(default={})) -> dict:
    return await engine.set_schedule(
        str(payload.get("trigger", "")),
        str(payload.get("lastRun", payload.get("last_run", ""))),
        str(payload.get("nextRun", payload.get("next_run", ""))),
    )


@app.post("/api/plan")
async def api_plan(payload: dict = Body(default={})) -> dict:
    return await engine.set_plan(list(payload.get("plan", [])))


@app.get("/api/loopstate")
async def api_loopstate_get() -> dict:
    """Export the restorable loop state (Component 6 memory)."""
    return engine.state.export_loop_state()


@app.post("/api/loopstate")
async def api_loopstate_post(payload: dict = Body(default={})) -> dict:
    """Resume from an exported loop state."""
    return await engine.import_loop_state(dict(payload))


@app.post("/api/reset")
async def api_reset() -> dict:
    await engine.reset()
    return {"ok": True}


@app.post("/api/stop")
async def api_stop() -> dict:
    await engine.stop()
    return {"ok": True}
