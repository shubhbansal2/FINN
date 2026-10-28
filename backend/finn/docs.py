"""Download PDFs once and keep their text, page by page.

Text is cached on disk by URL hash; the documents table records the content hash so the research
cache can tell when a company's source documents actually changed.
"""
import hashlib
import json
import logging
import re

from .config import CACHE_DIR
from .db import now_ist
from .http import browser_session

log = logging.getLogger(__name__)
_http = None


def _session():
    global _http
    if _http is None:
        _http = browser_session()
    return _http


def _paths(url: str):
    h = hashlib.sha256(url.encode()).hexdigest()[:24]
    d = CACHE_DIR / "docs"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{h}.pdf", d / f"{h}.json"


def pages(url: str, max_pages: int | None = None) -> list[str]:
    """Text of each page (1-indexed in citations; list is 0-indexed). Empty list if unreadable."""
    pdf_path, txt_path = _paths(url)
    if txt_path.exists():
        cached = json.loads(txt_path.read_text(encoding="utf-8"))
        return cached["pages"][:max_pages] if max_pages else cached["pages"]
    referer = "https://www.nseindia.com/" if "nseindia" in url else "https://www.bseindia.com/"
    r = _session().get(url, timeout=60, headers={"Referer": referer})
    r.raise_for_status()
    if not r.content.startswith(b"%PDF"):
        log.warning("not a PDF: %s", url)
        return []
    pdf_path.write_bytes(r.content)
    import pymupdf
    with pymupdf.open(pdf_path) as doc:
        texts = [re.sub(r"[ \t]+", " ", p.get_text()).strip() for p in doc]
    txt_path.write_text(json.dumps({"url": url, "sha256": hashlib.sha256(r.content).hexdigest(), "pages": texts}),
                        encoding="utf-8")
    pdf_path.unlink()  # keep the text, not 50MB annual reports
    return texts[:max_pages] if max_pages else texts


def sha(url: str) -> str | None:
    _, txt_path = _paths(url)
    if not txt_path.exists():
        return None
    return json.loads(txt_path.read_text(encoding="utf-8"))["sha256"]


def numbered(texts: list[str], start: int = 1) -> str:
    """Page-tagged text for prompts, so the model can cite pages."""
    return "\n\n".join(f"[page {i}]\n{t}" for i, t in enumerate(texts, start) if t)


def mark_fetched(conn, url: str) -> None:
    conn.execute("UPDATE documents SET sha256=?, text_path=?, fetched_at=? WHERE url=?",
                 (sha(url), str(_paths(url)[1]), now_ist().isoformat(timespec="seconds"), url))


def normalise(s: str) -> str:
    return re.sub(r"[^a-z0-9%.]+", " ", s.lower()).strip()


def quote_found(quote: str, texts: list[str]) -> int | None:
    """Page number (1-indexed) where a quote appears, tolerant of whitespace/punctuation; None if
    the model invented it."""
    q = normalise(quote)
    if len(q) < 12:
        return None
    probe = q[:120]
    norm = [normalise(t) for t in texts]
    for i, t in enumerate(norm, 1):
        if probe in t:
            return i
    for i in range(len(norm) - 1):  # a sentence that runs across a page break
        if probe in f"{norm[i]} {norm[i + 1]}":
            return i + 1
    return None
