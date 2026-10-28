"""Push pipeline: classify and score every filing, then build the windowed digest.

Score = category/rule weight
      + market reaction (the stock moved hard in the session that priced the filing in)
      + the investor's own watched categories.
Every point added is recorded as a human-readable reason, so the app can say *why* a card is
at the top.
"""
import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta

from ..config import PORTFOLIO
from ..db import get_setting, now_ist
from ..market import day_stats, reaction_date, sparkline
from .classify import classify, tidy
from .results import card_from_filing, period_from_text, results_card

DEFAULT_PREFS = {
    "watch_categories": ["results", "management_change", "M&A", "fund_raise", "litigation", "pledging"],
    "volume_multiple": 2.0,
    "volume_lookback": 20,
    "price_move_pct": 4.0,
    "min_alert_score": 70,
}

TIER_TOP, TIER_GLANCE = 70, 35

CATEGORY_LABEL = {
    "results": "Results", "management_change": "Management", "M&A": "M&A", "fund_raise": "Fund raise",
    "litigation": "Legal", "pledging": "Pledge", "insider_trading": "Insider trade", "credit_rating": "Rating",
    "capex": "Capex", "dividend": "Dividend", "bonus_split": "Bonus/split", "press_release": "News",
    "earnings_call": "Earnings call", "investor_meetings": "Investor meet", "agm_egm": "AGM/EGM",
    "postal_ballot": "Postal ballot", "unclassified": "Routine",
}


def prefs(conn: sqlite3.Connection) -> dict:
    return {**DEFAULT_PREFS, **get_setting(conn, "prefs", {})}


def score_filing(conn: sqlite3.Connection, row: sqlite3.Row, p: dict) -> dict:
    c = classify(row["subject"], row["text"])
    score, reasons = c.weight, [f"{CATEGORY_LABEL[c.category]} filing"]
    reaction = None
    if c.weight >= 20:  # don't let a market move promote a compliance certificate
        reaction = day_stats(conn, row["symbol"], on=reaction_date(row["ts"]), lookback=p["volume_lookback"])
        if reaction and reaction["date"] == reaction_date(row["ts"]):
            move = abs(reaction["move_pct"])
            if move >= 6:
                score += 15
                reasons.append(f"stock moved {reaction['move_pct']:+.1f}% that session")
            elif move >= 3:
                score += 8
                reasons.append(f"stock moved {reaction['move_pct']:+.1f}% that session")
            if (reaction["vol_x"] or 0) >= p["volume_multiple"]:
                score += 5
                reasons.append(f"volume {reaction['vol_x']:.1f}× average")
        else:
            reaction = None
    if c.category in p["watch_categories"] and c.weight >= 40:
        score += 5
        reasons.append("a category you watch")
    return {
        "category": c.category,
        "importance": min(score, 100),
        "rules": {"tag": c.tag, "needs_llm": c.needs_llm, "reasons": reasons, "reaction": reaction},
    }


def process(conn: sqlite3.Connection) -> int:
    """(Re)score every filing. Cheap and deterministic, so it simply runs over everything; LLM
    output lives in other keys of `enrichment` and is preserved."""
    p = prefs(conn)
    n = 0
    for row in conn.execute("SELECT * FROM announcements").fetchall():
        s = score_filing(conn, row, p)
        enrichment = json.loads(row["enrichment"] or "{}")
        enrichment["rules"] = s["rules"]
        conn.execute(
            "UPDATE announcements SET category=?, importance=?, enrichment=?, processed_at=? WHERE id=?",
            (s["category"], s["importance"], json.dumps(enrichment), now_ist().isoformat(timespec="seconds"), row["id"]),
        )
        n += 1
    return n


def _filing(row: sqlite3.Row) -> dict:
    e = json.loads(row["enrichment"] or "{}")
    return {
        "id": row["id"], "ts": row["ts"], "subject": row["subject"], "text": row["text"], "url": row["url"],
        "headline": tidy(row["text"]) or row["subject"],
        "category": row["category"], "score": row["importance"], "summary": row["summary"],
        "reasons": e.get("rules", {}).get("reasons", []), "tag": e.get("rules", {}).get("tag"),
        "llm": e.get("llm"), "results_pdf": e.get("results_pdf"),
    }


def digest(conn: sqlite3.Connection, hours: int = 24, end: datetime | None = None,
           symbols: list[str] | None = None) -> dict:
    """All filings in the window, grouped into events (one per company per category), ranked."""
    end = end or now_ist()
    start = end - timedelta(hours=hours)
    symbols = symbols or PORTFOLIO
    names = {r["symbol"]: r["name"] for r in conn.execute("SELECT symbol, name FROM companies")}
    rows = conn.execute(
        f"SELECT * FROM announcements WHERE ts>=? AND ts<=? AND symbol IN ({','.join('?' * len(symbols))}) "
        "ORDER BY importance DESC, ts DESC",
        (start.isoformat(), end.isoformat(), *symbols),
    ).fetchall()

    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["symbol"], r["category"])].append(_filing(r))

    events, routine = [], defaultdict(list)
    for (sym, cat), filings in groups.items():
        lead = filings[0]  # highest score, then newest
        ev = {
            "key": f"{sym}:{cat}:{lead['id']}",
            "symbol": sym, "name": names.get(sym, sym),
            "category": cat, "label": CATEGORY_LABEL.get(cat, cat),
            "score": lead["score"], "ts": max(f["ts"] for f in filings),
            "lead": lead, "related": filings[1:],
        }
        if cat == "results":
            card = results_card(conn, sym, period_from_text(lead["text"]))
            if card and card["status"] == "pending":
                # Just filed. Best: numbers read off the filing itself. Otherwise the last published
                # quarter, clearly marked, until the standardised table updates.
                pdf = next((f["results_pdf"] for f in filings if f.get("results_pdf")), None)
                if pdf:
                    card = card_from_filing(pdf, pdf["period"])
                else:
                    last = results_card(conn, sym)
                    card = (last | {"status": "previous", "pending_quarter": card["quarter"], "note": card["note"]}) if last else card
            ev["card"] = card
        if ev["score"] < TIER_GLANCE:
            routine[cat].append(ev)
        else:
            events.append(ev)

    events.sort(key=lambda e: (e["score"], e["ts"]), reverse=True)
    for ev in events:
        ev["spark"] = sparkline(conn, ev["symbol"], 30)
    return {
        "window": {"start": start.isoformat(timespec="minutes"), "end": end.isoformat(timespec="minutes"), "hours": hours},
        "top": [e for e in events if e["score"] >= TIER_TOP],
        "glance": [e for e in events if e["score"] < TIER_TOP],
        "routine": {
            "count": sum(len(f["related"]) + 1 for evs in routine.values() for f in evs),
            "groups": [{"category": c, "label": CATEGORY_LABEL.get(c, c),
                        "items": [{"symbol": e["symbol"], "text": e["lead"]["headline"], "url": e["lead"]["url"],
                                   "ts": e["ts"], "n": len(e["related"]) + 1} for e in evs]}
                       for c, evs in sorted(routine.items(), key=lambda kv: -sum(len(e["related"]) + 1 for e in kv[1]))],
        },
        "filings_total": len(rows),
    }
