"""Company fundamentals from screener.in: financial tables, profile, and document links.

Financial numbers are parsed straight from screener's HTML tables, so the research view's
numbers never come from an LLM.
"""
import logging
import re
import time
from datetime import datetime

from bs4 import BeautifulSoup, Tag

from ..db import session, upsert
from ..http import browser_session

log = logging.getLogger(__name__)

BASE = "https://www.screener.in/company"
SECTIONS = ["quarters", "profit-loss", "balance-sheet", "cash-flow", "ratios", "shareholding"]
DOC_KINDS = {"transcript": "transcript", "ppt": "ppt", "rec": "recording"}


def _num(text: str) -> float | None:
    t = text.replace(",", "").replace("%", "").replace("₹", "").strip()
    if not t:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _label(td: Tag) -> str:
    # The first text node is the label; later ones are "+" expanders or tooltip text.
    first = next(td.stripped_strings, "")
    return first.replace("\xa0", " ").rstrip("+").strip()


def parse_table(section: Tag) -> dict | None:
    table = section.select_one("table")
    if not table:
        return None
    periods = [th.get_text(strip=True) for th in table.select("thead th")][1:]
    rows: dict[str, list[float | None]] = {}
    for tr in table.select("tbody tr"):
        cells = tr.select("td")
        if not cells:
            continue
        label = _label(cells[0])
        if not label or label == "Raw PDF":
            continue
        rows[label] = [_num(td.get_text(strip=True)) for td in cells[1:]]
    if not rows or not periods:
        return None
    return {"periods": periods, "rows": rows}


def parse_profile(soup: BeautifulSoup) -> dict:
    ratios = {}
    for li in soup.select("#top-ratios li"):
        name = li.select_one(".name")
        value = li.select_one(".value")
        if name and value:
            ratios[name.get_text(strip=True)] = " ".join(value.get_text(" ", strip=True).split())
    about = soup.select_one(".company-profile .about")
    links = {a.get_text(strip=True): a.get("href", "") for a in soup.select(".company-profile a")}
    bse_link = soup.select_one("a[href*='bseindia.com/stock-share-price/']")
    bse_match = re.search(r"/(\d{6})/?$", bse_link["href"]) if bse_link else None
    sector = [a.get_text(strip=True) for a in soup.select("section#peers a[href^='/market/']")]
    h1 = soup.select_one("h1")
    return {
        "name": h1.get_text(strip=True) if h1 else None,
        "about": about.get_text(" ", strip=True) if about else None,
        "ratios": ratios,
        "website": links.get("Website"),
        "bse_code": bse_match.group(1) if bse_match else None,
        "sector": " > ".join(sector) if sector else None,
    }


def parse_documents(soup: BeautifulSoup) -> list[dict]:
    docs: list[dict] = []
    for a in soup.select("section#documents div.annual-reports li a"):
        year = re.search(r"(19|20)\d{2}", a.get_text(" ", strip=True))
        if year and a.get("href"):
            docs.append({"url": a["href"], "kind": "annual_report", "period": year.group(0)})
    for li in soup.select("section#documents div.concalls li"):
        period_el = li.select_one("div")
        period = period_el.get_text(strip=True) if period_el else ""
        for a in li.select("a.button-chip"):
            kind = DOC_KINDS.get(a.get_text(strip=True).lower())
            if kind and a.get("href"):
                docs.append({"url": a["href"], "kind": kind, "period": period})
    return docs


def fetch_company(symbol: str, http=None) -> dict:
    """Scrape one company. Prefers consolidated numbers, falls back to standalone."""
    http = http or browser_session()
    for basis, url in (("consolidated", f"{BASE}/{symbol}/consolidated/"), ("standalone", f"{BASE}/{symbol}/")):
        r = http.get(url, timeout=20)
        if r.status_code == 404:
            raise LookupError(f"{symbol} not found on screener.in")
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        tables = {}
        for name in SECTIONS:
            sec = soup.select_one(f"section#{name}")
            parsed = parse_table(sec) if sec else None
            if parsed:
                tables[name] = parsed
        quarters = tables.get("quarters", {}).get("rows", {})
        if any(v is not None for vals in quarters.values() for v in vals):
            break
        log.info("%s: no consolidated numbers, trying standalone", symbol)
    return {"basis": basis, "tables": tables, "profile": parse_profile(soup), "documents": parse_documents(soup)}


def ingest_fundamentals(symbols: list[str], portfolio: set[str] | None = None) -> dict[str, str]:
    portfolio = portfolio or set()
    http = browser_session()
    status: dict[str, str] = {}
    now = datetime.now().isoformat(timespec="seconds")
    for sym in symbols:
        try:
            data = fetch_company(sym, http)
        except Exception as e:
            log.warning("fundamentals failed for %s: %s", sym, e)
            status[sym] = f"error: {e}"
            continue
        p = data["profile"]
        with session() as conn:
            upsert(conn, "companies", {
                "symbol": sym, "name": p["name"], "bse_code": p["bse_code"], "sector": p["sector"],
                "in_portfolio": int(sym in portfolio),
                "profile": {"about": p["about"], "ratios": p["ratios"], "website": p["website"]},
                "updated_at": now,
            }, key=("symbol",))
            for section, table in data["tables"].items():
                upsert(conn, "fundamentals", {
                    "symbol": sym, "section": section, "basis": data["basis"],
                    "data": table, "fetched_at": now,
                }, key=("symbol", "section"))
            for doc in data["documents"]:
                upsert(conn, "documents", {"symbol": sym, **doc}, key=("url",))
        status[sym] = f"{data['basis']}: {len(data['tables'])} tables, {len(data['documents'])} docs"
        time.sleep(1.0)  # screener rate-limits aggressive scraping
    return status
