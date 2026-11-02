# FINN research engine (Pull side)

Evidence-grounded company research for any NSE symbol for which primary documents can be retrieved. It is not a chatbot: every section is built from retrieved documents, and every figure, quote and argument links to a document and page.

## How a request flows

1. **Request**: ticker or company name, optional question, optional period ("Q2 FY27", "FY26"). Validated with zod; input ≤ 60 / 500 characters.
2. **Resolve** (`src/research/resolve.ts`):
   - **Registry first**: NSE symbol, BSE code, or a unique name match.
   - **Several name matches** return the candidates; FINN does not guess.
   - **An unknown NSE symbol is verified live** before it is accepted. The price provider must return INR daily data for `<SYMBOL>.NS`, and the filings source must have a company page with a readable name. The company is then registered as `adhoc`, with sector and size `unknown`, never invented.
3. **Retrieve** (`src/research/engine.ts → selectDocuments`):
   - **Up to 2 results filings, 4 transcripts, 1 annual report and 1 investor presentation**, primary sources only (exchange-filed or company-issued).
   - **Download, extract and index.** Each document is downloaded, extracted page by page, and chunked by structure. Headings start chunks; tables never merge into prose; chunks never cross a page. It is then indexed in SQLite FTS5 (BM25).
   - **Failures are reported, not hidden.** A failed download, a scanned PDF or a failed extraction appears in **Sources** with the reason.
4. **Extract**:
   - **Financial facts**: `results-parser.ts`, deterministic, described below.
   - **Management statements**: `guidance.ts`, deterministic sentence extraction, optionally refined by the model.
5. **Compute** (`facts-view.ts`, `scorecard.ts`). All arithmetic is plain code with named formulas: EBITDA, margins, YoY, interest coverage, guidance variance.
6. **Assemble** a schema-validated report (`report.ts`). Every evidence id referenced anywhere must resolve; a dangling reference fails the run rather than shipping.
7. **Cache** by a hash of document versions, engine and parser versions, question, period and model configuration. An identical request reuses the stored report.

## The results parser and its checks

Indian listed companies file results in the SEBI LODR Reg. 33 layout. The parser:

- **Finds the reporting period** in the filing title ("…ENDED 30TH SEPTEMBER, 2026"), tolerating OCR noise in the day. If it can't, it extracts nothing.
- **Matches rows by letters only**, so "Revenue from Operation s" still matches. It keeps every figure exactly as printed (`reportedText`), with its scale, page, row label and column.
- **Assigns columns** by the standard order (Q, Q−1, Q−4, YTD, YTD−1, FY−1), then **proves the mapping** with arithmetic:
  - PBT − tax = PAT per column (either sign convention);
  - YTD = Q1 + Q2 for half-year filings.
- **Handles OCR-split figures.** A row with one token too many is merged only if exactly one merge forms a well-grouped number ("16 6,013" → "166,013"). That figure stays **unverified** unless another page confirms it. Ambiguous rows are dropped and noted.
- **Skips pages that do not state their unit or their basis** (consolidated / standalone).
- **Verification status decides display:**
  - `checks_passed` figures are preferred.
  - `unverified` figures are shown with a marker.
  - `check_failed` figures are never displayed. They are used only to detect conflicts.
  - Disagreeing verified sources show "Sources disagree".

## What uses real evidence, what is demo, what is unavailable

Verified by running against live sources on 2026-11-01 (`npm run finn -- research --symbols …` with `FINN_DATA_MODE=live`):

| Module | RELIANCE (portfolio) | TATAELXSI (not in universe) | Source of content |
|---|---|---|---|
| Company resolution | Registry | **Verified live**, registered as `adhoc` | Yahoo chart + screener page |
| Financial trajectory | **Real**: Q2 FY27, Q1 FY27, Q2 FY26, H1 FY27, H1 FY26, consolidated and standalone, arithmetic-checked | **Unavailable**: no results filing among the 5 most recent announcements | BSE results PDF |
| Balance sheet & cash | **Partial**: interest coverage only; borrowings, CFO, FCF, cash conversion, working capital explained as not extracted | Unavailable | BSE results PDF |
| Guidance (statements) | **Real**: 55 verbatim statements from 4 calls, incl. "we have not put any margin target" | **Real**: 21 statements from 4 calls | Transcripts (BSE / company IR) |
| Guidance scorecard | **Real but no scored rows**: Reliance gave no explicit numeric targets; each row says why | Same | Code over statements + facts |
| Narrative vs numbers | **Real**: statements next to the latest reported figures on the same subject (no verdicts) | Unavailable (no figures) | Code |
| Business snapshot | **Extractive**: verbatim passages from annual report / presentation | Extractive | AR / presentation |
| Bull vs bear | **Computed** observations from verified figures (no model configured) | Unavailable (no figures) | Code |
| Question | **Extractive**: most relevant passages, e.g. the capex slide (₹38,682 crore, Q1 FY27) | — | Retrieval |

**Demo mode** (`FINN_DATA_MODE=fixture`):
- Research works only for companies whose documents are already in the fixture database.
- Documents are not downloaded in demo mode, so an empty demo database yields a partial report with every module explaining its absence.
- Recorded documents are not shipped as fixtures.

