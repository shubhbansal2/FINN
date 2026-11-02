# Data providers: verification record

Every claim below comes from a real request made on **2026-11-01** with FINN's truthful User-Agent (`FINN-prototype/0.1 (investment research prototype; non-commercial)`). FINN sends no cookies, no browser impersonation, and no spoofed Referer/Origin. A provider that only works with those is treated as unavailable.

Re-verify before relying on any of this. None of these providers offers FINN an SLA.

| Provider | Used for | Verdict | Evidence (2026-11-01) |
|---|---|---|---|
| Yahoo Finance chart API `query1.finance.yahoo.com/v8/finance/chart/<ticker>` | End-of-day OHLCV | **Works** | `RELIANCE.NS` → 200 JSON. Live ingest stored 248 sessions for each of 21 NSE listings. Unknown symbol → 404 with `chart.error`. |
| Yahoo, BSE tickers | BSE-only fallback | **Works with a caveat** | `RELIANCE.BO` → 200. `500325.BO` (the scrip code) → 404. Yahoo uses the BSE *trading symbol*, not the scrip code. `RELIANCE.BO` returned only 1 session for a 3-month range, against 64 for `.NS`. |
| BSE announcements JSON API `api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w` | Announcements | **Unavailable to an honest client** | Returns the bseindia.com HTML homepage instead of JSON unless the request imitates the BSE website. Not implemented. |
| NSE APIs `www.nseindia.com/api/...` | Announcements | **Not used** | Known to require session cookies harvested from the homepage. Not attempted. |
| screener.in company page `/company/<SYMBOL>/consolidated/` | Discovery of announcements and document links | **Works** | 200 HTML for all 21 companies. robots.txt allows `/company/<symbol>/`. |
| BSE attachments `www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=<guid>.pdf` | Filing PDFs | **Works, intermittently flaky** | 302 → `xml-data/corpfiling/AttachHis/<guid>.pdf` → 200 `application/pdf` (8.8 MB results PDF, 11 MB annual report). Twice the redirector returned a malformed HTTP response, which Node rejects ("Unexpected whitespace after header value"). FINN falls back to the direct `AttachLive/`/`AttachHis/` paths. |
| Company IR sites (e.g. `apollohospitals.com`) | Transcripts, decks | **Works where listed** | Linked from screener. Only domains in `config/universe.json` → `irDomains` count as company-issued. |
| Rating agencies (ICRA, CRISIL, CARE) | — | **Never fetched** | Third-party documents. Recorded as links only. |

## What screener.in is, and is not, used for

FINN takes three things from the page: the **filed announcement subject**, its **timestamp** (`<time datetime>`), and the **exchange-hosted link**.

FINN ignores screener's own one-line announcement summaries and its "AI Summary" features. On 2026-11-01, one summary called a Q2 FY27 board outcome "Q2 FY26", contradicting the filing it described.

**Coverage limit.** The page lists only the five most recent announcements per company. Frequent polling is needed so that filings are not missed between runs. A complete history needs a source FINN can reach without impersonation, which is still an open item.

## Quality observations from real documents

- **Reliance Q2 FY27 results PDF** (`880087f6…`): 31 pages extracted. The pages are scans carrying an embedded OCR layer of mixed quality: page 3 reads "One Intcrnat ional Ce nter … Scnapati Bapat Marg".
  - Text extraction succeeds, but numeric extraction from these pages must not trust the text without cross-checks. This must be addressed before results figures are shown (milestone M6).
- **Duplicate attachments.** The Reliance "Board Meeting Outcome" attachment has the same bytes as the "Unaudited Financial Results" attachment. FINN stores it once and marks the second document `duplicate_of` the first.
- **Transcripts** (Apr 2024, Apr 2025): 23 and 43 pages of clean text.
