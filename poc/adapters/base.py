from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator, Literal, Optional

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    stream: bool = False
    user: Optional[str] = None
    max_tokens: Optional[int] = Field(default=None, alias="max_tokens")

    model_config = {"populate_by_name": True, "extra": "ignore"}


class ChatUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChatChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: str = "stop"


class ChatResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: list[ChatChoice]
    usage: ChatUsage = Field(default_factory=ChatUsage)
    system_fingerprint: Optional[str] = None
    # Non-OpenAI extras surfaced for the proxy:
    cost_usd: Optional[float] = None
    backend_session_id: Optional[str] = None


class ChatChunk(BaseModel):
    delta: str
    finish_reason: Optional[str] = None


@dataclass
class SessionRef:
    backend: str
    session_id: str


class RateLimitError(Exception):
    def __init__(self, message: str, retry_after: int = 900):
        super().__init__(message)
        self.retry_after = retry_after


class BaseAdapter(ABC):
    name: str

    @abstractmethod
    async def complete(
        self, req: ChatRequest, session: SessionRef | None = None
    ) -> ChatResponse: ...

    @abstractmethod
    async def stream(
        self, req: ChatRequest, session: SessionRef | None = None
    ) -> AsyncIterator[ChatChunk]: ...

    @abstractmethod
    async def start_session(self, system: str | None = None) -> SessionRef: ...

    @abstractmethod
    async def resume_session(self, ref: SessionRef) -> None: ...

    def supports(self, model: str) -> bool:
        return True
