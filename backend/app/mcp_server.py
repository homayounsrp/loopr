"""Loopr — MCP server (the orchestrator's control plane).

Run this as an MCP server in a Claude client (Claude Code / Desktop). Its tools
let the connected AI orchestrate the shared dashboard: define the agent pipeline,
set the goal + rubric + target, kick off the build, and read the results. The
inner maker/checker agents run on the dashboard's own Anthropic API key.

It talks to the running dashboard backend over its REST control plane, so start
the backend first (uvicorn on :8000). Override the URL with LOOPR_URL. This
module is standalone (only needs `mcp` + `httpx`), so run the file directly.

The repo ships a project-scoped `.mcp.json`, so Claude Code auto-detects this
server when you open the project — no manual registration needed. To register it
by hand (run from the repo root, so the relative paths resolve):

    claude mcp add loopr \
      -e LOOPR_URL=http://localhost:8000 \
      -- ./backend/.venv/bin/python ./backend/app/mcp_server.py
"""

from __future__ import annotations

import os
import re

import httpx
from mcp.server.fastmcp import FastMCP

BASE = os.environ.get("LOOPR_URL", "http://localhost:8000")

mcp = FastMCP("loopr")


def _slug(name: str) -> str:
    """Stable pane key from an agent name (so repeated pushes upsert one pane)."""
    s = re.sub(r"[^a-z0-9]+", "-", str(name).strip().lower()).strip("-")
    return s or "main"


async def _get(path: str) -> dict:
    async with httpx.AsyncClient() as c:
        r = await c.get(BASE + path, timeout=30)
        r.raise_for_status()
        return r.json()


async def _post(path: str, body: dict | None = None) -> dict:
    async with httpx.AsyncClient() as c:
        r = await c.post(BASE + path, json=body or {}, timeout=60)
        r.raise_for_status()
        return r.json()


def _status(s: dict, evals: list) -> str:
    done = bool(evals) and all(e["passed"] for e in evals)
    if s["halted"]:
        return "done" if done else "stopped"
    return "building" if s["running"] else "idle"


@mcp.tool()
async def get_dashboard_state() -> dict:
    """Summary of the shared factory: goal, agent pipeline, rubric with the latest
    0-100 scores, target, build/loop, status, and the checker's critique. Omits the
    full HTML to save tokens — use get_section_html for that."""
    s = await _get("/api/state")
    evals = s.get("evals", [])
    avg = round(sum(e["score"] for e in evals) / len(evals)) if evals else 0
    return {
        "goal": s["vision"]["brief"] or "(none yet)",
        "status": _status(s, evals),
        "build": s["build"],
        "loop": s["loopCount"],
        "maxLoops": s["maxLoops"] if s["maxLoopsEnabled"] else None,
        "targetAccuracy": s["targetAccuracy"],
        "avgScore": avg,
        "done": bool(evals) and all(e["passed"] for e in evals),
        "agents": [
            {"name": a["name"], "kind": a["kind"], "model": a["model"], "role": a["role"]}
            for a in s["agents"]
        ],
        "rubric": [
            {"criterion": e["label"], "score": e["score"], "met": e["passed"], "reason": e["detail"]}
            for e in evals
        ],
        "critique": s["reviewNotes"],
        "htmlChars": len(s["html"]),
        "recentMessages": [{"role": m["role"], "text": m["text"]} for m in s["messages"][-6:]],
    }


@mcp.tool()
async def get_section_html() -> str:
    """The current built About Us section HTML."""
    s = await _get("/api/state")
    return s["html"] or "(empty)"


