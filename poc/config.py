import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
DEFAULT_MODEL = os.environ.get("POC_DEFAULT_MODEL", "haiku")
DB_PATH = Path(os.environ.get("POC_DB_PATH", DATA_DIR / "jobs.db"))
SERVER_HOST = os.environ.get("POC_HOST", "127.0.0.1")
SERVER_PORT = int(os.environ.get("POC_PORT", "8765"))
SUBPROCESS_TIMEOUT_S = int(os.environ.get("POC_TIMEOUT_S", "120"))
RATE_PACE_SECS = int(os.environ.get("POC_RATE_PACE_SECS", "900"))
FAKE_RATE_LIMIT = os.environ.get("POC_FAKE_RATE_LIMIT") == "1"
FAKE_BACKEND = os.environ.get("POC_FAKE_BACKEND") == "1"

DISALLOWED_TOOLS = "Bash,Edit,Write,Glob,Grep,Read,WebFetch,WebSearch"
