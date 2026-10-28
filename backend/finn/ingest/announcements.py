"""Corporate announcements from NSE, falling back to BSE when NSE refuses (e.g. cloud IPs)."""
import logging
import time
from datetime import date, datetime, timedelta

from ..db import session, upsert
from ..http import BSE, NSE

log = logging.getLogger(__name__)


def _nse_rows(nse: NSE, symbol: str, start: date, end: date) -> list[dict]:
    data = nse.get_json("/api/corporate-announcements", {
        "index": "equities", "symbol": symbol,
        "from_date": start.strftime("%d-%m-%Y"), "to_date": end.strftime("%d-%m-%Y"),
    })
    return [{
        "id": f"NSE:{a['seq_id']}",
        "symbol": symbol,
        "exchange": "NSE",
        "ts": a["sort_date"].replace(" ", "T"),
        "subject": a.get("desc"),
        "text": a.get("attchmntText"),
        "url": a.get("attchmntFile"),
        "file_size": a.get("fileSize"),
    } for a in data]


def _bse_rows(bse: BSE, symbol: str, bse_code: str, start: date, end: date) -> list[dict]:
    rows: list[dict] = []
    for page in range(1, 11):
        data = bse.get_json("/AnnSubCategoryGetData/w", {
            "pageno": page, "strCat": -1, "strPrevDate": start.strftime("%Y%m%d"),
            "strScrip": bse_code, "strSearch": "P", "strToDate": end.strftime("%Y%m%d"),
            "strType": "C", "subcategory": -1,
        })
        table = data.get("Table") or []
        if not table:
            break
        for a in table:
            att = a.get("ATTACHMENTNAME")
            rows.append({
                "id": f"BSE:{a['NEWSID']}",
                "symbol": symbol,
                "exchange": "BSE",
                "ts": a["DT_TM"].split(".")[0],
                "subject": a.get("NEWSSUB"),
                "text": a.get("HEADLINE"),
                "url": f"https://www.bseindia.com/xml-data/corpfiling/AttachLive/{att}" if att else None,
                "file_size": None,
            })
    return rows


def ingest_announcements(symbols: list[str], days: int = 30) -> dict[str, int]:
    """Fetch the last `days` of filings per symbol. Returns rows per symbol (-1 = failed)."""
    end = datetime.now().date()
    start = end - timedelta(days=days)
    nse, bse = NSE(), BSE()
    counts: dict[str, int] = {}
    with session() as conn:
        for sym in symbols:
            try:
                rows = _nse_rows(nse, sym, start, end)
            except Exception as e:
                code = conn.execute("SELECT bse_code FROM companies WHERE symbol=?", (sym,)).fetchone()
                if not (code and code["bse_code"]):
                    log.warning("NSE failed for %s (%s) and no BSE code known", sym, e)
                    counts[sym] = -1
                    continue
                log.info("NSE failed for %s (%s); using BSE", sym, e)
                rows = _bse_rows(bse, sym, code["bse_code"], start, end)
            for row in rows:
                upsert(conn, "announcements", row, key=("id",))
            counts[sym] = len(rows)
            time.sleep(0.4)  # be polite to the exchange
    return counts
