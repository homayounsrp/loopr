"""Domain model for the two-loop "About Us" section builder.

Plain data (Pydantic) — behaviour lives in the agents and the engine. Field
names are snake_case in Python but serialise to camelCase on the wire so the
TypeScript frontend stays idiomatic (see `CamelModel`).

The buildable artifact is now a single HTML fragment (the About Us section the
agents author). Evals are human-defined, plain-English criteria judged by an
LLM; the Vision is a free-text brand brief. Both are edited from the GUI.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Base model: snake_case in Python, camelCase in JSON."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Tone(str, Enum):
    info = "info"
    good = "good"
    bad = "bad"
    steer = "steer"


class AgentDef(CamelModel):
    """One agent in the pipeline, defined in the Agent Builder GUI.

    kind == "maker"   → writes/updates the HTML from the brief + checker feedback.
    kind == "checker" → grades the rubric (0-100) and critiques the build.

    The pipeline runs the agents in order each loop; a maker followed by a checker
    is a maker–checker loop. `role` is extra instructions folded into the agent's
    system prompt; `model` is its LLM.
    """

    id: str
    name: str
    kind: str  # "maker" | "checker"
    role: str = ""
    model: str


class Vision(CamelModel):
    """The brand brief — the goal, accumulated from the chat. Agents honour it."""

    brief: str


class EvalSpec(CamelModel):
    """One rubric check. `kind` decides HOW it's scored:

    - "llm"     → a plain-English criterion the checker judges 0-100 (default).
    - "command" → a shell command the checker runs against the user's own files
      (e.g. `pytest tests/auth`). In Mode B the checker already has the project
      on disk, so Loopr stores only the command; the client runs it and pushes
      the score (100 = pass / % passing). The backend never executes anything.
    """

    id: str
    criterion: str  # the label/criterion text
    kind: str = "llm"  # "llm" | "command"
    command: str = ""  # for kind="command": what the checker runs
    target: int = -1  # per-criterion pass threshold; -1 = inherit the global target


class EvalResult(CamelModel):
    id: str
    label: str  # the criterion text
    score: int  # the grader's 0..100 score for how well this rubric is met
    passed: bool  # score >= the effective target
    detail: str  # the grader's reason
    kind: str = "llm"  # mirrors the spec's kind, so the UI can render it
    command: str = ""  # mirrors the spec's command (for kind="command")
    target: int = 0  # the effective target this result was judged against


class LogEntry(CamelModel):
    id: int
    loop: str  # the agent name (or "system") that produced the entry
    at: float  # ms since engine start
    message: str
    tone: Tone


class ChatMessage(CamelModel):
    """The conversation with the Builder. `user` turns carry the brief + any
    attached files; `builder` turns are the Coder's short reply per build."""

    id: int
    role: str  # "user" | "builder"
    text: str
    at: float  # ms since engine start
    files: list[str] = []  # attached file names (user turns only)


class OutputStream(CamelModel):
    """A live output pane. In Mode B the orchestrator (the connected Claude) streams
    its own working output here, plus one stream per subagent it spawns, so the
    dashboard shows each participant's output separately.

    role == "orchestrator" → the driver's own output (always exactly one).
    role == "subagent"     → one pane per spawned subagent.
    """

    id: str  # stable key the orchestrator picks (slug); upserts by this
    label: str  # display name ("Orchestrator", "Researcher", …)
    role: str  # "orchestrator" | "subagent"
    status: str  # "streaming" | "done"
    text: str  # accumulated output (markdown)
    at: float  # ms since engine start
    worktree: str = ""  # branch/worktree this agent runs in (Component 2 isolation)
    tokens: int = 0  # cumulative tokens this agent has used


class Finding(CamelModel):
    """A structured evaluation finding — the checker's contract ({issue, where,
    fix_hint}). `addressed` flips true once a later pass fixes it, so the UI shows
    the evaluation→next-pass feedback flow, not just a freeform critique."""

    id: str
    issue: str
    where: str = ""
    fix_hint: str = ""
    addressed: bool = False


