#!/usr/bin/env bash
# Top-level helper for the PoC.
#
#   ./run.sh setup       create .venv and install requirements
#   ./run.sh server      start the FastAPI proxy in the foreground
#   ./run.sh worker      start the batch worker in the foreground
#   ./run.sh demo "..."  one-shot sync call against the running server
#   ./run.sh batch       submit a 3-prompt batch and poll until done
#   ./run.sh test        end-to-end smoke test (uses POC_FAKE_BACKEND=1 by default)
#   ./run.sh docs        print the file:// URL for docs/index.html

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VENV="$ROOT/.venv"
PY="${PY:-python3}"

ensure_venv() {
  if [ -x "$VENV/bin/python" ]; then
    PY="$VENV/bin/python"
  fi
}

cmd="${1:-help}"; shift || true

case "$cmd" in
  setup)
    "$PY" -m venv "$VENV"
    "$VENV/bin/pip" install -q --upgrade pip
    "$VENV/bin/pip" install -q -r poc/requirements.txt
    echo "venv ready at $VENV"
    ;;
  server)
    ensure_venv
    exec "$PY" -m poc.server
    ;;
  worker)
    ensure_venv
    exec "$PY" -m poc.queue.worker "${1:-claude-code}"
    ;;
  demo)
    ensure_venv
    exec "$PY" -m poc.demo.client "$@"
    ;;
  batch)
    ensure_venv
    exec "$PY" -m poc.demo.batch_submit "$@"
    ;;
  test)
    ensure_venv
    PY="$PY" exec bash poc/tests/test_smoke.sh
    ;;
  docs)
    echo "file://$ROOT/docs/index.html"
    ;;
  help|*)
    sed -n '2,12p' "$0"
    ;;
esac
