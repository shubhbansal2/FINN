# FINN — Technical Architecture

Status: implemented and deployed (live mode, https://129-154-248-25.sslip.io). Sections 0–6 are the original design from 2026-11-01. The numbered "Revisions" list below records where implementation changed it, and wins where they differ. Last updated 2026-11-03.

FINN is a mobile-first investment intelligence app with two modes:

- **Push — the Brief.** A ranked, windowed digest of portfolio filings plus threshold alerts on end-of-day (EOD) price and volume.
- **Pull — the Dossier.** On-demand research on any NSE company, grounded only in primary documents (annual reports, concall transcripts, results filings), with every claim traceable to a page.

This document defines boundaries, the data model, key decisions, the build sequence, and what is deliberately out of scope.

---

## 0. Repository inspection (2026-11-01)

| Question | Finding |
|---|---|
| Existing files / dependencies | None. The project directory is empty; no `package.json`, lockfile, or source. |
| New or partial? | New (greenfield). Nothing to preserve or migrate. |
| Version control | Not a git repository. `git init` is part of Milestone 0. |
| Runtime / framework configured | None configured. Available on the dev machine: Node 20.15.0, npm 10.7.0, Python 3.12.4. |
| Tests | None. |
| Environment variables | None; no `.env` or `.env.example`. |
| Deployment settings | None. |
| Reusable components / design conventions | None. Conventions are defined in §1.1 and are established in Milestone 0. |

### Provider verification status

**Nothing below is verified.** An automated reachability probe was attempted on 2026-11-01. It was blocked because the NSE endpoint requires browser-impersonating headers and cookie replay, which this project will not do. Milestone 0.5 exists to verify each provider honestly before any code depends on it. Until a provider is verified, treat it as **unknown**.

| Provider | Intended use | Access model (as understood, unverified) | Status |
|---|---|---|---|
| Yahoo Finance chart endpoint (via `yahoo-finance2`) | EOD price/volume | Unofficial, undocumented JSON endpoint; no SLA; may rate-limit or change | Unverified |
| BSE announcements API (`api.bseindia.com`) | Corporate announcements, attachments | Public JSON used by bseindia.com; undocumented; may require a Referer header | Unverified |
| NSE announcements API (`nseindia.com/api/...`) | Corporate announcements | Known to require session cookies from the homepage and browser-like headers | Unverified; **not used** unless access is legitimate without circumvention |
| screener.in company pages | Links to annual reports and concall transcripts | Public HTML; scraping terms to be checked | Unverified |
| Exchange-hosted PDFs (BSE/NSE archives) | Document content | Static files | Unverified |

---

### Revisions after implementing the data foundation (2026-11-01)

The sections below are the original design. Where implementation changed a decision, this list wins.

1. **Providers verified.** See [PROVIDERS.md](PROVIDERS.md).
   - Yahoo chart: works. BSE attachment PDFs: work. screener.in pages: work.
   - The BSE announcements JSON API is unavailable to an honest client, and is not implemented.
2. **Announcements come from screener.in discovery**, not a BSE API adapter. FINN keeps the filed title, timestamp and exchange-hosted link, and ignores screener's summaries. Limit: the ~5 most recent filings per company.
3. **Raw SQL migrations over `better-sqlite3`, not Drizzle.** The CHECK constraints carry the data-integrity rules and read more clearly as SQL. Repositories are typed by hand in `src/db/repositories.ts`, and validated with zod where data re-enters the domain (financial facts).
4. **One database file per data mode** (`finn-live.sqlite`, `finn-fixture.sqlite`) instead of a `data_mode` filter on every query. Demo and live data cannot mix by construction.
5. **BSE listings carry two identifiers.** The scrip code (`500325`) is the exchange id. The trading symbol (`RELIANCE`) is the provider ticker, giving Yahoo `RELIANCE.BO`. Yahoo does not resolve `500325.BO`.
6. **Document storage is three tables:**
   - `document`: metadata and origin;
   - `document_version`: one row per content hash, with extraction status;
   - `document_segment`: page- or section-located text.

   The original `passage` table and the FTS5 index arrive with retrieval (M5/M7).
7. **No worker process or job table yet.** Ingestion runs from the CLI (`scripts/finn.ts`). The worker described in §1.2 is still the plan once scheduling is needed.
8. **Research engine (M5–M7)** is described in [RESEARCH.md](RESEARCH.md).
   - **Financial facts:** a deterministic Reg. 33 parser, arithmetic-checked, rather than LLM table extraction.
   - **Model role:** the model only filters, labels and writes from verified evidence.
   - **Synchronous runs:** research runs synchronously in the API request (in-process, one run per company at a time) rather than via the worker; a first run takes ~30–60 s.
   - **Passage storage:** `chunk` + FTS5 replace the planned `passage` table.
   - **Guidance:** `management_statement` replaces `guidance_statement`; verdicts are computed at report time, not stored.
9. **Integration, review and demo readiness (2026-11-02).**
   - **Research jobs:** research now runs as an in-process job (`src/server/research-jobs.ts`). It reports stages and per-source progress, which the UI polls, and the report is returned only when the job finishes. Limits: at most 2 concurrent jobs, a global hourly cap, and loss of jobs on restart.
   - **Demo reports:** demo mode serves research reports recorded from live runs (`fixtures/research/`, written by `research --record`). Integrity tests check every citation in them.
   - **Watchlist and preferences:** these are stored in SQLite (migration 7). The feed and alert rules cover the watchlist, not the static portfolio role. There is a single shared user, with no accounts.
   - **Demo clock:** demo mode measures windows from a fixed demo clock (`FINN_DEMO_NOW`), so recorded data stays in its windows. The clock is shown on Signals.
   - **One company identifier:** the canonical id (`nse:reliance`) is used across signals, watchlist and research (`/research?company=…`). The resolver accepts it directly.
   - **Evidence identity:** fact evidence ids include the period. Before this, two columns on one page shared a citation. Passages are windowed around their quotes.
   - **End-to-end tests:** Playwright runs against a production build in demo mode (`npm run test:e2e`).
10. **Model provider, interface and deployment (2026-11-03).**
    - **Gemini:** the free Google Gemini API is the default provider (`FINN_LLM_PROVIDER`), alongside Anthropic Claude behind the same `LlmClient`.
      - Extraction uses `gemini-3.5-flash-lite` and synthesis `gemini-3.6-flash`.
      - An overloaded synthesis model falls back to the extraction model. A report built with any failed or fallback call is not reused from the cache.
    - **Interface:**
      - typefaces: Libre Caslon Text (headings), Libre Franklin (text) and Roboto Mono, with Public Sans digits for tabular figures;
      - a signal-bars wordmark;
      - a light, dark or system theme switch, stored per browser.
    - **Deployment:** one Oracle Cloud Always Free Arm VM (`deploy/oracle/`).
      - `next start` runs behind Caddy, which provides automatic HTTPS.
      - SQLite lives on the boot volume.
      - A systemd timer refreshes prices and filings on weekdays at 10:00 and 17:00 IST, in place of the worker in §1.2.
    - **Results first cut on the push side:** `ingest:results` parses new results filings with the research parser (shared via `storeResultsFacts`). A results signal then carries Revenue, EBITDA, PBT and PAT with QoQ and YoY, built only from that filing's facts (`src/push/first-cut.ts`).

## 1. System boundaries

### 1.1 Responsibilities

**Responsive frontend** (`src/app`, `src/ui`)
- Renders the Brief, the Dossier, the evidence viewer, and settings.
- Owns no business logic. It formats DTOs from the API and calls nothing but FINN's own API.
- Renders untrusted filing text only as text nodes, never `dangerouslySetInnerHTML`.
- Design conventions, set in Milestone 0:
  - Single-column mobile layout from 360px; two-pane layout (list + detail) at ≥ 1024px.
  - Information is shown as dense list rows with progressive disclosure, not a grid of cards.
  - Tabular numerals for every figure.
  - Colour carries state only: up, down, alert, stale, unverified. It is never decorative.
  - Design tokens are CSS custom properties in `src/ui/tokens.css`, with light and dark themes.
  - Every figure on screen is either tappable to its source or explicitly labelled as derived.

**API and application services** (`src/app/api`, `src/services`)
- Next.js Route Handlers form a thin HTTP layer: validate input (zod), call a service, map the result to a DTO.
- Services orchestrate domain logic and repositories, e.g. `BriefService`, `AlertService`, `ResearchService`, `EvidenceService`.
- This layer enforces rate limits, input-size limits, and the access code for expensive operations.

**Market data ingestion** (`src/data/adapters/prices`)
- Fetches daily OHLCV bars per listing and upserts them idempotently on `(listing, trade_date)`.
- Records each fetch attempt in `source_fetch` for provenance and freshness.
- After each ingest, triggers alert-rule evaluation.

**Corporate announcement ingestion** (`src/data/adapters/announcements`)
- Fetches announcements per company for a date window and dedupes on the exchange's own reference ID.
- Maps exchange categories to the FINN taxonomy (rules first, cheap-model fallback).
- Registers attachments as `document` rows to fetch later. It never fetches inline.

**Financial document ingestion** (`src/data/documents`)
- Discovers document links (screener.in, announcement attachments).
- Downloads with size and type limits, hashes and dedupes, parses page by page, chunks into passages, and indexes them for full-text retrieval.

**Financial calculations** (`src/domain/finance`)
- Pure, deterministic TypeScript functions with no I/O: period alignment, QoQ/YoY growth, margins, derived EBITDA, leverage, cash conversion, guidance-versus-actual verdicts, unit normalisation.
- The single source of truth for any number FINN computes. The LLM never does arithmetic that reaches the UI.

**AI extraction and analysis** (`src/ai`)
- `ModelRouter` maps each task to a model tier. Prompts are versioned modules; outputs are schema-validated; a response cache sits in front.
- Tasks:
  - classify an ambiguous announcement;
  - extract a results table;
  - extract guidance statements;
  - extract an appointee profile from a filing;
  - write a research section from supplied evidence.
- The layer produces **candidates**. Candidates become facts or claims only after deterministic verification (§3.7).

**Persistent storage** (`src/db`)
- SQLite (WAL mode) through Drizzle ORM. Schema, migrations, and repositories live here.
- FTS5 virtual table over passages for retrieval.
- Raw downloaded files are stored on disk under `DATA_DIR/blobs/<sha256>`, with metadata in the database.

**Caching and background processing** (`src/jobs`, `scripts/worker.ts`)
- A durable job queue in a SQLite `job` table with leases, attempts, and backoff. Job types: `ingest_prices`, `ingest_announcements`, `fetch_document`, `parse_document`, `extract_results`, `build_research_report`, `evaluate_alerts`.
- Caches:
  - LLM response cache (`llm_call` table);
  - HTTP conditional-request metadata (ETag / Last-Modified) on `source_fetch`;
  - parsed documents, which are cached implicitly by content hash.
- The scheduler runs EOD ingest after market close (default 18:30 IST), polls announcements every 30 minutes during 09:00–20:00 IST, and accepts manual triggers.

### 1.2 Process topology

**Two processes, one codebase, one database.**

```
┌──────────────────────────── single host ────────────────────────────┐
│  web  (next start)                      worker  (tsx scripts/worker)│
│  ├─ UI (RSC + client components)        ├─ scheduler (cron-like)    │
│  ├─ Route Handlers  ──► services        ├─ job runner (leases)      │
│  └─ reads; enqueues jobs                ├─ adapters (HTTP out)      │
│                                         ├─ PDF parse / chunk        │
│                                         └─ AI extraction            │
│                  └──────────► SQLite (WAL) + blob dir ◄──────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

**Why the web and worker processes are separate.**
- Document download, PDF parsing, and multi-call LLM analysis take tens of seconds to minutes. That exceeds request timeouts and would block request handling.
- A separate worker keeps API latency predictable.
- A provider outage or a slow PDF cannot degrade the UI.
- Retries survive process restarts.

**Why not more services.**
- At the scale of 20 companies and one user, a message broker (Redis/SQS), a separate vector database, or per-adapter microservices would add deployment and failure surface without benefit.
- The SQLite job table gives durability, leasing, and inspection for free.
- Both processes import the same domain types, so no internal API contract has to be versioned.

**Upgrade path, not built now.** Swap SQLite for Postgres (Drizzle supports both) and the job table for a queue when there are multiple users or hosts.

### 1.3 Technology choices

| Concern | Choice | Concrete reason |
|---|---|---|
| Language | TypeScript, `strict: true`, `noUncheckedIndexedAccess: true` | One type system from adapter to UI; DTOs shared by web and worker |
| Web framework | Next.js (App Router), version pinned at scaffold | Server-only modules keep secrets off the client; Route Handlers and UI in one deployable unit |
| Market data | `yahoo-finance2` (Node) instead of Python `yfinance` | Both wrap the same unofficial Yahoo endpoint. The Node library avoids a second runtime, a second dependency tree, and a cross-language boundary for one adapter. |
| DB / ORM | SQLite via `better-sqlite3` + Drizzle | Zero-ops; synchronous, fast reads; FTS5 built in; typed schema and migrations; portable to Postgres |
| Validation | zod | Boundary validation for provider payloads, LLM outputs, env vars, and API input from one schema definition |
| PDF text | `unpdf` (pdf.js) | Per-page text extraction in Node with no native build step, so page numbers for citations are exact |
| HTML parsing (screener) | `cheerio` | Small, no headless browser |
| Retrieval | SQLite FTS5 (BM25) + section heuristics | Financial documents use exact vocabulary ("EBITDA margin", "capex", "guidance"). Lexical search is precise, free, and deterministic. Embeddings are deferred until retrieval quality demonstrably fails. |
| LLM | Provider-agnostic `LlmClient` interface; default Anthropic (Claude Haiku 5.5 for bulk extraction, Claude Sonnet 5.5 for synthesis). **Open decision**, see §6. | Routing by task tier; structured output via tool/JSON schema; prompt caching on long document context |
| Styling | CSS Modules + design tokens (no UI kit) | Small dependency surface; forces a deliberate visual system instead of kit defaults |
| Tests | Vitest; Playwright for one mobile and one desktop smoke flow | Fast unit tests for pure domain code; real-browser check of primary workflows |
| Hosting | One Node host with a persistent disk (e.g. Render or Railway). **Open decision**, see §6. | SQLite and the blob dir need a durable disk. The worker needs a long-running process, which serverless does not provide. |

---

## 2. Core data model

### 2.1 Conventions

- IDs are text ULIDs. Timestamps are UTC ISO-8601. Exchange-local times are converted from IST at ingestion, and the original string is retained.
- **Missing is never zero.**
  - Numeric value columns are nullable.
  - Every nullable financial value is paired with a status column that says *why* it is null.
  - Database `CHECK` constraints enforce that `value IS NULL` exactly when the status is a "missing" status.
- Money is stored in absolute rupees (`REAL`). Reported values are also kept exactly as printed (`value_raw` text plus `unit_scale`), so a normalisation bug can be audited.
  - Doubles represent integers exactly up to about 9×10¹⁵, comfortably above the largest Indian company revenue in rupees.
  - Rounding happens only at display.
- Every ingested row references the `source_fetch` that produced it.
- `data_mode` (`live` | `fixture`) is carried on `source_fetch` and propagates through every query to the UI.
- Single-user prototype: there is no `user` table. Alert rules and settings are global. Adding `user_id` later is mechanical.

### 2.2 Entities

```
company 1─* listing 1─* price_bar
company 1─* announcement *─1 document (attachment, optional)
company 1─* document 1─* passage
company 1─* financial_fact *─1 document, *─1 passage (optional)
company 1─* guidance_statement *─1 passage
company 1─* research_report 1─* research_section 1─* claim 1─* claim_citation *─1 passage
alert_rule 1─* alert_event
source_fetch 1─* (price_bar | announcement | document)
```

#### `company`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| name | text | Legal or common name as listed |
| isin | text unique null | Primary cross-exchange key when known |
| sector, industry | text null | From the exchange master or manual seed; never LLM-inferred |
| reporting_profile | enum `industrial` \| `bank` \| `nbfc` \| `insurance` | Drives which metrics apply. Banks and insurers have no EBITDA (`not_applicable`). |
| in_portfolio | bool | Membership of the demo portfolio |
| created_at | timestamp | |

#### `listing` (exchange ticker)
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| company_id | FK company | |
| exchange | enum `NSE` \| `BSE` | |
| symbol | text | NSE symbol (e.g. `RELIANCE`) or BSE scrip code (e.g. `500325`) |
| provider_symbol | text | e.g. Yahoo `RELIANCE.NS` |
| currency | text default `INR` | |
| is_primary | bool | The listing used for price alerts |
| active | bool | |
| | unique(exchange, symbol) | |

#### `price_bar` (daily observation)
| Column | Type | Notes |
|---|---|---|
| listing_id | FK | PK part |
| trade_date | date | PK part; exchange-local trading date |
| open, high, low, close | real null | Null only if the provider omitted the field. A non-trading day has **no row**, not a zero row. |
| adj_close | real null | Provider-adjusted for splits and dividends; used for return calculations |
| volume | integer null | |
| source_fetch_id | FK source_fetch | |
| | PK(listing_id, trade_date) | Upsert is idempotent |

#### `source_fetch` (provenance for every external read)
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| provider | text | `yahoo`, `bse`, `nse`, `screener`, `exchange_pdf`, `fixture` |
| data_mode | enum `live` \| `fixture` | |
| request_key | text | Normalised description, e.g. `announcements:BSE:500325:2026-10-31..2026-11-01` |
| started_at, finished_at | timestamp | |
| status | enum `ok` \| `partial` \| `unavailable` \| `invalid_payload` | |
| http_status | int null | |
| item_count, rejected_count | int | Rejected = failed schema validation |
| error_message | text null | Truncated; never contains secrets |
| etag, last_modified | text null | For conditional re-fetch |

#### `announcement`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| company_id | FK | |
| exchange | enum | |
| exchange_ref | text | Exchange's own ID; `unique(exchange, exchange_ref)` dedupes |
| headline | text | As filed |
| body_text | text null | As filed (plain text) |
| exchange_category, exchange_subcategory | text null | Raw values, kept for audit |
| category | enum (FINN taxonomy, §2.3) | |
| category_method | enum `rule` \| `llm` \| `manual` | |
| category_confidence | real null | Rules = 1.0; LLM = model-reported, used only for display ordering of uncertain items |
| published_at | timestamp | Exchange dissemination time |
| attachment_document_id | FK document null | |
| summary_line | text null | One-line summary, if generated (claim-like: cites the attachment) |
| source_fetch_id | FK | |

Materiality scores are **not stored**. They are computed at read time from the current rule weights, so changing weights takes effect immediately without a backfill.

#### `document` (source document)
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| company_id | FK | |
| kind | enum `annual_report` \| `concall_transcript` \| `results_filing` \| `investor_presentation` \| `announcement_attachment` | |
| title | text | |
| fiscal_year | int null | Indian FY, e.g. 2026 = Apr 2025–Mar 2026 |
| fiscal_quarter | int null | 1–4 |
| filed_at | timestamp null | |
| content_sha256 | text unique null | Null until downloaded; the dedupe key |
| mime_type, byte_size, page_count | | |
| blob_path | text null | |
| fetch_status | enum `pending` \| `fetched` \| `failed` \| `too_large` \| `unsupported_type` | |
| parse_status | enum `pending` \| `parsed` \| `no_text_layer` \| `failed` | `no_text_layer` = scanned PDF; OCR is out of scope |
| parse_error | text null | |
| source_fetch_id | FK null | |

#### `document_url`
Many URLs can resolve to one document: the same PDF can appear both via screener and via a BSE attachment.

| Column | Type | Notes |
|---|---|---|
| url | text PK | Canonicalised |
| document_id | FK | |
| discovered_via | text | e.g. `screener:RELIANCE`, `bse_announcement:<ref>` |

#### `passage` (evidence chunk)
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| document_id | FK | |
| ordinal | int | Order within the document |
| page_start, page_end | int | 1-based. Chunks never span more than 2 pages, so citations stay precise. |
| section_hint | text null | Detected heading (e.g. "Management Discussion and Analysis") |
| text | text | Extracted plain text, whitespace-normalised |
| text_sha256 | text | |
| | FTS5 shadow table `passage_fts(text, section_hint)` | |

#### `financial_fact`
One reported or derived value, for one metric, one period, one statement scope, from one source.

| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| company_id | FK | |
| statement_scope | enum `consolidated` \| `standalone` | Required. Facts from different scopes are never mixed in one calculation (enforced in the domain layer). |
| period_type | enum `quarter` \| `half_year` \| `nine_months` \| `annual` | |
| period_start, period_end | date | |
| fiscal_label | text | e.g. `Q2 FY27`, `FY26` |
| metric | enum (§2.4) | e.g. `revenue_from_operations`, `pbt`, `pat`, `finance_costs`, `depreciation_amortisation` |
| value | real null | In absolute `currency` units (or the metric's natural unit for ratios and counts) |
| value_raw | text null | Exactly as printed, e.g. `"2,35,481.00"` or `"(1,204.5)"` |
| unit | enum `currency` \| `percent` \| `ratio` \| `count` \| `days` | |
| unit_scale | enum `one` \| `thousand` \| `lakh` \| `million` \| `crore` \| `billion` null | As printed in the table header |
| currency | text null | `INR` for currency units; null otherwise |
| value_status | enum `reported` \| `derived` \| `not_reported` \| `not_applicable` \| `unparseable` | `CHECK ((value IS NULL) = (value_status IN ('not_reported','not_applicable','unparseable')))` |
| audit_status | enum `audited` \| `reviewed` \| `unaudited` \| `unknown` | |
| document_id | FK document | Required for `reported`; for `derived`, the document of its inputs |
| passage_id | FK passage null | |
| source_location | json | `{page, table_label, row_label, column_label}`, e.g. row "Finance costs", column "Quarter ended 30.09.2026" |
| extraction_method | enum `llm_table_extraction` \| `rule_parser` \| `derived_formula` \| `manual_entry` | |
| extractor_version | text | Prompt version + model ID, or formula ID (e.g. `ebitda.v1`) |
| derived_from | json null | `{formula: 'ebitda.v1', inputs: [fact_id…]}` |
| verification_status | enum `unverified` \| `checks_passed` \| `check_failed` \| `human_verified` | |
| verification_notes | text null | Which check failed and by how much |
| created_at | timestamp | |
| | unique(company_id, statement_scope, period_type, period_end, metric, document_id) | Several sources for one fact can coexist. A deterministic selector picks the canonical one: latest filed, prefer audited, prefer `checks_passed`. |

#### `guidance_statement`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| company_id | FK | |
| document_id, passage_id | FK | The transcript or report it came from |
| quote | text | Verbatim span; must be found in `passage.text` (§3.7) |
| speaker | text null | As attributed in the transcript |
| stated_period | text | The quarter in which it was said, e.g. `Q4 FY26` |
| target_metric | enum `revenue_growth` \| `ebitda_margin` \| `pat_growth` \| `capex` \| `volume_growth` \| `other` | |
| target_metric_detail | text null | Free text when `other` |
| target_period | text null | e.g. `FY27`; null if unspecified (then not assessable) |
| guidance_type | enum `point` \| `range` \| `directional` \| `qualitative` | |
| low, high | real null | For point (`low = high`) or range |
| unit | enum `percent` \| `currency` \| `count` | |
| direction | enum `up` \| `down` \| `flat` null | |
| conditions | text null | e.g. "subject to raw-material prices" |
| extraction_method, extractor_version | | |
| verification_status | enum `quote_verified` \| `quote_not_found` | `quote_not_found` rows are never shown |

#### `guidance_assessment`
The promise-ledger row: deterministic comparison of guidance against facts.

| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| guidance_id | FK | |
| actual_fact_ids | json | Inputs used |
| actual_value | real null | Computed by `domain/finance` |
| verdict | enum `met` \| `missed` \| `within_range` \| `too_early` \| `not_measurable` \| `insufficient_data` | |
| method | text | Formula ID, e.g. `growth_vs_range.v1` |
| computed_at | timestamp | |

#### `research_report`, `research_section`, `claim`, `claim_citation`
| Entity | Key columns |
|---|---|
| research_report | id, company_id, status (`queued` \| `running` \| `complete` \| `partial` \| `failed`), input_document_ids (json), input_hash (sha256 of document hashes + prompt versions; the report cache key), model_routing (json), token_usage (json), estimated_cost_usd, error, created_at, completed_at |
| research_section | id, report_id, kind (`business` \| `financial_snapshot` \| `trajectory` \| `balance_sheet` \| `cash_quality` \| `narrative_vs_numbers` \| `guidance` \| `bull_bear`), status (`complete` \| `insufficient_evidence` \| `failed`), ordinal |
| claim | id, section_id, text, claim_type (`sourced_fact` \| `quotation` \| `inference`), fact_ids (json null; numbers in the claim must come from these), verification_status (`verified` \| `unverified`), ordinal |
| claim_citation | claim_id, passage_id, quote (span), quote_found (bool), match_score (real) |

An `inference` claim must still cite the passages it reasons from. It is displayed with an "Analysis" label, distinct from sourced statements.

#### `alert_rule`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| kind | enum `price_move` \| `volume_spike` \| `announcement_category` | |
| scope | enum `portfolio` \| `company` | |
| company_id | FK null | Required when scope = company |
| params | json | Validated per kind by zod. `price_move {threshold_pct, basis:'close_to_close'}`; `volume_spike {multiple, lookback_sessions, min_history_sessions}`; `announcement_category {categories[]}` |
| enabled | bool | |
| created_at, updated_at | timestamp | |

Defaults are seeded: price move ±5%, volume 2× its 20-session average, categories results / M&A / management_change / fund_raise / litigation / credit_rating / pledging.

#### `alert_event`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| rule_id | FK | |
| rule_snapshot | json | The rule's params when it fired; rules can later change |
| company_id | FK | |
| subject_date | date | Trading date or announcement date |
| announcement_id | FK null | |
| observation | json | e.g. `{close_change_pct:-6.2, volume:…, avg_volume_20:…, ratio:3.1, sessions_used:20}` |
| dedupe_key | text unique | `rule_id:company_id:subject_date[:announcement_id]`; re-evaluation never duplicates |
| data_mode | enum | Inherited from the inputs |
| created_at, seen_at | timestamp | |

#### Operational tables
- **`llm_call`:** cache_key (unique), task, model, prompt_version, input_tokens, output_tokens, cache_read_tokens, latency_ms, status, response_json, error, created_at.
- **`job`:** id, type, payload (json), dedupe_key (unique while pending/running), status, attempts, max_attempts, run_after, lease_until, last_error, created_at, updated_at.

### 2.3 Announcement taxonomy

The 17 categories from the reference document are adopted unchanged:

`results`, `ma`, `fund_raise`, `management_change`, `litigation`, `insider_trading`, `earnings_call`, `investor_meetings`, `credit_rating`, `dividend`, `bonus_split`, `capex`, `press_release`, `postal_ballot`, `agm_egm`, `pledging`, `unclassified`.

Each category carries a default weight (user-adjustable) and a default treatment:

| Treatment | Categories | Presentation |
|---|---|---|
| **Expanded with enrichment** | results, management_change | Results first-cut table; appointee profile from the filing |
| **Expanded with one-line summary** | ma, fund_raise, litigation, credit_rating, pledging, capex | Summary cites the attachment |
| **Listed** | dividend, bonus_split, insider_trading, press_release | Headline + key field (e.g. record date) |
| **Collapsed** | earnings_call, investor_meetings, postal_ballot, agm_egm, unclassified | One line per company: "N routine filings" |

### 2.4 Metric registry

`src/domain/finance/metrics.ts` is the single registry. For each metric it defines the code, the label, the unit, which reporting profiles it applies to, and whether it is reported or derived.

Initial set: `revenue_from_operations`, `other_income`, `total_income`, `total_expenses`, `finance_costs`, `depreciation_amortisation`, `exceptional_items`, `pbt`, `tax_expense`, `pat`, `pat_attributable_to_owners`, `ebitda` (derived), `ebitda_margin` (derived), `pat_margin` (derived); later, annual-report balance-sheet and cash-flow lines.

---

## 3. Architecture decisions

### 3.1 Source adapters

Each provider implements:

```ts
interface SourceAdapter<Req, Item> {
  readonly provider: ProviderId;
  fetch(req: Req, ctx: FetchContext): Promise<AdapterResult<Item>>;
}

type AdapterResult<Item> =
  | { status: 'ok' | 'partial'; items: Item[]; rejected: RejectedItem[]; fetchedAt: string; meta: FetchMeta }
  | { status: 'unavailable'; reason: UnavailableReason; fetchedAt: string; meta: FetchMeta };
```

- **Expected failures are values.** Timeouts, 4xx/5xx responses, and schema mismatches are returned as results, not thrown, so callers must handle them (the type system enforces this). Programming errors still throw.
- **Raw payloads are validated with zod at the boundary.** Invalid items go into `rejected` with a reason; valid siblings still ingest (`partial`).
- **A shared `HttpClient` handles transport.**
  - Per-host concurrency of 1 and a minimum interval between requests.
  - 15s timeout.
  - Retries only on network errors, 429, and 5xx: up to 3, with exponential backoff and jitter, honouring `Retry-After`.
  - Conditional GETs.
  - A truthful User-Agent identifying FINN.
- **No browser impersonation, no cookie harvesting, no CAPTCHA or bot-check circumvention.** A provider that requires these is marked unavailable.
- **A `FixtureAdapter` serves recorded responses** for each provider interface. This is used for tests and for an explicit demo mode (§3.3).
- **Adding a provider** (e.g. NSE through a legitimate route) means writing one adapter plus a mapping into the same normalised types. Nothing downstream changes.

### 3.2 Documents: fetch, parse, deduplicate, index

1. **Discover.** Adapters emit candidate URLs with `kind`, period, and `discovered_via`. The URL is canonicalised; an existing `document_url` short-circuits.
2. **Fetch** (worker job `fetch_document`).
   - Only HTTPS, and only hosts on an allowlist (exchange archives, screener-linked company IR hosts recorded at discovery).
   - Content type must be `application/pdf` (or detected by magic bytes).
   - The download streams to disk with a hard cap (default 50 MB) and aborts above it (`too_large`).
3. **Deduplicate.** Compute sha256 of the bytes. If it matches an existing `document.content_sha256`, attach the new URL to that document and stop.
4. **Parse** (job `parse_document`).
   - `unpdf` extracts text per page, then whitespace is normalised and hyphenation repaired.
   - If the median characters per page is below a threshold, the document is marked `no_text_layer` (scanned). The UI shows "This document has no extractable text" with a link to the original. **No OCR in scope.**
5. **Chunk.**
   - Pages are split into passages of roughly 300–600 words on paragraph boundaries, never spanning more than two pages.
   - Section headings are detected heuristically (all-caps or title-case short lines; known AR section names).
   - Results-filing tables are kept as page-level passages so row and column context survives.
6. **Index.** Passages are inserted into FTS5. Retrieval for a research task is a fixed query set per section (e.g. Guidance: `guidance OR outlook OR "we expect" OR target OR capex`), filtered to the selected documents and ranked by BM25, with a top-k cap per document.
7. **Reprocessing.** Parsing and chunking are versioned. Bumping `CHUNKER_VERSION` re-chunks from the stored blob without re-downloading.

### 3.3 Provider unavailability

- Every read path returns data plus a **freshness envelope** (§3.4).
- **Degradation order:** live fetch → last successful snapshot (marked stale with its age) → explicit "unavailable" state.
- **No step in that chain synthesises data.**
- Failures are scoped. One company's announcement fetch failing marks only that company's section as unavailable; the rest of the Brief renders.
- **Demo mode is explicit and global.**
  - `FINN_DATA_MODE=fixture` routes all adapters to recorded fixtures.
  - The UI shows a persistent "Demo data — recorded <date>" banner, and every DTO carries `dataMode: 'fixture'`.
  - Fixtures are captured from real provider responses during Milestone 0.5, with their capture date and source.
  - Hand-written synthetic payloads exist only in unit tests and are never served by the app.
  - Live and fixture data are never mixed in one view.
- **Research for a ticker with no retrievable documents** returns a report whose sections are `insufficient_evidence`, listing exactly what was searched for and not found. It is not a model-written report from general knowledge.

### 3.4 Data freshness

Every API response includes, per data source used:

```ts
type Freshness = {
  provider: ProviderId;
  dataMode: 'live' | 'fixture';
  asOf: string | null;          // finished_at of the last ok/partial fetch
  lastAttemptAt: string | null;
  lastAttemptStatus: FetchStatus | null;
  state: 'fresh' | 'stale' | 'unavailable' | 'never_fetched';
};
```

- **EOD prices** are `stale` if the latest bar is older than the most recent expected NSE trading session. The session is computed from a weekday rule plus a static NSE holiday list for the year, committed in `src/domain/calendar/nse-holidays-2026.ts` and documented as needing yearly update.
- **Announcements** are `stale` if the last successful fetch is more than 2 hours old between 09:00 and 20:00 IST.
- **UI:**
  - A compact source-status strip at the top of the Brief: "Prices as of 31 Oct close · Filings 14:05 · BSE ok".
  - Per-item stale or unavailable markers.
  - Relative times that never hide the absolute timestamp (it is available on tap).

### 3.5 Model calls: routing, caching, retries

**Routing** (`src/ai/router.ts`), each task mapped to a tier:

| Task | Tier | Why |
|---|---|---|
| Classify an ambiguous announcement (rules failed) | small | Short input, closed label set |
| Extract a results table into metric rows | small | Structured extraction; verified deterministically afterwards |
| Extract an appointee profile from a filing | small | Span extraction from one attachment |
| Extract guidance statements from a transcript | small | Span extraction with quotes, chunked per transcript |
| Write research sections and the bull/bear case from supplied evidence | large | Reasoning across evidence; output is still citation-checked |

**Cache.**
- `cache_key = sha256(task, prompt_version, model, canonical JSON of inputs)`. Inputs reference passages by text hash, so re-chunking that changes text invalidates the cache naturally.
- A hit returns the stored response without a network call.
- Failed calls are not cached as successes. Invalid outputs are stored with their status, for debugging only.

**Provider prompt caching.** Long, stable context (a transcript's passages) goes first in the prompt so repeated tasks over the same document reuse the cached prefix.

**Structured output.**
- Every task declares a zod schema, sent as a tool/JSON schema.
- If the response fails validation, there is one repair attempt that includes the validation error. If that fails, the task fails visibly (section `failed`). It does not fall back to free text.

**Retries.**
- 429, 5xx, and network errors: up to 3 attempts with backoff and jitter, honouring `Retry-After`.
- Other 4xx errors and refusals are not retried.

**Budgets.**
- Per-report token and cost ceilings (env-configurable). On reaching the ceiling, the report finishes as `partial` with the remaining sections marked "not generated (budget)".
- A daily global ceiling.
- Usage is recorded in `llm_call` and surfaced in the report footer as tokens and estimated cost. This makes efficiency visible.

**Determinism.** Temperature 0. Prompts are versioned modules in `src/ai/prompts/*.ts` with a `PROMPT_VERSION` constant per task.

### 3.6 Deterministic financial calculations

- All arithmetic lives in `src/domain/finance`. Functions are pure and take `FinancialFact` values, not raw numbers, so provenance and status travel with every input.
- Results are a discriminated union: `{ kind: 'value', value, inputs, formula } | { kind: 'not_computable', reason }`. Reasons include: an input is missing, scopes are mixed, periods are misaligned, the base is ≤ 0 for a growth rate ("n.m."), or the metric does not apply.
- Formulas are versioned and documented in code and in the UI tooltip:
  - `growth.v1`: `(current − base) / |base|`, defined only when `base > 0`. Otherwise not meaningful.
  - `ebitda.v1`: `PBT + finance_costs + depreciation_amortisation`, using PBT **before exceptional items** when reported separately. Labelled "derived; includes other income".
  - `ebitda_ex_oi.v1`: `ebitda.v1 − other_income`, shown as a secondary line.
  - `margin.v1`: `metric / revenue_from_operations`.
- **Period alignment.** A results filing's columns (current quarter, previous quarter, year-ago quarter) are extracted with their period-end dates. QoQ and YoY pair facts by `period_end`, never by column position.
- **Verification checks** (set `verification_status`):
  - `|PBT − tax − PAT| ≤ tolerance`;
  - `total_income ≈ revenue + other_income`;
  - the unit scale is consistent within a table;
  - extracted `value_raw` re-parses to `value`.
- A failed check marks the fact `check_failed`. The UI shows the number with an "unverified — check filing" marker and the reason.
- Property-based and fixture tests cover each formula, including negative and zero bases, missing inputs, and mixed scopes.

### 3.7 Source references, from ingestion to UI

```
source_fetch ─► document (sha256, url) ─► passage (page_start..page_end, text)
                                   │                │
            financial_fact.document_id/passage_id   claim_citation.passage_id + quote
            + source_location {page,row,column}     guidance_statement.passage_id + quote
                                   │                │
                    services build SourceRef DTOs (never raw DB rows)
                                   │
                  UI <Cite> chip → Evidence sheet: passage text (plain text),
                  highlighted quote, page n, document title, filed date,
                  extraction method, verification status, "Open PDF at page n"
```

- **Quote verification** is deterministic.
  - The model must return, for each claim, the passage IDs it relied on and a verbatim supporting span.
  - The span is normalised (case, whitespace, ligatures, hyphenation) and must match a substring of the cited passage's text, allowing for small OCR-like character differences (match score ≥ 0.9).
- **Claims without verified support** are stored as `unverified` and are **hidden by default**. A disclosure shows "N statements removed: no supporting passage found".
- **Numbers in generated prose** must come from `fact_ids` supplied in the prompt context. A post-check scans the claim text for numerals and requires each to match a supplied fact value (formatted) or a quoted span. Otherwise the claim is downgraded to `unverified`.
- **`SourceRef` is the only shape the UI receives:** `{documentId, title, kind, fiscalLabel, filedAt, page, quote?, pdfUrl, extractionMethod, verificationStatus, dataMode}`.

### 3.8 Secrets and user input

**Secrets.**
- Loaded only in server code via `src/config/env.ts`, which zod-validates `process.env` at startup and imports `server-only`.
- No secret uses a `NEXT_PUBLIC_` prefix.
- `.env` is git-ignored; `.env.example` lists every variable with a description and no values.
- Secrets are never logged; the error-message truncation also redacts `Authorization` and key patterns.

**User input.**
- Ticker: `^[A-Z0-9&-]{1,20}$` after upper-casing, then resolved against `listing` or the exchange master. Unknown tickers return 404 with a message; they are never passed to an LLM to "guess".
- Free-text fields, such as a research focus question: ≤ 500 characters, trimmed, and passed to the model only as delimited data.
- Rule params are validated by the same zod schemas as storage, with bounds (e.g. `0.5 ≤ threshold_pct ≤ 50`, `1.2 ≤ multiple ≤ 20`).
- Date windows are capped at 31 days.

**Expensive endpoints.**
- Research generation and document fetch are rate-limited per IP: a token bucket in SQLite, e.g. 5 report builds per hour.
- They are also gated by `FINN_ACCESS_CODE` on public deployments. Cached reports remain viewable without the code.
- Request bodies are capped at 16 KB.

**Untrusted document text (prompt injection).**
- Filing and transcript text is placed in clearly delimited data blocks, with an instruction that it is content, not instructions.
- Model output can only populate schema fields. It cannot trigger tools, URLs, SQL, or code.
- All queries are Drizzle-parameterised. No LLM-generated SQL or code is ever executed.

**Rendering.**
- Filing text is rendered as React text nodes.
- External links are `rel="noopener noreferrer"` and limited to `https:` URLs from known hosts.
- A strict CSP is set in `next.config` headers.

---

## 4. Implementation sequence

Each milestone leaves the app runnable and its tests green. **M0 → M1 → M2 is the critical path; M3 and M4 can proceed in parallel after M2.**

### M0 — Scaffold and conventions
- **Create:** `package.json` (pinned versions), `tsconfig.json` (strict), ESLint (no-explicit-any as error), Prettier, Vitest config, `src/config/env.ts`, `.env.example`, `.gitignore`, `src/ui/tokens.css`, app shell with mobile/desktop layout, `git init`.
- **Acceptance:** `npm run dev` serves the shell; `npm run typecheck`, `npm run lint`, and `npm test` all pass; startup fails fast with a clear message if a required env var is missing.
- **Tests:** env schema (valid, missing, malformed).
- **Depends on:** nothing.
- **Failure modes:** Windows/OneDrive path issues with native modules (`better-sqlite3` prebuilds). Mitigation: verify the install in M0 and keep `DATA_DIR` outside OneDrive-synced folders.

### M0.5 — Provider feasibility spike (manual, documented)
- **Create:** `docs/PROVIDERS.md` (per provider: endpoint, auth/headers needed, rate observations, sample payload, terms notes, verdict); `scripts/capture-fixtures.ts`; `fixtures/<provider>/…` with capture dates.
- **Acceptance:** each provider has a recorded verdict (works / works with constraints / unavailable). For every working provider there is at least one captured fixture for one company and date range.
- **Tests:** none (spike), but fixtures feed later tests.
- **Depends on:** M0.
- **Failure modes:** BSE requires headers that amount to impersonation, or NSE is unreachable without circumvention. **Decision point:** if no announcement source is legitimately reachable, the Brief runs on fixtures with the demo banner, and this is stated in the README.

### M1 — Domain core (pure, no I/O)
- **Create:** `src/domain/taxonomy.ts` (categories, default weights and treatments, rule-based mapper from exchange category/subject strings), `src/domain/ranking.ts`, `src/domain/alerts/rules.ts` (price move, volume spike, category match), `src/domain/finance/{metrics,growth,ebitda,margins,align,verify,guidance}.ts`, `src/domain/calendar/*`, `src/domain/types.ts`.
- **Acceptance:** every function is pure and typed with discriminated-union results; no import from `src/data`, `src/db`, or `src/ai`, enforced by an ESLint `no-restricted-imports` boundary.
- **Tests:**
  - ranking order for mixed categories and recency;
  - weight changes reorder as expected;
  - volume spike excludes the current session from the average and requires minimum history;
  - price move at ±threshold boundaries;
  - growth with zero, negative, and missing base;
  - EBITDA derivation with and without exceptional items;
  - mixed-scope rejection;
  - period alignment by date, not position;
  - verification tolerance;
  - guidance verdicts for point, range, directional, and missing actual.
- **Depends on:** M0.
- **Failure modes:** floating-point surprises at boundaries (use explicit comparison helpers); fiscal-year edge cases (an April–March FY spans two calendar years).

### M2 — Storage
- **Create:** `src/db/schema.ts` (all §2 tables with CHECK constraints), `drizzle.config.ts`, migrations, `src/db/repositories/*`, `src/db/seed.ts` (portfolio companies, listings, default alert rules), FTS5 setup migration.
- **Acceptance:** `npm run db:migrate && npm run db:seed` creates a working DB; repositories return domain types; inserting a fact with `value = NULL` and status `reported` is rejected by the database.
- **Tests:** repository round-trips on an in-memory DB; uniqueness and dedupe constraints; CHECK constraints; FTS query returns the expected passage.
- **Depends on:** M1 (types).
- **Failure modes:** Drizzle and FTS5 interop (raw SQL migration for the virtual table); WAL with two processes on network or synced drives.

### M3 — Market data and price/volume alerts
- **Create:** `src/data/http.ts`, `src/data/adapters/prices/{yahoo,fixture}.ts`, `src/jobs/{queue,runner}.ts`, `src/jobs/handlers/{ingestPrices,evaluateAlerts}.ts`, `scripts/worker.ts`, `src/services/alerts.ts`, `GET /api/alerts`.
- **Acceptance:**
  - running the worker (or `npm run ingest:prices`) populates around 60 sessions per portfolio listing;
  - re-running is idempotent;
  - alerts fire once per rule/company/date;
  - freshness reflects real fetch outcomes;
  - with the network disabled, the API returns the last snapshot marked stale.
- **Tests:**
  - adapter maps a captured fixture to bars;
  - a malformed payload is rejected without crashing;
  - HTTP client retry/backoff, using fake timers;
  - job lease and retry behaviour;
  - alert evaluation end to end on fixture bars;
  - API returns the freshness envelope.
- **Depends on:** M2 (and M0.5 verdict for Yahoo).
- **Failure modes:** Yahoo rate-limits or changes the endpoint; missing bars on holidays treated as gaps (they must not be); split-day price jumps triggering false alerts (use `adj_close`; document residual risk).

### M4 — Announcements and the Brief
- **Create:** `src/data/adapters/announcements/{bse,fixture}.ts` (plus `nse.ts` only if M0.5 verified legitimate access), `src/jobs/handlers/ingestAnnouncements.ts`, `src/ai/{client,router,cache}.ts`, `src/ai/prompts/classifyAnnouncement.ts`, `src/services/brief.ts`, `GET /api/brief?window=`, UI: `src/app/(app)/brief/*`, `src/ui/{BriefList,BriefItem,RoutineGroup,SourceStatus,Cite}`.
- **Acceptance:**
  - the Brief shows a window picker (24h default, 3d, 7d, custom ≤ 31d);
  - material items appear first;
  - routine filings collapse per company;
  - price/volume alerts are interleaved by time and rank;
  - every item links to the original filing;
  - the empty window shows "Nothing filed in this window" with the last fetch time;
  - provider failure shows a per-source unavailable state;
  - it works at 360px and 1440px.
- **Tests:**
  - adapter fixture mapping and dedupe on `exchange_ref`;
  - rule-based category mapping on a table of real headlines;
  - LLM classification used only when rules fail (mocked client);
  - LLM cache hit avoids a second call;
  - the Brief service orders and groups correctly;
  - the API rejects a 90-day window;
  - Playwright smoke at mobile and desktop widths.
- **Depends on:** M2, M3 (queue, HTTP client).
- **Failure modes:** exchange category strings are inconsistent (keep raw values and expand rules from observed data); IST/UTC window boundaries off by a day (test explicitly); duplicate filings across exchanges (dedupe by company + headline + timestamp proximity, documented as heuristic).

### M5 — Document ingestion
- **Create:** `src/data/documents/{discover,fetch,parse,chunk,index}.ts`, `src/data/adapters/screener.ts`, `src/jobs/handlers/{fetchDocument,parseDocument}.ts`, `src/services/evidence.ts`, `GET /api/evidence/:passageId`, evidence sheet UI.
- **Acceptance:**
  - for one company, the latest annual report, up to four concall transcripts, and the last results filing are fetched, parsed, chunked, and searchable;
  - a duplicate URL or identical bytes create no new document;
  - an oversized or non-PDF file is rejected with a status;
  - a scanned PDF is marked `no_text_layer`;
  - the evidence sheet shows the passage with page number and an "Open PDF at page n" link.
- **Tests:**
  - URL canonicalisation;
  - hash dedupe;
  - size cap aborts the stream;
  - chunker respects the page-span limit and paragraph boundaries (fixture PDF text);
  - scanned-PDF detection;
  - FTS retrieval returns guidance passages for a transcript fixture;
  - host allowlist rejects other hosts.
- **Depends on:** M2, M3 (queue, HTTP).
- **Failure modes:** screener markup changes or blocks automated access (fall back to BSE attachments for results and transcripts; record it); PDFs with broken text layers (garbled glyphs, detected by a printable-ratio heuristic and treated as `no_text_layer`); very large annual reports (300+ pages) are slow to parse (worker-only, streamed, with a progress status).

### M6 — Results first-cut and appointee profile (push enrichment)
- **Create:** `src/ai/prompts/{extractResultsTable,extractAppointeeProfile}.ts`, `src/services/extraction/{results,profile}.ts`, `src/jobs/handlers/extractResults.ts`, UI `ResultsFirstCut`, `AppointeeProfile`.
- **Acceptance:**
  - for a results filing, Revenue, EBITDA (derived, labelled), PBT, and PAT appear for the current quarter with QoQ and YoY;
  - the scope (consolidated/standalone) is shown;
  - every figure taps to its page, row, and column;
  - verification failures are visible;
  - bank and NBFC companies show EBITDA as "not applicable";
  - for a management change, the profile shown is extracted from the filing and cited; if the filing has none, the UI says "No profile in filing". There is no LinkedIn scraping (§5).
- **Tests:**
  - extraction output schema validation and the repair path (mocked model);
  - facts stored with full provenance;
  - verification checks flag a deliberately inconsistent fixture;
  - QoQ/YoY pairs by `period_end`;
  - missing year-ago column yields "not computable", not zero.
- **Depends on:** M1, M4, M5.
- **Failure modes:** multi-column tables mis-read (the deterministic cross-checks catch most; unverified figures are flagged, not hidden); unit scale in a header far from the table (extract the scale explicitly and fail if absent).

### M7 — Company research workflow (the Dossier)
- **Create:** `src/ai/prompts/{extractGuidance,writeSection}.ts`, `src/services/research/{plan,retrieve,guidanceLedger,sections,verifyClaims}.ts`, `src/jobs/handlers/buildResearchReport.ts`, `POST /api/research` (enqueue; returns report ID), `GET /api/research/:id` (status + content), UI `src/app/(app)/company/[ticker]/*` with `PromiseLedger`, `SectionView`, `ClaimText`.
- **Scope order** (build top-down; stop where time ends):
  1. Promise ledger (guidance across the last four quarters vs reported actuals, with verdicts computed in `domain/finance/guidance.ts`).
  2. Financial snapshot and trajectory from facts.
  3. Bull vs bear from cited evidence.
  4. Business snapshot.
  5. Balance sheet and cash quality, deferred unless annual-report statement extraction lands.
- **Acceptance:**
  - research works for an NSE ticker that was not in the demo set (smoke test with a fresh ticker);
  - progress states (queued → fetching documents → extracting → writing → complete/partial/failed) are real job states, not timers;
  - every displayed claim has a verified citation or is labelled "Analysis";
  - unverified claims are hidden by default, with a count;
  - a re-request with unchanged inputs returns the cached report instantly;
  - the footer shows tokens and estimated cost.
- **Tests:**
  - quote verification (exact, whitespace-variant, hyphenation-variant, fabricated quote rejected);
  - numeral post-check downgrades a claim with an unsupported number;
  - guidance ledger verdicts from fixture facts;
  - report `input_hash` cache hit;
  - budget ceiling yields `partial`;
  - API returns 404 for unknown tickers and 429 when rate-limited;
  - a section with no retrieved evidence becomes `insufficient_evidence` without calling the model.
- **Depends on:** M5, M6 (facts).
- **Failure modes:** guidance phrased vaguely ("double-digit growth") is mapped to a directional/range type with an explicit rule table, or `not_measurable`; target period ambiguous; model cites the wrong passage (caught by quote verification); long transcripts exceed context (chunked extraction per passage batch, merged deterministically).

### M8 — Settings, states, and finish
- **Create:** `src/app/(app)/settings/*` (alert thresholds, category weights), `PUT /api/rules/:id`, shared state components (`Loading`, `Empty`, `Stale`, `Unavailable`, `Partial`, `ErrorState`), accessibility pass.
- **Acceptance:**
  - changing a threshold re-evaluates alerts on the next run and visibly re-ranks the Brief immediately (weights apply at read time);
  - invalid params are rejected with field errors;
  - every view has all five states reachable in tests;
  - keyboard and screen-reader basics work;
  - the app is usable at 360px.
- **Tests:** rule validation bounds; API round-trip; state components render per state; Playwright: change a threshold, then see the effect.
- **Depends on:** M3, M4.
- **Failure modes:** settings and stored events drift (events keep `rule_snapshot`, so history stays truthful).

### M9 — Deployment and reproducible demo
- **Create:** `README.md` (setup, scripts, architecture summary, data modes, known limitations), `Dockerfile` or a platform config with web and worker services and a persistent disk, `scripts/demo-reset.ts` (migrate, seed, ingest live, or load fixtures).
- **Acceptance:**
  - a fresh clone runs following the README in either mode;
  - the deployed URL works on a phone;
  - the demo banner appears in fixture mode;
  - the known-limitations section matches reality.
- **Tests:** CI script runs typecheck, lint, unit tests, and the Playwright smoke against a production build in fixture mode.
- **Depends on:** all previous milestones.
- **Failure modes:** host disk not persistent (verify after a redeploy); provider IP blocks from the cloud host that did not occur locally (re-run M0.5 checks from the host; fall back to scheduled local ingest pushing snapshots, documented).

---

## 5. Scope discipline

### Priority order

All work is judged against these, in this order:

1. **A credible signal feed** — M3, M4, M6 (results first-cut).
2. **One complete company research workflow** — M5, M7, with the promise ledger first.
3. **Reliable evidence attribution** — §3.7 runs through every milestone; it is not a later polish step.
4. **A distinctive responsive interface** — triage-first Brief, evidence sheet, ledger view; M0 tokens, M8 states.
5. **A reproducible demo and deployment** — M0.5 fixtures, M9.

**Cut line under time pressure:** M0–M4 plus M6 results is the minimum shippable Brief. M5 plus the M7 ledger is the minimum Dossier. Everything else is ordered behind those.

### Deliberately deferred

| Feature | Why deferred |
|---|---|
| LinkedIn profile scraping | Violates LinkedIn's terms and is unreliable to automate. Replaced by the profile that SEBI Reg 30 appointment disclosures typically include in the filing itself. A plain LinkedIn *search link* (not fetched) may be offered. |
| OCR for scanned PDFs | Adds a heavy dependency for a minority of documents; these are surfaced honestly instead |
| Embeddings / vector DB | FTS5 is sufficient for exact financial vocabulary; revisit with retrieval-quality evidence |
| Intraday or real-time prices | The brief specifies EOD; alerts are evaluated after close and say so |
| Web Push / native notifications | The in-app alert inbox proves the push logic. OS notifications need service-worker and subscription plumbing that does not improve signal quality. A first stretch item. |
| Multi-user accounts / auth | Single-user prototype; an access code protects spend |
| Holdings, quantities, P&L, broker integration | Not needed for filtering signal; portfolio is a watch-list |
| News, broker notes, secondary research | Explicitly excluded for the pull side by the brief |
| Free-form chat over all documents | A scoped "ask this dossier" box is a stretch item after M7, reusing the same retrieval and citation verification |
| Voice interface | Does not improve the two core workflows within the time available |
| Decorative charts | Only charts that answer a question: e.g. a price line with alert markers on an alert detail, a quarterly revenue/margin trajectory in the Dossier |

### Proposed demo set (validated in M0.5)

These tickers are a proposal. Any that fail validation or have no retrievable documents are swapped.

- **Portfolio (18):** RELIANCE, HDFCBANK, BAJFINANCE, INFY, LT, SUNPHARMA, TITAN, ASIANPAINT, MARUTI, TRENT, POLYCAB, DIXON, PIDILITIND, CDSL, HAL, APOLLOHOSP, DEEPAKNTR, KPITTECH.
  - Mix: large/mid cap, a bank and an NBFC (to exercise the "EBITDA not applicable" path), a PSU, and consumer, industrial, pharma, and IT names.
- **Ad-hoc research (4):** KAYNES, ASTRAL, PAGEIND, plus one ticker chosen by the reviewer at demo time to prove generalisation.

---

## 6. Open decisions

| # | Decision | Default if unanswered | Impact of changing later |
|---|---|---|---|
| 1 | LLM provider and keys | Anthropic: Claude Haiku 5.5 (extraction) and Claude Sonnet 5.5 (synthesis) behind `LlmClient`; Gemini Flash is a free-tier alternative | Low: one client implementation; prompts may need tuning |
| 2 | Hosting | Single Node host with a persistent disk running web and worker | Medium: serverless would require Postgres, an external queue, and a cron service |
| 3 | NSE access | Not used unless legitimately reachable without impersonation or cookie replay; BSE plus fixtures otherwise | Low: adapter interface isolates it |
| 4 | Deadline | The brief's deadline is 2026-11-01 (today). The cut line in §5 applies. | Determines how far down M7 the build goes |
