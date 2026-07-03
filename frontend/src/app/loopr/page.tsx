"use client";

// Loopr — Mode B (client-driven) control surface. The backend makes zero LLM
// calls: a connected Claude ("the orchestrator") drives this dashboard over the
// `loopr` MCP tools. You set the rubric, target and cap; the loop iterates an
// artifact until every criterion clears the bar, and every step streams here live.

import React, { useEffect, useRef, useState } from "react";
import { useFactory } from "../../lib/useFactory";
import type {
  BuildRecord, CodeChange, Finding, Gate, IterationRecord,
  OutputStream, PlanStep, ScheduleInfo, Snapshot,
} from "../../lib/types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/* ── primitives ───────────────────────────────────────────────────── */

type Variant = "primary" | "dark" | "ghost" | "danger" | "success" | "subtle";
const VBG: Record<Variant, React.CSSProperties> = {
  primary: { background: "var(--accent)", color: "#fff", boxShadow: "0 6px 14px -5px rgba(91,87,242,.55)" },
  dark: { background: "var(--surface-3)", color: "var(--text)", border: "1px solid var(--border-2)" },
  ghost: { background: "var(--surface)", color: "var(--text-2)", border: "1px solid var(--border-2)" },
  danger: { background: "var(--bad)", color: "#fff" },
  success: { background: "var(--good)", color: "#fff" },
  subtle: { background: "var(--surface-3)", color: "var(--text-2)" },
};
const Btn: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; sm?: boolean }
> = ({ variant = "subtle", sm, style, children, ...rest }) => (
  <button
    className="dl-btn"
    style={{
      border: "none", borderRadius: "var(--r-sm)", fontWeight: 650,
      fontFamily: "inherit", padding: sm ? "6px 11px" : "9px 15px",
      fontSize: sm ? 12.5 : 13.5, display: "inline-flex", alignItems: "center", gap: 6,
      ...VBG[variant], ...style,
    }}
    {...rest}
  >
    {children}
  </button>
);

const Pill: React.FC<{ color: string; bg: string; children: React.ReactNode; title?: string }> = ({ color, bg, children, title }) => (
  <span title={title} style={{
    fontSize: 11, fontWeight: 700, borderRadius: "var(--r-pill)", padding: "3px 10px",
    background: bg, color, letterSpacing: ".01em", whiteSpace: "nowrap",
  }}>{children}</span>
);


// The single source of truth for "what's happening right now" — connection
// first, then where the loop is. Used by the always-visible topbar readout and
// the Status KPI card so they never disagree.
type LiveState = { label: string; detail: string; glyph: string; color: string; bg: string; dot: string; pulse: boolean };
function deriveLive(connected: boolean, snap: Snapshot): LiveState {
  if (!connected)
    return { label: "Disconnected", detail: "Reconnecting to the backend…", glyph: "⚠", color: "var(--bad-ink)", bg: "var(--bad-weak)", dot: "var(--bad)", pulse: true };
  const conn = snap.mode === "client" ? "Claude connected" : "API mode";
  const pass = `pass ${snap.loopCount}${snap.maxLoopsEnabled ? `/${snap.maxLoops}` : ""}`;
  switch (snap.status) {
    case "working":
      return { label: "Looping", detail: `${conn} · ${pass}`, glyph: "●", color: "var(--accent-ink)", bg: "var(--accent-weak)", dot: "var(--accent)", pulse: true };
    case "awaiting_human":
      return { label: "Waiting for you", detail: "Resolve the gate to continue", glyph: "⏸", color: "var(--blue)", bg: "var(--blue-weak)", dot: "var(--blue)", pulse: true };
    case "done":
      return { label: "Done", detail: `Target met in ${snap.loopCount} ${snap.loopCount === 1 ? "pass" : "passes"}`, glyph: "✓", color: "var(--good-ink)", bg: "var(--good-weak)", dot: "var(--good)", pulse: false };
    case "stopped_cap":
      return { label: "Hit the cap", detail: `Stopped at ${snap.loopCount}/${snap.maxLoops} — target not met`, glyph: "◼", color: "var(--warn-ink)", bg: "var(--warn-weak)", dot: "var(--warn)", pulse: false };
    case "stopped":
      return { label: "Stopped", detail: "The loop was halted", glyph: "■", color: "var(--bad-ink)", bg: "var(--bad-weak)", dot: "var(--bad)", pulse: false };
    default:
      return snap.locked
        ? { label: "Ready", detail: `${conn} · waiting to start`, glyph: "▸", color: "var(--good-ink)", bg: "var(--good-weak)", dot: "var(--good)", pulse: true }
        : { label: "Idle", detail: `${conn} · set up your rubric`, glyph: "•", color: "var(--text-2)", bg: "var(--surface-3)", dot: "var(--text-3)", pulse: false };
  }
}

// Always-visible readout that lives in the sticky topbar.
const LiveStatus: React.FC<{ connected: boolean; snap: Snapshot }> = ({ connected, snap }) => {
  const s = deriveLive(connected, snap);
  return (
    <div title={`${s.label} — ${s.detail}`} style={{
      display: "flex", alignItems: "center", gap: 9, padding: "5px 13px 5px 11px",
      borderRadius: "var(--r-pill)", background: s.bg, border: "1px solid var(--border)",
    }}>
      <span style={{ position: "relative", display: "inline-flex", width: 9, height: 9 }}>
        <span style={{ ...dot, background: s.dot, position: "relative", zIndex: 1, animation: s.pulse ? "dl-breathe 1.6s ease-in-out infinite" : "none" }} />
        {s.pulse && <span style={{ position: "absolute", inset: 0, borderRadius: 999, background: s.dot, animation: "dl-ping 1.6s cubic-bezier(0,0,.2,1) infinite" }} />}
      </span>
      <div style={{ lineHeight: 1.12, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 750, color: s.color, whiteSpace: "nowrap" }}>{s.glyph} {s.label}</div>
        <div className="dl-hide-sm" style={{ fontSize: 10.5, color: "var(--text-3)", fontWeight: 550, marginTop: 1, whiteSpace: "nowrap" }}>{s.detail}</div>
      </div>
    </div>
  );
};

// A section card: icon tile, title, one-line description, optional right slot, collapse.
const Section: React.FC<{
  icon: React.ReactNode; title: string; desc: string; right?: React.ReactNode;
  open?: boolean; onToggle?: () => void; delay?: number; children: React.ReactNode;
}> = ({ icon, title, desc, right, open, onToggle, delay = 0, children }) => {
  const collapsible = onToggle !== undefined;
  return (
    <section className={`dl-card dl-rise ${open ? "dl-open" : ""}`} style={{ ...card, animationDelay: `${delay}ms` }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 13, cursor: collapsible ? "pointer" : "default" }}>
        <span style={iconChip}>{icon}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.015em" }}>{title}</div>
          <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2 }}>{desc}</div>
        </div>
        {right}
        {collapsible && <span className="dl-chev" style={{ color: "var(--text-3)", fontSize: 12 }}>▾</span>}
      </div>
      {(!collapsible || open) && <div style={{ marginTop: 18 }}>{children}</div>}
    </section>
  );
};

