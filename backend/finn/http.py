"""Shared HTTP sessions. NSE needs cookies from its homepage before the API answers."""
import time

import requests

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)


def browser_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    return s


class NSE:
    BASE = "https://www.nseindia.com"

    def __init__(self) -> None:
        self.s = browser_session()
        self.s.headers.update({
            "Accept": "application/json, text/plain, */*",
            "Referer": f"{self.BASE}/companies-listing/corporate-filings-announcements",
        })
        self._warm = False

    def _warm_up(self) -> None:
        self.s.get(self.BASE, timeout=15)
        self._warm = True

    def get_json(self, path: str, params: dict | None = None, retries: int = 3):
        for attempt in range(retries):
            if not self._warm:
                self._warm_up()
            r = self.s.get(f"{self.BASE}{path}", params=params, timeout=20)
            if r.status_code in (401, 403):  # cookies expired: re-warm and retry
                self._warm = False
                time.sleep(1 + attempt)
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"NSE refused {path} after {retries} attempts")


class BSE:
    BASE = "https://api.bseindia.com/BseIndiaAPI/api"

    def __init__(self) -> None:
        self.s = browser_session()
        self.s.headers.update({
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.bseindia.com/",
            "Origin": "https://www.bseindia.com",
        })

    def get_json(self, path: str, params: dict):
        r = self.s.get(f"{self.BASE}{path}", params=params, timeout=20)
        r.raise_for_status()
        return r.json()
