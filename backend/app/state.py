"""FactoryState — the single mutable state the two agents share.

The agents read and mutate this; the engine schedules them and reads
`to_snapshot()` to broadcast. Config (the brand brief, the eval criteria, the
loop cap) is owned by the human and edited from the GUI; the agents' *work* (the
built HTML and its progress) is what `reset_work()` clears — so a demo can always
start from empty without touching the setup.
"""

from __future__ import annotations

import os
import time
import uuid

from .domain.models import (
    AgentDef,
    BuildRecord,
    ChangedFile,
    ChatMessage,
    CodeChange,
    EvalResult,
    EvalSpec,
    Finding,
    Gate,
    IterationRecord,
    LogEntry,
    OutputStream,
    PlanStep,
    ScheduleInfo,
    Snapshot,
    Tone,
    Vision,
)

HEALTH_WINDOW = 20
MAX_LOG = 80
MAX_FILES = 8  # attached context files kept for the makers
MAX_FILE_CHARS = 6000  # per-file text budget
MAX_AGENTS = 6  # pipeline length cap
MAX_OUTPUTS = 12  # live output panes kept (orchestrator + subagents)
MAX_OUTPUT_CHARS = 40000  # per-pane text budget (keeps the tail)
MAX_HISTORY = 60  # iteration records kept
MAX_BUILDS = 20  # build artifacts kept in memory (for diff/resume)
MAX_FINDINGS = 40  # structured findings kept

DEFAULT_CRITERIA: list[str] = []  # start empty — the user defines their own rubric
DEFAULT_MAX_LOOPS = 12
DEFAULT_TARGET = 85  # desired per-rubric accuracy (0..100) the loop iterates to

# "client" = the backend makes ZERO LLM calls; a connected Claude client does the
# work via the MCP tools (free, uses its own tools + subscription). "api" = the
# backend runs the autonomous pipeline on ANTHROPIC_API_KEY.
MODE = os.environ.get("LOOPR_MODE", "client")
if MODE not in ("client", "api"):
    MODE = "client"

#: the models the GUI may pick between (an allowlist keeps arbitrary ids out)
ALLOWED_MODELS = {
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-8",
}
DEFAULT_MODEL = os.environ.get("LOOPR_MODEL", "claude-sonnet-4-6")
if DEFAULT_MODEL not in ALLOWED_MODELS:
    DEFAULT_MODEL = "claude-sonnet-4-6"
AGENT_KINDS = ("maker", "checker")


def _default_agents() -> list[AgentDef]:
    """The default maker→checker loop, editable in the Agent Builder."""
    return [
        AgentDef(
            id="builder", name="Builder", kind="maker", model=DEFAULT_MODEL,
            role="Write the About Us HTML from the brief and the checker's feedback.",
        ),
        AgentDef(
            id="reviewer", name="Reviewer", kind="checker", model=DEFAULT_MODEL,
            role="Grade each rubric 0-100 and critique the build so it hits the target.",
        ),
    ]


def _now_ms() -> float:
    return time.time() * 1000


def _eid() -> str:
    return uuid.uuid4().hex[:8]


