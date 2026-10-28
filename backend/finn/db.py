import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from .config import DATA_DIR, DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS companies (
    symbol       TEXT PRIMARY KEY,
    name         TEXT,
    isin         TEXT,
    bse_code     TEXT,
    sector       TEXT,
    in_portfolio INTEGER NOT NULL DEFAULT 0,
    profile      TEXT,            -- JSON: about, top ratios
    updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS prices (
    symbol TEXT NOT NULL,
    date   TEXT NOT NULL,         -- YYYY-MM-DD
    open   REAL, high REAL, low REAL, close REAL,
    volume INTEGER,
    PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS announcements (
    id           TEXT PRIMARY KEY, -- "NSE:<seq_id>" or "BSE:<newsid>"
    symbol       TEXT NOT NULL,
    exchange     TEXT NOT NULL,
    ts           TEXT NOT NULL,    -- ISO local time (IST) of dissemination
    subject      TEXT,             -- exchange's own category, e.g. "Outcome of Board Meeting"
    text         TEXT,             -- exchange's one-line description
    url          TEXT,             -- attachment PDF
    file_size    TEXT,
    category     TEXT,             -- FINN category (filled by the push pipeline)
    importance   REAL,
    summary      TEXT,
    enrichment   TEXT,             -- JSON: results numbers, person bio, ...
    processed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_ann_symbol_ts ON announcements(symbol, ts);
CREATE INDEX IF NOT EXISTS ix_ann_ts ON announcements(ts);

CREATE TABLE IF NOT EXISTS fundamentals (
    symbol     TEXT NOT NULL,
    section    TEXT NOT NULL,     -- quarters | profit-loss | balance-sheet | cash-flow | ratios | shareholding
    basis      TEXT NOT NULL,     -- consolidated | standalone
    data       TEXT NOT NULL,     -- JSON: {"periods": [...], "rows": {label: [values]}}
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (symbol, section)
);

CREATE TABLE IF NOT EXISTS documents (
    url        TEXT PRIMARY KEY,
    symbol     TEXT NOT NULL,
    kind       TEXT NOT NULL,     -- annual_report | transcript | ppt | recording
    period     TEXT NOT NULL,     -- "2026" for ARs, "Oct 2026" for concalls
    sha256     TEXT,              -- filled once downloaded
    text_path  TEXT,
    fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_docs_symbol ON documents(symbol, kind);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL           -- JSON
);

CREATE TABLE IF NOT EXISTS alerts (
    id         TEXT PRIMARY KEY,  -- deterministic, so re-running never duplicates
    kind       TEXT NOT NULL,     -- volume | price | filing
    symbol     TEXT NOT NULL,
    ts         TEXT NOT NULL,     -- when the triggering event happened (IST)
    title      TEXT NOT NULL,
    detail     TEXT,              -- JSON
    score      REAL,
    created_at TEXT NOT NULL,
    seen       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_alerts_ts ON alerts(ts);

CREATE TABLE IF NOT EXISTS llm_cache (
    key        TEXT PRIMARY KEY,  -- sha256 of (model, prompt)
    model      TEXT NOT NULL,
    purpose    TEXT NOT NULL,
    response   TEXT NOT NULL,
    in_tokens  INTEGER,
    out_tokens INTEGER,
    cost_usd   REAL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research (
    symbol     TEXT NOT NULL,
    section    TEXT NOT NULL,     -- guidance | narrative | bull_bear | business
    data       TEXT NOT NULL,     -- JSON
    inputs_sha TEXT NOT NULL,     -- hash of source docs; recompute only when they change
    created_at TEXT NOT NULL,
    PRIMARY KEY (symbol, section)
);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def now_ist() -> datetime:
    """Naive IST wall-clock time; exchange timestamps are stored the same way."""
    return datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=5, minutes=30)


def get_setting(conn: sqlite3.Connection, key: str, default):
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(conn: sqlite3.Connection, key: str, value) -> None:
    upsert(conn, "settings", {"key": key, "value": json.dumps(value)}, key=("key",))


def upsert(conn: sqlite3.Connection, table: str, row: dict, key: tuple[str, ...]) -> None:
    """Insert or update by primary key, leaving columns not in `row` untouched."""
    cols = list(row)
    values = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in row.values()]
    updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c not in key)
    conn.execute(
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))}) "
        f"ON CONFLICT ({', '.join(key)}) DO " + (f"UPDATE SET {updates}" if updates else "NOTHING"),
        values,
    )
