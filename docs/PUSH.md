# FINN push engine: signals, digest and alerts

The Brief and Alerts screens are driven by deterministic, testable rules in `src/push/`. No model decides what matters. The engine has no UI dependencies and runs from the CLI as well as the app.

## What it does, and what it does not do

- **Evaluated on demand.** Rules run when the Brief or Alerts screen loads, when "Evaluate now" is pressed, or via `npm run finn -- alerts:evaluate`.
- **No background watching.** FINN does not watch markets continuously or send push notifications. On the live deployment, a timer refreshes prices, filings and results figures on weekdays at 10:00 and 17:00 IST (see the README's "When data updates"). The rules then run against that data the next time a screen loads.
- **In-app delivery only.** An alert sits in the Alerts inbox as *new* until it is marked *seen*.
- **End-of-day data only.** Price and volume signals use completed sessions; the intraday path is never known.

## Signal types

| Kind | Source | Event time |
|---|---|---|
| `announcement` | Exchange filing, ranked by the policy | Publication time on the exchange |
| `results` | A results filing whose subject is the results, not a meeting notice, newspaper copy or presentation | Publication time |
| `price_move` | Daily change on the adjusted close | Session close, 15:30 IST |
| `volume_spike` | Session volume against the mean of prior sessions | Session close, 15:30 IST |
| `combination` | Signals from one company close in time, per the policy's combination rules | Latest component |

**Results first cut.** A results signal shows the headline numbers from the filing itself:
- **Lines:** Revenue, EBITDA, PBT and PAT for the quarter, against the previous quarter (QoQ) and the same quarter a year earlier (YoY).
  - A results statement prints all three quarters side by side, so every number comes from the one filing.
  - EBITDA is derived as PBT + finance costs + depreciation & amortisation, and is marked as derived.
- **How it is read:** the same deterministic parser research uses (`src/research/results-parser.ts`), with the filing's own arithmetic checked (PBT − tax = PAT).
  - Only figures that **passed** a check are shown.
  - A figure that failed, or could not be checked, is left out with the reason. A headline in the feed is a stronger claim than a flagged cell in research.
  - Growth from a zero or negative base is shown as "n.m.", not as a percentage.
- **Where it comes from:** `ingest:results` downloads results filings from the last 60 days and parses them. It runs in the weekday refresh, so the numbers are usually there before anyone opens the app.
  - Consolidated figures are used when the filing has them, standalone otherwise.
  - A meeting notice or newspaper copy yields no figures and is left as a plain filing.
- **On screen:** the row shows revenue YoY (or PAT YoY) and a one-line summary. The detail shows the full table, linked to the statement's page.
- **Demo mode:** shows no first cut, because results PDFs are not downloaded in demo mode. The detail says the figures are not extracted.

**Every signal keeps both timestamps:**
- **Occurred:** when the event happened (filing publication time, or session close).
- **Stored by FINN:** when FINN ingested the data.

**Combinations never hide their parts:**
- **Components are kept:** each component remains listed under the combination.
- **Overlaps merge into one item:** if two combinations share a component, e.g. a price move with unusual volume, and the same price move with a filing, they are merged into one item.
- **No causation is claimed:** the explanation always states that co-occurrence is not evidence of cause.

## The ranking policy (`config/signal-policy.json`)

The file is validated on load (`src/push/policy.ts`); invalid tiers, missing categories or broken patterns fail with the offending field named.

| Field | Meaning |
|---|---|
| `categoryTiers` | Starting tier per ENAM glossary category. Results and M&A start high; most compliance categories start routine. |
| `contentRules` | Per-category adjustments from what the filing says. Matched against the filed subject, and against the attachment's first pages when FINN has downloaded it. The first matching rule for the category wins. Examples: a results *meeting notice* → low; a CFO/MD change → high; commercial paper → low; a downgrade → high; a reaffirmation → low. |
| `ambiguousTier` | Tier for filings the classifier could not place (shown with the candidate categories). |
| `missingEvidencePenalty` | Lower a filing one tier when no exchange-filed or company-issued document is linked. |
| `staleAfterHours` | Signals older than this are labelled stale and ranked after fresh ones of the same tier. The tier itself is unchanged. |
| `duplicateWindowHours` | Same company and same normalised subject within this window counts as the same filing. |
| `prices` | `series` (adjusted close by default), `movePct`, `highMoveMultiple`, `maxSessionGapDays`, `corporateActionGapPct`. |
| `volume` | `multiple`, `highMultiple`, `lookbackSessions`, `minHistorySessions`, `minVolumeShares`. |
| `combinations` | Which signal kinds combine, within how many sessions, and at what tier. |

**There is no numeric impact score.** Order within the Brief is fixed:
1. tier;
2. fresh before stale;
3. newest first;
4. kind;
5. a stable id.

Equivalent inputs always produce the same order, whatever order they arrive in (tested).

## Rule details that matter

**Price moves**
- **Series:** adjusted close / previous adjusted close − 1.
- **Corporate actions:**
  - If the adjusted and raw changes differ by more than `corporateActionGapPct`, the signal says a split, bonus or dividend adjustment is likely.
  - If no adjusted price exists, the raw close is used and the signal says so.
- **Data gaps:** sessions more than `maxSessionGapDays` apart are not compared.
- **Tier:** a move at or above `movePct × highMoveMultiple` is high.

**Volume**
- **Baseline:** the mean of up to `lookbackSessions` sessions *before* the session. The session itself is never in its own baseline.
- **Zero-volume sessions** are treated as unavailable (suspensions or data gaps): excluded, never averaged in.
- **Insufficient history:** fewer than `minHistorySessions` usable sessions means "insufficient history", not a guess.
- **Zero baseline:** a zero baseline means "not computable", never a division.

**Threshold boundaries**
- **Display precision:** comparisons use the precision shown on screen, 2 decimals.
- **Example:** 1.999× shows as "2.00×" and fires a 2× rule, so the screen never shows a threshold value that did not alert.

**Filings → sessions (for combinations)**
- **Which session a filing belongs to:** a filing after 15:30 IST, or on a weekend, belongs to the next weekday session.
- **Holidays:** exchange holidays are not modelled.

## Digest

- **Window:**
  - Presets: `24h` (default), `3d`, `7d`, `30d`.
  - Custom ranges: `YYYY-MM-DD..YYYY-MM-DD` in IST, inclusive, up to 31 days.
  - Bounds are half-open `[from, to)` in UTC, so an event exactly at the boundary appears once.
- **Filtering:** filings by publication time; market signals by session close.
- **Grouping:** by company, companies ordered by their strongest signal. Routine filings collapse to one line per company.
- **Duplicates:**
  - **What counts as the same filing:** the same attachment URL, a byte-identical attachment (known only after download), or the same subject within the duplicate window.
  - **Shown once:** the strongest copy is kept and the others are listed under it.
- **Empty windows:** the digest says nothing above routine happened, and names the latest material filing before the window.

## Alert rules

- **Kinds:**
  - `price_move`: threshold %, direction, minimum volume.
  - `volume_spike`: multiple, lookback, minimum history, minimum volume.
  - `announcement`: categories, minimum tier.
- **Scope:** the whole watchlist, or selected companies.
- **Storage:** rules are stored in SQLite (`alert_rule`) and validated by `RuleInputSchema` at the API boundary.
- **Versions:** an edit increments the version, and each alert stores the rule as it was when it fired.
- **Evaluation and delivery are separate:**
  - **Evaluation** (`evaluateRules`, pure) produces candidates with a dedupe key per *(rule, event)*.
  - **Storage** (`recordAlerts`) writes `alert_event` rows plus an `alert_delivery` row (`pending` → `seen`).
- **Deduplication:**
  - **One alert per rule per event:** an event never alerts twice for the same rule, across repeated ingestion, repeated evaluation, or rule edits.
  - **Same filing under another identity:** a filing that reappears under another id is checked against its suppressed duplicates.
- **Horizon:** evaluation looks back 10 days (`ALERT_HORIZON_DAYS`). Lowering a threshold can therefore alert on recent past sessions once.
- **Deleting a rule** keeps its past alerts.

## Explanations

Each signal carries:
- **What happened:** a factual sentence.
- **Why it surfaced:** each rule's reason, in order.
- **Rules that fired:** the rule ids.
- **Evidence:** the exchange filing link, extracted figures with page, or the price/volume series values.
- **Not known:** for example, the attachment has not been read, the cause of the move is unknown, or the intraday path is unknown.
- **Times:** the event time and the storage time.

## Limitations

- **Ranking reads only the filed subject** unless the attachment has been downloaded (live mode, via research or `ingest:documents`). A generic subject such as "Change in Management" stays at its category's starting tier.
- **Duplicate detection is partial in demo mode.** Byte-identical attachments are only known after download. In demo mode Reliance's "Unaudited Financial Results" and "Board Meeting Outcome…" appear separately, although the live database knows they are the same PDF.
- **Exchange holidays** are not modelled (freshness, session mapping and gaps).
- **Coverage of filings** is limited to the ~5 most recent per company (see [DATA.md](DATA.md)).
- **Single user, no push channel.** Data refresh is scheduled on the deployment, but alert evaluation is not.
- **Rule order in the Alerts screen** is by creation time; seeded rules share a timestamp.

## Commands

```bash
npm run finn -- brief --window 7d
```

```bash
npm run finn -- alerts:evaluate
```

Tests: `src/push/push.test.ts`. They cover threshold boundaries, both directions, adjusted series, insufficient history, zero volume, duplicates, window boundaries, rule changes, multiple signals from one event, missing data, stable ranking and idempotent evaluation.

## In the app (2026-11-02)

- **Watchlist scope.** The feed and alert rules cover the stored watchlist (`/watchlist`). It is seeded once from the configured portfolio and editable after that. An empty watchlist produces an explained empty feed.
- **Demo clock.** In demo mode, windows are measured from `FINN_DEMO_NOW` (default 1 Nov 2026, 16:00 IST), shown on Signals as "Demo clock fixed at …". Live mode uses the real clock.
- **Remembered window.** The chosen window is saved as a preference and used when `/` is opened without one.
- **Company focus.** A company from the watchlist preselects the company filter (`/?company=nse:…`). A company not on the watchlist gets a note instead of a silently empty feed.
- **Alert settings.** Each rule states its condition in plain words. Its generated name follows its parameters unless the user renamed it, so a rule cannot be called "±5%" while firing at 4%.
