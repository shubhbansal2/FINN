"""Model-written research sections, grounded in primary sources only.

- business(): cheap model over the most relevant pages of the latest annual report.
- judgement(): strong model, once per company, over *already-verified* transcript quotes and
  computed numbers -- never raw web data and never its own outside knowledge of the company. Every
  claim it makes must point at one of the numbered quotes it was given.
"""
import json
import re
import sqlite3

from .. import docs, llm

BIZ_KEYWORDS = re.compile(r"segment|business overview|our business|revenue (mix|share|from)|product portfolio|"
                          r"% of (total )?revenue|geograph|customers|brands|verticals|divisions", re.I)

BIZ_SYSTEM = ("You summarise what a company does from its own annual report for an investor new to it. "
              "Use only the pages given. Cite the page for each segment. If revenue shares aren't stated, "
              "leave them null rather than estimating.")
BIZ_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["what_it_does", "segments", "facts"],
    "properties": {
        "what_it_does": {"type": "string", "description": "Two sentences, plain English."},
        "segments": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["name", "share_pct", "detail", "page"],
            "properties": {"name": {"type": "string"}, "share_pct": {"type": ["number", "null"]},
                           "detail": {"type": "string"}, "page": {"type": "integer"}}}},
        "facts": {"type": "array", "description": "Up to 4 scale facts (capacity, stores, customers, geographies) with page.",
                  "items": {"type": "object", "additionalProperties": False, "required": ["fact", "page"],
                            "properties": {"fact": {"type": "string"}, "page": {"type": "integer"}}}},
    },
}


def latest_annual_report(conn: sqlite3.Connection, symbol: str) -> dict | None:
    rows = conn.execute("SELECT url, period FROM documents WHERE symbol=? AND kind='annual_report'", (symbol,)).fetchall()
    rows = [r for r in rows if (r["period"] or "").isdigit()]
    return dict(max(rows, key=lambda r: int(r["period"]))) if rows else None


def business(conn: sqlite3.Connection, symbol: str, name: str) -> dict | None:
    ar = latest_annual_report(conn, symbol)
    if not ar:
        return None
    texts = docs.pages(ar["url"])
    docs.mark_fetched(conn, ar["url"])
    if not texts:
        return None
    ranked = sorted(range(len(texts)), key=lambda i: -len(BIZ_KEYWORDS.findall(texts[i])))
    chosen = sorted(i for i in ranked[:10] if texts[i].strip())
    body = "\n\n".join(f"[page {i + 1}]\n{texts[i][:4000]}" for i in chosen)
    out = llm.complete_json(conn, purpose="business_snapshot", tier="cheap", system=BIZ_SYSTEM, schema=BIZ_SCHEMA,
                            prompt=f"{name} annual report {ar['period']}, selected pages:\n\n{body}")
    return out | {"source": ar["url"], "year": ar["period"]}


JUDGE_SYSTEM = (
    "You are a sceptical buy-side analyst. You are given (a) numbered verbatim quotes from management "
    "on recent earnings calls, (b) a scorecard of their guidance against reported results, and (c) "
    "figures computed from the company's reported statements. Use ONLY this material: no outside "
    "knowledge of the company, no news, no broker views. Your job is to analyse management, not "
    "summarise them: where does the story match the numbers, where does it diverge, and what is too "
    "early to call. Every point must reference quote ids (e.g. [Q3]) and/or specific figures given. "
    "Be terse; no hedging filler."
)
JUDGE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["verdict", "narrative_vs_numbers", "bull", "bear", "watch"],
    "properties": {
        "verdict": {"type": "string", "description": "One sentence: can you take management at their word, and why."},
        "narrative_vs_numbers": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["claim", "quote_ids", "verdict", "numbers"],
            "properties": {
                "claim": {"type": "string", "description": "What management says, paraphrased in <=15 words."},
                "quote_ids": {"type": "array", "items": {"type": "string"}},
                "verdict": {"type": "string", "enum": ["agrees", "diverges", "too_early"]},
                "numbers": {"type": "string", "description": "The reported figures that confirm or contradict it."}}}},
        "bull": {"type": "array", "items": {"$ref": "#/$defs/point"}},
        "bear": {"type": "array", "items": {"$ref": "#/$defs/point"}},
        "watch": {"type": "array", "items": {"type": "string"}, "description": "2-3 things to check next quarter."},
    },
    "$defs": {"point": {"type": "object", "additionalProperties": False, "required": ["point", "evidence"],
                        "properties": {"point": {"type": "string"}, "evidence": {"type": "string"}}}},
}


def judgement(conn: sqlite3.Connection, name: str, extracted: list[dict], score: dict, cards: dict) -> dict:
    quotes = []
    for ex in extracted:
        for kind in ("guidance", "themes"):
            for item in ex.get(kind, []):
                quotes.append({"id": f"Q{len(quotes) + 1}", "call": item["call"], "quote": item["quote"],
                               "page": item["page"], "source": item["source"],
                               "about": item.get("label") or item.get("topic")})
    numbers = {
        "cagr": (cards.get("trajectory") or {}).get("cagr"),
        "annual": {k: dict(zip(cards["trajectory"]["periods"], v)) for k, v in cards["trajectory"]["series"].items()}
        if cards.get("trajectory") else None,
        "latest_quarter": (cards.get("financial") or {}).get("latest_quarter"),
        "observations": [o["text"] for k in ("trajectory", "balance_sheet", "cash", "shareholding")
                         for o in (cards.get(k) or {}).get("observations", [])],
    }
    scorecard = [{"target": r["label"], "period": r["period"], "guided": [r["low"], r["high"], r["unit"]],
                  "status": r["status"], "actual": r.get("actual"), "move_across_calls": r.get("move")}
                 for r in score["items"]]
    prompt = (f"Company: {name}\n\n(a) Management quotes:\n"
              + "\n".join(f"[{q['id']}] ({q['call']} call, on {q['about']}) \"{q['quote']}\"" for q in quotes)
              + f"\n\n(b) Guidance scorecard:\n{json.dumps(scorecard, ensure_ascii=False)}"
              + f"\n\n(c) Reported figures (₹ Cr unless %):\n{json.dumps(numbers, ensure_ascii=False)}"
              + "\n\nGive 3-5 narrative-vs-numbers checks, 3 bull points, 3 bear points, and what to watch.")
    out = llm.complete_json(conn, purpose="judgement", tier="strong", system=JUDGE_SYSTEM, schema=JUDGE_SCHEMA,
                            prompt=prompt, effort="high", max_tokens=16000)
    by_id = {q["id"]: q for q in quotes}
    for row in out["narrative_vs_numbers"]:
        row["quotes"] = [by_id[i] for i in row.pop("quote_ids") if i in by_id]
    return out
