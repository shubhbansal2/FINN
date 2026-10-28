"""Promised vs delivered.

1. Extract (cheap model, once per transcript, cached): every explicit piece of forward guidance
   management gave, with a verbatim quote. Quotes are checked against the transcript text; an
   unverifiable quote is dropped, not shown.
2. Track (deterministic): the same target guided on successive calls -> raised / cut / held.
3. Score (deterministic): whole-company guidance on revenue growth, EBITDA / EBIT margin and PAT
   growth is compared with the reported numbers for that period -> delivered / missed / on track /
   behind / pending. Anything not like-for-like (constant currency, one segment) or not in the
   statements (capex, order inflow) is listed with the reason, unscored.
"""
import re
import sqlite3
from datetime import datetime

from .. import docs, llm
from ..financials import headline_rows, is_lender, pct_change, table

METRICS = ["revenue_growth", "ebitda_margin", "ebit_margin", "pat_growth", "other_margin", "capex", "order_inflow",
           "volume_growth", "loan_growth", "deposit_growth", "credit_cost", "working_capital", "other"]
SCORABLE = {"revenue_growth", "ebitda_margin", "ebit_margin", "pat_growth"}

SYSTEM = (
    "You extract management guidance from Indian listed-company earnings-call transcripts (or, when "
    "no transcript exists, investor presentations) for an investor who will hold management to it. "
    "Rules: only statements by company management, never analysts; only forward-looking targets "
    "(numbers or explicit direction) on headline metrics; each item needs a verbatim quote copied "
    "exactly from the document (one or two sentences); map the period to Indian fiscal years "
    "(FY27 = April 2026 to March 2027) when the speaker makes it clear; skip vague aspiration with no "
    "metric. Be precise about what a target is measured on: 'operating margin' at IT-services and "
    "similar companies means EBIT margin (after depreciation), not EBITDA; growth guided 'in constant "
    "currency' or in USD is basis=constant_currency; a target for one segment, division or portfolio "
    "(not the whole company) is basis=segment. Also note the 3-5 themes analysts pressed on."
)

SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["guidance", "themes", "tone"],
    "properties": {
        "guidance": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["metric", "basis", "label", "low", "high", "unit", "period", "direction", "quote", "speaker"],
            "properties": {
                "metric": {"type": "string", "enum": METRICS},
                "basis": {"type": "string", "enum": ["company_reported", "constant_currency", "segment", "other"],
                          "description": "company_reported = whole-company figures in reported rupees."},
                "label": {"type": "string", "description": "Short, e.g. 'FY27 revenue growth'"},
                "low": {"type": ["number", "null"]}, "high": {"type": ["number", "null"]},
                "unit": {"type": "string", "enum": ["%", "₹ Cr", "bps", "x", "units", "other"]},
                "period": {"type": "string", "description": "e.g. 'FY27', 'Q3 FY27', 'H2 FY27', 'medium term'"},
                "direction": {"type": "string", "enum": ["target", "at_least", "at_most", "up", "down", "stable"]},
                "quote": {"type": "string"}, "speaker": {"type": "string"},
            }}},
        "themes": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["topic", "management_says", "quote"],
            "properties": {"topic": {"type": "string"}, "management_says": {"type": "string"}, "quote": {"type": "string"}}}},
        "tone": {"type": "string", "description": "One line: management's overall tone on this call."},
    },
}

MONTHS = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def call_date(period: str) -> datetime:
    mon, year = period.split()
    return datetime(int(year), MONTHS[mon[:3]], 1)


def call_quarter(period: str) -> str:
    """A call in 'Oct 2026' discusses the quarter ended Sep 2026 -> 'Q2 FY27'."""
    d = call_date(period)
    m, y = d.month, d.year
    qend = {1: (12, y - 1), 2: (12, y - 1), 3: (12, y - 1), 4: (3, y), 5: (3, y), 6: (3, y),
            7: (6, y), 8: (6, y), 9: (6, y), 10: (9, y), 11: (9, y), 12: (9, y)}[m]
    q = {6: 1, 9: 2, 12: 3, 3: 4}[qend[0]]
    fy = qend[1] + 1 if qend[0] >= 4 else qend[1]
    return f"Q{q} FY{fy % 100:02d}"


