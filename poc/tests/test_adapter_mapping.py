"""Pure unit tests for the OpenAI-shape → claude CLI argv mapping.

Run:  python -m poc.tests.test_adapter_mapping
"""

from __future__ import annotations

import sys

from ..adapters.base import ChatMessage, SessionRef
from ..adapters.claude_code import (
    build_argv,
    map_model,
    messages_to_prompt,
    parse_retry_after,
)


def _check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{('  -- ' + detail) if detail else ''}")
    if not cond:
        sys.exit(1)


def test_model_aliases() -> None:
    print("test_model_aliases")
    _check("opus alias", map_model("opus") == "opus")
    _check("gpt-4o → sonnet", map_model("gpt-4o") == "sonnet")
    _check("gpt-4o-mini → haiku", map_model("gpt-4o-mini") == "haiku")
    _check("claude-opus-4-7 → opus", map_model("claude-opus-4-7") == "opus")
    _check("future opus prefix", map_model("claude-opus-99") == "opus")


def test_messages_flatten() -> None:
    print("test_messages_flatten")
    msgs = [
        ChatMessage(role="system", content="be brief"),
        ChatMessage(role="user", content="hi"),
        ChatMessage(role="assistant", content="hello"),
        ChatMessage(role="user", content="bye"),
    ]
    system, prompt = messages_to_prompt(msgs)
    _check("system extracted", system == "be brief")
    _check("user/assistant retained", "[USER]\nhi" in prompt and "[ASSISTANT]\nhello" in prompt)
    _check("order preserved", prompt.index("[USER]\nhi") < prompt.index("[USER]\nbye"))


def test_argv_no_session() -> None:
    print("test_argv_no_session")
    argv = build_argv(model="haiku", system=None, session=None, new_session_id=None)
    _check("uses -p", "-p" in argv)
    _check("model haiku", "--model" in argv and argv[argv.index("--model") + 1] == "haiku")
    _check("json output", "--output-format" in argv and argv[argv.index("--output-format") + 1] == "json")
    _check("no-session-persistence", "--no-session-persistence" in argv)
    _check("disallowed tools set", "--disallowedTools" in argv)
    _check("no resume", "--resume" not in argv)


def test_argv_with_session() -> None:
    print("test_argv_with_session")
    ref = SessionRef(backend="claude-code", session_id="abc-123")
    argv = build_argv(model="sonnet", system="sys", session=ref, new_session_id=None)
    _check("resume present", "--resume" in argv and argv[argv.index("--resume") + 1] == "abc-123")
    _check("no --no-session-persistence", "--no-session-persistence" not in argv)
    _check("append-system-prompt", "--append-system-prompt" in argv)


def test_retry_after() -> None:
    print("test_retry_after")
    _check("seconds", parse_retry_after("rate limit; retry in 42 seconds") == 42)
    _check("minutes", parse_retry_after("retry in 5 minutes") == 300)
    _check("hours", parse_retry_after("try again in 2 hours") == 7200)
    _check("fallback", parse_retry_after("you hit your usage limit") > 0)


def main() -> None:
    test_model_aliases()
    test_messages_flatten()
    test_argv_no_session()
    test_argv_with_session()
    test_retry_after()
    print("ALL OK")


if __name__ == "__main__":
    main()
