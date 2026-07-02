"""The two agent step kinds the pipeline runs — data-driven, not fixed classes.

The Agent Builder defines a list of AgentDef; the engine runs them in order each
loop. Each agent is one of:

  maker   → run_maker:   writes/updates the HTML from the brief + checker feedback
  checker → run_checker: grades the rubric (0-100) and critiques the build

Both are parameterised by the AgentDef (name, role, model), so users can add,
name, re-role, re-model, and re-order agents to compose their own loop.
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING

from ..domain.models import AgentDef, EvalResult, Tone
from . import llm

if TYPE_CHECKING:
    from ..state import FactoryState


# -- maker --------------------------------------------------------------------

_MAKER_SYSTEM = (
    "You are a Builder agent in a maker–checker pipeline. You build the 'About Us' "
    "section of a website as a single self-contained HTML fragment. It may include "
    "one <style> block and inline styles; NEVER include <script>, event handlers, or "
    "external resources. The conversation is the user's brief; attached files are "
    "reference material to draw real content/facts from. Each turn you receive the "
    "current HTML, the checker's per-rubric grades (0-100) with reasons, and the "
    "checker's critique notes. Rewrite the WHOLE section to push every rubric to the "
    "target and address the notes, while honouring the brief and keeping the copy "
    "tight and the design clean. Return the complete HTML plus a one-sentence chat "
    "reply (what you built or changed) via the write_section tool."
)

_WRITE_TOOL = {
    "name": "write_section",
    "description": "Submit the complete HTML for the About Us section, plus a short chat reply.",
    "input_schema": {
        "type": "object",
        "properties": {
            "html": {
                "type": "string",
                "description": "A self-contained HTML fragment. May include one <style> block. No <script>.",
            },
            "summary": {
                "type": "string",
                "description": "One friendly sentence for the chat: what you built or changed.",
            },
        },
        "required": ["html", "summary"],
        "additionalProperties": False,
    },
}

_SCRIPT_RE = re.compile(r"<script\b.*?</script\s*>", re.IGNORECASE | re.DOTALL)
_ON_ATTR_RE = re.compile(r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.IGNORECASE)
_JS_URL_RE = re.compile(r"(href|src)\s*=\s*(\"|')\s*javascript:[^\"']*(\"|')", re.IGNORECASE)


def _strip_scripts(html: str) -> str:
    html = _SCRIPT_RE.sub("", html)
    html = _ON_ATTR_RE.sub("", html)
    html = _JS_URL_RE.sub(r"\1=\2#\3", html)
    return html.strip()


def _with_role(base: str, agent: AgentDef) -> str:
    if agent.role.strip():
        return f"{base}\n\nYou are '{agent.name}'. Your specific role: {agent.role.strip()}"
    return base


def _offline_html(state: "FactoryState") -> str:
    brief = (state.vision.brief or "About our company.").strip()
    return (
        "<section style=\"font-family:system-ui,sans-serif;max-width:640px;margin:0 "
        "auto;padding:32px;line-height:1.5\"><h2 style=\"margin:0 0 12px\">About Us</h2>"
        f"<p style=\"color:#374151\">{brief}</p></section>"
    )


async def run_maker(state: "FactoryState", agent: AgentDef) -> None:
    payload = {
        "conversationBrief": state.vision.brief or "(no brief yet — make a sensible start)",
        "attachedFiles": [{"name": f["name"], "content": f["content"]} for f in state.context_files],
        "targetAccuracy": state.target_accuracy,
        "currentHtml": state.html or "(empty — nothing built yet)",
        "rubricGrades": [
            {"rubric": r.label, "score": r.score, "atTarget": r.passed, "checkerReason": r.detail}
            for r in state.eval_results
        ],
        "checkerNotes": state.review_notes or "(none yet)",
    }
    user = (
        "Build or improve the About Us section so EVERY rubric's score reaches at least "
        f"the target accuracy ({state.target_accuracy}%). Use the attached files for real "
        "content where relevant, focus on the lowest-scoring rubrics, and address the "
        "checker notes. Return the full HTML and a one-sentence chat reply via "
        "write_section.\n\n" + json.dumps(payload, indent=2)
    )
    got = await llm.tool_call(
        model=agent.model, system=_with_role(_MAKER_SYSTEM, agent), tool=_WRITE_TOOL,
        user=user, max_tokens=3200,
    )
    if got is None or not isinstance(got.get("html"), str) or not got["html"].strip():
        html, summary = _offline_html(state), "Built a first draft (offline)."
    else:
        html = got["html"]
        summary = got.get("summary") if isinstance(got.get("summary"), str) and got["summary"].strip() else "Updated the section."

    state.set_html(_strip_scripts(html))
    prefix = f"{agent.name}: " if state.maker_count() > 1 else ""
    state.add_builder_message(f"{prefix}{summary}")
    state.log(agent.name, f"built the section (build #{state.build}, loop {state.loop_count})", Tone.info)


# -- checker ------------------------------------------------------------------

_CHECKER_SYSTEM = (
    "You are a Checker agent in a maker–checker pipeline: the critic AND the grader. "
    "You are given the brand brief (the goal), the current About Us HTML, the rubric — "
    "a list of criteria the site owner wrote — and the target accuracy. Do two things "
    "and return them via the review tool: (1) GRADE — for every rubric criterion, give "
    "an integer SCORE from 0 to 100 for how fully the section's ACTUAL rendered content "
    "satisfies it (100 = flawless, target = clearly good enough). Be calibrated and "
    "consistent, with a short reason. (2) CRITIQUE — write 3-5 concise, prioritised, "
    "actionable notes telling the maker how to push every below-target rubric up to the "
    "target and better fit the brief. Do NOT rewrite the HTML and do NOT invent criteria."
)

_REVIEW_TOOL = {
    "name": "review",
    "description": "Score every rubric criterion 0-100 and give the maker critique notes.",
    "input_schema": {
        "type": "object",
        "properties": {
            "verdicts": {
                "type": "array",
                "description": "One entry per rubric id.",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "score": {"type": "integer", "description": "0-100."},
                        "reason": {"type": "string", "description": "Short reason (<= 20 words)."},
                    },
                    "required": ["id", "score", "reason"],
                    "additionalProperties": False,
                },
            },
            "notes": {"type": "string", "description": "3-5 actionable bullets (one per line)."},
        },
        "required": ["verdicts", "notes"],
        "additionalProperties": False,
    },
}


async def run_checker(state: "FactoryState", agent: AgentDef) -> None:
    if not state.eval_specs:
        state.apply_results([])  # no rubric → trivially met
        return

    payload = {
        "conversationBrief": state.vision.brief,
        "attachedFiles": [{"name": f["name"], "content": f["content"]} for f in state.context_files],
        "targetAccuracy": state.target_accuracy,
        "aboutUsHtml": state.html,
        "rubric": [{"id": s.id, "text": s.criterion} for s in state.eval_specs],
    }
    user = (
        "Score the About Us section 0-100 on every rubric criterion (judge only what the "
        f"HTML actually contains; the owner's target is {state.target_accuracy}%) and give "
        "the maker critique notes to reach it. Return review.\n\n" + json.dumps(payload, indent=2)
    )
    got = await llm.tool_call(
        model=agent.model, system=_with_role(_CHECKER_SYSTEM, agent), tool=_REVIEW_TOOL,
        user=user, max_tokens=1024,
    )

    if got is None:  # offline
        score = 100 if state.html.strip() else 0
        results = [
            EvalResult(id=s.id, label=s.criterion, score=score, passed=False, detail="offline: not graded")
            for s in state.eval_specs
        ]
        state.apply_results(results)
        state.review_notes = "Tighten the copy and make sure each rubric is clearly addressed."
        return

    verdicts = got.get("verdicts", []) if isinstance(got.get("verdicts"), list) else []
    notes = got.get("notes", "") if isinstance(got.get("notes"), str) else ""

    parsed: list[tuple[str, int, str]] = []  # (id, score, reason) in returned order
    for v in verdicts:
        try:
            parsed.append((str(v["id"]), max(0, min(100, int(v["score"]))), str(v.get("reason", ""))[:200]))
        except Exception:
            continue
    vmap = {vid: (sc, rs) for vid, sc, rs in parsed}
    # If the model echoed the wrong ids but the count lines up, map by position.
    positional = None
    if not any(s.id in vmap for s in state.eval_specs) and len(parsed) == len(state.eval_specs):
        positional = parsed

    results = []
    for i, s in enumerate(state.eval_specs):
        if s.id in vmap:
            score, reason = vmap[s.id]
        elif positional is not None:
            _, score, reason = positional[i]
        else:
            score, reason = 0, "no score returned"
        results.append(EvalResult(id=s.id, label=s.criterion, score=score, passed=False, detail=reason))
    state.apply_results(results)
    if notes:
        state.review_notes = notes

    if not state.was_green:
        avg = round(sum(r.score for r in results) / len(results)) if results else 100
        met = sum(1 for r in results if r.passed)
        first = next((ln.strip(" -•\t") for ln in notes.splitlines() if ln.strip()), "")
        msg = f"graded avg {avg}% · {met}/{len(results)} at target"
        if first:
            msg += f" · {first[:70]}"
        state.log(agent.name, msg, Tone.steer)