// A KPI tile for the dashboard header row.
const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: string; delay?: number }> = ({
  label, value, sub, accent, delay = 0,
}) => (
  <div className="dl-card dl-rise" style={{ ...statTile, animationDelay: `${delay}ms` }}>
    <div style={{ ...statTop, background: accent ?? "var(--border-2)" }} />
    <div style={statLabel}>{label}</div>
    <div className="dl-num" style={{ ...statValue, color: accent ?? "var(--text)" }}>{value}</div>
    {sub && <div style={statSub}>{sub}</div>}
  </div>
);

/* ── artifact preview ─────────────────────────────────────────────── */

const PreviewFrame: React.FC<{ children: React.ReactNode; fill?: boolean }> = ({ children, fill }) => (
  <div style={fill ? { ...previewFrame, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } : previewFrame}>
    <div style={previewBar}>
      <span style={{ ...dot, background: "#f6716f" }} />
      <span style={{ ...dot, background: "#f3bf4d" }} />
      <span style={{ ...dot, background: "#3ddc91" }} />
      <span style={{ marginLeft: 8, fontSize: 10.5, color: "var(--text-3)", fontWeight: 600, letterSpacing: ".03em" }}>live preview</span>
    </div>
    {children}
  </div>
);

const Preview: React.FC<{ html: string; fill?: boolean; theme?: "light" | "dark" }> = ({ html, fill, theme = "dark" }) => {
  const h = html.trim();
  if (!h) {
    return (
      <PreviewFrame fill={fill}>
        <div style={fill ? { ...emptyBox, flex: 1, height: "auto" } : emptyBox}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>◳</div>
          <div style={{ fontSize: 13, fontWeight: 650, color: "var(--text-2)" }}>Nothing built yet</div>
          <div style={{ fontSize: 12, marginTop: 4, color: "var(--text-3)" }}>The current build renders here.</div>
        </div>
      </PreviewFrame>
    );
  }
  // Match the preview surface to the dashboard theme so it doesn't flash white in
  // dark mode. `color-scheme` also themes default form controls/scrollbars.
  const bg = theme === "dark" ? "#0f1117" : "#ffffff";
  const fg = theme === "dark" ? "#e7e7ee" : "#111111";
  const link = theme === "dark" ? "#8ab4ff" : "#2563eb";
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:${theme}}*{box-sizing:border-box}html,body{margin:0}body{font-family:Inter,system-ui,sans-serif;background:${bg};color:${fg};padding:12px 14px}a{color:${link}}</style></head><body>${h}</body></html>`;
  return (
    <PreviewFrame fill={fill}>
      <iframe title="Artifact preview" sandbox="allow-same-origin" srcDoc={srcDoc}
        style={{ width: "100%", height: fill ? "100%" : 288, flex: fill ? 1 : undefined, border: "none", background: bg, display: "block" }} />
    </PreviewFrame>
  );
};

// Code-mode artifact: what a build changed in a real project. Shows a summary,
// an optional branch / PR link (only when the loop pushed one), and a list of
// touched files each with a high-level note. Rendered instead of the iframe.
const CodeArtifact: React.FC<{ change: CodeChange; fill?: boolean }> = ({ change, fill }) => (
  <div style={fill ? { ...previewFrame, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } : previewFrame}>
    <div style={previewBar}>
      <span style={{ ...dot, background: "#f6716f" }} />
      <span style={{ ...dot, background: "#f3bf4d" }} />
      <span style={{ ...dot, background: "#3ddc91" }} />
      <span style={{ marginLeft: 8, fontSize: 10.5, color: "var(--text-3)", fontWeight: 600, letterSpacing: ".03em" }}>code changes</span>
      {change.files.length > 0 && (
        <span className="dl-num" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-3)" }}>{change.files.length} file{change.files.length > 1 ? "s" : ""}</span>
      )}
    </div>
    <div style={{ flex: fill ? 1 : undefined, minHeight: 0, overflowY: "auto", padding: 14, background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: 12 }}>
      {change.summary && <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>{change.summary}</div>}
      {(change.branch || change.prUrl) && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {change.prUrl && <a className="dl-link" href={change.prUrl} target="_blank" rel="noreferrer" style={prChip}>⧉ View PR</a>}
          {change.branch && <span className="dl-num" style={branchChip} title="pushed branch">⑂ {change.branch}</span>}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {change.files.length === 0 ? (
          <div style={monoHint}>No files reported for this build.</div>
        ) : change.files.map((f, i) => (
          <div key={i} style={{ border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "9px 11px", background: "var(--surface)" }}>
            <div className="dl-num" style={{ fontSize: 12, fontWeight: 650, color: "var(--accent-ink)", wordBreak: "break-all", fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{f.path}</div>
            {f.summary && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 3, lineHeight: 1.45 }}>{f.summary}</div>}
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ── markdown ─────────────────────────────────────────────────────── */

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s)]+)/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) nodes.push(<b key={k++}>{m[1]}</b>);
    else if (m[2] !== undefined) nodes.push(<code key={k++} style={inlineCode}>{m[2]}</code>);
    else if (m[3] !== undefined) nodes.push(<a key={k++} className="dl-link" href={m[4]} target="_blank" rel="noreferrer" style={mdLink}>{m[3]}</a>);
    else nodes.push(<a key={k++} className="dl-link" href={m[5]} target="_blank" rel="noreferrer" style={mdLink}>{m[5]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const Markdown: React.FC<{ text: string }> = ({ text }) => {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0; let key = 0; let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push(<p key={key++} style={mdP}>{renderInline(para.join(" "))}</p>); para = []; } };
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { flush(); i++; continue; }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); blocks.push(<div key={key++} style={mdH(h[1].length)}>{renderInline(h[2])}</div>); i++; continue; }
    if (/^[-*•]\s+/.test(t)) {
      flush(); const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*•]\s+/, "")); i++; }
      blocks.push(<ul key={key++} style={mdList}>{items.map((it, j) => <li key={j} style={mdLi}>{renderInline(it)}</li>)}</ul>);
      continue;
    }
    if (/^\d+[.)]\s+/.test(t)) {
      flush(); const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^\d+[.)]\s+/, "")); i++; }
      blocks.push(<ol key={key++} style={{ ...mdList, listStyle: "decimal" }}>{items.map((it, j) => <li key={j} style={mdLi}>{renderInline(it)}</li>)}</ol>);
      continue;
    }
    para.push(t); i++;
  }
  flush();
  return <>{blocks}</>;
};

const Critique: React.FC<{ notes: string }> = ({ notes }) => {
  const items = notes.split(/\r?\n/).map((l) => l.replace(/^\s*[•\-–*]\s+/, "").trim()).filter(Boolean);
  if (items.length === 0) return null;
  return <ul style={critiqueList}>{items.map((it, i) => <li key={i} style={{ marginBottom: 6 }}>{renderInline(it)}</li>)}</ul>;
};

/* ── live output pane ─────────────────────────────────────────────── */

type NodeState = "streaming" | "done" | "pending";

// Compact token count: 940, 18.3k, 1.2M.
const fmtTokens = (n: number): string =>
  n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`;