class FactoryState:
    def __init__(self) -> None:
        # -- config (human-owned, survives reset) -----------------------------
        # The goal is now driven by the chat; empty until the user sends a brief.
        self.vision: Vision = Vision(brief="")
        self.eval_specs: list[EvalSpec] = [
            EvalSpec(id=_eid(), criterion=c) for c in DEFAULT_CRITERIA
        ]
        self.max_loops: int = DEFAULT_MAX_LOOPS
        self.max_loops_enabled: bool = True
        self.target_accuracy: int = DEFAULT_TARGET
        self.per_criterion_targets: bool = False  # each criterion uses its own target
        self.agents: list[AgentDef] = _default_agents()
        self.mode: str = MODE
        self.schedule: ScheduleInfo = ScheduleInfo()  # cadence — config, survives reset
        self.locked: bool = False  # settings submitted → read-only for the human

        # -- durable job queue: each Submit enqueues a job the orchestrator polls.
        # A job is pending while run_request_seq > run_ack_seq; the orchestrator
        # claims it (acks) so it runs exactly once, even across sessions/restarts.
        self.run_request_seq: int = 0
        self.run_ack_seq: int = 0

        # -- the agents' work (cleared by reset) ------------------------------
        self.html: str = ""
        self.code_change: CodeChange | None = None  # code-mode artifact, if any
        self.build: int = 0
        self.loop_count: int = 0
        self.halted: bool = False
        self.review_notes: str = ""
        self.messages: list[ChatMessage] = []
        self.context_files: list[dict] = []  # [{name, content}] given to the Builder
        self.outputs: list[OutputStream] = []  # Mode B live output panes
        # -- loop monitoring (cleared by reset) -------------------------------
        self.history: list[IterationRecord] = []
        self.findings: list[Finding] = []
        self.builds: list[BuildRecord] = []
        self.gate: Gate | None = None
        self.plan: list[PlanStep] = []
        self._msg_seq = 0
        self.eval_results: list[EvalResult] = self._pending_results()
        self.health: float = 0.0
        self._health_history: list[float] = []
        self.was_green: bool = False

        # -- engine bookkeeping ----------------------------------------------
        self.ticks: dict[str, int] = {a.id: 0 for a in self.agents}
        self.log_entries: list[LogEntry] = []
        self.running: bool = False
        self.started_at: float = 0.0
        self.now: float = 0.0
        self.speed: float = 1.0
        self._log_seq = 0

    # -- helpers --------------------------------------------------------------

    def _effective_target(self, spec: EvalSpec) -> int:
        """The pass threshold for one criterion: its own target when per-criterion
        mode is on and it has one set, otherwise the global target."""
        if self.per_criterion_targets and spec.target >= 0:
            return spec.target
        return self.target_accuracy

    def _pending_results(self, detail: str = "not built yet") -> list[EvalResult]:
        return [
            EvalResult(id=s.id, label=s.criterion, score=0, passed=False, detail=detail,
                       kind=s.kind, command=s.command, target=self._effective_target(s))
            for s in self.eval_specs
        ]

    def _recompute_verdict(self) -> None:
        """Re-derive passed / was_green / health from scores vs each target."""
        results = self.eval_results
        spec_by_id = {s.id: s for s in self.eval_specs}
        for r in results:
            spec = spec_by_id.get(r.id)
            r.target = self._effective_target(spec) if spec else self.target_accuracy
            r.passed = r.score >= r.target
        if results:
            self.was_green = all(r.passed for r in results)
            self.health = sum(r.score for r in results) / (100 * len(results))
        else:
            self.was_green = True  # no rubric → trivially done
            self.health = 1.0

    # -- config setters (from the GUI) ---------------------------------------

    def set_vision(self, brief: str) -> None:
        self.vision = Vision(brief=str(brief))
        self._reopen("brand brief updated")

    def set_eval_specs(self, items: list[dict]) -> None:
        specs: list[EvalSpec] = []
        for it in items:
            crit = str(it.get("criterion", "")).strip()
            command = str(it.get("command", "")).strip()
            if not crit and not command:
                continue
            kind = str(it.get("kind", "llm"))
            if kind not in ("llm", "command"):
                kind = "llm"
            if kind == "command" and not crit:
                crit = command  # fall back to showing the command as the label
            try:
                target = int(it.get("target", -1))
            except (TypeError, ValueError):
                target = -1
            target = -1 if target < 0 else max(0, min(100, target))
            specs.append(EvalSpec(id=str(it.get("id") or _eid()), criterion=crit, kind=kind, command=command, target=target))
        self.eval_specs = specs
        self.eval_results = self._pending_results("criteria changed — re-checking")
        self._reopen(f"criteria updated ({len(specs)})")

    def set_max_loops(self, n: int, enabled: bool) -> None:
        self.max_loops = max(1, min(500, int(n)))
        self.max_loops_enabled = bool(enabled)
        # Cap off, or cap raised above the count, and not done yet → keep going.
        if self.halted and not self.was_green:
            if not self.max_loops_enabled or self.loop_count < self.max_loops:
                self.halted = False

    def set_target_accuracy(self, v: int) -> None:
        self.target_accuracy = max(0, min(100, int(v)))
        self._recompute_verdict()  # same scores, new bar → re-derive done-ness
        if self.was_green:
            self.halted = True  # target reached
        elif not self.max_loops_enabled or self.loop_count < self.max_loops:
            self.halted = False  # target now unmet → keep iterating
        self.log("system", f"target accuracy → {self.target_accuracy}%", Tone.steer)

    def _resettle_after_target_change(self) -> None:
        """Same scores, new thresholds → re-derive done-ness and keep/stop the loop."""
        self._recompute_verdict()
        if self.was_green:
            self.halted = True
        elif not self.max_loops_enabled or self.loop_count < self.max_loops:
            self.halted = False

    def set_per_criterion_targets(self, enabled: bool) -> None:
        self.per_criterion_targets = bool(enabled)
        self._resettle_after_target_change()
        self.log("system", f"per-criterion targets {'on' if enabled else 'off'}", Tone.steer)

    def set_criterion_targets(self, targets: dict) -> None:
        """Set individual criterion thresholds in place (does not reset scores)."""
        for s in self.eval_specs:
            if s.id in targets:
                try:
                    v = int(targets[s.id])
                except (TypeError, ValueError):
                    continue
                s.target = -1 if v < 0 else max(0, min(100, v))
        self._resettle_after_target_change()

    def maker_count(self) -> int:
        return sum(1 for a in self.agents if a.kind == "maker")

    def set_agents(self, items: list[dict]) -> None:
        """Replace the pipeline from the Agent Builder (ordered maker/checker list)."""
        agents: list[AgentDef] = []
        for it in items[:MAX_AGENTS]:
            name = str(it.get("name", "")).strip() or "Agent"
            kind = str(it.get("kind", "maker"))
            if kind not in AGENT_KINDS:
                kind = "maker"
            model = str(it.get("model", DEFAULT_MODEL))
            if model not in ALLOWED_MODELS:
                model = DEFAULT_MODEL
            agents.append(
                AgentDef(
                    id=str(it.get("id") or _eid()),
                    name=name,
                    kind=kind,
                    role=str(it.get("role", "")),
                    model=model,
                )
            )
        if not agents:
            agents = _default_agents()
        self.agents = agents
        # preserve run counts for surviving agents; new agents start at 0
        self.ticks = {a.id: self.ticks.get(a.id, 0) for a in agents}
        self._reopen(f"pipeline updated ({len(agents)} agents) — rebuilding")

    # -- chat with the Builder ------------------------------------------------

    def _at(self) -> float:
        return (_now_ms() - self.started_at) if self.running else 0.0

    def add_user_message(self, text: str, files: list[dict]) -> None:
        """A chat turn: the brief + optional files. Refines the current section."""
        names: list[str] = []
        for f in files or []:
            name = str(f.get("name", "file"))
            content = str(f.get("content", ""))[:MAX_FILE_CHARS]
            self.context_files.append({"name": name, "content": content})
            names.append(name)
        self.context_files = self.context_files[-MAX_FILES:]

        self.messages.append(
            ChatMessage(id=self._msg_seq, role="user", text=str(text), at=self._at(), files=names)
        )
        self._msg_seq += 1

        # The goal the agents work toward is the whole conversation so far.
        convo = "\n\n".join(m.text for m in self.messages if m.role == "user" and m.text.strip())
        self.vision = Vision(brief=convo)
        self._reopen("new instruction — building")

    def add_builder_message(self, text: str) -> None:
        self.messages.append(
            ChatMessage(id=self._msg_seq, role="builder", text=str(text), at=self._at())
        )
        self._msg_seq += 1

    # -- Mode B live output (orchestrator + subagents) -----------------------

    def push_output(
        self,
        id: str,
        text: str,
        label: str | None = None,
        role: str = "subagent",
        append: bool = True,
        status: str = "streaming",
        worktree: str | None = None,
        tokens: int = -1,
    ) -> None:
        """Upsert an output pane by id. `role` is 'orchestrator' (the driver's own
        output) or 'subagent' (one pane per spawned subagent). Appends by default so
        the orchestrator can stream chunks; pass append=False to replace. `worktree`
        tags the pane with the branch/checkout the agent runs in (Component 2).
        `tokens` (>= 0) sets that agent's cumulative token usage."""
        sid = str(id).strip() or "main"
        role = role if role in ("orchestrator", "subagent") else "subagent"
        status = status if status in ("streaming", "done") else "streaming"
        for o in self.outputs:
            if o.id == sid:
                o.text = ((o.text + str(text)) if append else str(text))[-MAX_OUTPUT_CHARS:]
                if label:
                    o.label = str(label)
                o.role = role
                o.status = status
                if worktree is not None:
                    o.worktree = str(worktree)
                if tokens >= 0:
                    o.tokens = int(tokens)
                o.at = self._at()
                return
        self.outputs.append(
            OutputStream(
                id=sid,
                label=str(label or sid),
                role=role,
                status=status,
                text=str(text)[-MAX_OUTPUT_CHARS:],
                worktree=str(worktree or ""),
                tokens=max(0, int(tokens)),
                at=self._at(),
            )
        )
        # keep the orchestrator pane + the most recent subagents
        if len(self.outputs) > MAX_OUTPUTS:
            orch = [o for o in self.outputs if o.role == "orchestrator"]
            subs = [o for o in self.outputs if o.role != "orchestrator"]
            self.outputs = orch + subs[-(MAX_OUTPUTS - len(orch)) :]

    def clear_outputs(self) -> None:
        self.outputs = []

    # -- loop monitoring ------------------------------------------------------

    def compute_status(self) -> str:
        """Derive the loop-skill status the UI shows."""
        if self.gate is not None:
            return "awaiting_human"
        if self.halted:
            if self.was_green:
                return "done"
            if self.max_loops_enabled and self.loop_count >= self.max_loops:
                return "stopped_cap"
            return "stopped"
        return "working" if self.running else "idle"

    def record_iteration(self) -> None:
        """Append this pass to the history spine (called after a grade)."""
        ev = self.eval_results
        avg = round(sum(r.score for r in ev) / len(ev)) if ev else 0
        summary = next((m.text for m in reversed(self.messages) if m.role == "builder"), "")
        self.history.append(
            IterationRecord(
                iteration=self.loop_count,
                build=self.build,
                avg=avg,
                scores={r.id: r.score for r in ev},
                findings=sum(1 for f in self.findings if not f.addressed),
                summary=str(summary)[:200],
                at=self._at(),
            )
        )
        self.history = self.history[-MAX_HISTORY:]

    def record_build(self, summary: str) -> None:
        """Remember a produced artifact so builds can be diffed and resumed."""
        self.builds.append(
            BuildRecord(
                build=self.build,
                summary=str(summary)[:200],
                chars=len(self.html),
                html=self.html,
                at=self._at(),
            )
        )
        self.builds = self.builds[-MAX_BUILDS:]

    def set_findings(self, items: list[dict]) -> None:
        """Adopt the checker's structured findings ({issue, where, fix_hint,
        addressed}). Preserves ids so the UI can track addressed-over-time."""
        out: list[Finding] = []
        for it in items[:MAX_FINDINGS]:
            issue = str(it.get("issue", "")).strip()
            if not issue:
                continue
            out.append(
                Finding(
                    id=str(it.get("id") or _eid()),
                    issue=issue[:300],
                    where=str(it.get("where", ""))[:200],
                    fix_hint=str(it.get("fix_hint") or it.get("fixHint") or "")[:300],
                    addressed=bool(it.get("addressed", False)),
                )
            )
        self.findings = out
        self.log("system", f"findings updated ({len(out)})", Tone.info)

    def set_gate(self, action: str, detail: str = "") -> None:
        """Raise a human checkpoint — the loop is awaiting_human until resolved."""
        self.gate = Gate(id=_eid(), action=str(action)[:200], detail=str(detail)[:600])
        self.log("system", f"awaiting human: {action}", Tone.steer)

    def resolve_gate(self, approve: bool) -> None:
        if self.gate is None:
            return
        act = self.gate.action
        self.gate = None
        if approve:
            self.log("system", f"gate approved: {act}", Tone.good)
        else:
            self.running = False
            self.halted = True
            self.log("system", f"gate rejected — loop stopped: {act}", Tone.bad)

    def set_schedule(self, trigger: str, last_run: str = "", next_run: str = "") -> None:
        self.schedule = ScheduleInfo(
            trigger=str(trigger)[:120], last_run=str(last_run)[:120], next_run=str(next_run)[:120]
        )
        self.log("system", f"cadence → {trigger or 'in-session'}", Tone.steer)

    def set_plan(self, items: list[dict]) -> None:
        """Record this round's decomposition (subtask → agent → worktree)."""
        steps: list[PlanStep] = []
        for it in items[:MAX_AGENTS]:
            sub = str(it.get("subtask", "")).strip()
            if not sub:
                continue
            steps.append(
                PlanStep(
                    subtask=sub[:200],
                    agent=str(it.get("agent", ""))[:80],
                    worktree=str(it.get("worktree", ""))[:120],
                )
            )
        self.plan = steps

    def export_loop_state(self) -> dict:
        """A restorable snapshot of the loop (Component 6 memory)."""
        return {
            "goal": self.vision.brief,
            "targetAccuracy": self.target_accuracy,
            "maxLoops": self.max_loops,
            "maxLoopsEnabled": self.max_loops_enabled,
            "rubric": [{"id": s.id, "criterion": s.criterion} for s in self.eval_specs],
            "iteration": self.loop_count,
            "build": self.build,
            "status": self.compute_status(),
            "html": self.html,
            "reviewNotes": self.review_notes,
            "schedule": self.schedule.model_dump(by_alias=True),
            "findings": [f.model_dump(by_alias=True) for f in self.findings],
            "history": [h.model_dump(by_alias=True) for h in self.history],
            "builds": [b.model_dump(by_alias=True) for b in self.builds],
            "plan": [p.model_dump(by_alias=True) for p in self.plan],
        }

    def import_loop_state(self, d: dict) -> None:
        """Resume from an exported state file: restore config + monitoring state."""
        if "goal" in d:
            self.vision = Vision(brief=str(d.get("goal", "")))
        if isinstance(d.get("rubric"), list):
            self.eval_specs = [
                EvalSpec(id=str(r.get("id") or _eid()), criterion=str(r.get("criterion", "")))
                for r in d["rubric"]
                if str(r.get("criterion", "")).strip()
            ]
        if "targetAccuracy" in d:
            self.target_accuracy = max(0, min(100, int(d["targetAccuracy"])))
        if "maxLoops" in d:
            self.max_loops = max(1, min(500, int(d["maxLoops"])))
        if "maxLoopsEnabled" in d:
            self.max_loops_enabled = bool(d["maxLoopsEnabled"])
        self.html = str(d.get("html", ""))
        self.build = int(d.get("build", 0) or 0)
        self.loop_count = int(d.get("iteration", 0) or 0)
        self.review_notes = str(d.get("reviewNotes", ""))
        if isinstance(d.get("schedule"), dict):
            s = d["schedule"]
            self.schedule = ScheduleInfo(
                trigger=str(s.get("trigger", "")),
                last_run=str(s.get("lastRun") or s.get("last_run") or ""),
                next_run=str(s.get("nextRun") or s.get("next_run") or ""),
            )
        self.set_findings(list(d.get("findings", [])))
        self.set_plan(list(d.get("plan", [])))
        self.history = [
            IterationRecord.model_validate(h) for h in d.get("history", []) if isinstance(h, dict)
        ][-MAX_HISTORY:]
        self.builds = [
            BuildRecord.model_validate(b) for b in d.get("builds", []) if isinstance(b, dict)
        ][-MAX_BUILDS:]
        self.eval_results = self._pending_results("resumed — re-checking")
        self._recompute_verdict()
        self.gate = None
        self.log("system", "resumed from saved state", Tone.good)

    def _reopen(self, why: str) -> None:
        """A config change gives the agents fresh work against the new goal."""
        self.halted = False
        self.was_green = False
        self.loop_count = 0
        self.review_notes = ""
        self.log("system", why, Tone.steer)

    # -- reset (wipe agent work, keep config) --------------------------------

    def reset_work(self) -> None:
        self.html = ""
        self.code_change = None
        self.build = 0
        self.loop_count = 0
        self.halted = False
        self.review_notes = ""
        self.messages = []
        self.context_files = []
        self.outputs = []
        self.history = []
        self.findings = []
        self.builds = []
        self.gate = None
        self.plan = []
        self.locked = False
        self.vision = Vision(brief="")
        self.eval_results = self._pending_results()
        self.health = 0.0
        self._health_history = []
        self.was_green = False
        self.log("system", "reset — chat & section cleared; nothing saved", Tone.info)

    # -- mutations used by the agents ----------------------------------------

    def set_html(self, html: str) -> None:
        self.build += 1
        self.html = html

    def set_code_change(self, summary: str, files: list[dict], branch: str, pr_url: str) -> None:
        """Record a code-mode artifact: what this build changed in a real project."""
        self.build += 1
        self.code_change = CodeChange(
            summary=str(summary),
            files=[
                ChangedFile(path=str(f.get("path", "")).strip(), summary=str(f.get("summary", "")).strip())
                for f in files if str(f.get("path", "")).strip()
            ],
            branch=str(branch or "").strip(),
            pr_url=str(pr_url or "").strip(),
            build=self.build,
            at=self._at(),
        )

    def apply_results(self, results: list[EvalResult]) -> None:
        """Adopt the grader's scored results; derive passed/was_green vs target."""
        self.eval_results = results
        self._recompute_verdict()

    def apply_scores(self, scores: list[dict]) -> None:
        """Client-driven grading: map pushed {id|criterion, score, reason} onto the
        rubric (by id, then by criterion text) and derive done-ness."""
        by_id: dict[str, tuple[int, str]] = {}
        by_text: dict[str, tuple[int, str]] = {}
        for e in scores or []:
            try:
                sc = max(0, min(100, int(e.get("score", 0))))
            except Exception:
                continue
            reason = str(e.get("reason", "") or "")[:200]
            if e.get("id"):
                by_id[str(e["id"])] = (sc, reason)
            if e.get("criterion"):
                by_text[str(e["criterion"]).strip().lower()] = (sc, reason)
        results = []
        for s in self.eval_specs:
            sc, reason = (
                by_id.get(s.id)
                or by_text.get(s.criterion.strip().lower())
                or (0, "no score returned")
            )
            results.append(
                EvalResult(id=s.id, label=s.criterion, score=sc, passed=False, detail=reason,
                           kind=s.kind, command=s.command)
            )
        self.apply_results(results)

    def log(self, loop: str, message: str, tone: Tone = Tone.info) -> None:
        entry = LogEntry(
            id=self._log_seq,
            loop=loop,
            at=(_now_ms() - self.started_at) if self.running else 0.0,
            message=message,
            tone=tone,
        )
        self._log_seq += 1
        self.log_entries = [entry, *self.log_entries][:MAX_LOG]

    def tick(self, agent_id: str) -> None:
        self.now = _now_ms()
        self.ticks[agent_id] = self.ticks.get(agent_id, 0) + 1

    # -- observation ----------------------------------------------------------

    def to_snapshot(self) -> Snapshot:
        return Snapshot(
            running=self.running,
            started_at=self.started_at,
            now=self.now,
            mode=self.mode,
            html=self.html,
            build=self.build,
            loop_count=self.loop_count,
            max_loops=self.max_loops,
            max_loops_enabled=self.max_loops_enabled,
            target_accuracy=self.target_accuracy,
            per_criterion_targets=self.per_criterion_targets,
            total_tokens=sum(o.tokens for o in self.outputs),
            halted=self.halted,
            agents=self.agents,
            vision=self.vision,
            eval_specs=self.eval_specs,
            evals=self.eval_results,
            review_notes=self.review_notes,
            messages=self.messages,
            file_names=[f["name"] for f in self.context_files],
            outputs=self.outputs,
            health=self.health,
            ticks=self.ticks,
            log=self.log_entries,
            status=self.compute_status(),
            history=self.history,
            findings=self.findings,
            builds=self.builds,
            code_change=self.code_change,
            gate=self.gate,
            schedule=self.schedule,
            plan=self.plan,
            locked=self.locked,
        )
