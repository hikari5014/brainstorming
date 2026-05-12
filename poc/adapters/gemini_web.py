from __future__ import annotations

from typing import AsyncIterator

from .base import BaseAdapter, ChatChunk, ChatRequest, ChatResponse, SessionRef

# NOTE: stub adapter.
# Implementing a real Gemini Web backend requires either:
#   (a) Playwright-driven browser automation against gemini.google.com (fragile,
#       breaks on layout changes, must handle CAPTCHA and re-auth), or
#   (b) Reverse-engineered cookie-based clients (e.g. the `gemini-webapi` PyPI
#       package). Both are grey-area w.r.t. Google's ToS.
#
# v1 of this PoC returns 501 to keep the proxy honest about which backend
# actually fulfilled the call.


class GeminiWebAdapter(BaseAdapter):
    name = "gemini-web"

    async def complete(
        self, req: ChatRequest, session: SessionRef | None = None
    ) -> ChatResponse:
        raise NotImplementedError(
            "gemini-web adapter is a stub; see docs/index.html#out-of-scope"
        )

    async def stream(
        self, req: ChatRequest, session: SessionRef | None = None
    ) -> AsyncIterator[ChatChunk]:
        raise NotImplementedError("gemini-web stub")
        yield  # pragma: no cover

    async def start_session(self, system: str | None = None) -> SessionRef:
        raise NotImplementedError("gemini-web stub")

    async def resume_session(self, ref: SessionRef) -> None:
        raise NotImplementedError("gemini-web stub")
