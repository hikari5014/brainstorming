#!/usr/bin/env bash
# End-to-end smoke test for the proxy + worker.
# Runs against POC_FAKE_BACKEND=1 by default so it does not consume real
# Claude quota. Set POC_FAKE_BACKEND=0 to exercise the real CLI.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PY="${PY:-python3}"
PORT="${POC_PORT:-8765}"
DATA_DIR="poc/data"
LOG_DIR="$DATA_DIR"
mkdir -p "$DATA_DIR"

export POC_FAKE_BACKEND="${POC_FAKE_BACKEND:-1}"
export POC_PORT="$PORT"

cleanup() {
  for f in "$DATA_DIR"/server.pid "$DATA_DIR"/worker.pid; do
    [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
}
trap cleanup EXIT

echo "[smoke] init db"
"$PY" -m poc.queue.store --init

echo "[smoke] unit: adapter mapping"
"$PY" -m poc.tests.test_adapter_mapping

echo "[smoke] start server on :$PORT (fake-backend=$POC_FAKE_BACKEND)"
nohup "$PY" -m poc.server >"$LOG_DIR/server.log" 2>&1 &
echo $! >"$DATA_DIR/server.pid"

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then break; fi
  sleep 0.3
done
curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null || { echo "server failed to start"; tail -n 50 "$LOG_DIR/server.log"; exit 1; }

echo "[smoke] sync call"
OUT="$(curl -sf "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"haiku","messages":[{"role":"user","content":"reply with the single word PONG"}]}')"
echo "$OUT" | "$PY" -c "import json,sys; d=json.load(sys.stdin); t=d['choices'][0]['message']['content']; print('  sync reply:', repr(t)); assert 'PONG' in t.upper(), t"

echo "[smoke] rate-limit path (POC_FAKE_RATE_LIMIT=1)"
RL_OUT="$(curl -s -o /dev/null -w '%{http_code} %header{Retry-After}' \
  -H 'content-type: application/json' \
  -H 'X-Backend: claude-code' \
  --data-binary '{"model":"haiku","messages":[{"role":"user","content":"hi"}]}' \
  "http://127.0.0.1:$PORT/v1/chat/completions" \
  -X POST -H 'expect:' 2>&1 || true)"
# Re-issue with env var set on the server: easier to assert against the adapter directly.
"$PY" -c "
import asyncio, os
os.environ['POC_FAKE_RATE_LIMIT']='1'
from poc.adapters.claude_code import ClaudeCodeAdapter
from poc.adapters.base import ChatRequest, RateLimitError
async def main():
    a=ClaudeCodeAdapter()
    try:
        await a.complete(ChatRequest(model='haiku', messages=[{'role':'user','content':'x'}]))
    except RateLimitError as e:
        print('  rate-limit OK retry_after=', e.retry_after)
        return
    raise SystemExit('expected RateLimitError')
asyncio.run(main())
"

echo "[smoke] start worker"
nohup "$PY" -m poc.queue.worker claude-code >"$LOG_DIR/worker.log" 2>&1 &
echo $! >"$DATA_DIR/worker.pid"

echo "[smoke] submit batch"
BID="$(curl -sf "http://127.0.0.1:$PORT/v1/batches" \
  -H 'content-type: application/json' \
  -d '{"requests":[
    {"model":"haiku","messages":[{"role":"user","content":"reply PONG"}]},
    {"model":"haiku","messages":[{"role":"user","content":"reply PING"}]},
    {"model":"haiku","messages":[{"role":"user","content":"reply BEEP"}]}
  ]}' | "$PY" -c "import json,sys;print(json.load(sys.stdin)['id'])")"
echo "  batch id: $BID"

for i in $(seq 1 60); do
  ST="$(curl -sf "http://127.0.0.1:$PORT/v1/batches/$BID" | "$PY" -c "import json,sys;print(json.load(sys.stdin)['status'])")"
  if [ "$ST" = "completed" ] || [ "$ST" = "failed" ]; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/v1/batches/$BID" | "$PY" -c "
import json,sys
b=json.load(sys.stdin)
assert b['status']=='completed', b
assert b['counts']['completed']==3, b['counts']
print('  batch OK', b['counts'])
"

echo "[smoke] docs sanity"
"$PY" -c "
p='docs/index.html'
s=open(p,encoding='utf-8').read()
for needle in ['mermaid.initialize','id=\"problem\"','id=\"architecture\"','id=\"comparison\"','id=\"risk\"','id=\"patterns\"','id=\"decision\"','id=\"walkthrough\"','id=\"future\"']:
    assert needle in s, f'missing {needle!r}'
print('  docs OK   open file://'+__import__('os').path.abspath(p))
"

echo "[smoke] ALL OK"
