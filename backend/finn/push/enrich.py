"""LLM enrichment for the filings that earn it.

Who gets a model call (cheap tier, first few pages of the PDF only):
  - filings the rules couldn't place (`needs_llm`), and
  - non-routine categories where the one-line exchange text says nothing useful
    ("...informed the Exchange about change in Management").
Results get no call: their card is built from the parsed quarterly table.
Management changes are read further (up to 10 pages): SEBI requires an appointment filing to carry
the appointee's brief profile, so the incoming person's background comes from the company's own
disclosure rather than the web.
"""
import json
import logging
import re
import sqlite3
from datetime import datetime, timedelta

from .. import docs, llm
from ..db import now_ist
from .classify import BASE_WEIGHT
from .results import extract_from_filing, period_from_text, results_card

log = logging.getLogger(__name__)

ENRICH_CATEGORIES = {"management_change", "M&A", "fund_raise", "litigation", "credit_rating", "pledging",
                     "insider_trading", "capex", "press_release", "bonus_split"}

SYSTEM = (
    "You read Indian stock-exchange filings for a busy portfolio manager. Be literal and specific: "
    "names, amounts in ₹ crore, dates, counterparties. Never speculate beyond the filing. "
    "If the filing is boilerplate with no investor-relevant content, say so and mark it routine. "
    "For people joining or leaving, take their background only from the filing's own profile or "
    "annexure (career, prior roles, qualifications); null if the filing gives none."
)

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["category", "materiality", "summary", "people", "evidence"],
    "properties": {
        "category": {"type": "string", "enum": sorted(BASE_WEIGHT)},
        "materiality": {"type": "string", "enum": ["routine", "notable", "material"]},
        "summary": {"type": "string", "description": "One line, at most 25 words, what changed and why it matters."},
        "people": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "role", "change", "effective_date", "previous_role", "background"],
                "properties": {
                    "name": {"type": "string"},
                    "role": {"type": "string"},
                    "change": {"type": "string", "enum": ["appointed", "resigned", "retired", "re-appointed", "other"]},
                    "effective_date": {"type": ["string", "null"]},
                    "previous_role": {"type": ["string", "null"]},
                    "background": {"type": ["string", "null"],
                                   "description": "2-3 sentences from the filing's profile: career path, notable prior roles, qualifications."},
                },
            },
        },
        "evidence": {"type": "string", "description": "Verbatim sentence from the filing supporting the summary."},
    },
}

def _needs_call(row: sqlite3.Row, e: dict) -> bool:
    rules = e.get("rules", {})
    if "llm" in e:
        return False
    if rules.get("needs_llm"):
        return True
    return row["category"] in ENRICH_CATEGORIES and (row["importance"] or 0) >= 30


def results_from_filings(conn: sqlite3.Connection, since: str) -> int:
    """Results filed but not yet in the standardised table: read the numbers off the filing."""
    n = 0
    for row in conn.execute("SELECT * FROM announcements WHERE ts>=? AND category='results' AND url IS NOT NULL", (since,)).fetchall():
        e = json.loads(row["enrichment"] or "{}")
        period = period_from_text(row["text"])
        if "results_pdf" in e or e.get("rules", {}).get("tag") != "results" or not period:
            continue
        card = results_card(conn, row["symbol"], period)
        if not card or card["status"] != "pending":
            continue
        try:
            extracted = extract_from_filing(conn, row["url"])
        except llm.QuotaExhausted:
            break
        except Exception as ex:
            log.warning("results extract %s failed: %s", row["id"], ex)
            continue
        if extracted:
            e["results_pdf"] = extracted | {"period": period}
            conn.execute("UPDATE announcements SET enrichment=? WHERE id=?", (json.dumps(e), row["id"]))
            conn.commit()
            n += 1
    return n