// One box in the agent graph: streams the agent's live output, like the old
// Live-output pane but compact so nodes can be wired together.
const AgentNode: React.FC<{
  label: string; role: "orchestrator" | "subagent"; state: NodeState;
  subtask?: string; worktree?: string; text: string; tokens?: number;
}> = ({ label, role, state, subtask, worktree, text, tokens }) => {
  const isOrch = role === "orchestrator";
  const accent = isOrch ? "var(--accent)" : "var(--cyan)";
  const stateLabel = state === "streaming" ? "streaming…" : state === "done" ? "done ✓" : "queued";
  const stateColor = state === "streaming" ? accent : state === "done" ? "var(--good-ink)" : "var(--text-3)";
  const hasMeta = !!worktree || (tokens ?? 0) > 0;
  return (
    <div className="dl-card dl-pop" style={{
      border: `1px solid ${isOrch ? "rgba(123,107,255,.42)" : "rgba(67,198,240,.34)"}`,
      borderRadius: "var(--r)", background: "var(--surface)", backgroundImage: "var(--sheen)",
      padding: 11, boxShadow: "var(--sh-sm)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: (subtask || hasMeta) ? 6 : 7 }}>
        <span style={{ ...streamDot, background: accent, animation: state === "streaming" ? "dl-pulse 1.15s ease-in-out infinite" : "none" }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span style={{ fontSize: 10.5, fontWeight: 650, color: stateColor, flexShrink: 0 }}>{stateLabel}</span>
      </div>
      {subtask && <div style={{ fontSize: 11, color: "var(--text-3)", margin: "0 0 8px", lineHeight: 1.4 }}>{subtask}</div>}
      {hasMeta && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {worktree && <span style={{ ...worktreeTag, display: "inline-block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title="isolated worktree or branch">⑂ {worktree}</span>}
          {(tokens ?? 0) > 0 && <span className="dl-num" style={{ fontSize: 10.5, fontWeight: 650, color: "var(--text-3)" }} title="tokens used by this agent">◆ {fmtTokens(tokens!)} tok</span>}
        </div>
      )}
      <div style={{ ...outputBody, maxHeight: isOrch ? 240 : 180 }}>
        {text.trim() ? <Markdown text={text} /> : <span style={{ color: "var(--text-3)", fontSize: 12 }}>{state === "pending" ? "not started yet" : "waiting…"}</span>}
      </div>
    </div>
  );
};

// The live stream as a graph: the orchestrator up top, wired down to each
// subagent. Edges follow the decomposition plan (subtask → agent); with no plan
// yet it falls back to whatever subagents are streaming.
const AgentGraph: React.FC<{ outputs: OutputStream[]; plan: PlanStep[] }> = ({ outputs, plan }) => {
  const orch = outputs.find((o) => o.role === "orchestrator");
  const subs = outputs.filter((o) => o.role === "subagent");
  const streamState = (s: OutputStream): NodeState => (s.status === "done" ? "done" : "streaming");
  const byLabel = (name: string) => subs.find((s) => s.label.trim().toLowerCase() === name.trim().toLowerCase());

  const children = plan.length > 0
    ? plan.map((p, i) => {
        const o = byLabel(p.agent);
        return { key: `${p.agent}-${i}`, label: p.agent || `Agent ${i + 1}`, subtask: p.subtask,
          worktree: p.worktree || o?.worktree || "", state: (o ? streamState(o) : "pending") as NodeState, text: o?.text ?? "", tokens: o?.tokens ?? 0 };
      })
    : subs.map((s) => ({ key: s.id, label: s.label, subtask: "", worktree: s.worktree, state: streamState(s), text: s.text, tokens: s.tokens }));

  if (!orch && children.length === 0) {
    return (
      <div style={outputEmpty}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>◍</div>
        <div style={{ fontWeight: 650, color: "var(--text-2)" }}>Waiting for the orchestrator</div>
        <div style={{ marginTop: 5, fontSize: 12.5, color: "var(--text-3)" }}>
          Drive this with the <code style={inlineCode}>loopr</code> tools. The orchestrator and each subagent it spawns appear here, wired by the plan.
        </div>
      </div>
    );
  }
  return (
    <div>
      <AgentNode label={orch?.label ?? "Orchestrator"} role="orchestrator"
        state={orch ? streamState(orch) : "pending"} text={orch?.text ?? ""} tokens={orch?.tokens ?? 0} />
      {children.length > 0 && (
        <div style={{ marginLeft: 13, borderLeft: "2px solid var(--border-2)", paddingLeft: 16, paddingTop: 6, marginTop: 4, display: "flex", flexDirection: "column", gap: 12 }}>
          {children.map((c) => (
            <div key={c.key} style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: -16, top: 18, width: 14, height: 2, background: "var(--border-2)" }} />
              <AgentNode label={c.label} role="subagent" state={c.state} subtask={c.subtask} worktree={c.worktree} text={c.text} tokens={c.tokens} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/* ── loop-monitor sub-panels ──────────────────────────────────────── */

type RubricRow = { id?: string; criterion: string; kind?: "llm" | "command"; command?: string; fileName?: string; target?: number };

function lineDiff(prev: string, next: string): { added: number; removed: number } {
  const a = new Set(prev.split("\n").map((l) => l.trim()).filter(Boolean));
  const b = new Set(next.split("\n").map((l) => l.trim()).filter(Boolean));
  let added = 0; let removed = 0;
  b.forEach((l) => { if (!a.has(l)) added++; });
  a.forEach((l) => { if (!b.has(l)) removed++; });
  return { added, removed };
}

const GateBanner: React.FC<{ gate: Gate; onResolve: (approve: boolean) => void }> = ({ gate, onResolve }) => (
  <div className="dl-slide" style={gateBanner}>
    <span style={{ fontSize: 20, lineHeight: 1 }}>⏸</span>
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: "var(--warn-ink)" }}>Approval needed: {gate.action}</div>
      {gate.detail && <div style={{ fontSize: 12.5, color: "var(--warn-ink)", opacity: 0.85, marginTop: 2 }}>{gate.detail}</div>}
    </div>
    <div style={{ display: "flex", gap: 8 }}>
      <Btn variant="success" sm onClick={() => onResolve(true)}>✓ Approve</Btn>
      <Btn variant="danger" sm onClick={() => onResolve(false)}>✕ Reject</Btn>
    </div>
  </div>
);

const MonBlock: React.FC<{ title: string; hint: string; icon?: string; children: React.ReactNode }> = ({ title, hint, icon, children }) => (
  <div style={monBlock}>
    <div style={{ display: "flex", alignItems: "flex-start", gap: 11, marginBottom: 15, paddingBottom: 14, borderBottom: "1px solid var(--border)" }}>
      {icon && <span style={monIcon}>{icon}</span>}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 750, letterSpacing: "-.01em" }}>{title}</div>
        <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 3, lineHeight: 1.45 }}>{hint}</div>
      </div>
    </div>
    {children}
  </div>
);

// Full-width avg-score chart. `hover` is the history index of the highlighted
// pass (null = none); it draws a guide line + emphasised dot there.
const AvgChart: React.FC<{ values: number[]; hover: number | null; h?: number }> = ({ values, hover, h = 60 }) => {
  const W = 640;
  const pts = values.length === 1 ? [values[0], values[0]] : values;
  const n = pts.length;
  const mx = 6, my = 9;
  const step = (W - 2 * mx) / (n - 1);
  const px = (i: number) => mx + i * step;
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const pad = Math.max(6, (hi - lo) * 0.4);
  const dmin = lo - pad, dmax = hi + pad;
  const y = (v: number) => (h - my) - ((v - dmin) / (dmax - dmin)) * (h - 2 * my);
  const line = pts.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${px(n - 1).toFixed(1)},${h} L${mx},${h} Z`;
  const hIdx = hover === null ? null : (values.length === 1 ? 1 : hover);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" width="100%" height={h} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id="avgspk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#avgspk)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={5} opacity={0.32} strokeLinejoin="round" strokeLinecap="round" style={{ filter: "blur(4px)" }} />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={px(n - 1)} cy={y(pts[n - 1])} r={3.2} fill="var(--accent)" vectorEffect="non-scaling-stroke" />
      {hIdx !== null && (
        <>
          <line x1={px(hIdx)} x2={px(hIdx)} y1={0} y2={h} stroke="var(--accent)" strokeWidth={1} opacity={0.4} vectorEffect="non-scaling-stroke" />
          <circle cx={px(hIdx)} cy={y(pts[hIdx])} r={5} fill="var(--accent)" stroke="var(--surface-2)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
};

const HistoryPanel: React.FC<{ history: IterationRecord[] }> = ({ history }) => {
  const [hover, setHover] = useState<number | null>(null);
  if (history.length === 0) return <div style={monoHint}>No passes yet. Each grade adds a row and moves the trend line.</div>;
  const avgs = history.map((h) => h.avg);
  const last = history[history.length - 1];
  const prev = history.length > 1 ? history[history.length - 2] : null;
  const delta = prev ? last.avg - prev.avg : 0;
  const trend = !prev ? "first pass" : delta > 0 ? `▲ +${delta}` : delta < 0 ? `▼ ${delta}` : "no change";
  const tc = delta > 0 ? "var(--good)" : delta < 0 ? "var(--bad)" : "var(--text-2)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* avg-score summary + full-width chart */}
      <div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={microLabel}>avg score / pass</div>
          <div style={{ fontSize: 12.5, textAlign: "right" }}>
            <span className="dl-num" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-.03em" }}>{(hover !== null ? history[hover]?.avg : last.avg)}%</span>
            <span className="dl-num" style={{ color: tc, fontWeight: 700, marginLeft: 6 }}>{hover !== null ? `pass ${history[hover]?.iteration}` : trend}</span>
          </div>
        </div>
        <div style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
          <AvgChart values={avgs} hover={hover} />
          {/* invisible hit columns, one per pass, to drive the hover */}
          <div style={{ position: "absolute", inset: 0, display: "flex" }}>
            {history.map((_, i) => (
              <div key={i} style={{ flex: 1, cursor: "pointer" }} onMouseEnter={() => setHover(i)} />
            ))}
          </div>
        </div>
      </div>
      {/* history table, full width; rows highlight in sync with the chart hover */}
      <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--r-sm)" }}>
        <table style={hTable}>
          <thead><tr>
            <th style={hTh}>#</th><th style={hTh}>build</th><th style={hTh}>avg</th><th style={hTh}>open</th><th style={{ ...hTh, textAlign: "left" }}>summary</th>
          </tr></thead>
          <tbody>
            {history.slice().reverse().map((h, i) => {
              const idx = history.length - 1 - i;
              const on = hover === idx;
              return (
                <tr key={i} className="dl-row" onMouseEnter={() => setHover(idx)} onMouseLeave={() => setHover(null)}
                  style={{ background: on ? "var(--accent-weak)" : "transparent", cursor: "pointer" }}>
                  <td className="dl-num" style={{ ...hTd, boxShadow: on ? "inset 2px 0 0 var(--accent)" : "none" }}>{h.iteration}</td>
                  <td className="dl-num" style={hTd}>#{h.build}</td>
                  <td className="dl-num" style={{ ...hTd, fontWeight: 700, color: h.avg >= 85 ? "var(--good-ink)" : "var(--warn-ink)" }}>{h.avg}%</td>
                  <td className="dl-num" style={hTd}>{h.findings}</td>
                  <td style={{ ...hTd, textAlign: "left", color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 0, width: "100%" }}>{h.summary || "·"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const FindingsPanel: React.FC<{ findings: Finding[] }> = ({ findings }) => {
  if (findings.length === 0) return <div style={monoHint}>No findings yet. The checker posts what to fix (the issue, where it is, and a hint) and ticks each one off as it&apos;s resolved.</div>;
  const open = findings.filter((f) => !f.addressed).length;
  return (
    <div>
      <div style={{ fontSize: 11.5, color: "var(--text-2)", marginBottom: 9 }}>
        <b style={{ color: open ? "var(--warn-ink)" : "var(--good-ink)" }}>{open} open</b> · {findings.length - open} fixed
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {findings.map((f) => (
          <div key={f.id} className="dl-row" style={{ ...findingRow, opacity: f.addressed ? 0.6 : 1 }}>
            <Pill color={f.addressed ? "var(--good-ink)" : "var(--warn-ink)"} bg={f.addressed ? "var(--good-weak)" : "var(--warn-weak)"}>
              {f.addressed ? "✓ fixed" : "open"}
            </Pill>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 550, textDecoration: f.addressed ? "line-through" : "none" }}>{f.issue}</div>
              <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 2 }}>
                {f.where && <><code style={inlineCode}>{f.where}</code> · </>}{f.fixHint || "no fix hint"}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const MemoryPanel: React.FC<{ builds: BuildRecord[]; onResume: (doc: unknown) => void }> = ({ builds, onResume }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const exportState = async () => {
    try {
      const doc = await (await fetch(`${API}/api/loopstate`)).json();
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = "loop-state.json"; a.click();
      URL.revokeObjectURL(url);
    } catch { /* offline */ }
  };
  const onFile = async (f: File | null) => {
    if (!f) return;
    try { onResume(JSON.parse(await f.text())); } catch { /* bad file */ }
    if (fileRef.current) fileRef.current.value = "";
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 11 }}>
        <Btn variant="dark" sm onClick={exportState}>⭳ Export</Btn>
        <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
        <Btn variant="ghost" sm onClick={() => fileRef.current?.click()}>⭱ Resume</Btn>
      </div>
      {builds.length === 0 ? <div style={monoHint}>No builds saved yet.</div> : (
        <div style={{ display: "flex", flexDirection: "column", maxHeight: 176, overflowY: "auto" }}>
          {builds.slice().reverse().map((b, i, arr) => {
            const older = arr[i + 1];
            const diff = older ? lineDiff(older.html, b.html) : null;
            return (
              <div key={b.build} className="dl-row" style={buildRow}>
                <span className="dl-num" style={{ fontWeight: 700, fontSize: 12, width: 40 }}>#{b.build}</span>
                <span style={{ fontSize: 12, color: "var(--text-2)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.summary}</span>
                <span className="dl-num" style={{ fontSize: 11, color: "var(--text-3)" }}>{b.chars}c</span>
                {diff && <span className="dl-num" style={{ fontSize: 11, fontWeight: 700 }}><span style={{ color: "var(--good)" }}>+{diff.added}</span> <span style={{ color: "var(--bad)" }}>−{diff.removed}</span></span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const ScheduleStrip: React.FC<{ schedule: ScheduleInfo }> = ({ schedule }) => {
  const on = !!schedule.trigger;
  return (
    <span style={{ fontSize: 11.5, color: on ? "var(--cyan)" : "var(--text-3)", display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ display: "inline-block", animation: on ? "dl-spin 6s linear infinite" : "none" }}>⟳</span>
      {on ? <>cadence <b>{schedule.trigger}</b>{schedule.nextRun && <> · next {schedule.nextRun}</>}{schedule.lastRun && <> · last {schedule.lastRun}</>}</> : "in-session, no schedule"}
    </span>
  );
};

/* ── page ─────────────────────────────────────────────────────────── */

const Page: React.FC = () => {
  const { snap, connected, stop, reset, setEvals, setMaxLoops, setTargetAccuracy, setGoal, setPerCriterionTargets, setCriterionTargets, resolveGate, setLocked } = useFactory();

  const resumeState = (doc: unknown) => {
    fetch(`${API}/api/loopstate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) })
      .catch(() => { /* offline */ });
  };

  const [controlsOpen, setControlsOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [maxDraft, setMaxDraft] = useState<number | null>(null);
  const [evalDraft, setEvalDraft] = useState<RubricRow[] | null>(null);
  const [goalDraft, setGoalDraft] = useState<string | null>(null);
  const goalFocused = useRef(false);
  const rubricFileRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const autoOpened = useRef(false);
  const lastSpecSig = useRef<string | null>(null);

  // Reflect the theme the no-flash init script already applied, then let the user toggle it.
  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "light" || t === "dark") setTheme(t);
  }, []);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("loopr-theme", next); } catch { /* private mode */ }
  };

  useEffect(() => {
    if (!snap) return;
    if (maxDraft === null) setMaxDraft(snap.maxLoops);
    // Keep the goal field in sync with the backend, but never clobber what the
    // user is actively typing.
    if (!goalFocused.current && goalDraft !== snap.vision.brief) setGoalDraft(snap.vision.brief);
    const sig = snap.evalSpecs.map((e) => `${e.id}:${e.criterion}`).join("|");
    if (lastSpecSig.current !== sig || evalDraft === null) {
      lastSpecSig.current = sig;
      setEvalDraft(snap.evalSpecs.map((e) => ({ id: e.id, criterion: e.criterion, target: e.target ?? -1 })));
    }
  }, [snap, maxDraft, evalDraft, goalDraft]);

  useEffect(() => {
    if (snap && snap.build > 0 && !autoOpened.current) { autoOpened.current = true; setSidebarOpen(true); }
  }, [snap]);

  if (!snap) {
    return (
      <div style={{ ...wrap, minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <div className="dl-rise">
          <div style={{ ...logoMark, margin: "0 auto 16px", width: 46, height: 46, fontSize: 24 }}>⟲</div>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 6px", letterSpacing: "-.02em" }}>Loopr</h1>
          <p style={{ color: "var(--text-2)", margin: 0 }}>{connected ? "Waiting for the first snapshot…" : "Connecting to the backend…"}</p>
          <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>expects <code style={inlineCode}>ws://localhost:8000/ws/factory</code></p>
        </div>
      </div>
    );
  }

  const total = snap.evals.length;
  const green = snap.evals.filter((e) => e.passed).length;
  const avgScore = total ? Math.round(snap.evals.reduce((a, e) => a + e.score, 0) / total) : 0;
  const allGreen = total > 0 && green === total;
  const subAgentCount = snap.outputs.filter((o) => o.role === "subagent").length;
  const openFindings = snap.findings.filter((f) => !f.addressed).length;
  const live = deriveLive(connected, snap);

  const applyEvals = () => {
    if (!evalDraft) return;
    setEvals(
      evalDraft
        .map((e) => ({ id: e.id, criterion: e.criterion, kind: e.kind ?? "llm", command: e.command ?? "", target: e.target ?? -1 }))
        .filter((e) => e.criterion.trim() || e.command.trim()),
    );
    setEvalDraft(null);
  };
  const mutRow = (i: number, patch: Partial<RubricRow>) => {
    if (!evalDraft) return;
    const next = [...evalDraft];
    next[i] = { ...next[i], ...patch };
    setEvalDraft(next);
  };
  // Drag a criterion's own target: update the draft and, if it's a saved row,
  // push it live so the pass/fail colouring updates immediately.
  const dragTarget = (i: number, row: RubricRow, value: number) => {
    mutRow(i, { target: value });
    if (row.id) setCriterionTargets({ [row.id]: value });
  };
  const removeRow = (i: number) => setEvalDraft((evalDraft ?? []).filter((_, j) => j !== i));
  const addLLM = () => setEvalDraft([...(evalDraft ?? []), { criterion: "" }]);
  const submitSettings = () => {
    applyEvals();
    if (goalDraft != null) setGoal(goalDraft.trim());
    if (maxDraft != null) setMaxLoops(maxDraft, snap.maxLoopsEnabled);
    setLocked(true);
  };
  const importRubricFile = async (f: File | null) => {
    if (!f) return;
    const text = (await f.text()).trim();
    // Attach the file as a single rubric — the checker reads the whole document.
    // No line-splitting: a prose rubric shouldn't explode into dozens of rows.
    if (text) setEvalDraft([...(evalDraft ?? []), { criterion: text, kind: "llm", fileName: f.name }]);
    if (rubricFileRef.current) rubricFileRef.current.value = "";
  };

  return (
    <div style={{ minHeight: "100vh" }}>
      {/* ── top bar ─────────────────────────────────────────────────── */}
      <div style={topbar}>
        <div style={{ ...wrap, padding: "0 24px", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={logoMark}>⟲</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1 }}>Loopr</div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)", fontWeight: 550, letterSpacing: ".02em" }}>loop engineering studio</div>
          </div>
          <div style={{ marginLeft: 4 }}><LiveStatus connected={connected} snap={snap} /></div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {snap.running && <Btn variant="danger" sm onClick={stop}>■ Stop</Btn>}
            <Btn variant="ghost" sm onClick={toggleTheme} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} aria-label="Toggle theme"
              style={{ padding: "6px 9px" }}>{theme === "dark" ? "☀" : "☾"}</Btn>
            <Btn variant="ghost" sm onClick={() => { reset(); autoOpened.current = false; }}>↺ Reset</Btn>
            <Btn variant={sidebarOpen ? "primary" : "dark"} sm onClick={() => setSidebarOpen((o) => !o)}
              aria-pressed={sidebarOpen} title={sidebarOpen ? "Hide the artifact panel" : "Show the artifact panel"}>◳ Artifact</Btn>
          </div>
        </div>
      </div>

      <div style={{ ...wrap, display: "flex", flexDirection: "column", gap: 18 }}>
        {/* ── KPI row ───────────────────────────────────────────────── */}
        <div style={kpiRow}>
          <Stat label="Status" value={<span style={{ fontSize: 19 }}>{live.glyph} {live.label}</span>} sub={live.detail} accent={live.dot} delay={0} />
          <Stat label="Avg score" value={total ? `${avgScore}%` : "·"} sub={total ? `${green}/${total} at target` : "no rubric"} accent={allGreen ? "var(--good)" : undefined} delay={40} />
          <Stat label="Build" value={`#${snap.build}`} sub={snap.build ? "latest artifact" : "nothing yet"} delay={80} />
          <Stat label="Iterations" value={`${snap.loopCount}${snap.maxLoopsEnabled ? `/${snap.maxLoops}` : ""}`} sub={snap.maxLoopsEnabled ? "cap on" : "no cap"} delay={120} />
          <Stat label="Open findings" value={openFindings} sub={`${snap.findings.length - openFindings} fixed`} accent={openFindings ? "var(--warn)" : snap.findings.length ? "var(--good)" : undefined} delay={160} />
          <Stat label="Tokens" value={fmtTokens(snap.totalTokens)} sub={snap.totalTokens ? "across all agents" : "none yet"} delay={200} />
        </div>

        {/* ── gate ──────────────────────────────────────────────────── */}
        {snap.gate && <GateBanner gate={snap.gate} onResolve={resolveGate} />}

        <div className="dl-cols" style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>

            {/* ── loop settings ───────────────────────────────────── */}
            <Section icon="⚙" title="Loop settings" delay={40}
              desc="Define your rubric, the passing score, and a safety cap, then submit to hand it to the loop."
              open={controlsOpen} onToggle={() => setControlsOpen((o) => !o)}
              right={snap.locked ? (
                <Pill color="var(--good-ink)" bg="var(--good-weak)">🔒 submitted</Pill>
              ) : (
                <span className="dl-hide-sm dl-num" style={{ fontSize: 12, color: "var(--text-3)", fontWeight: 550 }}>
                  {total} criteria · target {snap.targetAccuracy}% · cap {snap.maxLoopsEnabled ? snap.maxLoops : "off"}
                </span>
              )}>
              <div style={{ opacity: snap.locked ? 0.55 : 1, pointerEvents: snap.locked ? "none" : "auto", display: "flex", flexDirection: "column", gap: 20 }}>
                <div>
                  <Label>Loop goal</Label>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", margin: "2px 0 10px" }}>
                    Say what you want built or researched — the orchestrator reads this as the job (<span className="dl-num">get_workspace → goal</span>).
                  </div>
                  <textarea
                    className="dl-input"
                    value={goalDraft ?? ""}
                    onChange={(e) => setGoalDraft(e.target.value)}
                    onFocus={() => { goalFocused.current = true; }}
                    onBlur={() => { goalFocused.current = false; setGoal((goalDraft ?? "").trim()); }}
                    placeholder="e.g. Research the last 3 days of AI-agent news, cite real sources, and deliver an HTML brief."
                    rows={3}
                    style={{ ...inp, width: "100%", resize: "vertical", minHeight: 62, lineHeight: 1.5, fontFamily: "inherit" }}
                  />
                  {(goalDraft ?? "").trim() === "" && (
                    <div style={{ fontSize: 11, color: "var(--warn-ink)", marginTop: 6 }}>No goal set yet — the orchestrator won’t know what to build.</div>
                  )}
                </div>
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <Label>Rubric</Label>
                    <ToggleSwitch checked={snap.perCriterionTargets} onChange={setPerCriterionTargets} label="individual targets" />
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", margin: "2px 0 10px" }}>
Add criteria or <b style={{ color: "var(--text-2)" }}>import a file</b>. <span className="dl-num">avg {avgScore}% · {green}/{total} at target</span>
                  </div>
                  {!snap.perCriterionTargets && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 9 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 650, color: "var(--text-2)" }}>Target accuracy · all criteria</span>
                      <div style={scoreTrack}>
                        <div style={{ width: `${snap.targetAccuracy}%`, height: 8, borderRadius: 999, background: "var(--accent)", opacity: 0.5 }} />
                        <div style={{ position: "absolute", left: `${snap.targetAccuracy}%`, top: "50%", transform: "translate(-50%,-50%)", width: 11, height: 15, borderRadius: 3, background: "var(--accent)", boxShadow: "0 0 0 2px var(--surface)", pointerEvents: "none" }} />
                        <input type="range" min={0} max={100} value={snap.targetAccuracy} aria-label="target accuracy"
                          onChange={(e) => setTargetAccuracy(Number(e.target.value))}
                          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "ew-resize" }} />
                      </div>
                      <span className="dl-num" style={{ fontSize: 11.5, fontWeight: 700, width: 44, textAlign: "right", color: "var(--accent-ink)" }}>≥{snap.targetAccuracy}%</span>
                      <span style={{ width: 28, flexShrink: 0 }} aria-hidden />
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {(evalDraft ?? []).length === 0 && (
                      <div style={{ fontSize: 12.5, color: "var(--text-3)", padding: "10px 12px", border: "1px dashed var(--border-2)", borderRadius: "var(--r-sm)", background: "var(--surface-2)" }}>
                        No criteria yet. Add one below, or import a checklist file.
                      </div>
                    )}
                    {(evalDraft ?? []).map((row, i) => {
                      const lineCount = row.criterion.split(/\r?\n/).filter((l) => l.trim()).length;
                      return (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          {row.fileName ? (
                            <div title={row.criterion} style={{ ...inp, flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", cursor: "default" }}>
                              <span style={{ fontSize: 16, lineHeight: 1 }}>📄</span>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: 12.5, fontWeight: 650, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.fileName}</div>
                                <div style={{ fontSize: 11, color: "var(--text-3)" }}>imported rubric · {lineCount} lines · the checker reads the whole file</div>
                              </div>
                            </div>
                          ) : (
                            <input className="dl-input" value={row.criterion} onChange={(e) => mutRow(i, { criterion: e.target.value })} placeholder="e.g. Cites at least two real sources" style={{ ...inp, flex: 1 }} />
                          )}
                          {(() => {
                            const pc = snap.perCriterionTargets;
                            const effTarget = pc && (row.target ?? -1) >= 0 ? (row.target as number) : snap.targetAccuracy;
                            return (
                              <>
                                <div title={pc ? `pass threshold ${effTarget}%` : `target ${effTarget}% (global)`} style={scoreTrack}>
                                  <div style={{ width: `${effTarget}%`, height: 8, borderRadius: 999, background: "var(--accent)", opacity: pc ? 0.6 : 0.4, transition: "width .12s var(--ease)" }} />
                                  <div style={{ position: "absolute", left: `${effTarget}%`, top: "50%", transform: "translate(-50%,-50%)", width: 11, height: 15, borderRadius: 3, background: pc ? "var(--accent)" : "var(--border-2)", boxShadow: "0 0 0 2px var(--surface)", pointerEvents: "none" }} />
                                  {pc && (
                                    <input type="range" min={0} max={100} value={effTarget} aria-label="pass threshold"
                                      onChange={(e) => dragTarget(i, row, Number(e.target.value))}
                                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "ew-resize" }} />
                                  )}
                                </div>
                                <span className="dl-num" style={{ fontSize: 11.5, fontWeight: 700, width: 44, textAlign: "right", color: pc ? "var(--accent-ink)" : "var(--text-3)" }}>≥{effTarget}%</span>
                              </>
                            );
                          })()}
                          <button className="dl-btn" onClick={() => removeRow(i)} style={xBtn} title="remove">✕</button>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 11, flexWrap: "wrap", alignItems: "center" }}>
                    <Btn variant="subtle" sm onClick={addLLM}>+ Criterion</Btn>
                    <input ref={rubricFileRef} type="file" accept=".txt,.md,.markdown,.csv,.json,.yaml,.yml" style={{ display: "none" }} onChange={(e) => importRubricFile(e.target.files?.[0] ?? null)} />
                    <Btn variant="ghost" sm onClick={() => rubricFileRef.current?.click()}>⭱ Import file</Btn>
                    {snap.perCriterionTargets && (
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>Drag each bar · untouched use <b className="dl-num" style={{ color: "var(--text-2)" }}>{snap.targetAccuracy}%</b></span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
                  <div style={{ minWidth: 240 }}>
                    <Label>Loop cap</Label>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                        <input type="checkbox" checked={snap.maxLoopsEnabled} onChange={(e) => setMaxLoops(maxDraft ?? snap.maxLoops, e.target.checked)} /> cap at
                      </label>
                      <input className="dl-input dl-num" type="number" min={1} max={500} value={maxDraft ?? snap.maxLoops}
                        onChange={(e) => setMaxDraft(Number(e.target.value))} disabled={!snap.maxLoopsEnabled}
                        style={{ ...inp, width: 72, opacity: snap.maxLoopsEnabled ? 1 : 0.5 }} />
                    </div>
                    <div style={{ ...hintText, color: snap.maxLoopsEnabled ? "var(--text-3)" : "var(--warn-ink)" }}>
                      {snap.maxLoopsEnabled ? "Stops here even if the target isn’t met." : "No cap. Runs until the target, or press Stop."}
                    </div>
                  </div>
                </div>
              </div>

              {/* submit / submitted bar */}
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                {snap.locked ? (
                  <>
                    <span style={{ fontSize: 13, fontWeight: 650, color: "var(--good-ink)" }}>✓ Settings submitted</span>
                    <span style={{ fontSize: 12, color: "var(--text-3)" }}>The loop is running against these. Press Edit to change them.</span>
                    <Btn variant="ghost" sm style={{ marginLeft: "auto" }} onClick={() => setLocked(false)}>✎ Edit settings</Btn>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 12, color: "var(--text-3)" }}>Locks the rubric, target and cap, and hands them to the loop as the job to run.</span>
                    <Btn variant="primary" style={{ marginLeft: "auto" }} onClick={submitSettings} disabled={total === 0 && (evalDraft ?? []).filter((r) => r.criterion.trim()).length === 0}>✓ Submit settings</Btn>
                  </>
                )}
              </div>
            </Section>


            {/* ── loop monitor ────────────────────────────────────── */}
            <Section icon="◎" title="Loop monitor" delay={140}
              desc="How the run is doing over time: convergence, open fixes, how the work is split, and its saved history."
              right={<ScheduleStrip schedule={snap.schedule} />}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <MonBlock icon="↗" title="Iteration history" hint="Is it converging? Each pass plots its average score.">
                  <HistoryPanel history={snap.history} />
                </MonBlock>
                <div style={monRow}>
                  <MonBlock icon="⚑" title="Findings" hint="What the checker flagged to fix, and what’s done.">
                    <FindingsPanel findings={snap.findings} />
                  </MonBlock>
                  <MonBlock icon="❐" title="Memory" hint="Every build kept. Diff any two, or save and restore the run.">
                    <MemoryPanel builds={snap.builds} onResume={resumeState} />
                  </MonBlock>
                </div>
              </div>
            </Section>
          </div>

          {/* ── artifact rail ───────────────────────────────────────── */}
          {sidebarOpen && (
            <aside className="dl-slide dl-rail" style={sidebar}>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <span style={iconChip}>◳</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>The artifact</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>the current build, graded live</div>
                </div>
                <button className="dl-btn" onClick={() => setSidebarOpen(false)} style={xBtn} title="hide">✕</button>
              </div>
              <div className="dl-num" style={{ fontSize: 11.5, color: "var(--text-3)", margin: "11px 0", flexShrink: 0 }}>
                {snap.build === 0 ? "empty" : `build #${snap.build}`} · loop {snap.loopCount}{snap.maxLoopsEnabled ? `/${snap.maxLoops}` : ""}
              </div>
              {snap.codeChange ? <CodeArtifact change={snap.codeChange} fill /> : <Preview html={snap.html} fill theme={theme} />}
              <div style={{ marginTop: 16, flexShrink: 0 }}>
                <div className="dl-num" style={{ fontSize: 12, fontWeight: 700, marginBottom: 9 }}>Rubric · avg {avgScore}% · {green}/{total} at target</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {snap.evals.map((r) => (
                    <div key={r.id} title={r.detail}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 3, gap: 8 }}>
                        <span style={{ color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                          {r.kind === "command" && <span title="command check" style={{ color: "var(--text-3)" }}>❯ </span>}{r.label}
                        </span>
                        <b className="dl-num" style={{ flexShrink: 0, color: r.passed ? "var(--good-ink)" : "var(--warn-ink)" }}>
                          {r.kind === "command" ? (r.passed ? "✓ pass" : "✗ fail") : `${r.score}%`}
                        </b>
                      </div>
                      {r.kind === "command" && r.command && (
                        <div className="dl-num" style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "ui-monospace, SFMono-Regular, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 }}>{r.command}</div>
                      )}
                      <div style={{ position: "relative", width: "100%", height: 8, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
                        <div className="dl-bar" style={{ width: `${r.score}%`, height: 8, borderRadius: 999, background: r.passed ? "var(--good)" : "var(--warn)", transition: "width .5s var(--ease)" }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {snap.reviewNotes && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 7 }}>Latest critique</div>
                  <Critique notes={snap.reviewNotes} />
                </div>
              )}
            </aside>
          )}

          {/* ── live agents rail (the stream as a graph) ─────────────── */}
          <aside className="dl-slide dl-rail" style={rightRail}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, flexShrink: 0 }}>
              <span style={iconChip}>◍</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>Live agents</div>
                <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>the stream, wired by the plan</div>
              </div>
              <span className="dl-num" style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 550, flexShrink: 0 }}>
                {subAgentCount > 0 ? `1 + ${subAgentCount}` : "idle"}
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", marginTop: 12 }}>
              <AgentGraph outputs={snap.outputs} plan={snap.plan} />
            </div>
          </aside>
        </div>

      </div>
    </div>
  );
};