class IterationRecord(CamelModel):
    """One entry in the loop's append-only history (the state file's spine) — shows
    whether the loop is converging, plateaued, or oscillating."""

    iteration: int
    build: int
    avg: int  # avg rubric score this pass
    scores: dict[str, int]  # rubric id → score (per-rubric trend)
    findings: int  # open findings after this pass
    summary: str = ""  # what this pass produced
    at: float = 0.0


class BuildRecord(CamelModel):
    """Memory (Component 6): a produced artifact kept so the loop can diff builds
    and resume. Holds the HTML so the UI can diff consecutive builds."""

    build: int
    summary: str = ""
    chars: int = 0
    html: str = ""
    at: float = 0.0


class ChangedFile(CamelModel):
    """One file a code-mode build touched: the path plus a high-level, plain
    English note on what changed in it. No line counts by design."""

    path: str
    summary: str = ""


class CodeChange(CamelModel):
    """A code-mode artifact. When a build edits a real project instead of
    producing HTML, the orchestrator pushes this so the artifact rail can show
    what changed. `branch` and `pr_url` are set only when the loop actually
    pushed a branch or opened a PR, so the UI shows the link only if it exists."""

    summary: str = ""  # one-line overview of the whole change
    files: list[ChangedFile] = []
    branch: str = ""  # "" = no branch pushed
    pr_url: str = ""  # "" = no PR opened
    build: int = 0
    at: float = 0.0


class Gate(CamelModel):
    """A pending human checkpoint — the loop is `awaiting_human` until resolved
    (approve → proceed, reject → stop). Guards irreversible actions."""

    id: str
    action: str  # what the loop wants to do (e.g. "publish the article")
    detail: str = ""


class ScheduleInfo(CamelModel):
    """Cadence for a scheduled loop (Component 1). Empty trigger = in-session only."""

    trigger: str = ""  # e.g. "every 30m", "on push", "manual"
    last_run: str = ""
    next_run: str = ""


class PlanStep(CamelModel):
    """One subtask in this round's decomposition (orchestrated loop) — routed to a
    specialist, optionally in its own worktree."""

    subtask: str
    agent: str = ""
    worktree: str = ""


class Snapshot(CamelModel):
    """Everything the UI renders. The engine emits a fresh one on every change."""

    running: bool
    started_at: float
    now: float

    mode: str  # "client" (a Claude client does the work) | "api" (backend calls the LLM)

    html: str  # the About Us section the agents built ("" = empty)
    build: int
    loop_count: int  # how many Coder iterations have run
    max_loops: int  # the cap (only applied when max_loops_enabled)
    max_loops_enabled: bool  # off → iterate until every rubric hits the target
    target_accuracy: int  # desired per-rubric score (0..100) the loop iterates to
    per_criterion_targets: bool = False  # if true, each criterion uses its own target
    total_tokens: int = 0  # tokens used across all agents this loop
    halted: bool  # done (all rubrics at target) or hit the loop cap

    agents: list[AgentDef]  # the pipeline defined in the Agent Builder

    vision: Vision  # the current goal (accumulated from the chat)
    eval_specs: list[EvalSpec]  # the editable criteria definitions
    evals: list[EvalResult]  # the latest checker results
    review_notes: str  # the latest checker critique for the makers

    messages: list[ChatMessage]  # the chat with the maker(s)
    file_names: list[str]  # attached context files currently in play

    outputs: list[OutputStream]  # Mode B: live orchestrator + subagent output panes

    health: float  # rolling pass-rate, 0..1
    ticks: dict[str, int]  # runs per agent id
    log: list[LogEntry]

    # -- loop monitoring (the loop-skill surface) --------------------------
    status: str  # idle | working | done | stopped_cap | stopped | awaiting_human
    history: list[IterationRecord]  # append-only per-pass record (convergence)
    findings: list[Finding]  # structured evaluation findings (open/addressed)
    builds: list[BuildRecord]  # memory: produced artifacts, for diff & resume
    code_change: CodeChange | None = None  # code-mode artifact (files changed), or null
    gate: Gate | None  # a pending human checkpoint, or null
    schedule: ScheduleInfo  # cadence, if scheduled
    plan: list[PlanStep]  # this round's decomposition (subtask → agent)
    locked: bool  # settings submitted → read-only for the human, ready for the loop
