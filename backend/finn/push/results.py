"""Quarterly results card: Revenue, EBITDA (NII for lenders), PBT and PAT, QoQ and YoY.

Numbers come from screener's parsed quarterly table, not from a model reading the PDF. When a
company has just filed and screener hasn't caught up, the card says so instead of guessing.
"""
import re
import sqlite3
from datetime import datetime

from ..financials import headline_rows, is_lender, pct_change, table

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def quarter_label(period: str) -> str:
    """'Sep 2026' -> 'Q2 FY27' (Indian fiscal year starts in April)."""
    mon, year = period.split()
    m, y = MONTHS.index(mon) + 1, int(year)
    q = {6: 1, 9: 2, 12: 3, 3: 4}.get(m)
    fy = y + 1 if m >= 4 else y
    return f"Q{q} FY{fy % 100:02d}" if q else period


def period_from_text(text: str | None) -> str | None:
    """'...for the quarter ended September 30, 2026' -> 'Sep 2026'."""
    m = re.search(r"(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+(20\d\d)",
                  text or "", re.I)
    return f"{m.group(1)[:3].title()} {m.group(2)}" if m else None


def results_card(conn: sqlite3.Connection, symbol: str, period: str | None = None) -> dict | None:
    q = table(conn, symbol, "quarters")
    if not q:
        return None
    periods = q["periods"]
    idx = periods.index(period) if period in periods else None
    if period and idx is None:
        return {"status": "pending", "period": period, "quarter": quarter_label(period),
                "note": "Filed with the exchange; standardised numbers not published yet."}
    idx = len(periods) - 1 if idx is None else idx
    rows = headline_rows(q["rows"])

    def at(i, vals):
        return vals[i] if vals and 0 <= i < len(vals) else None

    metrics = []
    for name, vals in rows.items():
        cur, prev, ya = at(idx, vals), at(idx - 1, vals), at(idx - 4, vals)
        metrics.append({"name": name, "value": cur, "qoq": pct_change(cur, prev), "yoy": pct_change(cur, ya)})

    rev = at(idx, rows["Revenue"])
    margins = {}
    if not is_lender(q["rows"]):
        for label, key in (("EBITDA margin", "EBITDA"), ("PAT margin", "PAT")):
            cur, ya = at(idx, rows[key]), at(idx - 4, rows[key])
            rev_ya = at(idx - 4, rows["Revenue"])
            if cur is not None and rev and ya is not None and rev_ya:
                m_now, m_ya = cur / rev * 100, ya / rev_ya * 100
                margins[label] = {"value": round(m_now, 1), "yoy_bps": round((m_now - m_ya) * 100)}
    else:
        npa = q["rows"].get("Gross NPA %")
        if npa and at(idx, npa) is not None:
            margins["Gross NPA"] = {"value": at(idx, npa), "yoy_bps": round((at(idx, npa) - (at(idx - 4, npa) or at(idx, npa))) * 100)}

    pat = next(m for m in metrics if m["name"] == "PAT")
    return {
        "status": "ready",
        "period": periods[idx],
        "quarter": quarter_label(periods[idx]),
        "basis": q["basis"],
        "lender": is_lender(q["rows"]),
        "unit": "₹ Cr",
        "metrics": metrics,
        "margins": margins,
        "headline": _headline(metrics),
        "pat_yoy": pat["yoy"],
        "as_of": datetime.now().isoformat(timespec="seconds"),
    }


# ---- straight from the results filing, for the hours before screener catches up ----------------

FILING_SYSTEM = (
    "You read Indian quarterly results filings (SEBI format). Extract line items exactly as printed "
    "for three columns: the quarter just ended, the preceding quarter, and the same quarter last year. "
    "Prefer the consolidated statement if present. Copy numbers as printed (no unit conversion); state "
    "the unit from the statement header. Use null for anything not printed."
)
_COL = {"type": "object", "additionalProperties": False,
        "required": ["revenue", "other_income", "finance_costs", "depreciation", "pbt", "pat", "interest_earned", "interest_expended"],
        "properties": {k: {"type": ["number", "null"]} for k in
                       ["revenue", "other_income", "finance_costs", "depreciation", "pbt", "pat", "interest_earned", "interest_expended"]}}
FILING_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["basis", "unit", "lender", "page", "current", "previous_quarter", "year_ago"],
    "properties": {
        "basis": {"type": "string", "enum": ["consolidated", "standalone"]},
        "unit": {"type": "string", "enum": ["crore", "lakh", "million", "thousand", "rupees"]},
        "lender": {"type": "boolean", "description": "Bank/NBFC format (interest earned / expended)."},
        "page": {"type": "integer", "description": "Page the statement is on."},
        "current": _COL, "previous_quarter": _COL, "year_ago": _COL,
    },
}
TO_CRORE = {"crore": 1, "lakh": 0.01, "million": 0.1, "thousand": 1e-4, "rupees": 1e-7}


