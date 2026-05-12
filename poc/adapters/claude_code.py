from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from typing import AsyncIterator

from .. import config
from .base import (
    BaseAdapter,
    ChatChoice,
    ChatChunk,
    ChatMessage,
    ChatRequest,
    ChatResponse,
    ChatUsage,
    RateLimitError,
    SessionRef,
)

MODEL_ALIASES = {
    "haiku": "haiku",
    "sonnet": "sonnet",
    "opus": "opus",
    "gpt-3.5-turbo": "haiku",
    "gpt-4o-mini": "haiku",
    "gpt-4o": "sonnet",
    "gpt-4": "sonnet",
    "gpt-4-turbo": "sonnet",
    "claude-haiku-4-5-20251001": "haiku",
    "claude-sonnet-4-6": "sonnet",
    "claude-opus-4-7": "opus",
}

RATE_LIMIT_PATTERN = re.compile(r"rate.?limit|usage.?limit|5.?hour|quota", re.IGNORECASE)
RETRY_AFTER_PATTERN = re.compile(r"(\d+)\s*(second|minute|hour|s|m|h)", re.IGNORECASE)


def map_model(name: str) -> str:
    key = name.lower().strip()
    if key in MODEL_ALIASES:
        return MODEL_ALIASES[key]
    if key.startswith("claude-opus"):
        return "opus"
    if key.startswith("claude-sonnet"):
        return "sonnet"
    if key.startswith("claude-haiku"):
        return "haiku"
    return config.DEFAULT_MODEL


def messages_to_prompt(messages: list[ChatMessage]) -> tuple[str | None, str]:
    """Split first system message off, flatten the rest."""
    system = None
    chat = list(messages)
    if chat and chat[0].role == "system":
        system = chat[0].content
        chat = chat[1:]
    parts = [f"[{m.role.upper()}]\n{m.content}" for m in chat]
    return system, "\n\n".join(parts)


def build_argv(
    *,
    model: str,
    system: str | None,
    session: SessionRef | None,
    new_session_id: str | None,
) -> list[str]:
    argv = [
        config.CLAUDE_BIN,
        "-p",
        "--model",
        model,
        "--output-format",
        "json",
        "--disallowedTools",
        config.DISALLOWED_TOOLS,
    ]
    if session is not None:
        argv += ["--resume", session.session_id]
    elif new_session_id is not None:
        argv += ["--session-id", new_session_id]
    else:
        argv += ["--no-session-persistence"]
    if system:
        argv += ["--append-system-prompt", system]
    return argv


def parse_retry_after(text: str) -> int:
    m = RETRY_AFTER_PATTERN.search(text)
    if not m:
        return config.RATE_PACE_SECS
    n = int(m.group(1))
    unit = m.group(2).lower()
    if unit.startswith("h"):
        return n * 3600
    if unit.startswith("m"):
        return n * 60
    return n


class ClaudeCodeAdapter(BaseAdapter):
    name = "claude-code"

    async def complete(
        self, req: ChatRequest, session: SessionRef | None = None
    ) -> ChatResponse:
        model = map_model(req.model)
        system, prompt = messages_to_prompt(req.messages)

        # If we're resuming, only send the newest user message (server has the history).
        if session is not None:
            for m in reversed(req.messages):
                if m.role == "user":
                    prompt = m.content
                    break
            system = None  # already in session

        new_sid = None
        if session is None and req.user:
            new_sid = self._sid_from_user(req.user)

        if config.FAKE_RATE_LIMIT:
            raise RateLimitError("FAKE rate limit hit (5-hour usage limit)", retry_after=2)

        if config.FAKE_BACKEND:
            return self._fake_response(model, prompt, new_sid)

        argv = build_argv(
            model=model, system=system, session=session, new_session_id=new_sid
        )

        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(prompt.encode("utf-8")),
                timeout=config.SUBPROCESS_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError(f"claude -p timed out after {config.SUBPROCESS_TIMEOUT_S}s")

        stderr_text = stderr.decode("utf-8", errors="replace")
        if proc.returncode != 0:
            if RATE_LIMIT_PATTERN.search(stderr_text):
                raise RateLimitError(stderr_text, parse_retry_after(stderr_text))
            raise RuntimeError(
                f"claude -p exit={proc.returncode}: {stderr_text[:500]}"
            )

        try:
            payload = json.loads(stdout.decode("utf-8"))
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"could not parse claude json output: {e}; head={stdout[:200]!r}"
            )

        is_error = payload.get("is_error") or payload.get("error")
        if is_error:
            msg = payload.get("result") or payload.get("message") or json.dumps(payload)
            if RATE_LIMIT_PATTERN.search(str(msg)):
                raise RateLimitError(str(msg), parse_retry_after(str(msg)))
            raise RuntimeError(f"claude returned error: {msg}")

        text = (
            payload.get("result")
            or payload.get("text")
            or payload.get("content")
            or ""
        )
        sid = payload.get("session_id") or new_sid or ""
        cost = payload.get("total_cost_usd") or payload.get("cost_usd")
        usage_in = payload.get("usage") or {}
        usage = ChatUsage(
            prompt_tokens=usage_in.get("input_tokens", 0) or 0,
            completion_tokens=usage_in.get("output_tokens", 0) or 0,
            total_tokens=(
                (usage_in.get("input_tokens", 0) or 0)
                + (usage_in.get("output_tokens", 0) or 0)
            ),
        )

        dropped = []
        if req.temperature is not None:
            dropped.append("temperature")
        if req.top_p is not None:
            dropped.append("top_p")
        fp = f"claude-code; dropped={','.join(dropped)}" if dropped else "claude-code"

        return ChatResponse(
            id=f"chatcmpl-{uuid.uuid4().hex[:24]}",
            created=int(time.time()),
            model=payload.get("model", model),
            choices=[
                ChatChoice(message=ChatMessage(role="assistant", content=text))
            ],
            usage=usage,
            system_fingerprint=fp,
            cost_usd=cost,
            backend_session_id=sid,
        )

    async def stream(
        self, req: ChatRequest, session: SessionRef | None = None
    ) -> AsyncIterator[ChatChunk]:
        raise NotImplementedError(
            "streaming not yet supported; v2 will wrap --output-format stream-json"
        )
        yield  # pragma: no cover  (make this a generator)

    async def start_session(self, system: str | None = None) -> SessionRef:
        sid = str(uuid.uuid4())
        return SessionRef(backend=self.name, session_id=sid)

    async def resume_session(self, ref: SessionRef) -> None:
        return None

    @staticmethod
    def _sid_from_user(user: str) -> str:
        # Deterministic UUIDv5 so the same `user` value maps to the same session id.
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"poc-user.{user}"))

    @staticmethod
    def _fake_response(model: str, prompt: str, sid: str | None) -> ChatResponse:
        last = prompt.rsplit("[USER]", 1)[-1].strip() or prompt
        if "PONG" in last.upper() or "pong" in last:
            text = "PONG"
        else:
            text = f"[FAKE {model}] echo: {last[:200]}"
        return ChatResponse(
            id=f"chatcmpl-{uuid.uuid4().hex[:24]}",
            created=int(time.time()),
            model=model,
            choices=[ChatChoice(message=ChatMessage(role="assistant", content=text))],
            usage=ChatUsage(prompt_tokens=len(prompt) // 4, completion_tokens=len(text) // 4),
            system_fingerprint="claude-code; fake=1",
            cost_usd=0.0,
            backend_session_id=sid or "fake-session",
        )
