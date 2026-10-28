"""Deterministic research cards: financial snapshot, trajectory, balance sheet, cash quality.

All numbers and every observation sentence are computed from the company's reported statements
(as standardised by screener.in). No model is involved, so nothing here can be hallucinated, and
it works instantly for any ticker.
"""
import json
import sqlite3

from ..financials import headline_rows, is_lender, pct_change, series, table
from ..market import bars
from ..push.results import results_card


def _cagr(vals: list, years: int) -> float | None:
    clean = [v for v in vals if v is not None]
    if len(vals) <= years or vals[-1] is None or vals[-1 - years] is None:
        return None
    start, end = vals[-1 - years], vals[-1]
    if start <= 0 or end <= 0:
        return None
    return round(((end / start) ** (1 / years) - 1) * 100, 1) if clean else None


def _obs(text: str, tone: str = "neutral") -> dict:
    return {"text": text, "tone": tone}


def _annual(pl: dict) -> tuple[list[str], dict]:
    """Annual columns only (drop TTM)."""
    keep = [i for i, p in enumerate(pl["periods"]) if p != "TTM"]
    return [pl["periods"][i] for i in keep], {k: [v[i] if i < len(v) else None for i in keep] for k, v in pl["rows"].items()}


def header(conn: sqlite3.Connection, symbol: str) -> dict | None:
    co = conn.execute("SELECT * FROM companies WHERE symbol=?", (symbol,)).fetchone()
    if not co:
        return None
    profile = json.loads(co["profile"] or "{}")
    b = bars(conn, symbol, 260)
    price = None
    if len(b) >= 2:
        closes = [r["close"] for r in b]
        price = {
            "close": round(closes[-1], 2), "date": b[-1]["date"],
            "change_pct": round((closes[-1] / closes[-2] - 1) * 100, 2),
            "high_52w": round(max(r["high"] for r in b), 2), "low_52w": round(min(r["low"] for r in b), 2),
            "return_1y": round((closes[-1] / closes[0] - 1) * 100, 1),
            "spark": [round(c, 2) for c in closes[-120:]],
        }
    return {"symbol": symbol, "name": co["name"], "sector": co["sector"], "in_portfolio": bool(co["in_portfolio"]),
            "about": profile.get("about"), "ratios": profile.get("ratios", {}), "website": profile.get("website"),
            "price": price}


def financial_snapshot(conn: sqlite3.Connection, symbol: str) -> dict | None:
    pl = table(conn, symbol, "profit-loss")
    if not pl:
        return None
    rows = headline_rows(pl["rows"])
    ttm = pl["periods"].index("TTM") if "TTM" in pl["periods"] else len(pl["periods"]) - 1
    metrics = {k: (v[ttm] if v and ttm < len(v) else None) for k, v in rows.items()}
    rev = metrics["Revenue"]
    second = "NII" if "NII" in rows else "EBITDA"
    out = {
        "basis": pl["basis"], "lender": is_lender(pl["rows"]), "period": "TTM",
        "metrics": [{"name": k, "value": v} for k, v in metrics.items()],
        "margins": [],
        "latest_quarter": results_card(conn, symbol),
    }
    if rev:
        if second == "EBITDA" and metrics["EBITDA"] is not None:
            out["margins"].append({"name": "EBITDA margin", "value": round(metrics["EBITDA"] / rev * 100, 1)})
        if metrics["PAT"] is not None:
            out["margins"].append({"name": "PAT margin", "value": round(metrics["PAT"] / rev * 100, 1)})
    ratios = table(conn, symbol, "ratios")
    if ratios:
        for label in ("ROCE %", "ROE %"):
            if label in ratios["rows"] and ratios["rows"][label][-1] is not None:
                out["margins"].append({"name": label.replace(" %", ""), "value": ratios["rows"][label][-1]})
    return out


