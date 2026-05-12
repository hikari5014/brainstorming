from __future__ import annotations

import asyncio
import json
import signal
import sys

from .. import config
from ..adapters import get_adapter
from ..adapters.base import ChatRequest, RateLimitError
from . import store


_stop = asyncio.Event()


def _install_signal_handlers(loop: asyncio.AbstractEventLoop) -> None:
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _stop.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_: _stop.set())


async def _run_one(adapter_name: str) -> bool:
    job = store.claim_next()
    if job is None:
        return False
    try:
        adapter = get_adapter(adapter_name)
        req = ChatRequest.model_validate(json.loads(job["request_json"]))
        resp = await adapter.complete(req)
        store.complete(job["id"], resp.model_dump(mode="json"))
        print(f"[worker] {job['id']} done ({resp.usage.total_tokens} tokens)", flush=True)
    except RateLimitError as e:
        store.requeue(job["id"], e.retry_after)
        print(
            f"[worker] {job['id']} rate-limited; requeued for {e.retry_after}s",
            flush=True,
        )
        await asyncio.sleep(min(e.retry_after, 30))
    except Exception as e:
        store.fail(job["id"], f"{type(e).__name__}: {e}")
        print(f"[worker] {job['id']} failed: {e}", flush=True)
    return True


async def main(adapter_name: str = "claude-code") -> None:
    store.init_db()
    loop = asyncio.get_event_loop()
    _install_signal_handlers(loop)
    print(f"[worker] up; adapter={adapter_name} db={config.DB_PATH}", flush=True)
    idle = 0
    while not _stop.is_set():
        did_work = await _run_one(adapter_name)
        if did_work:
            idle = 0
        else:
            idle = min(idle + 1, 10)
            try:
                await asyncio.wait_for(_stop.wait(), timeout=0.5 + 0.1 * idle)
            except asyncio.TimeoutError:
                pass
    print("[worker] shutting down", flush=True)


if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "claude-code"
    asyncio.run(main(name))
