// Wire types — mirror the FastAPI Snapshot (camelCase on the wire). The backend
// owns all logic now; the frontend only renders these and sends commands.

export type LoopId = "coder" | "reviewer";
export type Tone = "info" | "good" | "bad" | "steer";

export interface Vision {
  brief: string;
}

export type AgentKind = "maker" | "checker";

export interface AgentDef {
  id: string;
  name: string;
  kind: AgentKind;
  role: string;
  model: string;
}

export type CheckKind = "llm" | "command";

export interface EvalSpec {
  id: string;
  criterion: string;
  kind?: CheckKind; // "llm" (default) = LLM-judged; "command" = a test/command check
  command?: string; // for kind="command": what the checker runs
  target?: number; // per-criterion pass threshold; -1 = inherit the global target
}

export interface EvalResult {
  id: string;
  label: string;
  score: number; // 0..100 grader score
  passed: boolean; // score >= the effective target
  detail: string;
  kind?: CheckKind;
  command?: string;
  target?: number; // the effective target this result was judged against
}

export interface LogEntry {
  id: number;
  loop: LoopId;
  at: number;
  message: string;
  tone: Tone;
}

export interface ChatMessage {
  id: number;
  role: "user" | "builder";
  text: string;
  at: number;
  files: string[];
}

export interface OutputStream {
  id: string;
  label: string;
  role: "orchestrator" | "subagent";
  status: "streaming" | "done";
  text: string;
  at: number;
  worktree: string;
  tokens: number;
}

export type LoopStatus =
  | "idle"
  | "working"
  | "done"
  | "stopped_cap"
  | "stopped"
  | "awaiting_human";

export interface Finding {
  id: string;
  issue: string;
  where: string;
  fixHint: string;
  addressed: boolean;
}

export interface IterationRecord {
  iteration: number;
  build: number;
  avg: number;
  scores: Record<string, number>;
  findings: number;
  summary: string;
  at: number;
}

export interface BuildRecord {
  build: number;
  summary: string;
  chars: number;
  html: string;
  at: number;
}

export interface ChangedFile {
  path: string;
  summary: string;
}

export interface CodeChange {
  summary: string;
  files: ChangedFile[];
  branch: string;
  prUrl: string;
  build: number;
  at: number;
}

export interface Gate {
  id: string;
  action: string;
  detail: string;
}

export interface ScheduleInfo {
  trigger: string;
  lastRun: string;
  nextRun: string;
}

export interface PlanStep {
  subtask: string;
  agent: string;
  worktree: string;
}

export interface Snapshot {
  running: boolean;
  startedAt: number;
  now: number;
  mode: string; // "client" (your Claude does the work) | "api" (backend calls the LLM)

  html: string;
  build: number;
  loopCount: number;
  maxLoops: number;
  maxLoopsEnabled: boolean;
  targetAccuracy: number;
  perCriterionTargets: boolean;
  totalTokens: number;
  halted: boolean;

  agents: AgentDef[];

  vision: Vision;
  evalSpecs: EvalSpec[];
  evals: EvalResult[];
  reviewNotes: string;

  messages: ChatMessage[];
  fileNames: string[];
  outputs: OutputStream[];

  health: number;
  ticks: Record<LoopId, number>;
  log: LogEntry[];

  // loop monitoring
  status: LoopStatus;
  history: IterationRecord[];
  findings: Finding[];
  builds: BuildRecord[];
  codeChange: CodeChange | null;
  gate: Gate | null;
  schedule: ScheduleInfo;
  plan: PlanStep[];
  locked: boolean;
}

export type Command =
  | { type: "start" }
  | { type: "stop" }
  | { type: "setSpeed"; value: number }
  | { type: "chat"; text: string; files: { name: string; content: string }[] }
  | { type: "reset" }
  | { type: "setEvals"; evals: { id?: string; criterion: string; kind?: CheckKind; command?: string; target?: number }[] }
  | { type: "setMaxLoops"; value: number; enabled: boolean }
  | { type: "setTargetAccuracy"; value: number }
  | { type: "setPerCriterionTargets"; enabled: boolean }
  | { type: "setCriterionTargets"; targets: Record<string, number> }
  | { type: "setGoal"; text: string }
  | {
      type: "setAgents";
      agents: { id?: string; name: string; kind: string; role: string; model: string }[];
    }
  | { type: "resolveGate"; approve: boolean }
  | { type: "loadState"; state: unknown }
  | { type: "setLocked"; value: boolean };