def _printed_numbers(text: str) -> set[float]:
    """Every number printed on a page (absolute, 1 dp), for checking extracted figures."""
    out = set()
    for tok in re.findall(r"\d[\d,]*\.?\d*", text):
        try:
            out.add(round(float(tok.replace(",", "")), 1))
        except ValueError:
            pass
    return out


def extract_from_filing(conn: sqlite3.Connection, url: str) -> dict | None:
    """Cheap-model extraction of the results statement, with EBITDA computed (not extracted) and
    every figure checked against the numbers printed on the cited page."""
    from .. import docs, llm
    texts = docs.pages(url, max_pages=40)
    # Outcome filings open with a covering letter; send only the pages that look like the statement.
    statement = [i for i, t in enumerate(texts)
                 if re.search(r"profit before tax|revenue from operations|interest earned", t, re.I) and len(_printed_numbers(t)) > 40]
    if not statement:
        return None
    pages = statement[:3]
    body = "\n\n".join(f"[page {i + 1}]\n{texts[i]}" for i in pages)
    out = llm.complete_json(conn, purpose="results_extract", tier="cheap", system=FILING_SYSTEM, schema=FILING_SCHEMA,
                            prompt=f"Pages of the results filing that contain the financial statement:\n\n{body}")
    page_text = texts[out["page"] - 1] if 0 < out["page"] <= len(texts) else " ".join(texts)
    printed = _printed_numbers(page_text)
    raw = [v for col in ("current", "previous_quarter", "year_ago") for v in out[col].values() if v is not None]
    found = sum(1 for v in raw if round(abs(v), 1) in printed)
    k = TO_CRORE[out["unit"]]

    def col(c):
        c = {key: (v * k if v is not None else None) for key, v in out[c].items()}
        if out["lender"]:
            second = c["interest_earned"] - c["interest_expended"] if None not in (c["interest_earned"], c["interest_expended"]) else None
        else:
            parts = (c["pbt"], c["finance_costs"], c["depreciation"], c["other_income"])
            second = parts[0] + parts[1] + parts[2] - parts[3] if None not in parts else None
        return {"Revenue": c["interest_earned"] if out["lender"] and c["revenue"] is None else c["revenue"],
                ("NII" if out["lender"] else "EBITDA"): second, "PBT": c["pbt"], "PAT": c["pat"]}

    cur, prev, ya = col("current"), col("previous_quarter"), col("year_ago")
    metrics = [{"name": n, "value": round(cur[n], 1) if cur[n] is not None else None,
                "qoq": pct_change(cur[n], prev[n]), "yoy": pct_change(cur[n], ya[n])} for n in cur]
    return {"metrics": metrics, "basis": out["basis"], "lender": out["lender"], "page": out["page"], "source": url,
            "verified": f"{found} of {len(raw)} figures found on page {out['page']}", "verified_ratio": found / len(raw) if raw else 0}


def card_from_filing(extracted: dict, period: str) -> dict:
    trusted = extracted["verified_ratio"] >= 0.8
    note = (f"Read from the results filing by AI; {extracted['verified']}." if trusted else
            f"Unverified: only {extracted['verified']}; check the filing before relying on these.")
    return {"status": "filing", "period": period, "quarter": quarter_label(period), "basis": extracted["basis"],
            "lender": extracted["lender"], "unit": "₹ Cr", "metrics": extracted["metrics"], "margins": {},
            "headline": _headline(extracted["metrics"]) if trusted else None, "source": extracted["source"],
            "page": extracted["page"], "note": note + " Replaced by standardised figures once published."}


def _headline(metrics: list[dict]) -> str:
    """One deterministic sentence: what grew, what didn't."""
    by = {m["name"]: m for m in metrics}
    rev, pat = by["Revenue"], by["PAT"]
    if rev["yoy"] is None or pat["yoy"] is None:
        return "Results filed."
    def word(x):
        return "up" if x >= 0 else "down"
    lev = ""
    if rev["yoy"] is not None and pat["yoy"] is not None:
        gap = pat["yoy"] - rev["yoy"]
        if gap > 5:
            lev = ", profit outgrowing sales"
        elif gap < -5:
            lev = ", profit lagging sales"
    return f"Revenue {word(rev['yoy'])} {abs(rev['yoy']):.0f}% YoY, PAT {word(pat['yoy'])} {abs(pat['yoy']):.0f}%{lev}."
