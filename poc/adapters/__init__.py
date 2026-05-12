from .base import BaseAdapter, ChatRequest, ChatResponse, RateLimitError, SessionRef
from .claude_code import ClaudeCodeAdapter
from .gemini_web import GeminiWebAdapter

REGISTRY: dict[str, BaseAdapter] = {
    "claude-code": ClaudeCodeAdapter(),
    "gemini-web": GeminiWebAdapter(),
}


def get_adapter(name: str) -> BaseAdapter:
    if name not in REGISTRY:
        raise KeyError(f"unknown adapter: {name}")
    return REGISTRY[name]


__all__ = [
    "BaseAdapter",
    "ChatRequest",
    "ChatResponse",
    "RateLimitError",
    "SessionRef",
    "ClaudeCodeAdapter",
    "GeminiWebAdapter",
    "REGISTRY",
    "get_adapter",
]