def trajectory(conn: sqlite3.Connection, symbol: str) -> dict | None:
    pl = table(conn, symbol, "profit-loss")
    if not pl:
        return None
    periods, rows = _annual(pl)
    lender = is_lender(rows)
    hr = headline_rows(rows)
    n = min(10, len(periods))
    out = {"periods": periods[-n:], "series": {k: v[-n:] for k, v in hr.items() if v}, "observations": []}
    margin_key = "Financing Margin %" if lender else "OPM %"
    margins = rows.get(margin_key)
    if margins:
        out["series"]["Margin %"] = margins[-n:]
        out["margin_label"] = "Financing margin" if lender else "EBITDA margin"

    rev, pat = hr["Revenue"], hr["PAT"]
    r3, r5, p3, p5 = _cagr(rev, 3), _cagr(rev, 5), _cagr(pat, 3), _cagr(pat, 5)
    out["cagr"] = {"Revenue": {"3y": r3, "5y": r5, "10y": _cagr(rev, 9)}, "PAT": {"3y": p3, "5y": p5, "10y": _cagr(pat, 9)}}
    obs = out["observations"]
    if r3 is not None and r5 is not None:
        if r3 > r5 + 3:
            obs.append(_obs(f"Revenue growth accelerating: {r3:.0f}% CAGR over 3 years vs {r5:.0f}% over 5.", "pos"))
        elif r3 < r5 - 3:
            obs.append(_obs(f"Revenue growth slowing: {r3:.0f}% CAGR over 3 years vs {r5:.0f}% over 5.", "neg"))
        else:
            obs.append(_obs(f"Revenue compounding steadily at ~{r3:.0f}% a year.", "neutral"))
    if r3 is not None and p3 is not None:
        if p3 > r3 + 4:
            obs.append(_obs(f"Profit outgrowing revenue ({p3:.0f}% vs {r3:.0f}% 3-yr CAGR): operating leverage or margin gains.", "pos"))
        elif p3 < r3 - 4:
            obs.append(_obs(f"Profit lagging revenue ({p3:.0f}% vs {r3:.0f}% 3-yr CAGR): margins under pressure.", "neg"))
    # Screener's "financing margin" for lenders isn't a stable series; only trend operating margins.
    if not lender and margins and len([m for m in margins if m is not None]) >= 6:
        recent, prior = margins[-3:], margins[-6:-3]
        if None not in recent + prior:
            delta = sum(recent) / 3 - sum(prior) / 3
            label = out["margin_label"]
            if delta <= -2:
                obs.append(_obs(f"{label} compressing: {sum(recent)/3:.0f}% avg last 3 yrs vs {sum(prior)/3:.0f}% before.", "neg"))
            elif delta >= 2:
                obs.append(_obs(f"{label} expanding: {sum(recent)/3:.0f}% avg last 3 yrs vs {sum(prior)/3:.0f}% before.", "pos"))
    q = table(conn, symbol, "quarters")
    if q:
        qr = headline_rows(q["rows"])["Revenue"]
        if qr and len(qr) >= 5 and qr[-1] and qr[-5]:
            yoy = pct_change(qr[-1], qr[-5])
            if r3 is not None and yoy is not None and abs(yoy - r3) > 8:
                obs.append(_obs(f"Latest quarter revenue {yoy:+.0f}% YoY, {'well above' if yoy > r3 else 'well below'} the 3-yr trend.",
                                "pos" if yoy > r3 else "neg"))
    return out


def balance_sheet(conn: sqlite3.Connection, symbol: str) -> dict | None:
    bs = table(conn, symbol, "balance-sheet")
    if not bs:
        return None
    rows = bs["rows"]
    periods = bs["periods"]
    n = min(6, len(periods))
    equity = [((a or 0) + (b or 0)) if a is not None or b is not None else None
              for a, b in zip(rows.get("Equity Capital", []), rows.get("Reserves", []))]
    debt = series(rows, "Borrowings", "Borrowing") or []
    lender = "Deposits" in rows
    out = {"periods": periods[-n:], "lender": lender, "series": {"Net worth": equity[-n:], "Borrowings": debt[-n:]},
           "observations": []}
    obs = out["observations"]
    de = [round(d / e, 2) if d is not None and e else None for d, e in zip(debt, equity)]
    out["series"]["Debt / Equity"] = de[-n:]
    if lender:
        dep = rows["Deposits"]
        out["series"]["Deposits"] = dep[-n:]
        if dep[-1] and len(dep) > 3 and dep[-4]:
            obs.append(_obs(f"Deposits {_cagr(dep, 3) or 0:.0f}% CAGR over 3 years; leverage (assets/net worth) "
                            f"{(rows['Total Assets'][-1] / equity[-1]):.1f}×.", "neutral"))
    else:
        if de[-1] is not None:
            tone = "pos" if de[-1] < 0.3 else "neg" if de[-1] > 1 else "neutral"
            obs.append(_obs(f"Debt-to-equity {de[-1]:.2f}" + (" — essentially debt-free." if de[-1] < 0.1 else "."), tone))
        if len(debt) >= 4 and debt[-4] and debt[-1] and debt[-1] > 2 * debt[-4] and de[-1] and de[-1] > 0.3:
            obs.append(_obs(f"Borrowings up {debt[-1]/debt[-4]:.1f}× in 3 years.", "neg"))
        cwip = rows.get("CWIP")
        fa = rows.get("Fixed Assets")
        if cwip and fa and cwip[-1] and fa[-1] and cwip[-1] / fa[-1] > 0.15:
            obs.append(_obs(f"Capital work-in-progress is {cwip[-1]/fa[-1]*100:.0f}% of fixed assets: capacity coming.", "neutral"))
    ratios = table(conn, symbol, "ratios")
    if ratios and "Cash Conversion Cycle" in ratios["rows"]:
        rr = ratios["rows"]
        out["working_capital"] = {"periods": ratios["periods"][-n:],
                                  **{k: rr[k][-n:] for k in ("Debtor Days", "Inventory Days", "Days Payable", "Cash Conversion Cycle") if k in rr}}
        ccc = rr["Cash Conversion Cycle"]
        if len(ccc) >= 4 and ccc[-1] is not None and ccc[-4] is not None:
            d = ccc[-1] - ccc[-4]
            if ccc[-1] < 0:
                obs.append(_obs(f"Negative working-capital cycle ({ccc[-1]:.0f} days): customers and suppliers fund "
                                f"operations{' (less so than 3 years ago)' if d >= 15 else ''}.", "pos"))
            elif d >= 15:
                obs.append(_obs(f"Working-capital cycle lengthened {ccc[-4]:.0f} → {ccc[-1]:.0f} days in 3 years: cash getting tied up.", "neg"))
            elif d <= -15:
                obs.append(_obs(f"Working-capital cycle shortened {ccc[-4]:.0f} → {ccc[-1]:.0f} days in 3 years.", "pos"))
            else:
                obs.append(_obs(f"Cash conversion cycle {ccc[-1]:.0f} days, stable.", "neutral"))
    return out