/* ── styles ───────────────────────────────────────────────────────── */

const wrap: React.CSSProperties = { maxWidth: 1840, margin: "0 auto", padding: "18px 28px 48px" };

const topbar: React.CSSProperties = {
  position: "sticky", top: 0, zIndex: 20,
  background: "rgba(11,12,18,.72)", backdropFilter: "saturate(1.4) blur(16px)",
  WebkitBackdropFilter: "saturate(1.4) blur(16px)",
  borderBottom: "1px solid var(--border)", padding: "12px 0", marginBottom: 6,
};

const logoMark: React.CSSProperties = {
  width: 36, height: 36, borderRadius: 11, flexShrink: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "linear-gradient(140deg,#8b7dff 0%,#7b6bff 55%,#4f9dff 100%)", color: "#fff",
  fontSize: 21, fontWeight: 700, boxShadow: "0 8px 22px -6px rgba(123,107,255,.8)",
};

const card: React.CSSProperties = {
  backgroundColor: "var(--surface)", backgroundImage: "var(--sheen)",
  border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20, boxShadow: "var(--sh-sm)",
};

const iconChip: React.CSSProperties = {
  width: 36, height: 36, borderRadius: 10, flexShrink: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "var(--accent-weak)", color: "var(--accent-ink)", fontSize: 17, fontWeight: 700,
};

