# PoC — Subscription-Backed LLM Proxy

A FastAPI app that translates OpenAI-shape requests into `claude -p` subprocess
calls, plus a tiny SQLite-backed job queue for batch jobs.

## Quickstart

```bash
cd ..
./run.sh setup
./run.sh test          # uses POC_FAKE_BACKEND=1 so no real quota is consumed
./run.sh server &
./run.sh demo "Write a haiku about TCP."
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET  | `/healthz`              | liveness + registered adapter names |
| GET  | `/v1/models`            | lists `haiku`/`sonnet`/`opus` aliases |
| POST | `/v1/chat/completions`  | OpenAI-compatible; honors `X-Backend` (default `claude-code`) and `X-Conversation-Id` (enables `--resume`) |
| POST | `/v1/batches`           | body: `{"requests":[<chat-completions-body>, ...]}` |
| GET  | `/v1/batches/{id}`      | per-job statuses + counts |

## cURL

Sync:

```bash
curl -s http://127.0.0.1:8765/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"haiku","messages":[{"role":"user","content":"reply PONG"}]}' | jq
```

Multi-turn (re-use a session):

```bash
curl -s http://127.0.0.1:8765/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'X-Conversation-Id: my-convo-42' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"hello"}]}'
# subsequent calls with the same X-Conversation-Id pass --resume to the CLI
```

Batch:

```bash
BID=$(curl -s http://127.0.0.1:8765/v1/batches \
  -H 'content-type: application/json' \
  -d '{"requests":[
    {"model":"haiku","messages":[{"role":"user","content":"P1"}]},
    {"model":"haiku","messages":[{"role":"user","content":"P2"}]}
  ]}' | jq -r .id)

./run.sh worker &
curl -s http://127.0.0.1:8765/v1/batches/$BID | jq
```

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `CLAUDE_BIN` | `claude` | path to the Claude Code CLI |
| `POC_DEFAULT_MODEL` | `haiku` | fallback when the requested model name doesn't match an alias |
| `POC_HOST` | `127.0.0.1` | server bind host (**don't change unless you know what you're doing**) |
| `POC_PORT` | `8765` | server port |
| `POC_DB_PATH` | `poc/data/jobs.db` | SQLite file for the job queue |
| `POC_TIMEOUT_S` | `120` | per-call subprocess timeout |
| `POC_RATE_PACE_SECS` | `900` | fallback `Retry-After` when the CLI doesn't tell us how long to wait |
| `POC_FAKE_BACKEND` | `0` | when `1`, the adapter returns canned text without calling `claude` — used by the smoke test |
| `POC_FAKE_RATE_LIMIT` | `0` | when `1`, the adapter raises `RateLimitError` — used to exercise the 429 path |

## How sessions work

- Client passes `X-Conversation-Id: <any-string>` (or sets OpenAI's `user`
  field). On first call, the server allocates a UUID and runs
  `claude -p --session-id <uuid>`. The server caches `{convo → uuid}`
  in memory.
- On subsequent calls with the same `X-Conversation-Id`, the server uses
  `--resume <uuid>` and only forwards the latest `user` message (the CLI
  has the history).
- No conversation id ⇒ stateless `--no-session-persistence`.
- Cache is in-memory; restarting the server drops it.

## Rate limits

If `claude -p` returns a rate-limit-flavored error (matched by regex against
`rate limit`, `usage limit`, `5-hour`, `quota`), the proxy responds with **HTTP
429** + a `Retry-After` header. The worker requeues the job with
`not_before = now + retry_after`; the synchronous endpoint just bubbles the 429
to the caller.

## Tests

```bash
# pure unit (no subprocess, no server)
python -m poc.tests.test_adapter_mapping

# end-to-end (server + worker + batch + 429 path)
./run.sh test
```

## What this PoC deliberately does not do

- Streaming SSE (`--output-format stream-json` exists; we just haven't wrapped it)
- Real Gemini Web adapter (Playwright / cookie-based) — see `docs/index.html`
- Tool / function-calling translation
- Multi-user auth proxy
- Cost ledgers beyond passing `--max-budget-usd`
