#!/usr/bin/env python3
"""await_job — block until the human submits a job on the dashboard, then claim it.

The durable half of "press Submit → the orchestrator starts." The backend keeps a
pending job (see /api/nextjob) that survives restarts and reconnects until claimed.
This poller waits for one, claims it (so it runs exactly once), and prints it as
JSON for the orchestrator to act on.

Usage:
  python3 scripts/await_job.py [--timeout SECONDS] [--interval SECONDS] [--peek]
    --peek     print the current job status and exit (no waiting, no claim)

Backend URL defaults to http://localhost:8000, override with LOOPR_URL.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request

BASE = os.environ.get("LOOPR_URL", "http://localhost:8000")


def _get(path: str) -> dict:
    return json.loads(urllib.request.urlopen(BASE + path, timeout=15).read().decode())


def _post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=15).read().decode())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=float, default=1800)
    ap.add_argument("--interval", type=float, default=2)
    ap.add_argument("--peek", action="store_true")
    args = ap.parse_args()

    if args.peek:
        print(json.dumps(_get("/api/nextjob"), indent=2))
        return

    deadline = None if args.timeout <= 0 else args.timeout
    waited = 0.0
    while deadline is None or waited <= deadline:
        try:
            job = _get("/api/nextjob")
            if job.get("pending"):
                _post("/api/nextjob/claim", {"seq": job["seq"]})  # claim → runs once
                print("JOB")
                print(json.dumps(job, indent=2))
                return
        except Exception:
            pass  # backend restarting / offline — keep waiting
        time.sleep(args.interval)
        waited += args.interval
    print("TIMEOUT")
    sys.exit(2)


if __name__ == "__main__":
    main()
