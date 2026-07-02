"""Best-effort HTML sanitiser for agent-produced content.

The frontend also renders inside a sandboxed iframe (scripts disabled), so this
is defence in depth: strip <script>, inline event handlers, and javascript: URLs
before the content is stored.
"""

from __future__ import annotations

import re

_SCRIPT_RE = re.compile(r"<script\b.*?</script\s*>", re.IGNORECASE | re.DOTALL)
_ON_ATTR_RE = re.compile(r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.IGNORECASE)
_JS_URL_RE = re.compile(r"(href|src)\s*=\s*(\"|')\s*javascript:[^\"']*(\"|')", re.IGNORECASE)


def strip_scripts(html: str) -> str:
    html = _SCRIPT_RE.sub("", html)
    html = _ON_ATTR_RE.sub("", html)
    html = _JS_URL_RE.sub(r"\1=\2#\3", html)
    return html.strip()
