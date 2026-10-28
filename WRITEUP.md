# FINN: covering note (draft)

> Draft for the submission email. Fill in the links once deployed, and replace the cost estimates
> with the real figures from `python -m finn.cli costs` after a live run.

**Prototype:** <deployed link> · **Repo:** <GitHub link> · **Build history:** <Claude Code session export>

## What I built

FINN treats the investor's day as an inbox. The **Brief** reads every NSE filing across an
18-stock portfolio for a window you choose, groups them into events, and ranks them with an
explainable score: each card says *why* it's there ("Results filing · stock moved +5.4% that
session · volume 2.1× average"). Over the week I tested, 70 filings became 10 cards that need
attention, 8 worth a glance, and 45 routine filings collapsed into one line. You clear cards like
email; the brief can also be read aloud. Results arrive as a Revenue / EBITDA / PBT / PAT table with
QoQ and YoY (Net Interest Income for lenders, where EBITDA means nothing). Management changes carry
the incoming executive's background, taken from the profile the company itself discloses.

**Alerts** are your rules: volume vs its N-day average, daily price moves, filing types you care
about. Changing a threshold re-scores everything immediately.

**Research** works on any NSE ticker (try one outside the portfolio). The numbers (snapshot,
trajectory, balance sheet, cash quality) appear in seconds and are entirely computed. Then FINN reads
the last four earnings calls and the latest annual report and answers the question I think matters
most: **can you take management at their word?** Every piece of guidance is scored against reported
results (delivered / missed / on track / pending), with the guidance's path across calls (raised,
cut or reiterated) and the verbatim quote one tap away. A judgement pass then sets the story
against the numbers and writes a tight bull and bear case.

## Key decisions and trade-offs

- **Numbers never come from a model.** Financials are parsed from standardised statements, and every
  observation is computed. Where a model must read numbers (a results filing before the standardised
  table updates), it extracts raw line items only; EBITDA is computed in code, and each figure must
  appear on the cited page.
- **Rules first, models where they earn it.** 87% of filings are classified by rules. A cheap model
  reads only filings that are ambiguous or important but uninformative ("change in Management"),
  and only their first pages.
- **It runs on free tiers.** Gemini's free tier: Flash-Lite for all bulk reading, Gemini 3.6 Flash
  only for the one judgement call per company, each with an automatic fallback because free models
  get overloaded at peak times (the newest free Flash returned "high demand" errors in testing). I
  chose Gemini over Groq and OpenRouter because a single transcript (~25k tokens) exceeds their free
  per-minute token caps. Calls are paced to the free limits; if a daily quota runs out, the run stops
  cleanly and resumes next time from cache. Everything is cached by content hash, so a company is
  re-analysed only when a new transcript lands. The same code runs on Claude by switching the key.
- **Executive background from the filing.** Web-search grounding isn't free, but SEBI requires an
  appointment filing to carry the appointee's profile, so FINN reads it there: primary source, free,
  and a LinkedIn link for more.
- **Grounding enforced in code.** Quotes are matched verbatim against the source; unmatched ones are
  dropped. The judgement model only sees verified quotes and computed figures.
- **No vector DB, no agents.** Transcripts fit in context; the pipeline is deterministic code with
  model calls at fixed points. Easier to reason about, cheaper, and auditable.
- **Deliberately boring infra:** SQLite committed by a scheduled GitHub Action, one Docker service.
  Zero running cost; the trade-off is that data is as fresh as the last scheduled run.

## Cost (measured)

**$0.** The live run made 53 model calls (577k input, 43k output tokens) on Gemini's free tier. It
covered a week of portfolio filings (20 needed a model; rules handled the rest) and research on L&T,
Trent and Infosys, run twice while I fixed scoring. One company's research is 6 calls: 4 transcripts
(~19k tokens each), 1 annual-report pass (~9k) and 1 judgement (~3k in, ~3k out). The same run on
Claude Haiku 5.5 + Opus 5.5 at list prices would have cost about $0.53, most of it the Opus
judgements. On the free tier the binding constraint is daily request quota, not money.

## What the live run caught

Reviewing real output found scoring that would have been confidently wrong, now fixed in code:
Infosys guides revenue in constant currency (comparing it with rupee growth said "delivered"), IT
companies' "operating margin" is EBIT not EBITDA, and L&T's margin guidance is for one segment. The
extractor now records each target's basis and only like-for-like targets are scored. The quote
verifier also caught the model "quoting" management with a paraphrase; it is shown as not verbatim
rather than as a quote.

## What I left out

Intraday data; login and multiple users; server-sent push (notifications fire when the app is
opened); news and broker notes (by design for research); OCR for scanned PDFs; a native app.

## Where I'd take it next

1. Server-side Web Push so alerts reach a locked phone.
2. A guidance ledger that persists across quarters, so "promised vs delivered" becomes a
   multi-year credibility score per management team.
3. Learning the ranking from what the investor clears vs opens.
4. Peer views: the same scorecard across a sector.
