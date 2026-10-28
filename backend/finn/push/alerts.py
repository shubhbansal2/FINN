"""Triggered alerts: thresholds the investor sets, checked after every ingestion run.

Alert ids are deterministic ("volume:PGEL:2026-10-28"), so re-running never fires twice.
"""
import json
import sqlite3
from datetime import datetime, timedelta

from ..config import PORTFOLIO
from ..db import now_ist, upsert
from ..market import day_stats
from .classify import tidy
from .pipeline import CATEGORY_LABEL, prefs


def evaluate(conn: sqlite3.Connection, symbols: list[str] | None = None, filing_days: int = 3) -> list[dict]:
    p = prefs(conn)
    names = {r["symbol"]: r["name"] for r in conn.execute("SELECT symbol, name FROM companies")}
    now = now_ist().isoformat(timespec="seconds")
    fired: list[dict] = []

    def fire(alert: dict) -> None:
        exists = conn.execute("SELECT 1 FROM alerts WHERE id=?", (alert["id"],)).fetchone()
        if not exists:
            upsert(conn, "alerts", {**alert, "created_at": now}, key=("id",))
            fired.append(alert)

    for sym in symbols or PORTFOLIO:
        st = day_stats(conn, sym, lookback=p["volume_lookback"])
        if not st:
            continue
        name = names.get(sym, sym)
        detail = json.dumps(st)
        d = datetime.fromisoformat(st["date"])
        on = f"{d.day} {d:%b}"
        if st["vol_x"] and st["vol_x"] >= p["volume_multiple"]:
            fire({"id": f"volume:{sym}:{st['date']}", "kind": "volume", "symbol": sym, "ts": f"{st['date']}T15:30:00",
                  "title": f"{name}: volume {st['vol_x']:.1f}× its {p['volume_lookback']}-day average on {on} "
                           f"({st['move_pct']:+.1f}%)",
                  "detail": detail, "score": min(100, 50 + st["vol_x"] * 5)})
        if abs(st["move_pct"]) >= p["price_move_pct"]:
            fire({"id": f"price:{sym}:{st['date']}", "kind": "price", "symbol": sym, "ts": f"{st['date']}T15:30:00",
                  "title": f"{name} {'up' if st['move_pct'] > 0 else 'down'} {abs(st['move_pct']):.1f}% on {on}",
                  "detail": detail, "score": min(100, 50 + abs(st["move_pct"]) * 4)})

    since = (now_ist() - timedelta(days=filing_days)).isoformat()
    marks = ",".join("?" * len(p["watch_categories"]))
    for r in conn.execute(
        f"SELECT * FROM announcements WHERE ts>=? AND category IN ({marks}) AND importance>=? ORDER BY ts",
        (since, *p["watch_categories"], p["min_alert_score"]),
    ):
        # one alert per company/category/day: results day produces 5+ filings
        key = f"filing:{r['symbol']}:{r['category']}:{r['ts'][:10]}"
        fire({"id": key, "kind": "filing", "symbol": r["symbol"], "ts": r["ts"],
              "title": f"{names.get(r['symbol'], r['symbol'])}: {CATEGORY_LABEL[r['category']].lower()} — "
                       f"{r['summary'] or tidy(r['text']) or r['subject']}",
              "detail": json.dumps({"announcement_id": r["id"], "url": r["url"]}), "score": r["importance"]})
    return fired


def recent(conn: sqlite3.Connection, days: int = 7) -> list[dict]:
    since = (now_ist() - timedelta(days=days)).isoformat()
    return [dict(r) | {"detail": json.loads(r["detail"] or "{}")}
            for r in conn.execute("SELECT * FROM alerts WHERE ts>=? ORDER BY ts DESC, score DESC", (since,))]
