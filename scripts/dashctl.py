#!/usr/bin/env python3
"""dashctl — drive the Loopr dashboard (Mode B) from the shell.

A thin, stable wrapper over the backend REST control plane so the orchestrator
can push live output / builds / scores without a fresh ad-hoc curl each time
(one allowlisted command → no permission prompt per push). Backend URL defaults
to http://localhost:8000, override with LOOPR_URL.

Usage (text/markdown comes from STDIN so quoting never bites):
  dashctl out <id> <label> <role> <status> <append> [worktree]  # role: orchestrator|subagent
  dashctl build "<one-line summary>"                    # HTML fragment on STDIN
  dashctl scores                                        # JSON list on STDIN
  dashctl critique                                      # markdown on STDIN
  dashctl clear                                         # wipe all output panes
  dashctl state                                         # print a compact status line
  # -- loop monitoring --
  dashctl findings                                      # JSON list [{issue,where,fixHint,addressed}] on STDIN
  dashctl gate "<action>"                               # raise a human checkpoint; detail on STDIN
  dashctl resolve <1|0>                                 # approve(1)/reject(0) the gate
  dashctl schedule                                      # JSON {trigger,nextRun,lastRun} on STDIN
  dashctl plan                                          # JSON list [{subtask,agent,worktree}] on STDIN
  dashctl export                                        # print the restorable loop state (JSON)
  dashctl resume                                        # restore loop state from JSON on STDIN
  # -- durable job queue (auto-start on Submit) --
  dashctl nextjob                                       # {pending, seq, goal, target, cap, criteria}
  dashctl claim [seq]                                   # claim the pending job so it runs once
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

BASE = os.environ.get("LOOPR_URL", "http://localhost:8000")


def _post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())


def _get(path: str) -> dict:
    return json.loads(urllib.request.urlopen(BASE + path, timeout=30).read().decode())


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "out":
        _id, label, role, status, append = sys.argv[2:7]
        body = {
            "id": _id, "label": label, "role": role,
            "status": status, "append": append == "1", "text": sys.stdin.read(),
        }
        if len(sys.argv) > 7:
            body["worktree"] = sys.argv[7]
        out = _post("/api/output", body)
    elif cmd == "rubric":
        out = _post("/api/rubric", {"criteria": json.load(sys.stdin)})
    elif cmd == "target":
        out = _post("/api/target", {"percent": int(sys.argv[2])})
    elif cmd == "findings":
        out = _post("/api/findings", {"findings": json.load(sys.stdin)})
    elif cmd == "gate":
        out = _post("/api/gate", {"action": sys.argv[2] if len(sys.argv) > 2 else "", "detail": sys.stdin.read()})
    elif cmd == "resolve":
        out = _post("/api/gate/resolve", {"approve": (len(sys.argv) > 2 and sys.argv[2] == "1")})
    elif cmd == "schedule":
        out = _post("/api/schedule", json.load(sys.stdin))
    elif cmd == "plan":
        out = _post("/api/plan", {"plan": json.load(sys.stdin)})
    elif cmd == "export":
        out = _get("/api/loopstate")
    elif cmd == "resume":
        out = _post("/api/loopstate", json.load(sys.stdin))
    elif cmd == "build":
        out = _post("/api/build", {"content": sys.stdin.read(), "summary": sys.argv[2] if len(sys.argv) > 2 else ""})
    elif cmd == "scores":
        out = _post("/api/scores", {"scores": json.load(sys.stdin)})
    elif cmd == "critique":
        out = _post("/api/critique", {"notes": sys.stdin.read()})
    elif cmd == "clear":
        out = _post("/api/output/clear", {})
    elif cmd == "nextjob":
        out = _get("/api/nextjob")
    elif cmd == "claim":
        out = _post("/api/nextjob/claim", {"seq": int(sys.argv[2])} if len(sys.argv) > 2 else {})
    elif cmd == "reset":
        out = _post("/api/reset", {})
    elif cmd == "state":
        s = _get("/api/state")
        ev = s.get("evals", [])
        avg = round(sum(e["score"] for e in ev) / len(ev)) if ev else 0
        out = {
            "target": s["targetAccuracy"], "cap": s["maxLoops"] if s["maxLoopsEnabled"] else None,
            "build": s["build"], "loop": s["loopCount"], "avg": avg,
            "done": bool(ev) and all(e["passed"] for e in ev),
            "panes": [(o["label"], o["status"]) for o in s["outputs"]],
        }
    else:
        sys.exit(f"unknown command: {cmd!r} (out|build|scores|critique|clear|state)")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
