# Subscription-Backed LLM Proxy

A working idea + working code for **using a paid Claude Code subscription as the
LLM backend for your own applications** — without buying a separate Anthropic
API key. Bring-your-own-subscription, single-user, runs on `127.0.0.1`.

This repo has two halves:

| Path | What |
|---|---|
| [`docs/index.html`](docs/index.html) | Interactive design document — problem, architecture, backend comparison, risk matrix, decision flowchart, walkthrough. Open it in a browser (`./run.sh docs` prints the URL). |
| [`poc/`](poc/) | Runnable proof-of-concept: a local FastAPI proxy exposing an OpenAI-compatible `/v1/chat/completions`, backed by `claude -p` as a subprocess. Includes a SQLite job queue + worker for batch mode. |

## TL;DR

```bash
./run.sh setup      # one-time: create venv, install deps
./run.sh test       # end-to-end smoke (uses POC_FAKE_BACKEND=1 — no real quota)
./run.sh server     # start the proxy on 127.0.0.1:8765
./run.sh demo "Summarize the Treaty of Westphalia in one sentence."
```

To exercise the real Claude Code CLI instead of the fake backend:

```bash
POC_FAKE_BACKEND=0 ./run.sh test
```

## How it works

```
your app ──HTTP──▶ poc/server.py ──asyncio.subprocess──▶ claude -p --output-format json
                       │
                       └─ SQLite batch queue ──▶ poc/queue/worker.py (one job at a time)
```

The proxy speaks the OpenAI request/response shape, so any client library that
points at a custom `base_url` (the official `openai` SDK, LangChain, etc.) can
use this transparently.

## ToS posture

- **Claude Code via subprocess** — `claude -p` is an officially supported
  non-interactive mode; this PoC uses it as documented. Usage stays tied to
  the single logged-in user on your machine, within the 5-hour rolling rate
  limit of your subscription.
- **Not for resale or multi-tenant exposure** — the server binds to
  `127.0.0.1` on purpose. Don't put this behind a public URL and call it a
  SaaS; that violates the personal-subscription terms.
- **Gemini Web UI** ships as a *stub* adapter only. Real implementation
  requires browser automation or reverse-engineered cookie clients, both of
  which are clearly grey-area; see `docs/index.html#risk`.

## Repo map

```
docs/index.html              interactive design doc
poc/
  server.py                  FastAPI proxy
  config.py                  env-var config
  adapters/
    base.py                  BaseAdapter + ChatRequest/Response models
    claude_code.py           subprocess wrapper around `claude -p` (critical file)
    gemini_web.py            stub
  queue/
    store.py                 SQLite (WAL) job store
    worker.py                drains the queue, handles 429 backoff
  demo/
    client.py                sync demo
    batch_submit.py          batch demo
  tests/
    test_adapter_mapping.py  pure unit tests (no subprocess)
    test_smoke.sh            end-to-end smoke
run.sh                       setup | server | worker | demo | batch | test | docs
```

See [`poc/README.md`](poc/README.md) for the full env-var matrix and cURL
recipes.