const kpiRow: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(158px, 1fr))", gap: 12,
};

const statTile: React.CSSProperties = {
  position: "relative", padding: "15px 16px 14px", overflow: "hidden",
  backgroundColor: "var(--surface)", backgroundImage: "var(--sheen)",
  border: "1px solid var(--border)", borderRadius: "var(--r)", boxShadow: "var(--sh-sm)",
};
const statTop: React.CSSProperties = { position: "absolute", top: 0, left: 0, right: 0, height: 3 };
const statLabel: React.CSSProperties = {
  fontSize: 10.5, color: "var(--text-3)", fontWeight: 650, textTransform: "uppercase", letterSpacing: ".07em",
};
const statValue: React.CSSProperties = { fontSize: 27, fontWeight: 750, letterSpacing: "-.03em", lineHeight: 1.15, marginTop: 5 };
const statSub: React.CSSProperties = { fontSize: 11.5, color: "var(--text-3)", marginTop: 3 };

const sidebar: React.CSSProperties = {
  ...card, order: -1, width: 500, flexShrink: 0, position: "sticky", top: 78,
  height: "calc(100vh - 96px)", overflowY: "auto",
  display: "flex", flexDirection: "column",
};

// The live-agents rail on the right: full-height, streams the graph.
const rightRail: React.CSSProperties = {
  ...card, width: 400, flexShrink: 0, position: "sticky", top: 78,
  height: "calc(100vh - 96px)", overflowY: "auto",
  display: "flex", flexDirection: "column",
};

