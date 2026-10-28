"""End-of-day price & volume from Yahoo Finance."""
import logging

import pandas as pd
import yfinance as yf

from ..config import yahoo_symbol
from ..db import session

log = logging.getLogger(__name__)


def ingest_prices(symbols: list[str], period: str = "1y") -> dict[str, int]:
    """Download daily OHLCV for all symbols in one batch and upsert. Returns rows per symbol."""
    tickers = {yahoo_symbol(s): s for s in symbols}
    df = yf.download(
        list(tickers), period=period, interval="1d", group_by="ticker",
        auto_adjust=False, progress=False, threads=True,
    )
    counts: dict[str, int] = {}
    with session() as conn:
        for ysym, sym in tickers.items():
            try:
                frame = df[ysym] if isinstance(df.columns, pd.MultiIndex) else df
            except KeyError:
                log.warning("no price data for %s", ysym)
                counts[sym] = 0
                continue
            frame = frame.dropna(subset=["Close"])
            rows = [
                (sym, idx.strftime("%Y-%m-%d"), float(r.Open), float(r.High), float(r.Low),
                 float(r.Close), int(r.Volume))
                for idx, r in frame.iterrows()
            ]
            conn.executemany(
                "INSERT OR REPLACE INTO prices (symbol, date, open, high, low, close, volume) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            counts[sym] = len(rows)
    return counts
