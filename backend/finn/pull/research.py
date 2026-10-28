"""On-demand research for any NSE ticker.

Fast path (seconds, no LLM): scrape fundamentals + prices if missing or stale, compute the
deterministic cards. Slow path (background, LLM): transcripts -> guidance scorecard, annual report
-> business snapshot, then one strong-model judgement. Model output is stored in `research` keyed
by a hash of its source documents, so it's recomputed only when a new transcript or AR appears.
"""
import hashlib
import json
import logging
import threading
from datetime import datetime, timedelta

from .. import llm
from ..db import now_ist, session, upsert
from ..ingest.fundamentals import ingest_fundamentals
from ..ingest.prices import ingest_prices
from . import analysis, guidance
from .numbers import all_cards

log = logging.getLogger(__name__)
STATUS: dict[str, dict] = {}  # symbol -> {"state", "step", "error"}
_lock = threading.Lock()


def ensure_data(symbol: str) -> None:
    with session() as conn:
        co = conn.execute("SELECT updated_at FROM companies WHERE symbol=?", (symbol,)).fetchone()
        stale = not co or not co["updated_at"] or \
            datetime.fromisoformat(co["updated_at"]) < datetime.now() - timedelta(days=1)
        has_prices = conn.execute("SELECT 1 FROM prices WHERE symbol=? LIMIT 1", (symbol,)).fetchone()
        portfolio = {r["symbol"] for r in conn.execute("SELECT symbol FROM companies WHERE in_portfolio=1")}
    if stale:
        status = ingest_fundamentals([symbol], portfolio)
        if status.get(symbol, "").startswith("error"):
            raise LookupError(status[symbol])
    if not has_prices:
        ingest_prices([symbol])


def stored(conn, symbol: str) -> dict:
    return {r["section"]: json.loads(r["data"]) | {"_at": r["created_at"]}
            for r in conn.execute("SELECT section, data, created_at FROM research WHERE symbol=?", (symbol,))}


def view(symbol: str) -> dict:
    with session() as conn:
        cards = all_cards(conn, symbol)
        return {"symbol": symbol, "cards": cards, "analysis": stored(conn, symbol),
                "status": STATUS.get(symbol, {"state": "idle"}), "llm": llm.available()}


def _inputs_sha(ts: list[dict], ar: dict | None) -> str:
    return hashlib.sha256(json.dumps([t["url"] for t in ts] + [ar and ar["url"]]).encode()).hexdigest()[:16]


def analyse(symbol: str, force: bool = False) -> None:
    """Slow path; run in a thread. Updates STATUS as it goes."""
    def step(s):
        STATUS[symbol] = {"state": "running", "step": s}
        log.info("%s: %s", symbol, s)
    try:
        with session() as conn:
            name = conn.execute("SELECT name FROM companies WHERE symbol=?", (symbol,)).fetchone()["name"]
            ts = guidance.transcripts(conn, symbol)
            ar = analysis.latest_annual_report(conn, symbol)
            sha = _inputs_sha(ts, ar)
            have = {r["section"]: r["inputs_sha"] for r in conn.execute("SELECT section, inputs_sha FROM research WHERE symbol=?", (symbol,))}
            if not force and have.get("judgement") == sha:
                STATUS[symbol] = {"state": "done"}
                return
            now = now_ist().isoformat(timespec="seconds")

            def save(section, data):
                upsert(conn, "research", {"symbol": symbol, "section": section, "data": data, "inputs_sha": sha,
                                          "created_at": now}, key=("symbol", "section"))
                conn.commit()

            extracted = []
            for i, t in enumerate(ts, 1):
                what = "call transcript" if t["kind"] == "transcript" else "investor presentation"
                step(f"Reading {t['quarter']} {what} ({i}/{len(ts)})")
                extracted.append(guidance.extract(conn, t))
            card = guidance.scorecard(conn, symbol, extracted)
            card["calls"] = [{"period": t["period"], "quarter": t["quarter"], "url": t["url"], "kind": t["kind"],
                              "tone": ex.get("tone"), "dropped": ex.get("guidance_dropped", 0)} for t, ex in zip(ts, extracted)]
            card["themes"] = [th for ex in extracted for th in ex.get("themes", [])]
            save("guidance", card)

            step("Reading the annual report")
            biz = analysis.business(conn, symbol, name)
            if biz:
                save("business", biz)

            # A verdict on management needs management's own words; without them, don't fake one.
            if any(ex.get("guidance") or ex.get("themes") for ex in extracted):
                step("Weighing the story against the numbers")
                save("judgement", analysis.judgement(conn, name, extracted, card, all_cards(conn, symbol)))
            else:
                conn.execute("DELETE FROM research WHERE symbol=? AND section='judgement'", (symbol,))
                conn.commit()
        STATUS[symbol] = {"state": "done"}
    except llm.QuotaExhausted:
        STATUS[symbol] = {"state": "error", "error": "Today's free model quota is used up. Finished steps are saved; "
                                                     "try again tomorrow and it resumes where it stopped."}
    except Exception as ex:
        log.exception("research failed for %s", symbol)
        STATUS[symbol] = {"state": "error", "error": str(ex)}


def start(symbol: str, force: bool = False) -> dict:
    with _lock:
        if STATUS.get(symbol, {}).get("state") == "running":
            return STATUS[symbol]
        if not llm.available():
            STATUS[symbol] = {"state": "disabled", "error": "Set GEMINI_API_KEY (free) to enable transcript analysis."}
            return STATUS[symbol]
        STATUS[symbol] = {"state": "running", "step": "Starting"}
    threading.Thread(target=analyse, args=(symbol, force), daemon=True).start()
    return STATUS[symbol]
