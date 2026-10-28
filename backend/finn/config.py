import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Local secrets (e.g. GEMINI_API_KEY=...) from a git-ignored .env; real env vars win.
if (ROOT / ".env").exists():
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        name, sep, value = line.strip().partition("=")
        if sep and name and not name.startswith("#"):
            os.environ.setdefault(name.strip(), value.strip().strip("\"'"))
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"  # raw downloads (PDFs, HTML); not committed
DB_PATH = DATA_DIR / "finn.db"

# Mock portfolio: mixed sectors and sizes, NSE symbols.
PORTFOLIO = [
    "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "BHARTIARTL", "ITC",
    "LT", "SUNPHARMA", "TITAN", "BAJFINANCE", "ETERNAL", "DIXON",
    "POLYCAB", "PERSISTENT", "KPITTECH", "IRFC", "CDSL", "PGEL",
]

# Companies outside the portfolio used to demo on-demand research.
RESEARCH_DEMO = ["TRENT", "HAL", "DMART", "ASIANPAINT"]

# Yahoo Finance symbol overrides, for the few that don't follow "<NSE>.NS".
YAHOO_OVERRIDES: dict[str, str] = {}


def yahoo_symbol(symbol: str) -> str:
    return YAHOO_OVERRIDES.get(symbol, f"{symbol}.NS")
