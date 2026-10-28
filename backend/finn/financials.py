"""Read screener tables back out of the database, with a few derived helpers.

Lenders (banks, NBFCs) and operating companies use different P&L layouts on screener:
lenders have Revenue / Interest / Financing Profit, others Sales / Operating Profit. EBITDA is
meaningless for a lender, so they get Net Interest Income in its place, labelled as such.
"""
import json
import sqlite3


def table(conn: sqlite3.Connection, symbol: str, section: str) -> dict | None:
    row = conn.execute(
        "SELECT data, basis FROM fundamentals WHERE symbol=? AND section=?", (symbol, section)
    ).fetchone()
    if not row:
        return None
    data = json.loads(row["data"])
    data["basis"] = row["basis"]
    return data


def is_lender(rows: dict) -> bool:
    return "Financing Profit" in rows


def series(rows: dict, *labels: str) -> list[float | None] | None:
    for label in labels:
        if label in rows:
            return rows[label]
    return None


def headline_rows(rows: dict) -> dict[str, list[float | None]]:
    """Revenue / EBITDA (or NII) / PBT / PAT series from a quarters or profit-loss table."""
    revenue = series(rows, "Sales", "Revenue")
    if is_lender(rows):
        interest = rows.get("Interest") or []
        second = ("NII", [r - i if r is not None and i is not None else None for r, i in zip(revenue, interest)])
    else:
        second = ("EBITDA", series(rows, "Operating Profit"))
    return {
        "Revenue": revenue,
        second[0]: second[1],
        "PBT": series(rows, "Profit before tax"),
        "PAT": series(rows, "Net Profit"),
    }


def pct_change(new: float | None, old: float | None) -> float | None:
    if new is None or old is None or old == 0:
        return None
    return round((new - old) / abs(old) * 100, 1)