@mcp.tool()
async def get_workspace() -> dict:
    """MODE B (client-driven) — read your current job before you build/grade: the
    goal, the rubric with its ids + latest scores, the target, the current HTML,
    the last critique, and your role(s). You (the connected Claude) do the actual
    work with your own tools, then push results via save_build / save_scores /
    save_critique."""
    s = await _get("/api/state")
    evals = s.get("evals", [])
    return {
        "mode": s.get("mode"),
        "goal": s["vision"]["brief"] or "(none yet)",
        # `submitted` = the human locked the settings; the rubric/target/cap below are
        # the finalized job. If false, they may still be editing — wait or confirm.
        "submitted": s.get("locked", False),
        "targetAccuracy": s["targetAccuracy"],
        # the loop cap the human set in the control panel — honour it while iterating
        "maxLoops": s["maxLoops"] if s["maxLoopsEnabled"] else None,
        "rubric": [
            {"id": e["id"], "criterion": e["label"], "score": e["score"], "met": e["passed"]}
            for e in evals
        ],
        "currentHtml": s["html"] or "(empty)",
        "critique": s["reviewNotes"],
        "roles": [{"name": a["name"], "kind": a["kind"], "role": a["role"]} for a in s["agents"]],
        "build": s["build"],
        "loop": s["loopCount"],
        "done": bool(evals) and all(e["passed"] for e in evals),
    }


@mcp.tool()
async def save_build(html: str, summary: str = "") -> dict:
    """MODE B — push a new build of the section: a self-contained HTML fragment
    (may include one <style> block; no <script>). For a research report, write the
    report as HTML (headings, lists, a Sources section with links). `summary` is a
    one-line chat note. Returns the new build number."""
    return await _post("/api/build", {"content": html, "summary": summary})


@mcp.tool()
async def save_change(
    summary: str, files: list[dict], branch: str = "", pr_url: str = ""
) -> dict:
    """MODE B (code mode) — when this build edits a REAL project on disk instead of
    producing HTML, report what changed here so the artifact rail can show it.

    Make the edits with your own file tools first, then call this.
    - summary: one line describing the whole change.
    - files: [{path, summary}] — one entry per touched file, `summary` a short,
      high-level, plain-English note of what changed in that file (no diffs, no
      line counts).
    - branch / pr_url: pass ONLY if you actually pushed a branch or opened a PR;
      leave empty otherwise. The UI shows the link only when set.

    Returns the new build number. Grade it with save_scores as usual (command-kind
    rubric criteria like `pytest` run against the real files)."""
    return await _post(
        "/api/change",
        {"summary": summary, "files": files, "branch": branch, "prUrl": pr_url},
    )


@mcp.tool()
async def save_scores(scores: list[dict]) -> dict:
    """MODE B — grade the rubric against the current build. `scores` is a list of
    {id, score (0-100), reason}, using the ids from get_workspace's rubric. Put on
    your "checker" hat and grade honestly. Returns {avg, done} — loop again if not
    done."""
    return await _post("/api/scores", {"scores": scores})


@mcp.tool()
async def save_critique(notes: str) -> dict:
    """MODE B — post critique notes to guide your next build (markdown bullets ok)."""
    return await _post("/api/critique", {"notes": notes})


@mcp.tool()
async def emit_output(
    text: str,
    agent: str = "Orchestrator",
    is_subagent: bool = False,
    append: bool = True,
    done: bool = False,
    worktree: str = "",
    tokens: int = -1,
) -> dict:
    """MODE B — stream your live working output to the dashboard so anyone watching
    sees it happen.

    Call it with `is_subagent=False` (the default) for YOUR OWN output — that fills
    the single "Orchestrator" pane. If you spawn subagents, call it once per
    subagent with `is_subagent=True` and a distinct `agent` name (e.g. "Researcher",
    "Fact-checker") — each name gets its OWN pane, shown separately.

    `append=True` (default) adds `text` to that pane so you can stream in chunks;
    pass `append=False` to replace the pane's contents. Set `done=True` on the final
    chunk to mark that pane finished. `worktree` tags the pane with the branch the
    subagent runs in (Component 2 isolation). `tokens` sets this agent's cumulative
    token usage so the dashboard can show a per-agent and total breakdown. Text
    renders as markdown."""
    body = {
        "id": _slug(agent),
        "text": text,
        "label": agent,
        "role": "subagent" if is_subagent else "orchestrator",
        "append": append,
        "status": "done" if done else "streaming",
    }
    if worktree:
        body["worktree"] = worktree
    if tokens >= 0:
        body["tokens"] = tokens
    return await _post("/api/output", body)


