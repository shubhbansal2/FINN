"""End-of-day price helpers. Only completed sessions count: during market hours Yahoo returns a
partial bar for today, and an alert on half a day's volume would be wrong."""
import sqlite3
from datetime import date, datetime

from .db import now_ist

CLOSE_BUFFER = (16, 0)  # NSE closes 15:30 IST; give the data feed 30 minutes


def last_complete_date(now: datetime | None = None) -> str:
    now = now or now_ist()
    if (now.hour, now.minute) >= CLOSE_BUFFER:
        return now.date().isoformat()
    return date.fromordinal(now.date().toordinal() - 1).isoformat()


def bars(conn: sqlite3.Connection, symbol: str, limit: int = 260) -> list[sqlite3.Row]:
    """Completed daily bars, oldest first."""
    rows = conn.execute(
        "SELECT date, open, high, low, close, volume FROM prices WHERE symbol=? AND date<=? "
        "ORDER BY date DESC LIMIT ?",
        (symbol, last_complete_date(), limit),
    ).fetchall()
    return rows[::-1]


def day_stats(conn: sqlite3.Connection, symbol: str, on: str | None = None, lookback: int = 20) -> dict | None:
    """Move vs previous close and volume vs trailing average, for `on` (default: last completed day)."""
    b = bars(conn, symbol)
    if len(b) < 2:
        return None
    idx = len(b) - 1
    if on:
        later = [i for i, r in enumerate(b) if r["date"] >= on]
        if not later:
            return None
        idx = later[0]
        if idx == 0:
            return None
    cur, prev = b[idx], b[idx - 1]
    window = [r["volume"] for r in b[max(0, idx - lookback):idx] if r["volume"]]
    avg = sum(window) / len(window) if window else None
    return {
        "date": cur["date"],
        "close": cur["close"],
        "move_pct": round((cur["close"] / prev["close"] - 1) * 100, 2),
        "volume": cur["volume"],
        "vol_x": round(cur["volume"] / avg, 2) if avg else None,
    }


def reaction_date(ts: str) -> str:
    """The session that first prices in a filing: same day if filed before close, else next day."""
    dt = datetime.fromisoformat(ts)
    d = dt.date()
    if (dt.hour, dt.minute) >= (15, 30):
        d = date.fromordinal(d.toordinal() + 1)
    return d.isoformat()


def sparkline(conn: sqlite3.Connection, symbol: str, days: int = 30) -> list[float]:
    return [round(r["close"], 2) for r in bars(conn, symbol, days)]
