# FINN

A mobile-first investment intelligence prototype for an Indian equity portfolio, built for the ENAM AI Engineer Build Challenge.

- **Signals (push):** a ranked digest of watchlist filings, end-of-day price moves and volume spikes, with alert rules.
- **Research (pull):** company research built only from primary documents, with a financial table, a guidance-versus-actuals scorecard and a passage behind every figure and quote.

FINN is a prototype. It has not been deployed to a public URL, it has no user accounts, and its data sources are limited (see [Known limitations](#known-limitations)).

## Requirements

- Node.js **20.12 or later** (developed on 20.15.0) and npm 10.
- A C/C++ toolchain is **not** normally needed: `better-sqlite3` ships prebuilt binaries for current Node versions on Windows, macOS and Linux.
- About 500 MB of disk for dependencies and the build. Live mode stores downloaded filings under `FINN_DATA_DIR`.

## Quick start (demo mode, offline)

```bash
npm ci
```

```bash
npm run setup:demo
```

```bash
npm run dev
```

Open http://localhost:3000. Demo mode is the default when no `.env` exists. `setup:demo` creates `data/finn-fixture.sqlite`, applies the migrations, loads the company universe, and ingests the recorded price and filing fixtures. It makes no network calls.

## Configuration

Copy the template and edit it. Never commit `.env`.

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|---|---|---|
| `FINN_DATA_MODE` | `fixture` | `fixture` = recorded demo data; `live` = real providers. Each mode has its own database file. |
| `FINN_DATA_DIR` | `data` | SQLite database and downloaded documents. Use a persistent disk, not a cloud-synced folder. |
| `FINN_DEMO_NOW` | `2026-11-01T10:30:00.000Z` | Demo mode only: the fixed "now" signal windows are measured from. Shown on screen as the demo clock. |
| `FINN_LLM_PROVIDER` | `auto` | `gemini`, `anthropic`, or `auto` (Anthropic if its key is set, else Gemini). |
| `GEMINI_API_KEY` | empty | Optional. Free Google AI Studio key; enables model-assisted research modules. Read on the server only. |
| `FINN_GEMINI_MODEL_EXTRACTION`, `FINN_GEMINI_MODEL_SYNTHESIS` | `gemini-3.5-flash-lite`, `gemini-3.6-flash` | Optional Gemini model overrides. `gemini-3.8-flash` is newer but returned 503 / no response when tested on 2 Nov 2026. |
| `ANTHROPIC_API_KEY` | empty | Optional, paid. Uses Claude for the same modules. |
| `FINN_MODEL_EXTRACTION`, `FINN_MODEL_SYNTHESIS` | `claude-haiku-5-5`, `claude-opus-5-5` | Optional Claude model overrides. |
| `FINN_ENABLE_DEV_ROUTES` | `false` | Exposes `/dev/design-system` in production builds. |

No variable is exposed to the browser: there are no `NEXT_PUBLIC_` variables, and the model client lives in server-only modules.

## Database and migrations

SQLite via `better-sqlite3`. Migrations are ordered SQL in `src/db/migrations.ts`, tracked with `PRAGMA user_version`. They are applied automatically whenever the app or the CLI opens the database. To apply them explicitly:

```bash
npm run finn -- migrate
```

The watchlist is seeded once from the portfolio in `config/universe.json`. After that, the stored watchlist is authoritative, including when it is empty.

## Data modes

| Mode | What you see | How it is labelled |
|---|---|---|
| **Demo** (`fixture`) | Real provider responses recorded on 1 Nov 2026, replayed with a fixed demo clock. Research for RELIANCE, LT and KAYNES is served from reports recorded from live runs (`fixtures/research/`). Other companies say "No recorded report". | A "Demo data" tag on every page and signal, the demo clock on Signals, "Recorded" instead of a freshness state, a "Recorded demo report" banner on research. Separate database file. |
| **Live** (`live`) | Yahoo end-of-day prices, screener.in-discovered exchange filings, BSE/company PDFs downloaded and parsed on demand. Any NSE symbol can be researched after it is verified against two sources. | Per-source freshness ("Current", "Stale", "Partial", "Unavailable") with the session or fetch time. |
| **Partial data** | Some sources or documents are missing: for example no results filing, a transcript that failed to download, a company with no price history. | Research shows "Partial research: no …" and replaces each empty section with a one-line reason. Signals show a banner per degraded source and name the affected companies. Missing values are shown as "—" with their reason, never as zero. |
| **Provider failure** | A provider is down or refuses requests. | The failed source is reported, and everything else still renders. Research lists each source with its state ("Download failed", "No readable text"). The feed keeps the other source's signals. Failed model calls fall back to quoted passages or computed observations, and the report says so. |

Demo data is never substituted in live mode. Fixture adapters and recorded reports are used only when `FINN_DATA_MODE=fixture`.

## Live data

```bash
FINN_DATA_MODE=live npm run finn -- universe:sync
```

```bash
FINN_DATA_MODE=live npm run finn -- ingest:prices
```

```bash
FINN_DATA_MODE=live npm run finn -- ingest:filings
```

```bash
FINN_DATA_MODE=live npm run finn -- ingest:documents --limit 25
```

Then run the app with `FINN_DATA_MODE=live` in `.env`. Research downloads what it needs on demand. To record a live research run as a demo report:

```bash
FINN_DATA_MODE=live npm run finn -- research --symbols RELIANCE --record
```

After upgrading the PDF library or changing the extractor, re-extract stored documents from their saved files (no network):

```bash
FINN_DATA_MODE=live npm run finn -- reextract
```

The providers and what was verified against them are listed in [docs/PROVIDERS.md](docs/PROVIDERS.md). FINN sends an honest user agent and never imitates a browser.

## Tests and checks

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm test
```

```bash
npm run test:e2e
```

- `npm test` runs the Vitest unit and integration tests: financial arithmetic with hand-worked expectations, parsers, ranking, rules, migrations, UI components, and integrity checks over the recorded research reports.
- `npm run test:e2e` runs Playwright against a **production build** in demo mode. It uses its own data directory (`.e2e-data`) and build directory (`.next-e2e`), so it never touches your database. One test removes a company's price history on purpose, to check behaviour when a source is unavailable. The first run needs `npx playwright install chromium`.

## Production build and start

```bash
npm run build
```

```bash
npm start -- -p 3000
```

`npm start` serves the built app. `FINN_DATA_MODE` and the other variables are read at request time, so set them in the process environment or in `.env` next to the app.

## Deployment

**Recommended shape:** one long-running Node.js process on a host with a persistent disk, behind an HTTPS reverse proxy. Examples are a small VM, or Render or Fly.io with a mounted volume. This shape follows from the architecture:

- **SQLite file:** the database must live on a persistent, non-network disk.
- **In-process research jobs:** these run inside the server process. They are lost if it restarts, and they do not span instances.
- **Native module:** `better-sqlite3` cannot run on serverless platforms such as Vercel functions.

Steps on the host:

1. Install Node 20.12+.
2. Copy the repository and run `npm ci`.
3. Set the environment (above). Point `FINN_DATA_DIR` at the persistent disk.
4. Load data: `npm run setup:demo` for demo mode, or the live ingestion commands.
5. Build and start: `npm run build`, then `npm start -- -p $PORT`.
6. Put HTTPS in front with a reverse proxy or the platform's router, and run a single instance.

**Oracle Cloud Always Free:** [docs/DEPLOY-ORACLE.md](docs/DEPLOY-ORACLE.md) walks through a free Arm VM. `deploy/oracle/` holds the setup script, the systemd services (the app, plus a weekday data refresh for live mode), the Caddy HTTPS config and an update script. These are written but not yet run on a real Oracle VM.

**Not done:** FINN has not been deployed. No hosting credentials were available while it was being built, and no container image was built or tested (Docker was not installed). A production build was verified locally (`next build`, then `next start`), including on a 375px mobile viewport. That is the extent of what can be claimed.

## Architecture in brief

- **Next.js App Router, server-rendered:** pages read SQLite directly on the server. Mutations go through small JSON API routes that validate input with zod, cap body sizes and return typed errors.
- **Separate layers:** domain types and calculations (`src/domain`, `src/research/facts-view.ts`), providers (`src/data`), persistence (`src/db`), the engines (`src/push`, `src/research`), and UI (`src/ui`, `src/app`). Financial arithmetic exists in one place and names its formula.
- **Deterministic first:**
  - Ranking, anomaly detection, results parsing (with arithmetic cross-checks) and guidance scoring are rule-based and tested.
  - The model is optional. Its output is schema-validated, and every claim must cite evidence that exists. Quotes must appear verbatim in their passage.
- **Provenance everywhere:** every figure carries the document, page, printed value and unit. Derived figures name their formula. Missing data carries a reason. Demo data is labelled at the source and on screen.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DATA.md](docs/DATA.md), [docs/PUSH.md](docs/PUSH.md), [docs/RESEARCH.md](docs/RESEARCH.md), [docs/PROVIDERS.md](docs/PROVIDERS.md), and the walkthrough in [docs/DEMO.md](docs/DEMO.md).

## Known limitations

- **Prices:** end-of-day only, from an unofficial Yahoo endpoint with no SLA. Never real-time.
- **Announcements:** only the most recent ~5 per company, discovered via screener.in. The BSE and NSE APIs require browser impersonation, which FINN does not do.
- **Results figures:** from the latest results filing only, typically 5–6 periods. The balance sheet and cash-flow statement are not parsed, so free cash flow, debt and debt-to-equity are shown as unavailable with the reason.
- **Model-assisted modules:** implemented for Google Gemini (free tier) and Anthropic Claude behind one interface. Neither was exercised against the real API (no key was available); the request and response handling is unit-tested against recorded API shapes. The recorded demo reports use the deterministic fallbacks. On Gemini's free tier, rate limits are per Google project and Google may use the inputs (public filings and your question) to improve its products.
- **Alerts:** evaluated on page load and on demand only. There is no background scheduler and no push channel.
- **Single user:** the watchlist, alert rules and preferences are shared by everyone using a server. There are no accounts and no per-user isolation.
- **No OCR and no exchange holiday calendar.**
- **Dependency advisories (`npm audit --omit=dev`, 2 Nov 2026):** three remain, each needing a major upgrade:
  - `zod` (memory use on oversized collections): mitigated, because API bodies are size-capped (1–16 KB) before validation.
  - `postcss` via `next`: build-time CSS processing, with no untrusted CSS involved.
  - `next` itself (moderate).

  Upgrading `unpdf` to 1.8.1 removed the other seven, including a critical one in `tar`. The re-extraction gave the same figures, and one more of them now passes the arithmetic checks.