const emptyBox: React.CSSProperties = {
  height: 240, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  textAlign: "center", color: "var(--text-3)", padding: 20, background: "var(--surface-2)",
};

const previewFrame: React.CSSProperties = {
  border: "1px solid var(--border)", borderRadius: "var(--r)", overflow: "hidden", background: "var(--surface-2)",
};
const previewBar: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5, padding: "8px 12px",
  background: "var(--surface-3)", borderBottom: "1px solid var(--border)",
};
const dot: React.CSSProperties = { width: 9, height: 9, borderRadius: 999, display: "inline-block" };

const outputEmpty: React.CSSProperties = {
  border: "1.5px dashed rgba(123,107,255,.32)", borderRadius: "var(--r)", padding: "32px 18px",
  textAlign: "center", color: "var(--accent-ink)",
  backgroundColor: "var(--surface-2)", backgroundImage: "linear-gradient(180deg, rgba(123,107,255,.08), transparent)",
};

const outputBody: React.CSSProperties = { overflowY: "auto", fontSize: 13, lineHeight: 1.55, color: "var(--text)" };

const streamDot: React.CSSProperties = { width: 9, height: 9, borderRadius: 999, flexShrink: 0 };

const worktreeTag: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 650, color: "var(--text-2)", background: "var(--surface-3)",
  border: "1px solid var(--border-2)", borderRadius: 6, padding: "1px 7px",
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
};

