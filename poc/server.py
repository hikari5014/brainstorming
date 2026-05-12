from __future__ import annotations

import time
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import config
from .adapters import REGISTRY, get_adapter
from .adapters.base import ChatRequest, RateLimitError, SessionRef
from .queue import store

app = FastAPI(title="Subscription-Backed LLM Proxy", version="0.1.0")

# In-memory: {conversation_id -> SessionRef}
SESSIONS: dict[str, SessionRef] = {}


@app.on_event("startup")
def _startup() -> None:
    store.init_db()


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "adapters": list(REGISTRY.keys())}


@app.get("/v1/models")
def list_models() -> dict:
    return {
        "object": "list",
        "data": [
            {"id": "haiku", "object": "model", "owned_by": "claude-code"},
            {"id": "sonnet", "object": "model", "owned_by": "claude-code"},
            {"id": "opus", "object": "model", "owned_by": "claude-code"},
        ],
    }


def _select_backend(req: ChatRequest, x_backend: str | None) -> str:
    if x_backend:
        return x_backend
    # All real models route to claude-code today; gemini-web is opt-in only.
    return "claude-code"


@app.post("/v1/chat/completions")
async def chat_completions(
    req: ChatRequest,
    request: Request,
    x_backend: str | None = Header(default=None, alias="X-Backend"),
    x_conversation_id: str | None = Header(default=None, alias="X-Conversation-Id"),
) -> JSONResponse:
    backend = _select_backend(req, x_backend)
    try:
        adapter = get_adapter(backend)
    except KeyError:
        raise HTTPException(404, f"no such backend: {backend}")

    session: SessionRef | None = None
    convo = x_conversation_id or req.user
    if convo and convo in SESSIONS:
        session = SESSIONS[convo]
    elif convo:
        session = await adapter.start_session(
            system=next((m.content for m in req.messages if m.role == "system"), None)
        )
        SESSIONS[convo] = session

    try:
        resp = await adapter.complete(req, session=session)
    except RateLimitError as e:
        return JSONResponse(
            status_code=429,
            headers={"Retry-After": str(e.retry_after)},
            content={
                "error": {
                    "type": "rate_limit_exceeded",
                    "message": str(e),
                    "retry_after": e.retry_after,
                }
            },
        )
    except NotImplementedError as e:
        raise HTTPException(501, str(e))
    except Exception as e:
        raise HTTPException(502, f"{type(e).__name__}: {e}")

    headers = {}
    if resp.cost_usd is not None:
        headers["x-claude-cost-usd"] = f"{resp.cost_usd:.6f}"
    if resp.backend_session_id:
        headers["x-claude-session-id"] = resp.backend_session_id
    return JSONResponse(content=resp.model_dump(mode="json"), headers=headers)


class BatchRequest(BaseModel):
    requests: list[ChatRequest]


@app.post("/v1/batches")
async def create_batch(body: BatchRequest) -> dict:
    if not body.requests:
        raise HTTPException(400, "requests must be non-empty")
    payload = [r.model_dump(mode="json") for r in body.requests]
    bid, job_ids = store.enqueue_batch(payload)
    return {
        "id": bid,
        "object": "batch",
        "created_at": int(time.time()),
        "status": "queued",
        "total": len(job_ids),
        "job_ids": job_ids,
    }


@app.get("/v1/batches/{batch_id}")
async def get_batch(batch_id: str) -> dict:
    b = store.get_batch(batch_id)
    if b is None:
        raise HTTPException(404, "batch not found")
    return b


def main() -> None:
    uvicorn.run(
        "poc.server:app",
        host=config.SERVER_HOST,
        port=config.SERVER_PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
