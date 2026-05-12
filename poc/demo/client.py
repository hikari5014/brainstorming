"""Minimal sync demo: hit the local proxy with an OpenAI-shaped request.

Usage:  python -m poc.demo.client "your prompt"
"""

from __future__ import annotations

import json
import sys
import urllib.request

from .. import config

URL = f"http://{config.SERVER_HOST}:{config.SERVER_PORT}/v1/chat/completions"


def call(prompt: str, model: str = "haiku") -> dict:
    body = json.dumps(
        {"model": model, "messages": [{"role": "user", "content": prompt}]}
    ).encode()
    req = urllib.request.Request(
        URL, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


if __name__ == "__main__":
    p = " ".join(sys.argv[1:]) or "Say hello in one short sentence."
    out = call(p)
    print(out["choices"][0]["message"]["content"])