def transcripts(conn: sqlite3.Connection, symbol: str, n: int = 4) -> list[dict]:
    """The latest n quarters' management documents, one per quarter: the earliest call after the
    quarter closes (the results call; later ones are analyst days). Companies that publish no
    transcripts get their investor presentations instead."""
    def pick(kind):
        rows = conn.execute("SELECT url, period FROM documents WHERE symbol=? AND kind=?", (symbol, kind)).fetchall()
        rows = [r for r in rows if re.match(r"^[A-Z][a-z]{2} \d{4}$", r["period"] or "")]
        by_q: dict[str, sqlite3.Row] = {}
        for r in sorted(rows, key=lambda r: call_date(r["period"])):
            by_q.setdefault(call_quarter(r["period"]), r)
        chosen = sorted(by_q.items(), key=lambda kv: call_date(kv[1]["period"]), reverse=True)[:n]
        return [{"url": r["url"], "period": r["period"], "quarter": q, "kind": kind} for q, r in chosen]
    ts = pick("transcript")
    return ts if len(ts) >= 2 else pick("ppt")


def extract(conn: sqlite3.Connection, t: dict) -> dict:
    texts = docs.pages(t["url"])
    docs.mark_fetched(conn, t["url"])
    if not texts:
        return {"guidance": [], "themes": [], "tone": "", "error": "document unreadable"}
    what = "earnings call transcript" if t.get("kind", "transcript") == "transcript" else "investor presentation"
    out = llm.complete_json(conn, purpose="guidance_extract", tier="cheap", system=SYSTEM, schema=SCHEMA,
                            documents=[docs.numbered(texts)],
                            prompt=f"The {t['quarter']} {what} ({t['period']}). Extract as instructed.",
                            max_tokens=12000)
    for kind in ("guidance", "themes"):
        kept = []
        for item in out[kind]:
            page = docs.quote_found(item["quote"], texts)
            if page:  # drop anything we can't find verbatim in the source
                kept.append(item | {"page": page, "source": t["url"], "call": t["period"], "call_quarter": t["quarter"]})
        out[f"{kind}_dropped"] = len(out[kind]) - len(kept)
        out[kind] = kept
    return out


# ---- scoring against reported numbers -------------------------------------------------------

def _fy_quarters(fy: int) -> list[str]:
    y = 2000 + fy
    return [f"Jun {y - 1}", f"Sep {y - 1}", f"Dec {y - 1}", f"Mar {y}"]


def _period_quarters(period: str) -> list[str] | None:
    p = period.upper().replace(" ", "")
    if m := re.fullmatch(r"Q([1-4])FY(\d{2})", p):
        return [_fy_quarters(int(m.group(2)))[int(m.group(1)) - 1]]
    if m := re.fullmatch(r"H([12])FY(\d{2})", p):
        qs = _fy_quarters(int(m.group(2)))
        return qs[:2] if m.group(1) == "1" else qs[2:]
    if m := re.fullmatch(r"FY(\d{2})", p):
        return _fy_quarters(int(m.group(1)))
    return None


def _shift_year(q: str) -> str:
    mon, y = q.split()
    return f"{mon} {int(y) - 1}"


