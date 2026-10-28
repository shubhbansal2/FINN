"""Command-line entry point.

    python -m finn.cli all                      # ingest everything, then score, enrich and alert
    python -m finn.cli fundamentals TRENT HAL   # any NSE symbols
    python -m finn.cli announcements --days 7
    python -m finn.cli process                  # score + LLM-enrich filings, evaluate alerts
    python -m finn.cli research LT              # full research run (needs GEMINI_API_KEY, free)
    python -m finn.cli costs                    # LLM calls, tokens and spend so far
"""
import argparse
import json
import logging

from .config import PORTFOLIO, RESEARCH_DEMO


def process() -> dict:
    from .db import session
    from .push import alerts, enrich, pipeline
    with session() as conn:
        scored = pipeline.process(conn)
        conn.commit()
        enriched = enrich.enrich(conn)
        enrich.apply_llm_scores(conn)
        fired = alerts.evaluate(conn)
    return {"scored": scored, "enrichment": enriched, "new_alerts": [a["title"] for a in fired]}


def main() -> None:
    ap = argparse.ArgumentParser(prog="finn")
    ap.add_argument("job", choices=["prices", "announcements", "fundamentals", "all", "process", "research", "costs"])
    ap.add_argument("symbols", nargs="*", help="NSE symbols (default: portfolio)")
    ap.add_argument("--days", type=int, default=30, help="announcement lookback")
    ap.add_argument("--force", action="store_true", help="research: recompute even if sources are unchanged")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    symbols = [s.upper() for s in args.symbols] or PORTFOLIO
    results = {}
    if args.job in ("fundamentals", "all"):
        # First: it records each company's BSE code, which the announcements fallback needs.
        from .ingest.fundamentals import ingest_fundamentals
        targets = symbols + (RESEARCH_DEMO if args.job == "all" and not args.symbols else [])
        results["fundamentals"] = ingest_fundamentals(targets, set(PORTFOLIO))
    if args.job in ("prices", "all"):
        from .ingest.prices import ingest_prices
        results["prices"] = ingest_prices(symbols + (RESEARCH_DEMO if args.job == "all" and not args.symbols else []))
    if args.job in ("announcements", "all"):
        from .ingest.announcements import ingest_announcements
        results["announcements"] = ingest_announcements(symbols, days=args.days)
    if args.job in ("process", "all"):
        results["process"] = process()
    if args.job == "research":
        from .pull import research
        for s in args.symbols:
            research.ensure_data(s.upper())
            research.analyse(s.upper(), force=args.force)
            results[s] = research.STATUS.get(s.upper())
    if args.job == "costs":
        from . import llm
        from .db import session
        with session() as conn:
            results = llm.spend(conn)
    print(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