const prChip: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#fff", background: "var(--accent)",
  borderRadius: "var(--r-sm)", padding: "5px 11px", textDecoration: "none",
  display: "inline-flex", alignItems: "center", gap: 5,
};
const branchChip: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 650, color: "var(--text-2)", background: "var(--surface-3)",
  border: "1px solid var(--border-2)", borderRadius: "var(--r-sm)", padding: "4px 9px",
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%",
};

const gateBanner: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
  border: "1px solid rgba(243,191,77,.42)",
  backgroundColor: "var(--surface)", backgroundImage: "linear-gradient(180deg, rgba(243,191,77,.13), rgba(243,191,77,.04))",
  borderRadius: "var(--r-lg)", padding: "15px 17px", boxShadow: "0 16px 40px -18px rgba(243,191,77,.3)",
};

const monRow: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 14 };
const monBlock: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: "var(--r)", padding: "18px 20px", background: "var(--surface-2)" };
const monIcon: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 8, flexShrink: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "var(--accent-weak)", color: "var(--accent-ink)", fontSize: 14, fontWeight: 700,
};
const monoHint: React.CSSProperties = {
  fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.5, textAlign: "center",
  padding: "20px 18px", border: "1px dashed var(--border-2)", borderRadius: "var(--r-sm)", background: "var(--surface)",
};
const microLabel: React.CSSProperties = { fontSize: 10, color: "var(--text-3)", fontWeight: 650, textTransform: "uppercase", letterSpacing: ".07em" };