def actual(conn: sqlite3.Connection, symbol: str, metric: str, period: str) -> dict | None:
    """Reported value for a guided metric over a period; partial if the period isn't over yet."""
    q = table(conn, symbol, "quarters")
    wanted = _period_quarters(period)
    if not q or not wanted:
        return None
    rows = headline_rows(q["rows"])
    idx = {p: i for i, p in enumerate(q["periods"])}
    have = [p for p in wanted if p in idx]
    if not have:
        return {"status_hint": "pending", "covered": 0, "of": len(wanted)}

    def total(key, periods):
        vals = [rows[key][idx[p]] if p in idx and rows.get(key) else None for p in periods]
        return None if None in vals else sum(vals)

    value = None
    if metric in ("revenue_growth", "pat_growth"):
        key = "PAT" if metric == "pat_growth" else "Revenue"
        value = pct_change(total(key, have), total(key, [_shift_year(p) for p in have]))
    elif metric in ("ebitda_margin", "ebit_margin") and not is_lender(q["rows"]):
        e, r = total("EBITDA", have), total("Revenue", have)
        if metric == "ebit_margin":
            rows["Depreciation"] = q["rows"].get("Depreciation")
            d = total("Depreciation", have)
            e = e - d if e is not None and d is not None else None
        value = round(e / r * 100, 1) if e is not None and r else None
    if value is None:
        return None
    return {"value": value, "covered": len(have), "of": len(wanted), "quarters": have}


BASIS_WHY = {
    "constant_currency": "Guided in constant currency; reported rupee figures aren't comparable.",
    "segment": "Guided for one segment; reported figures are for the whole company.",
    "other": "Measured on a basis the reported statements don't show.",
}


def score(item: dict, act: dict | None) -> dict:
    # Only compare like with like: a constant-currency or segment target scored against
    # whole-company rupee figures would be confidently wrong.
    if item.get("basis", "company_reported") != "company_reported":
        return {"status": "unscored", "why": BASIS_WHY.get(item["basis"], BASIS_WHY["other"])}
    if item["metric"] not in SCORABLE or item["unit"] != "%":
        return {"status": "unscored", "why": "Not checkable against reported statements."}
    if act is None:
        return {"status": "unscored", "why": "Period too vague to check." if not _period_quarters(item["period"])
                else "No comparable reported figure."}
    if act.get("status_hint") == "pending":
        return {"status": "pending", "why": "Period hasn't been reported yet."}
    lo, hi, v = item["low"], item["high"], act["value"]
    target = lo if lo is not None else hi
    if target is None:
        return {"status": "unscored", "why": "No numeric target."}
    partial = act["covered"] < act["of"]
    tol = 0.5
    if item["direction"] == "at_most":
        ok = v <= (hi if hi is not None else target) + tol
    else:
        ok = v >= target - tol
    status = ("on_track" if ok else "behind") if partial else ("delivered" if ok else "missed")
    so_far = f" ({act['covered']} of {act['of']} quarters reported)" if partial else ""
    return {"status": status, "actual": v, "why": f"Reported {v:.1f}%{so_far}."}


def scorecard(conn: sqlite3.Connection, symbol: str, extracted: list[dict]) -> dict:
    """extracted: per-transcript outputs, newest first."""
    # One row per target (metric + period). Targets guided on several calls carry their path,
    # so "cut twice" is visible at a glance.
    by_target: dict[tuple, list[dict]] = {}
    for ex in extracted:
        for g in ex.get("guidance", []):
            key = (g["metric"], g["period"].upper().replace(" ", "")) if g["metric"] != "other" else (g["label"], g["call"])
            by_target.setdefault(key, []).append(g)
    rows = []
    for gs in by_target.values():
        gs = sorted(gs, key=lambda g: call_date(g["call"]))
        last = gs[-1]
        row = last | score(last, actual(conn, symbol, last["metric"], last["period"]))
        calls = []
        for g in gs:  # one point per call
            if not calls or calls[-1]["call"] != g["call"]:
                calls.append({"call": g["call"], "low": g["low"], "high": g["high"], "quote": g["quote"], "page": g["page"],
                              "source": g["source"]})
        row["path"] = calls
        row["move"] = None
        if len(calls) >= 2:
            pick = lambda c: c["low"] if c["low"] is not None else c["high"]
            f, l = pick(calls[0]), pick(calls[-1])
            row["move"] = "held" if f is None or l is None or f == l else ("raised" if l > f else "cut")
        rows.append(row)
    order = {"missed": 0, "behind": 1, "delivered": 2, "on_track": 3, "pending": 4, "unscored": 5}
    rows.sort(key=lambda r: (order[r["status"]], -call_date(r["call"]).timestamp()))
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"items": rows, "counts": counts}
