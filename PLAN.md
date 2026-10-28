# FINN: build plan

ENAM AI Engineer Build Challenge · deadline **Sun Nov 1, 2026**

## Product idea: the investor's inbox, cleared every morning

- **Brief (push):** ranked feed of cards for a chosen window (default 24h). Top items expanded, routine filings collapsed into one line. Swipe to dismiss/pin.
- **Alerts (push):** user-defined rules (volume > N× 20-day avg, |price move| > X%, categories I care about), delivered as PWA push notifications.
- **Ask (pull):** any NSE ticker → research cards, every claim cited to document + page. Chat follow-ups grounded in the same sources.
- *(Stretch)* 60-second spoken morning brief.

| Announcement type | Treatment |
|---|---|
| results | Revenue / EBITDA / PBT / PAT, QoQ and YoY, margin change |
| management_change | Who is joining/leaving + short bio of the incoming person |
| M&A, fund_raise, litigation, pledging, credit_rating | One-line LLM summary, high priority |
| dividend, agm_egm, earnings_call | Template line, no LLM |
| unclassified | Collapsed |

## Architecture

```
GitHub Actions cron ──> Python ingestion ──> database
   yfinance EOD (.NS) · NSE announcements (BSE fallback) · screener.in tables + PDF links
FastAPI backend  <──>  Next.js PWA (Vercel), Web Push
```

## Key decisions

1. **Numbers come from parsed tables (screener.in), never from an LLM.** LLM-extracted results figures are cross-checked against them.
2. **Model routing:** keyword rules → cheap model (classification, extraction to JSON schema) → strong model only for narrative-vs-numbers and bull/bear. Runs on Gemini's free tier by default (Claude optional).
3. **No vector DB.** Transcripts fit in context; annual reports are section-extracted.
4. **Cache by document hash;** log the token cost of every LLM call.
5. **Grounding enforced:** no outside knowledge, every claim cites a verbatim quote, quotes verified against source text.

## Signature feature: promised vs delivered

Extract guidance `{metric, target, period, quote, source}` from the last 4–5 transcripts, match against actual quarterly numbers, and score each row Delivered / Missed / Pending.

## Scope

- **Must-have:** Brief + ranking, results card, management-change card, alerts, Ask (business snapshot, financial snapshot, trajectory, guidance vs delivery, bull/bear) on any ticker, deployed for phone.
- **Nice-to-have:** chat follow-ups, balance sheet, cash quality, voice brief.
- **Left out:** intraday data, auth/multi-user, news/broker notes, native app.

## Companies

Portfolio: RELIANCE, HDFCBANK, ICICIBANK, INFY, BHARTIARTL, ITC, LT, SUNPHARMA, TITAN, BAJFINANCE, ETERNAL, DIXON, POLYCAB, PERSISTENT, KPITTECH, IRFC, CDSL, PGEL
Ad-hoc research: TRENT, HAL, DMART, ASIANPAINT

## Schedule

| Day | Work |
|---|---|
| Wed Oct 28 | Data plumbing: prices, announcements, screener scraper, schema, demo snapshot |
| Thu Oct 29 | Push pipeline: classifier, ranking, results extractor, mgmt bio, alert rules |
| Fri Oct 30 | Pull pipeline: PDF text, guidance extraction, scorecard, bull/bear, caching |
| Sat Oct 31 | Frontend PWA: Brief, Ask, cards, push notifications |
| Sun Nov 1 | Deploy, phone test, covering note, export AI build history |

## Risks

- NSE blocks cloud IPs → session cookies, BSE fallback, cached snapshot.
- Scanned PDFs → fall back to screener tables, flag the gap.
- Free-tier rate limits → caching + keyword-first classification.
