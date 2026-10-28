# FINN: Financial Investment Agent

A mobile-first agent for a public-markets investor, built for the ENAM AI Engineer Build Challenge.

**The point of view:** an investor's day starts with an inbox, not a dashboard. FINN reads every
exchange filing across the portfolio, ranks the handful that matter, collapses the rest, and lets you
clear the brief like email. When you want to dig in, it holds management to their word: every piece
of guidance from the last four earnings calls, checked against what was actually reported.

| | |
|---|---|
| **Brief** (push) | Filings in a window you choose (24h / 3d / week / month), grouped into events, ranked by an explainable score; results arrive as a Revenue / EBITDA / PBT / PAT card with QoQ and YoY; routine paperwork collapsed into one line. Swipe to clear. "Listen" reads the brief aloud. |
| **Alerts** (push) | Your thresholds: volume vs N-day average, daily price move, filing categories. Re-scored instantly when you change them; phone notifications via the PWA. |
| **Research** (pull) | Any NSE ticker. Numbers in seconds (snapshot, trajectory, balance sheet, cash quality), then: promised vs delivered, story vs numbers, bull/bear, business from the annual report, and a Q&A box, all grounded in transcripts and the annual report, with every quote verified. |

## Architecture

```
GitHub Actions (cron) ── ingest ──> data/finn.db (SQLite, committed) ──> Docker on Render
   yfinance EOD · NSE filings (BSE fallback) · screener.in tables + AR/transcript links
                                         │
FastAPI ── /api/* ─────────────────────── ┤
React PWA (Vite) ── served by FastAPI ────┘
```

```
backend/finn/
  ingest/      prices.py · announcements.py · fundamentals.py      (plumbing)
  push/        classify.py   rules first; only ambiguous filings go to a model
               pipeline.py   scoring with human-readable reasons + windowed digest
               results.py    results card from parsed tables, or read off the filing
               enrich.py     cheap-model summaries; exec background from the filing's profile
               alerts.py     threshold alerts, idempotent
  pull/        numbers.py    deterministic research cards + observations
               guidance.py   guidance extraction, quote verification, scorecard
               analysis.py   business snapshot (AR) + story-vs-numbers judgement
               ask.py        grounded Q&A over the last two transcripts
  llm.py       providers (Gemini free / Claude), routing, pacing, response cache, usage ledger
  api.py       FastAPI
frontend/src/  Brief · EventCard · Company · Screens (Portfolio, Research, Alerts)
```

## Key decisions

- **Numbers never come from a model.** Financials are parsed from screener.in's tables; every
  observation ("margins compressing 3 pts", "turned 115% of profit into cash") is computed. The
  one exception, a results filing read before screener updates, computes EBITDA itself and checks
  each extracted figure against the numbers printed on the cited page; under 80% verified, the card
  is marked unverified.
- **Rules before models.** 87% of filings are classified by rules; only the ambiguous ones (and the
  important ones whose exchange text says nothing, e.g. "change in Management") get a model call,
  on the first four pages only.
- **Free by default, routed by task.** On Gemini's free tier (plain REST, no SDK):
  `gemini-3.5-flash-lite` for bulk extraction (filings, transcripts, annual-report pages, Q&A) and
  `gemini-3.6-flash` only for the single judgement call per company. Free-tier models get
  overloaded at peak times, so each has an automatic fallback (`gemini-3.1-flash-lite`,
  `gemini-3-flash-preview`); the ledger records which model actually served each call. Calls are
  paced for per-minute limits, 429s are retried after Google's stated delay, and a used-up daily
  quota stops the run cleanly: everything finished is cached and the next run resumes. Gemini was
  chosen over Groq/OpenRouter free tiers because one transcript (~25k tokens) exceeds their
  per-minute token caps. Set `ANTHROPIC_API_KEY` instead to run on Claude (Haiku 5.5 / Opus 5.5);
  override models with `FINN_CHEAP_MODEL` / `FINN_STRONG_MODEL`. Google may use free-tier prompts to
  improve its products; FINN only sends public filings and transcripts.
- **Executive background from the filing, not the web.** SEBI requires an appointment filing to
  include the appointee's brief profile, so the cheap model reads it from there (primary source,
  free, nothing to hallucinate from search results); a LinkedIn search link is one tap away.
  (Web-search grounding isn't available on Gemini's free tier.)
- **Pay once.** Every LLM response is cached by a hash of (model, prompt, schema); research is
  keyed by the hash of its source documents, so a company is only re-analysed when a new transcript
  or annual report appears. Transcripts sit behind a prompt-cache breakpoint, so follow-up questions
  re-read them at cache prices.
- **Grounding is enforced, not requested.** Extracted quotes are matched verbatim against the
  source text; unmatched ones are dropped (and counted). The judgement model sees only those
  verified quotes plus computed figures: no raw web, no outside knowledge.
- **No vector database.** A transcript fits in context; annual reports are page-ranked by keyword.

## Run locally

```bash
cd backend
pip install -r requirements.txt
python -m finn.cli all            # ingest portfolio + research set, score, alert
cd ../frontend && npm install && npm run build
cd .. && python -m uvicorn finn.api:app --app-dir backend --port 8000
```

Open http://localhost:8000 (use the phone viewport in dev tools, or your phone on the same network).
Set `GEMINI_API_KEY` (free, no card: create one at https://aistudio.google.com/apikey) to enable
summaries, bios, results-from-filing, research analysis and Q&A; everything else works without it.
Your exact free-tier limits per model are shown in AI Studio.

Other jobs: `python -m finn.cli research TRENT`, `python -m finn.cli costs`.

## Deploy

`render.yaml` + `Dockerfile` give a single free web service. `.github/workflows/refresh.yml`
refreshes the data on a schedule and commits `data/finn.db`, which redeploys the service.
Add `GEMINI_API_KEY` as a repository secret and as a Render environment variable.

## Data sources

| Source | Used for |
|---|---|
| Yahoo Finance (`yfinance`) | End-of-day OHLCV; only completed sessions count for alerts |
| NSE corporate-announcements API, BSE API fallback | Filings |
| screener.in | Standardised statements; links to annual reports and transcripts |
| Company PDFs (exchange archives / IR sites) | Transcripts, annual reports, results filings |
| Appointment filings (SEBI-mandated profile) | Background of newly appointed executives |
