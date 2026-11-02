# Demo walkthrough

To see FINN on current data instead, open the live deployment at https://129-154-248-25.sslip.io (live mode, refreshed on weekdays; see the README's "When data updates").

A repeatable demonstration of FINN's two workflows in demo mode. No network access, no API key and no manual database edits are needed. The demo clock is fixed at 1 Nov 2026, 16:00 IST, so every run shows the same signals.

## Setup (once)

```bash
npm ci
```

```bash
npm run setup:demo
```

```bash
npm run build
```

```bash
npm start
```

Open http://localhost:3000 on a laptop or a phone. On a phone, use the machine's LAN address, e.g. `http://192.168.1.20:3000`.

To reset the demo database to its initial state (watchlist, rules and preferences included), delete `data/finn-fixture.sqlite` and run `npm run setup:demo` again.

## What is real and what is illustrative

- **Prices and filings:** real provider responses recorded on 1 Nov 2026 and replayed. They are not current market data. Every page and signal carries a "Demo data" tag, and Signals shows the fixed demo clock.
- **Research:** reports for RELIANCE, LT and KAYNES were produced by live runs against BSE filings and recorded verbatim. Every figure and quote links to the original BSE or company document, so a reviewer can check them against the source. Other companies show "No recorded report" in demo mode; nothing is generated to fill the gap.
- **Not used in the recorded reports:** no model was configured, so sections that need one fall back to quoted passages and computed observations. The reports say so.

## Workflow 1: what matters today (Signals)

1. **Open Signals** (`/`).
   - The header gives the material count for the window (high and medium priority), and the window selector is above the list.
   - On a phone, a one-line status shows "Demo data · Prices recorded · Filings recorded"; tap "Details" for the sources.
2. **Find the important event.**
   - The list is ordered by significance. On a phone the first item is pulled out as "Top signal".
   - In the 7-day window this is Larsen & Toubro's M&A filing (business transfer to L&T Vyoma), ranked high by the M&A rule.
3. **Inspect the evidence.**
   - Select the signal. The detail separates three things:
     - **Reported:** the filed subject, publication time, and a link to the BSE PDF.
     - **FINN's assessment:** the ranking rules that fired, as codes.
     - **Not known:** what FINN cannot tell from the data.
   - Then select Reliance's results signal. Demo mode does not download documents, so it says there are no checked figures yet and points to Research, where the recorded report has them. On the live site, the weekday refresh reads each new results filing, and the signal shows a results first cut: Revenue, EBITDA, PBT and PAT with QoQ and YoY, linked to the statement's page.
4. **Filter.** Choose a company, a category or a minimum priority, or switch off price moves or volume. An impossible combination explains itself and offers "Clear filters".

## Workflow 2: research a company

5. **Search.**
   - From a signal, "Research RELIANCE" opens the research view with the company already selected.
   - Alternatively, on Research, type `Reliance` (name or NSE symbol), or use the search palette (Ctrl K or the search icon).
   - A "Recorded demo report" banner states when the report was recorded and from what.
6. **Financial performance.**
   - Section 2 gives Q2 FY27 revenue ₹3,32,861 Cr (+6.7% QoQ, +28.6% YoY), PAT ₹29,250 Cr and the derived EBITDA margin.
   - Section 3 is the table. Switch "Quarters" / "H1 / 9M / FY" and consolidated / standalone. Each row cites its page.
   - Open any citation: the panel shows the passage, the value as printed (e.g. 332,861), the stated unit (₹ crore), the conversion, and the period and basis. It marks the figure as a reported fact or as computed by FINN.
7. **Guidance versus actuals.**
   - Section 5 lists management statements, numeric targets first.
   - Section 6, "Narrative vs numbers", is grouped by call, e.g. "Jul 2026 call · *likely Q1 FY27 results*". The quarter is inferred from the call month and labelled as such.
   - Each numeric statement shows target, horizon, actual, variance and a worded assessment ("Within the stated range", "Not yet reported", "Not assessable" with the reason). In these recordings no target could be checked against a reported figure, and the page says exactly that rather than implying a score.
8. **Partial and missing data.**
   - Open LT or KAYNES. "Partial research: no financial figures…" appears, because no results filing was among the recent announcements FINN could see.
   - The empty sections collapse to a one-line reason.
   - Searching for a symbol FINN does not know (e.g. `NOSUCHCO`) gives "Company not verified", with the reason that demo mode cannot verify new listings.

## Supporting screens

- **Watchlist** (`/watchlist`):
  - Each company shows its last close and 1D change, signals from the last 7 days, and whether research exists, with links to its signals and research.
  - Add or remove a company; the feed and alert rules follow.
- **Alert settings** (`/alerts`):
  - Change the price-move threshold. The rule's plain-language condition updates, and so does its name unless you renamed it.
  - Save and reload: the rule keeps its new version.
