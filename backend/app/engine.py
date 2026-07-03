"""Loopr engine — the orchestrator (a configurable agent pipeline).

It owns one FactoryState and drives a single loop iteration = run the pipeline
(the agents you defined in the Agent Builder) in order:

    maker   → writes / revises the About Us HTML from the brief + checker feedback
    checker → grades the rubric (0-100) and critiques the build; notes feed makers

A maker followed by a checker is a maker–checker loop; you can add, re-role,
re-model and re-order agents. The loop repeats until every rubric hits the target
accuracy or the (optional) loop cap, then it halts.

One engine instance drives one WebSocket connection: each viewer controls their
own factory (start / stop / speed / reset / chat / config) and receives a fresh
Snapshot after every step via the injected `emit` callback.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable

from .agents.steps import run_checker, run_maker
from .domain.models import Snapshot, Tone
from .sanitize import strip_scripts
from .state import FactoryState

#: floor delay between iterations (each iteration is dominated by LLM latency)
ITERATION_MS = 600

EmitFn = Callable[[Snapshot], Awaitable[None]]


class LooprEngine:
    def __init__(self, emit: EmitFn) -> None:
        self._emit_cb = emit
        self.state = FactoryState()
        self._task: asyncio.Task[None] | None = None

    # -- broadcast ------------------------------------------------------------

    async def emit_current(self) -> None:
        await self._emit_cb(self.state.to_snapshot())

    # -- lifecycle ------------------------------------------------------------

    async def start(self) -> None:
        if self.state.running:
            return
        now = time.time() * 1000
        self.state.running = True
        self.state.started_at = now
        self.state.now = now
        names = " → ".join(f"{a.name} ({a.kind})" for a in self.state.agents)
        self.state.log("system", f"started — pipeline: {names}", Tone.good)
        await self.emit_current()
        self._schedule()

    async def set_speed(self, mult: float) -> None:
        self.state.speed = max(mult, 0.1)

    # -- chat -----------------------------------------------------------------

    async def chat(self, text: str, files: list[dict]) -> None:
        """A user turn: the brief + optional files.

        In "api" mode this kicks off the autonomous backend loop. In "client" mode
        the backend never calls the LLM — it just records the goal; the connected
        Claude client reads it (get_workspace) and does the work via save_build/…"""
        self.state.add_user_message(text, files)
        if self.state.mode == "api" and not self.state.running:
            await self.start()
        else:
            await self.emit_current()

    # -- client-driven work (Mode B: the Claude client pushes results) --------

    async def save_build(self, content: str, summary: str = "") -> dict:
        self.state.set_html(strip_scripts(str(content)))
        self.state.loop_count += 1
        self.state.running = True  # a client is actively working
        self.state.halted = False
        note = str(summary).strip() or f"Updated the section (build #{self.state.build})."
        self.state.add_builder_message(note)
        self.state.record_build(note)  # memory: keep the artifact for diff/resume
        await self.emit_current()
        return {"build": self.state.build}

    async def save_change(
        self, summary: str, files: list[dict], branch: str = "", pr_url: str = ""
    ) -> dict:
        """Code-mode build: record what this pass changed in a real project
        (per-file high-level notes, plus an optional pushed branch / PR link)."""
        self.state.set_code_change(summary, list(files), branch, pr_url)
        self.state.loop_count += 1
        self.state.running = True
        self.state.halted = False
        note = str(summary).strip() or f"Changed {len(files)} file(s) (build #{self.state.build})."
        self.state.add_builder_message(note)
        self.state.record_build(note)  # memory: keep the change summary per build
        await self.emit_current()
        return {"build": self.state.build}

    async def save_scores(self, scores: list[dict]) -> dict:
        self.state.apply_scores(list(scores))
        self.state.record_iteration()  # append this pass to the history spine
        ev = self.state.eval_results
        avg = round(sum(r.score for r in ev) / len(ev)) if ev else 100
        if self.state.was_green:
            self.state.running = False
            self.state.halted = True
            self.state.log(
                "system",
                f"all {len(ev)} rubrics ≥ {self.state.target_accuracy}% — done "
                f"(build #{self.state.build})",
                Tone.good,
            )
        await self.emit_current()
        return {"avg": avg, "done": self.state.was_green}

    async def save_critique(self, notes: str) -> dict:
        self.state.review_notes = str(notes)
        await self.emit_current()
        return {"ok": True}

    async def push_output(
        self,
        id: str,
        text: str,
        label: str | None = None,
        role: str = "subagent",
        append: bool = True,
        status: str = "streaming",
        worktree: str | None = None,
        tokens: int = -1,
    ) -> dict:
        self.state.push_output(
            id, text, label=label, role=role, append=append, status=status, worktree=worktree, tokens=tokens
        )
        await self.emit_current()
        return {"ok": True, "id": id}

    async def clear_outputs(self) -> dict:
        self.state.clear_outputs()
        await self.emit_current()
        return {"ok": True}

    # -- loop monitoring (findings / gate / schedule / decomposition / memory) --

    async def set_findings(self, items: list[dict]) -> dict:
        self.state.set_findings(list(items))
        await self.emit_current()
        return {"findings": len(self.state.findings)}

    async def set_gate(self, action: str, detail: str = "") -> dict:
        self.state.set_gate(action, detail)
        await self.emit_current()
        return {"ok": True, "status": self.state.compute_status()}

    async def resolve_gate(self, approve: bool) -> dict:
        self.state.resolve_gate(approve)
        await self.emit_current()
        return {"ok": True, "status": self.state.compute_status()}

    async def set_schedule(self, trigger: str, last_run: str = "", next_run: str = "") -> dict:
        self.state.set_schedule(trigger, last_run, next_run)
        await self.emit_current()
        return {"ok": True}

    async def set_plan(self, items: list[dict]) -> dict:
        self.state.set_plan(list(items))
        await self.emit_current()
        return {"plan": len(self.state.plan)}

    async def import_loop_state(self, doc: dict) -> dict:
        self.state.import_loop_state(dict(doc))
        await self.emit_current()
        return {"ok": True, "status": self.state.compute_status()}

    # -- GUI-driven configuration & reset ------------------------------------

    async def reset(self) -> None:
        self.state.reset_work()
        await self.emit_current()

    async def set_evals(self, items: list[dict]) -> None:
        self.state.set_eval_specs(items)
        await self.emit_current()

    async def set_max_loops(self, n: int, enabled: bool) -> None:
        self.state.set_max_loops(n, enabled)
        await self.emit_current()

    async def set_target_accuracy(self, v: int) -> None:
        self.state.set_target_accuracy(v)
        await self.emit_current()

    async def set_per_criterion_targets(self, enabled: bool) -> None:
        self.state.set_per_criterion_targets(bool(enabled))
        await self.emit_current()

    async def set_criterion_targets(self, targets: dict) -> None:
        self.state.set_criterion_targets(dict(targets))
        await self.emit_current()

    async def set_goal(self, text: str) -> None:
        """Set the loop goal directly (what the human wants the orchestrator to
        build/research). The orchestrator reads this via get_workspace as `goal`."""
        if str(text).strip() == self.state.vision.brief.strip():
            return  # no-op (e.g. blur without an edit) — don't reset the loop
        self.state.set_vision(str(text))
        await self.emit_current()

    async def set_locked(self, locked: bool) -> None:
        """Submit (lock) or re-open (unlock) the settings. Locked = the human is
        done configuring and the rubric/target/cap are the finalized job the
        orchestrator reads via get_workspace."""
        was_locked = self.state.locked
        self.state.locked = bool(locked)
        # A fresh submit (unlocked → locked) with a real job enqueues a run the
        # orchestrator will pick up. Bumping the seq is what makes it "pending".
        if locked and not was_locked and self.state.vision.brief.strip() and self.state.eval_specs:
            self.state.run_request_seq += 1
        self.state.log(
            "system",
            "settings submitted — locked" if locked else "settings unlocked for editing",
            Tone.good if locked else Tone.steer,
        )
        await self.emit_current()

    async def claim_job(self, seq: int) -> dict:
        """Orchestrator claims the pending job so it runs exactly once."""
        if seq >= self.state.run_request_seq:
            self.state.run_ack_seq = self.state.run_request_seq
        await self.emit_current()
        return {"acked": self.state.run_ack_seq, "requested": self.state.run_request_seq}

    async def set_agents(self, items: list[dict]) -> None:
        self.state.set_agents(items)
        await self.emit_current()

    async def stop(self) -> None:
        self.state.running = False
        await self._cancel_task()
        await self.emit_current()

    async def shutdown(self) -> None:
        """Tear down without emitting (used when the socket is gone)."""
        self.state.running = False
        await self._cancel_task()

    # -- scheduling -----------------------------------------------------------

    def _schedule(self) -> None:
        if self._task:
            self._task.cancel()
        self._task = asyncio.create_task(self._run())

    async def _cancel_task(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def _run(self) -> None:
        try:
            while self.state.running:
                await asyncio.sleep(ITERATION_MS / 1000 / self.state.speed)
                if not self.state.running:
                    break
                await self._iterate()
        except asyncio.CancelledError:
            pass  # rescheduled or shutting down

    async def _iterate(self) -> None:
        st = self.state
        if st.halted:
            return
        if st.was_green:
            st.halted = True
            await self.emit_current()
            return
        if st.max_loops_enabled and st.loop_count >= st.max_loops:
            st.halted = True
            met = sum(1 for r in st.eval_results if r.passed)
            st.log(
                "system",
                f"stopped at max loops ({st.max_loops}) — "
                f"{met}/{len(st.eval_results)} rubrics at target {st.target_accuracy}%",
                Tone.bad,
            )
            await self.emit_current()
            return

        st.loop_count += 1

        # Run the pipeline in order: makers build, checkers grade + critique.
        for agent in list(st.agents):
            if not st.running:
                return
            if agent.kind == "checker":
                await run_checker(st, agent)
            else:
                await run_maker(st, agent)
            st.tick(agent.id)
            await self.emit_current()

        # After the pipeline, the last checker's grades decide "done".
        if st.was_green:
            st.halted = True
            st.log(
                "system",
                f"all {len(st.eval_results)} rubrics ≥ {st.target_accuracy}% — done "
                f"(build #{st.build}, {st.loop_count} loops)",
                Tone.good,
            )
            await self.emit_current()