def cash_quality(conn: sqlite3.Connection, symbol: str) -> dict | None:
    cf = table(conn, symbol, "cash-flow")
    pl = table(conn, symbol, "profit-loss")
    if not cf or not pl:
        return None
    _, pla = _annual(pl)
    lender = is_lender(pla)
    cfo = cf["rows"].get("Cash from Operating Activity", [])
    fcf = cf["rows"].get("Free Cash Flow", [])
    pat = pla.get("Net Profit", [])
    n = min(6, len(cf["periods"]), len(pat))
    out = {"periods": cf["periods"][-n:], "lender": lender,
           "series": {"CFO": cfo[-n:], "PAT": pat[-n:], "FCF": fcf[-n:] if fcf else []}, "observations": []}
    if lender:
        out["observations"].append(_obs("For a lender, operating cash flow swings with loan book growth and deposits; "
                                        "cash conversion isn't a meaningful quality test here.", "neutral"))
        return out
    c5, p5 = [x for x in cfo[-5:] if x is not None], [x for x in pat[-5:] if x is not None]
    if c5 and p5 and sum(p5) > 0:
        conv = sum(c5) / sum(p5) * 100
        out["conversion_5y"] = round(conv)
        tone = "pos" if conv >= 90 else "neg" if conv < 70 else "neutral"
        out["observations"].append(_obs(f"Turned {conv:.0f}% of the last 5 years' profit into operating cash.", tone))
    f5 = [x for x in fcf[-5:] if x is not None] if fcf else []
    if f5:
        neg_years = sum(1 for x in f5 if x < 0)
        if neg_years >= 3:
            out["observations"].append(_obs(f"Free cash flow negative in {neg_years} of the last 5 years: growth is being funded.", "neg"))
        elif sum(f5) > 0:
            out["observations"].append(_obs(f"Generated ₹{sum(f5):,.0f} Cr of free cash over 5 years.", "pos"))
    return out


def shareholding(conn: sqlite3.Connection, symbol: str) -> dict | None:
    sh = table(conn, symbol, "shareholding")
    if not sh:
        return None
    rows = {k: v for k, v in sh["rows"].items() if k != "No. of Shareholders"}
    obs = []
    prom = rows.get("Promoters")
    if prom and len(prom) >= 5 and prom[-1] is not None and prom[-5] is not None and abs(prom[-1] - prom[-5]) >= 1:
        d = prom[-1] - prom[-5]
        obs.append(_obs(f"Promoter holding {'up' if d > 0 else 'down'} {abs(d):.1f} pts in a year to {prom[-1]:.1f}%.",
                        "pos" if d > 0 else "neg"))
    return {"periods": sh["periods"][-8:], "series": {k: v[-8:] for k, v in rows.items()}, "observations": obs}


def all_cards(conn: sqlite3.Connection, symbol: str) -> dict:
    return {
        "header": header(conn, symbol),
        "financial": financial_snapshot(conn, symbol),
        "trajectory": trajectory(conn, symbol),
        "balance_sheet": balance_sheet(conn, symbol),
        "cash": cash_quality(conn, symbol),
        "shareholding": shareholding(conn, symbol),
    }