@mcp.tool()
async def save_findings(findings: list[dict]) -> dict:
    """MODE B — post the checker's structured findings so the loop's feedback flow
    is visible. Each is {issue, where, fix_hint, addressed}. Keep the same `id` and
    flip `addressed` to true on a later pass once the maker fixes it — that's how
    the dashboard shows evaluation→next-pass, not just a freeform critique."""
    return await _post("/api/findings", {"findings": findings})


@mcp.tool()
async def set_gate(action: str, detail: str = "") -> dict:
    """MODE B — raise a human checkpoint before an irreversible action (open a PR,
    publish, delete). The loop goes `awaiting_human`; the dashboard shows an
    Approve/Reject banner. Wait for the human to resolve it before proceeding."""
    return await _post("/api/gate", {"action": action, "detail": detail})


@mcp.tool()
async def set_schedule(trigger: str, next_run: str = "", last_run: str = "") -> dict:
    """MODE B — record the loop's cadence (Component 1) shown in the monitor, e.g.
    trigger 'every 30m' / 'on push' / 'nightly'. Empty trigger = in-session only."""
    return await _post("/api/schedule", {"trigger": trigger, "nextRun": next_run, "lastRun": last_run})


@mcp.tool()
async def set_plan(plan: list[dict]) -> dict:
    """MODE B — record this round's decomposition (orchestrated loop): a list of
    {subtask, agent, worktree}. Shows how you split the goal across specialists."""
    return await _post("/api/plan", {"plan": plan})


@mcp.tool()
async def export_state() -> dict:
    """MODE B — read the restorable loop state (Component 6 memory): goal, rubric,
    target, iteration, history, findings, builds, plan. Save it to resume later."""
    return await _get("/api/loopstate")


@mcp.tool()
async def resume_state(state: dict) -> dict:
    """MODE B — restore a loop from a previously exported state doc (memory)."""
    return await _post("/api/loopstate", state)


@mcp.tool()
async def clear_outputs() -> dict:
    """MODE B — clear all live output panes (orchestrator + subagents). Call at the
    start of a fresh run so old output doesn't linger."""
    return await _post("/api/output/clear")


@mcp.tool()
async def set_agents(agents: list[dict]) -> dict:
    """Define the agent pipeline. Each agent is {name, kind, role, model} where
    kind is 'maker' (builds the HTML) or 'checker' (grades the rubric 0-100 and
    critiques). model is one of: claude-sonnet-4-6, claude-haiku-4-5, claude-opus-4-8.
    Agents run left-to-right each loop; a maker followed by a checker is a
    maker-checker loop."""
    return await _post("/api/agents", {"agents": agents})


@mcp.tool()
async def set_rubric(criteria: list[str]) -> dict:
    """Set the pass/fail rubric: a list of plain-English criteria the checker
    grades 0-100 (e.g. 'Mentions the founding year', 'Warm, human tone')."""
    return await _post("/api/rubric", {"criteria": criteria})


@mcp.tool()
async def set_target(percent: int) -> dict:
    """Set the target accuracy (0-100). The loop iterates until every rubric
    scores at least this."""
    return await _post("/api/target", {"percent": percent})


@mcp.tool()
async def set_loop_cap(loops: int, enabled: bool = True) -> dict:
    """Set the max-loop safety cap. enabled=False → run until the target is hit
    (no cap; use stop to end)."""
    return await _post("/api/loop_cap", {"loops": loops, "enabled": enabled})


@mcp.tool()
async def send_brief(text: str) -> dict:
    """Send the goal/brief to the makers and start (or continue) the build loop.
    This is what kicks the pipeline off."""
    return await _post("/api/chat", {"text": text})


@mcp.tool()
async def reset() -> dict:
    """Clear the chat and the built section (keeps the rubric, target, and agents)."""
    return await _post("/api/reset")


@mcp.tool()
async def stop() -> dict:
    """Stop the running loop."""
    return await _post("/api/stop")


def main() -> None:
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