def enrich(conn: sqlite3.Connection, days: int = 7, limit: int = 60) -> dict:
    if not llm.available():
        return {"skipped": "no LLM key"}
    since = (now_ist() - timedelta(days=days)).isoformat()
    try:
        from_filings = results_from_filings(conn, since)
    except llm.QuotaExhausted:
        return {"stopped": "daily free-tier quota used up"}
    rows = conn.execute(
        "SELECT a.*, c.name AS company FROM announcements a LEFT JOIN companies c USING (symbol) "
        "WHERE a.ts>=? ORDER BY a.importance DESC", (since,)).fetchall()
    done = profiles = 0
    stopped = None
    for row in rows:
        e = json.loads(row["enrichment"] or "{}")
        if done >= limit or not _needs_call(row, e) or not row["url"]:
            continue
        try:
            # Appointment profiles usually sit in an annexure after the covering letter.
            mgmt = row["category"] == "management_change"
            texts = docs.pages(row["url"], max_pages=10 if mgmt else 4)
            body = docs.numbered(texts)[:30000 if mgmt else 15000]
            if not body.strip():
                continue
            out = llm.complete_json(
                conn, purpose="filing_summary", tier="cheap", system=SYSTEM, schema=SCHEMA,
                prompt=f"Company: {row['company']} ({row['symbol']})\nExchange subject: {row['subject']}\n"
                       f"Exchange text: {row['text']}\n\nFiling:\n{body}",
            )
            profiles += sum(1 for p in out["people"] if p.get("background"))
        except llm.QuotaExhausted:
            # Nothing is lost: finished calls are cached, and this filing is retried next run.
            stopped = "daily free-tier quota used up"
            break
        except Exception as ex:  # one bad PDF shouldn't stop the run
            log.warning("enrich %s failed: %s", row["id"], ex)
            continue
        out["evidence_verified"] = docs.quote_found(out.get("evidence", ""), texts) is not None
        e["llm"] = out
        conn.execute("UPDATE announcements SET summary=?, enrichment=? WHERE id=?",
                     (out["summary"], json.dumps(e), row["id"]))
        conn.commit()
        done += 1
    try:
        profiles += backfill_profiles(conn, since)
    except llm.QuotaExhausted:
        stopped = stopped or "daily free-tier quota used up"
    return {"enriched": done, "profiles": profiles, "results_from_filings": from_filings,
            **({"stopped": stopped} if stopped else {})}


PROFILE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["background"],
    "properties": {"background": {"type": ["string", "null"],
                                  "description": "2-3 sentences: career path, notable prior roles, qualifications. Null if absent."}},
}


def backfill_profiles(conn: sqlite3.Connection, since: str, lookback_days: int = 90) -> int:
    """A handover notice ("X has assumed charge today") rarely repeats the appointee's profile; the
    original appointment filing, weeks earlier, has it. Find that filing and read the profile there."""
    found = 0
    for row in conn.execute("SELECT id, symbol, ts, enrichment FROM announcements WHERE ts>=? AND enrichment LIKE '%\"people\"%'",
                            (since,)).fetchall():
        e = json.loads(row["enrichment"])
        missing = [p for p in e["llm"]["people"] if p["change"] in ("appointed", "re-appointed") and not p.get("background")]
        if not missing:
            continue
        earliest = (datetime.fromisoformat(row["ts"]) - timedelta(days=lookback_days)).isoformat()
        earlier = conn.execute("SELECT url FROM announcements WHERE symbol=? AND id<>? AND category='management_change' "
                               "AND ts BETWEEN ? AND ? AND url LIKE '%.pdf' ORDER BY ts DESC",
                               (row["symbol"], row["id"], earliest, row["ts"])).fetchall()
        for p in missing:
            surname = p["name"].split()[-1]
            for f in earlier:
                texts = docs.pages(f["url"], max_pages=10)
                body = "\n".join(texts)
                if surname.lower() not in body.lower() or not re.search(r"profile|experience|qualification", body, re.I):
                    continue
                out = llm.complete_json(conn, purpose="profile_backfill", tier="cheap", system=SYSTEM, schema=PROFILE_SCHEMA,
                                        prompt=f"From this filing, give the professional background of {p['name']}.\n\n"
                                               f"{docs.numbered(texts)[:30000]}")
                if out["background"]:
                    p["background"], p["background_source"] = out["background"], f["url"]
                    found += 1
                    break
        conn.execute("UPDATE announcements SET enrichment=? WHERE id=?", (json.dumps(e), row["id"]))
        conn.commit()
    return found


def apply_llm_scores(conn: sqlite3.Connection) -> None:
    """Fold the model's materiality call back into the score (rules score stays the base)."""
    for row in conn.execute("SELECT id, importance, category, enrichment FROM announcements WHERE enrichment LIKE '%\"llm\"%'"):
        e = json.loads(row["enrichment"])
        out = e["llm"]
        score = row["importance"]
        cat = row["category"]
        if e.get("rules", {}).get("needs_llm"):
            cat = out["category"]
            score = max(score, BASE_WEIGHT[cat])
        score = {"material": score + 10, "routine": min(score, 30)}.get(out["materiality"], score)
        reasons = e.get("rules", {}).get("reasons", [])
        if out["materiality"] == "material" and "judged material from the filing" not in reasons:
            reasons.append("judged material from the filing")
        conn.execute("UPDATE announcements SET category=?, importance=?, enrichment=? WHERE id=?",
                     (cat, min(score, 100), json.dumps(e), row["id"]))
