from __future__ import annotations

import argparse
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from .. import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    total INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    status TEXT NOT NULL,                  -- queued|in_progress|completed|failed
    model TEXT NOT NULL,
    request_json TEXT NOT NULL,
    response_json TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    not_before INTEGER NOT NULL DEFAULT 0, -- earliest epoch we may retry
    FOREIGN KEY(batch_id) REFERENCES batches(id)
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, not_before);
"""


@contextmanager
def connect(path: Path | None = None):
    p = Path(path or config.DB_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), isolation_level=None, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db(path: Path | None = None) -> None:
    with connect(path) as c:
        c.executescript(SCHEMA)


def enqueue_batch(requests: list[dict]) -> tuple[str, list[str]]:
    bid = f"batch_{uuid.uuid4().hex[:16]}"
    now = int(time.time())
    job_ids: list[str] = []
    with connect() as c:
        c.execute(
            "INSERT INTO batches(id, created_at, total) VALUES (?,?,?)",
            (bid, now, len(requests)),
        )
        for r in requests:
            jid = f"job_{uuid.uuid4().hex[:16]}"
            job_ids.append(jid)
            c.execute(
                "INSERT INTO jobs(id, batch_id, status, model, request_json, "
                "created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                (jid, bid, "queued", r.get("model", ""), json.dumps(r), now, now),
            )
    return bid, job_ids


def claim_next() -> dict | None:
    now = int(time.time())
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute(
            "SELECT * FROM jobs WHERE status='queued' AND not_before<=? "
            "ORDER BY created_at LIMIT 1",
            (now,),
        ).fetchone()
        if not row:
            c.execute("COMMIT")
            return None
        c.execute(
            "UPDATE jobs SET status='in_progress', updated_at=?, attempts=attempts+1 "
            "WHERE id=?",
            (now, row["id"]),
        )
        c.execute("COMMIT")
        return dict(row)


def complete(job_id: str, response: dict) -> None:
    now = int(time.time())
    with connect() as c:
        c.execute(
            "UPDATE jobs SET status='completed', response_json=?, updated_at=? WHERE id=?",
            (json.dumps(response), now, job_id),
        )


def fail(job_id: str, error: str) -> None:
    now = int(time.time())
    with connect() as c:
        c.execute(
            "UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?",
            (error, now, job_id),
        )


def requeue(job_id: str, retry_after_s: int) -> None:
    now = int(time.time())
    with connect() as c:
        c.execute(
            "UPDATE jobs SET status='queued', not_before=?, updated_at=? WHERE id=?",
            (now + retry_after_s, now, job_id),
        )


def get_batch(batch_id: str) -> dict | None:
    with connect() as c:
        b = c.execute(
            "SELECT * FROM batches WHERE id=?", (batch_id,)
        ).fetchone()
        if not b:
            return None
        jobs = [
            dict(r)
            for r in c.execute(
                "SELECT * FROM jobs WHERE batch_id=? ORDER BY created_at", (batch_id,)
            ).fetchall()
        ]
        counts = {"queued": 0, "in_progress": 0, "completed": 0, "failed": 0}
        for j in jobs:
            counts[j["status"]] = counts.get(j["status"], 0) + 1
        terminal = counts["completed"] + counts["failed"]
        status = (
            "completed"
            if terminal == len(jobs) and counts["failed"] == 0
            else "failed"
            if terminal == len(jobs)
            else "in_progress"
            if counts["in_progress"] or counts["completed"] or counts["failed"]
            else "queued"
        )
        return {
            "id": b["id"],
            "created_at": b["created_at"],
            "total": b["total"],
            "status": status,
            "counts": counts,
            "jobs": jobs,
        }


def _cli() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--init", action="store_true")
    args = p.parse_args()
    if args.init:
        init_db()
        print(f"initialized {config.DB_PATH}")


if __name__ == "__main__":
    _cli()
