"""Batch demo: enqueue N prompts, poll the batch until terminal.

Usage:  python -m poc.demo.batch_submit "prompt 1" "prompt 2" ...
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request

from .. import config

BASE = f"http://{config.SERVER_HOST}:{config.SERVER_PORT}"


def submit(prompts: list[str], model: str = "haiku") -> str:
    body = json.dumps(
        {
            "requests": [
                {"model": model, "messages": [{"role": "user", "content": p}]}
                for p in prompts
            ]
        }
    ).encode()
    req = urllib.request.Request(
        f"{BASE}/v1/batches", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["id"]


def poll(batch_id: str, timeout_s: int = 120) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        with urllib.request.urlopen(f"{BASE}/v1/batches/{batch_id}", timeout=10) as r:
            b = json.loads(r.read())
        if b["status"] in ("completed", "failed"):
            return b
        time.sleep(1.0)
    raise TimeoutError(f"batch {batch_id} not done within {timeout_s}s")


if __name__ == "__main__":
    prompts = sys.argv[1:] or [
        "Reply with the word PONG and nothing else.",
        "Reply with the word PING and nothing else.",
        "Say BEEP in one word.",
    ]
    bid = submit(prompts)
    print(f"submitted batch {bid} with {len(prompts)} jobs")
    result = poll(bid)
    print(f"status: {result['status']}  counts: {result['counts']}")
    for j in result["jobs"]:
        if j["response_json"]:
            text = json.loads(j["response_json"])["choices"][0]["message"]["content"]
            print(f"  {j['id']}: {text[:80]}")
        else:
            print(f"  {j['id']}: ERROR {j['error']}")
