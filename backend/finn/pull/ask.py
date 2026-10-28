"""Follow-up questions about one company, answered only from its primary sources.

Context = the two most recent call transcripts (page-tagged) + the computed financial cards. The
transcripts sit first in the prompt with a cache breakpoint, so a second question about the same
company re-reads them from cache at a tenth of the price. Cited quotes are verified against the
transcript text; unverified ones are marked, not silently shown.
"""
import json
import sqlite3

from .. import docs, llm
from . import guidance
from .numbers import all_cards

SYSTEM = (
    "You answer an investor's question about one company using ONLY the call transcripts and figures "
    "provided. No outside knowledge, news or opinions about the company. If the material doesn't "
    "answer the question, say so plainly and set answerable=false. Be concise (<=120 words), lead "
    "with the answer, and support it with verbatim quotes copied exactly from the transcripts."
)
SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["answerable", "answer", "quotes"],
    "properties": {
        "answerable": {"type": "boolean"},
        "answer": {"type": "string"},
        "quotes": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["call", "quote"],
            "properties": {"call": {"type": "string"}, "quote": {"type": "string"}}}},
    },
}


def answer(conn: sqlite3.Connection, symbol: str, question: str) -> dict:
    ts = guidance.transcripts(conn, symbol, n=2)
    texts = {t["period"]: docs.pages(t["url"]) for t in ts}
    cards = all_cards(conn, symbol)
    figures = {k: {kk: vv for kk, vv in (cards.get(k) or {}).items() if kk in ("series", "periods", "cagr", "metrics", "observations")}
               for k in ("financial", "trajectory", "balance_sheet", "cash")}
    documents = [f"=== {t['period']} earnings call transcript ({t['quarter']}) ===\n{docs.numbered(texts[t['period']])}" for t in ts]
    documents.append("=== Figures from reported statements (₹ Cr) ===\n" + json.dumps(figures, ensure_ascii=False))
    out = llm.complete_json(conn, purpose="ask", tier="cheap", system=SYSTEM, schema=SCHEMA,
                            documents=documents, prompt=f"Question: {question}", effort="medium")
    # The model's "call" label is free text; verify against every transcript we supplied.
    for q in out["quotes"]:
        q.update(verified=False, page=None, source=None)
        for t in ts:
            page = docs.quote_found(q["quote"], texts[t["period"]])
            if page:
                q.update(verified=True, page=page, source=t["url"], call=f"{t['quarter']} ({t['period']})")
                break
    return out