**Model-assisted modules** are implemented but were **not exercised against the real API**: no credentials were available in this environment. This covers statement refinement, the written snapshot, the written bull/bear and question answering.
- **Two providers, one path.** `src/llm/core.ts` holds the shared logic (cache, call log, JSON and schema checks, failure categories). `src/llm/gemini.ts` (Google Gemini `generateContent`, free tier) and `src/llm/anthropic.ts` (Claude) only translate their API's response. `FINN_LLM_PROVIDER` chooses between them.
- **Gemini specifics:**
  - The key goes in the `x-goog-api-key` header, never in the URL.
  - Output is constrained with `responseMimeType: application/json` and `responseJsonSchema`. If Google rejects the schema as too complex, the call is retried once with the schema written into the instructions.
  - Thinking is low for extraction and high for synthesis. Thought parts are discarded.
  - Safety, recitation and blocked-prompt outcomes count as refusals.
  - Rate limits (429) and 5xx errors retry twice with backoff, honouring `Retry-After`.
- **Tested against scripted fakes.** Both clients are tested against fake transports: caching, refusals, truncation, invalid output, plus Gemini's retries and schema fallback.
- **Verified the engine rejects unsupported output.** The engine drops model output whose quotes are not in the passage, whose figures are not in the cited evidence, or which cites unknown evidence ids.
- **Without a key**, every one of these modules falls back to the deterministic output above and says so.

## Model use

| Task | Tier (default model) | Input | Verification in code |
|---|---|---|---|
| Refine statements | extraction (`claude-haiku-5-5`) | candidate sentences + their chunk (≤ 1,200 chars each) | target figures and horizon must literally appear in the quote |
| Business snapshot | synthesis (`claude-opus-5-5`) | ≤ 6 retrieved passages | quote must be in the cited passage; figures must be in the quote |
| Bull / bear | synthesis | computed observations + statements + snapshot claims, by id | ids must exist; every figure must appear in cited items |
| Answer question | synthesis | ≤ 6 retrieved passages | as for the snapshot |

**How model calls behave:**
- **Structured output:** JSON schema, re-validated with zod.
- **Cache:** results are cached in `llm_call` keyed on (task, prompt version, model, input).
- **Retries:** bounded, via the SDK default of 2.
- **Recorded:** refusals, truncation and invalid output are recorded with their reason. Each report lists its model calls.
- **Fallbacks:** server-side refusal fallback (`fallbacks: "default"`) is enabled on Opus-tier calls.
- **Context size:** no request sends a whole document.

## Known limitations

- **Results history** covers only the periods printed in the latest results filing(s), typically 5–6 columns. Older quarters need older filings, which discovery (the 5 most recent announcements) usually doesn't reach.
- **Detached columns.** On pages where the statement prints only 2 columns inline and the rest in a separate block, FINN aligns the block only when row counts match exactly. Otherwise it takes those columns from another page or leaves them missing. For example, Reliance's year-ago EBITDA is missing because its D&A sits in such a block.
- **Balance-sheet and cash-flow statements** are laid out as label and figure columns; the rule parser does not align them yet.
- **Speakers** are recorded only when the transcript labels them as "Name: …". Many company-hosted transcripts do not.
- **Statement extraction** is lexical; some analyst remarks phrased as statements can slip through. The model refinement step exists to filter them when configured.
- **Scorecard scope.** It evaluates only percent targets for revenue growth and EBITDA margin with an explicit fiscal horizon. Absolute (₹ crore), bps and operational (GWh, mtpa) targets are recorded but not scored.
- **No OCR.** Scanned results PDFs with poor text layers produce fewer verified figures.

## In the app (2026-11-02)

- **Jobs and stages.**
  - `POST /api/research` resolves the company first. Ambiguous, unknown or unverifiable inputs get their own messages.
  - It then returns `202` with a job. `GET /api/research/jobs/:id` reports the stage (Retrieving sources → Extracting documents → Validating financial facts → Preparing analysis), each source as it finishes, and the report only once the job ends as complete, partially complete or failed.
  - Stages come from the engine's own progress events, not from a timer.
- **Report layout.** Eight sections, in order:
  1. Company and business
  2. Financial trajectory
  3. Financial performance table
  4. Balance sheet and cash quality
  5. Management guidance
  6. Narrative vs numbers (the scorecard)
  7. Bull and bear
  8. Sources and evidence

  Sections with no data collapse to one line giving the reason. On phones, sections 1–3 start open and the rest summarise themselves.
- **Scorecard wording.** Outcomes are worded, not ticked: "Within the stated range", "Above/Below the stated target", "Not yet reported", "Outcome not available", "Not assessable".
  - Comparisons use the one-decimal precision the report displays.
  - Each call is labelled with the quarter it most likely discusses, inferred from the call month and marked as inferred.
- **Evidence panel.** It shows the source passage, the value as printed, the stated unit, the normalised rupee value, the period and the basis. It also says whether the claim is a reported fact, a quotation, a computation, or FINN's interpretation.
- **Demo mode.** Demo mode serves reports recorded from live runs (`npm run finn -- research --symbols X --record`). `src/research/report-integrity.test.ts` checks every recorded report:
  - every citation resolves to a document the run used;
  - every quote appears in its passage;
  - every table figure cites evidence with the same value, period and basis.
