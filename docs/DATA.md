# FINN data foundation

How company data gets into FINN, how to run it with real or demo data, and what is not finished. For provider evidence, see [PROVIDERS.md](PROVIDERS.md); for the design, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Two modes, two databases

`FINN_DATA_MODE` decides where every adapter gets its data. Each mode uses its own SQLite file, so demo data and live data cannot mix.

| Mode | Prices | Filings | Documents | Database |
|---|---|---|---|---|
| `fixture` (default) | Recorded Yahoo responses in `fixtures/prices/yahoo/` | Recorded screener extracts in `fixtures/filings/` | Not downloaded | `data/finn-fixture.sqlite` |
| `live` | Yahoo chart API | screener.in discovery → exchange links | BSE / company IR PDFs and HTML | `data/finn-live.sqlite` |

**How fixtures are labelled.**
- Every fetch in fixture mode is recorded with `data_mode = 'fixture'` and a `fixture:*` provider name.
- `npm run finn -- status` prints `[DEMO DATA]` against each such record.
- Fixtures are **real responses captured on 2026-11-01** (see `capturedAt` in each file). They are not synthetic, and they are validated by exactly the same parser as live data.
- A company with no recording simply has no data. Nothing is generated to fill the gap.

Keep `FINN_DATA_DIR` outside cloud-synced folders such as OneDrive or Dropbox. SQLite's WAL files do not survive sync tools well.

## Run the demo (offline)

```bash
npm install
```

```bash
npm run finn -- universe:sync
```

```bash
npm run finn -- ingest:prices
```

```bash
npm run finn -- ingest:filings
```

```bash
npm run finn -- status
```

## Ingest real data

Set `FINN_DATA_MODE=live` in `.env`, or prefix each command with it. Then:

```bash
npm run finn -- universe:sync
```

```bash
npm run finn -- universe:verify
```

```bash
npm run finn -- ingest:prices
```

```bash
npm run finn -- ingest:filings
```

```bash
npm run finn -- ingest:documents --symbols RELIANCE --kinds quarterly_results,earnings_call_transcript --limit 5
```

```bash
npm run finn -- status
```

**Command notes.**
- **`universe:verify`** checks that each NSE and BSE listing resolves at Yahoo, and records `resolved` or `unresolved` on the listing.
- **`ingest:prices`** fetches one year of daily bars, pausing 1.2 s between symbols. It stores only completed sessions. Re-running is idempotent: revisions update the row in place, and `first_ingested_at` is kept.
- **`ingest:filings`** pauses 1.2 s between companies. Announcements are deduplicated by BSE filing GUID or NSE archive filename, and are classified on insert.
- **`ingest:documents`** downloads pending documents, plus earlier failures for another attempt, one at a time. Only exchange-filed and company-issued documents are ever fetched.
- **`reclassify`** re-runs the rule classifier after a rule change. It writes a new version row and keeps the old ones.
- **`capture:fixtures`** (live mode) re-records demo fixtures from the current provider responses.
- **`--role portfolio|research`** and **`--symbols A,B`** narrow any command.

The universe lives in [`config/universe.json`](../config/universe.json): 18 portfolio and 3 research companies. It is validated on load: invalid symbols, missing listings and duplicates are rejected, and the error names the offending entry. These are demo selections; the research engine is not limited to them.

## What is stored

| Table | Contents | Key integrity rules |
|---|---|---|
| `company`, `listing` | Universe; NSE symbol / BSE scrip code; provider ticker; resolution status | `UNIQUE(exchange, symbol)`; a BSE listing's Yahoo ticker is the BSE trading symbol, never the scrip code |
| `source_fetch` | One row per provider request: provider, mode, status, HTTP status, counts, error | Every stored price and announcement references the fetch that produced it |
| `price_bar` | Completed EOD sessions | PK `(listing, trade_date)`; prices > 0; `low ≤ high`; trade date and ingestion times stored separately |
| `announcement` | Filed title as listed, raw and UTC timestamps, exchange, exchange ref, source page URL, filing URL | `dedupe_key` UNIQUE (exchange ref, or conservative fallback on company + normalised title + minute); title is never rewritten |
| `announcement_classification` | Category, status (`matched` / `routine` / `ambiguous` / `no_match`), secondary categories, rule ids, version | Separate table, one row per classifier version |
| `document` | Metadata: kind, title, source URL, origin (`exchange_filed` / `company_issued` / `third_party` / `unverified_external`), availability, last error, `duplicate_of` | Only primary origins are queued; others are `not_fetched_policy` |
| `document_version` | One row per distinct content hash: size, MIME type, final URL, blob path, extraction status, error, extractor version, page count | `UNIQUE(document, sha256)` |
| `document_segment` | Extracted text by page (`p. 3`) or by HTML section (`§ Q&A`) | Kept apart from metadata; a scanned PDF has none, with status `no_text_layer` |
| `financial_fact` | Metric, basis, period, status, normalised value, printed text, printed value, scale, currency, source document, location, method, verification | DB CHECKs: value is NULL ⇔ status is missing; currency facts need a currency; reported facts keep the printed value |

## Rules worth knowing

**Prices**
- **EOD only.** A bar for today, fetched before 16:00 IST, is dropped as an in-progress value.
- **Freshness states:**
  - `eod_delayed`: current, and the last refresh succeeded.
  - `cached`: current, but the last refresh failed.
  - `stale`: older than the latest expected session.
  - `unavailable`: nothing stored.
- **Holidays.** Exchange holidays are not built in, so data looks stale on a holiday. This errs toward warning.

**Announcements**
- **Ambiguous stays unclassified.** "Board Meeting Outcome", a bare "-Allotment", or an investor presentation that doesn't say it's a results deck is stored as `unclassified/ambiguous`, with candidate categories.
- **Routine paperwork** is `unclassified/routine`: trading window, ESOP, compliance certificates, auditor appointments and similar.

**Financial facts**
- **Missing values** are explicit statuses: `not_reported`, `not_applicable`, `unparseable`, `ambiguous`. Never zero.
- **Consolidated and standalone** are separate keys. `resolveFact` throws if asked to merge them.
- **Comparisons** require the same basis, period type, unit and currency, and the correct prior period for QoQ/YoY. Otherwise the result is `not_computable` with a reason.
- **Units.** Values printed in crore or lakh are converted with the printed scale, and the printed text, number and scale are kept alongside.
- **Disagreeing sources** for one figure resolve to `conflict`; FINN does not pick one. A figure marked restated supersedes the original.

## Not finished

| Area | State |
|---|---|
| Announcement history | Only the ~5 most recent per company (screener page limit). No honest full-history source found yet. |
| BSE / NSE direct announcement APIs | Not implemented: they require browser impersonation (see PROVIDERS.md). |
| Model-assisted classification | Not wired. Titles with no rule match stay `unclassified/no_match` (15 of 105 live titles on 2026-11-01). |
| Financial-fact extraction from results PDFs | Schema, validation, storage and comparison logic exist and are tested. **No extractor fills them yet** (milestone M6). Real results PDFs carry noisy OCR text (see PROVIDERS.md). |
| OCR | Not supported. Image-only PDFs are reported as `no_text_layer`. |
| Document fetch in fixture mode | Not supported. Fixture mode covers prices and filings only. |
| Transcript dating | screener labels transcripts by call month ("Jul 2026"); no fiscal quarter is inferred. |
| Exchange holiday calendar | Not included; see freshness note above. |
| Scheduling | Commands are run by hand or by an external scheduler; no worker process yet. |
| Fixture licensing | `fixtures/` contains raw Yahoo responses. Check the provider's terms before publishing the repository with them. |