const hTable: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 11.5 };
const hTh: React.CSSProperties = { textAlign: "center", padding: "6px 8px", color: "var(--text-3)", fontWeight: 650, borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--surface)", textTransform: "uppercase", letterSpacing: ".05em", fontSize: 9.5 };
const hTd: React.CSSProperties = { textAlign: "center", padding: "6px 8px", borderBottom: "1px solid var(--surface-3)" };

const findingRow: React.CSSProperties = { display: "flex", gap: 9, alignItems: "flex-start", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "9px 10px", background: "var(--surface)" };
const buildRow: React.CSSProperties = { display: "flex", gap: 9, alignItems: "center", padding: "6px 8px", borderRadius: 7 };

const critiqueList: React.CSSProperties = { margin: 0, padding: "13px 15px 13px 30px", listStyle: "disc", background: "var(--accent-weak)", border: "1px solid rgba(123,107,255,.28)", borderRadius: "var(--r-sm)", color: "var(--accent-ink)", fontSize: 12, lineHeight: 1.55 };
const inlineCode: React.CSSProperties = { background: "var(--accent-weak)", borderRadius: 5, padding: "1px 5px", fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11, color: "var(--accent-ink)" };
const mdLink: React.CSSProperties = { color: "var(--accent-ink)", textDecoration: "underline", textUnderlineOffset: 2 };
const mdP: React.CSSProperties = { margin: "0 0 8px" };
const mdList: React.CSSProperties = { margin: "0 0 8px", paddingLeft: 20, listStyle: "disc" };
const mdLi: React.CSSProperties = { marginBottom: 3 };
const mdH = (lvl: number): React.CSSProperties => ({ fontSize: lvl <= 1 ? 15 : lvl === 2 ? 14 : 13, fontWeight: 700, margin: "6px 0 6px", letterSpacing: "-.01em" });

const xBtn: React.CSSProperties = { background: "var(--surface-3)", color: "var(--bad)", border: "1px solid var(--border-2)", borderRadius: 7, padding: "5px 8px", fontWeight: 700, fontSize: 12 };
const inp: React.CSSProperties = { border: "1px solid var(--border-2)", borderRadius: "var(--r-sm)", padding: "8px 11px", fontSize: 13, fontFamily: "inherit", background: "var(--surface-3)", color: "var(--text)" };
const hintText: React.CSSProperties = { fontSize: 11.5, color: "var(--text-3)", marginTop: 8, lineHeight: 1.45 };

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.01em" }}>{children}</div>
);

const ToggleSwitch: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label?: string }> = ({ checked, onChange, label }) => (
  <span role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
    style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 11.5, color: "var(--text-2)", fontWeight: 600, userSelect: "none" }}>
    {label}
    <span style={{ position: "relative", width: 34, height: 19, borderRadius: 999, flexShrink: 0, background: checked ? "var(--accent)" : "var(--surface-3)", border: "1px solid var(--border-2)", transition: "background .2s var(--ease)" }}>
      <span style={{ position: "absolute", top: 1.5, left: checked ? 16 : 1.5, width: 14, height: 14, borderRadius: 999, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.4)", transition: "left .2s var(--ease)" }} />
    </span>
  </span>
);

const scoreTrack: React.CSSProperties = { position: "relative", width: 132, height: 8, background: "var(--surface-3)", borderRadius: 999, flexShrink: 0 };

export default Page;
