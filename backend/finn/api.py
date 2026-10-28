"""HTTP API for the FINN app. Run: uvicorn finn.api:app --port 8000 (from backend/)."""
import json
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import llm
from .config import PORTFOLIO, ROOT
from .db import now_ist, session, set_setting
from .market import day_stats, last_complete_date, sparkline
from .push import alerts, pipeline
from .pull import ask, research

app = FastAPI(title="FINN")
SYMBOL = re.compile(r"^[A-Z0-9&-]{1,20}$")


def _symbol(s: str) -> str:
    s = s.upper().strip()
    if not SYMBOL.match(s):
        raise HTTPException(400, "Not an NSE symbol")
    return s


@app.get("/api/digest")
def get_digest(hours: int = 24):
    hours = max(1, min(hours, 24 * 90))
    with session() as conn:
        d = pipeline.digest(conn, hours=hours)
        latest = conn.execute("SELECT MAX(ts) FROM announcements").fetchone()[0]
        d["freshness"] = {"filings_until": latest, "prices_until": last_complete_date(), "now": now_ist().isoformat(timespec="minutes")}
        p = pipeline.prefs(conn)
        movers = []
        for sym in PORTFOLIO:
            st = day_stats(conn, sym, lookback=p["volume_lookback"])
            if st and (abs(st["move_pct"]) >= p["price_move_pct"] / 2 or (st["vol_x"] or 0) >= p["volume_multiple"]):
                movers.append({"symbol": sym, **st})
        d["movers"] = sorted(movers, key=lambda m: -abs(m["move_pct"]))
        d["alerts_unseen"] = conn.execute("SELECT COUNT(*) FROM alerts WHERE seen=0").fetchone()[0]
    return d


@app.get("/api/portfolio")
def get_portfolio():
    with session() as conn:
        names = {r["symbol"]: (r["name"], r["sector"]) for r in conn.execute("SELECT symbol, name, sector FROM companies")}
        out = []
        for sym in PORTFOLIO:
            st = day_stats(conn, sym) or {}
            out.append({"symbol": sym, "name": names.get(sym, (sym,))[0],
                        "sector": (names.get(sym, (None, None))[1] or "").split(" > ")[-1],
                        "close": st.get("close"), "move_pct": st.get("move_pct"), "vol_x": st.get("vol_x"),
                        "spark": sparkline(conn, sym, 60)})
    return out


@app.get("/api/alerts")
def get_alerts(days: int = 7):
    with session() as conn:
        return alerts.recent(conn, days)


@app.post("/api/alerts/seen")
def mark_seen():
    with session() as conn:
        conn.execute("UPDATE alerts SET seen=1")
    return {"ok": True}


class Prefs(BaseModel):
    watch_categories: list[str]
    volume_multiple: float
    volume_lookback: int
    price_move_pct: float
    min_alert_score: int


@app.get("/api/prefs")
def get_prefs():
    with session() as conn:
        return pipeline.prefs(conn) | {"categories": pipeline.CATEGORY_LABEL}


@app.put("/api/prefs")
def put_prefs(p: Prefs):
    if not (1.1 <= p.volume_multiple <= 20 and 0.5 <= p.price_move_pct <= 30 and 5 <= p.volume_lookback <= 120):
        raise HTTPException(400, "Threshold out of range")
    bad = set(p.watch_categories) - set(pipeline.CATEGORY_LABEL)
    if bad:
        raise HTTPException(400, f"Unknown categories: {sorted(bad)}")
    with session() as conn:
        set_setting(conn, "prefs", p.model_dump())
        pipeline.process(conn)          # rescoring is cheap and deterministic
        from .push.enrich import apply_llm_scores
        apply_llm_scores(conn)
        fired = alerts.evaluate(conn)   # new thresholds may trip new alerts
    return {"ok": True, "new_alerts": len(fired)}


@app.get("/api/filing/{fid:path}")
def get_filing(fid: str):
    with session() as conn:
        r = conn.execute("SELECT a.*, c.name FROM announcements a LEFT JOIN companies c USING (symbol) WHERE id=?", (fid,)).fetchone()
        if not r:
            raise HTTPException(404)
        return dict(r) | {"enrichment": json.loads(r["enrichment"] or "{}")}


@app.get("/api/search")
def search(q: str):
    q = q.strip().upper()
    with session() as conn:
        rows = conn.execute("SELECT symbol, name, in_portfolio FROM companies WHERE symbol LIKE ? OR UPPER(name) LIKE ? "
                            "ORDER BY in_portfolio DESC, symbol LIMIT 8", (f"{q}%", f"%{q}%")).fetchall()
    hits = [dict(r) for r in rows]
    if SYMBOL.match(q) and not any(h["symbol"] == q for h in hits):
        hits.append({"symbol": q, "name": None, "in_portfolio": 0, "new": True})
    return hits


@app.get("/api/company/{symbol}")
def get_company(symbol: str):
    symbol = _symbol(symbol)
    try:
        research.ensure_data(symbol)   # scrapes on first view: any NSE ticker works
    except LookupError as e:
        raise HTTPException(404, str(e))
    return research.view(symbol)


@app.post("/api/research/{symbol}")
def start_research(symbol: str, force: bool = False):
    return research.start(_symbol(symbol), force)


@app.get("/api/research/{symbol}/status")
def research_status(symbol: str):
    symbol = _symbol(symbol)
    return research.STATUS.get(symbol, {"state": "idle"})


class Question(BaseModel):
    question: str


@app.post("/api/ask/{symbol}")
def ask_company(symbol: str, q: Question):
    symbol = _symbol(symbol)
    if not llm.available():
        raise HTTPException(503, "Set GEMINI_API_KEY (free) on the server to ask questions.")
    if not 3 <= len(q.question) <= 500:
        raise HTTPException(400, "Question length")
    with session() as conn:
        try:
            return ask.answer(conn, symbol, q.question)
        except llm.QuotaExhausted:
            raise HTTPException(429, "Today's free model quota is used up; try again tomorrow.")
        except llm.LLMError as e:
            raise HTTPException(502, f"The model couldn't answer: {e}")


@app.get("/api/meta")
def meta():
    with session() as conn:
        p = llm.provider()
        return {"llm": llm.available(), "provider": p, "models": llm.ROUTES.get(p) if p else None,
                "usage": llm.spend(conn), "portfolio": PORTFOLIO}


# ---- the built PWA ---------------------------------------------------------------------------
DIST = Path(ROOT) / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        if path and f.is_file() and DIST in f.resolve().parents:
            return FileResponse(f, headers={"Cache-Control": "no-cache"} if f.suffix in (".js", ".webmanifest") else None)
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})
