"""Shared Anthropic wiring for the real agents.

Both the Coder and the Reviewer are real LLM agents: each cycle they run one
turn that is forced to call a single structured tool, and act on the tool input.
This module owns the (lazily built, shared) AsyncAnthropic client and a small
``tool_call`` helper so the agents stay focused on *what* they ask for, not the
transport. When no credentials are configured — or a call fails — ``tool_call``
returns None and the caller falls back to its offline behaviour.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from anthropic import AsyncAnthropic

_client: "AsyncAnthropic | None" = None
_client_tried = False


def get_client() -> "AsyncAnthropic | None":
    """Lazily build one shared AsyncAnthropic client, or None if unavailable.

    Supports either a standard API key (ANTHROPIC_API_KEY) or an OAuth access
    token (sk-ant-oat01-…, e.g. from ``claude`` / ``ant auth login``). OAuth
    tokens are sent as a Bearer token and require the oauth beta header on every
    request, so we wire that up explicitly.
    """
    global _client, _client_tried
    if _client_tried:
        return _client
    _client_tried = True

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    oauth = (
        os.environ.get("ANTHROPIC_AUTH_TOKEN")
        or os.environ.get("ANTHROPIC_OAUTH_KEY")
    )
    if not (api_key or oauth):
        return None  # no creds — agents stay in offline mode

    try:
        from anthropic import AsyncAnthropic

        if api_key:
            _client = AsyncAnthropic()
        else:
            _client = AsyncAnthropic(
                auth_token=oauth,
                default_headers={"anthropic-beta": "oauth-2025-04-20"},
            )
    except Exception:
        _client = None
    return _client


async def tool_call(
    *,
    model: str,
    system: str,
    tool: dict[str, Any],
    user: str,
    max_tokens: int = 1024,
) -> dict[str, Any] | None:
    """Run one turn forced to call ``tool``; return its input dict, or None.

    None means the model is unavailable or the call failed — the caller should
    fall back. Any network/auth/rate-limit error is swallowed so one bad tick
    never takes the loop down.
    """
    client = get_client()
    if client is None:
        return None
    try:
        msg = await client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            tools=[tool],
            tool_choice={"type": "tool", "name": tool["name"]},
            messages=[{"role": "user", "content": user}],
        )
    except Exception:
        return None
    for block in msg.content:
        if block.type == "tool_use" and block.name == tool["name"]:
            return block.input
    return None
