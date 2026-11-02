import { CATEGORIES } from '@/domain/taxonomy';
import { EXTRACTION_METHODS, PERIOD_TYPES, STATEMENT_BASES, UNIT_SCALES, UNITS, VALUE_STATUSES, VERIFICATION_STATUSES } from '@/domain/facts';

const inList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

/**
 * Ordered schema migrations. Each runs once, tracked by PRAGMA user_version.
 * Plain SQL rather than an ORM: the CHECK constraints below are the point,
 * and they read more clearly as SQL. Never edit a shipped migration; append.
 */
export const MIGRATIONS: string[] = [
  /* 1 — companies, listings, provenance, prices */ `
  CREATE TABLE company (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    sector            TEXT NOT NULL,
    size              TEXT NOT NULL CHECK (size IN ('large', 'mid', 'small', 'unknown')),
    reporting_profile TEXT NOT NULL CHECK (reporting_profile IN ('industrial', 'bank', 'nbfc', 'insurance', 'unknown')),
    role              TEXT NOT NULL CHECK (role IN ('portfolio', 'research', 'adhoc')),
    ir_domains        TEXT NOT NULL DEFAULT '[]',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE listing (
    id                    TEXT PRIMARY KEY,              -- '<EXCHANGE>:<symbol>'
    company_id            TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
    exchange              TEXT NOT NULL CHECK (exchange IN ('NSE', 'BSE')),
    symbol                TEXT NOT NULL,
    provider_symbol       TEXT,                          -- e.g. Yahoo 'RELIANCE.NS'; NULL when no mapping is known
    resolution_status     TEXT NOT NULL DEFAULT 'unverified' CHECK (resolution_status IN ('unverified', 'resolved', 'unresolved')),
    resolution_checked_at TEXT,
    resolution_note       TEXT,
    UNIQUE (exchange, symbol)
  );
  CREATE INDEX listing_company ON listing(company_id);

  CREATE TABLE source_fetch (
    id             TEXT PRIMARY KEY,
    provider       TEXT NOT NULL,
    data_mode      TEXT NOT NULL CHECK (data_mode IN ('live', 'fixture')),
    request_key    TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    status         TEXT CHECK (status IN ('ok', 'partial', 'unavailable', 'invalid_payload')),
    http_status    INTEGER,
    item_count     INTEGER NOT NULL DEFAULT 0,
    rejected_count INTEGER NOT NULL DEFAULT 0,
    error_message  TEXT
  );
  CREATE INDEX source_fetch_key ON source_fetch(request_key, started_at);

  CREATE TABLE price_bar (
    listing_id        TEXT NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
    trade_date        TEXT NOT NULL CHECK (trade_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
    open              REAL NOT NULL CHECK (open > 0),
    high              REAL NOT NULL CHECK (high > 0),
    low               REAL NOT NULL CHECK (low > 0 AND low <= high),
    close             REAL NOT NULL CHECK (close > 0),
    adj_close         REAL CHECK (adj_close IS NULL OR adj_close > 0),
    volume            INTEGER NOT NULL CHECK (volume >= 0),
    source_fetch_id   TEXT NOT NULL REFERENCES source_fetch(id),
    first_ingested_at TEXT NOT NULL,
    last_ingested_at  TEXT NOT NULL,
    PRIMARY KEY (listing_id, trade_date)
  ) WITHOUT ROWID;
  `,

  /* 2 — announcements; classification kept apart from source text */ `
  CREATE TABLE announcement (
    id               TEXT PRIMARY KEY,
    company_id       TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
    exchange         TEXT NOT NULL CHECK (exchange IN ('NSE', 'BSE')),
    exchange_ref     TEXT,                               -- exchange's own id (e.g. BSE attachment GUID)
    dedupe_key       TEXT NOT NULL UNIQUE,
    title            TEXT NOT NULL,                      -- exactly as filed; never rewritten
    published_at     TEXT NOT NULL,                      -- UTC ISO
    published_at_raw TEXT NOT NULL,                      -- as the source printed it
    source_url       TEXT NOT NULL,
    document_url     TEXT,
    source_provider  TEXT NOT NULL,
    source_fetch_id  TEXT NOT NULL REFERENCES source_fetch(id),
    ingested_at      TEXT NOT NULL,
    UNIQUE (exchange, exchange_ref)
  );
  CREATE INDEX announcement_company_time ON announcement(company_id, published_at);
  CREATE INDEX announcement_time ON announcement(published_at);

  CREATE TABLE announcement_classification (
    announcement_id TEXT NOT NULL REFERENCES announcement(id) ON DELETE CASCADE,
    version         TEXT NOT NULL,
    category        TEXT NOT NULL CHECK (category IN (${inList(CATEGORIES)})),
    status          TEXT NOT NULL CHECK (status IN ('matched', 'routine', 'ambiguous', 'no_match')),
    secondary       TEXT NOT NULL DEFAULT '[]',
    rule_ids        TEXT NOT NULL DEFAULT '[]',
    method          TEXT NOT NULL CHECK (method IN ('rule', 'model', 'manual')),
    classified_at   TEXT NOT NULL,
    PRIMARY KEY (announcement_id, version)
  );
  `,

  /* 3 — documents: metadata, fetched versions, extracted content */ `
  CREATE TABLE document (
    id             TEXT PRIMARY KEY,
    company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('annual_report', 'quarterly_results', 'investor_presentation', 'earnings_call_transcript', 'announcement_attachment', 'other')),
    title          TEXT NOT NULL,
    period_label   TEXT,
    published_at   TEXT,
    source_url     TEXT NOT NULL UNIQUE,
    discovered_via TEXT NOT NULL,
    origin         TEXT NOT NULL CHECK (origin IN ('exchange_filed', 'company_issued', 'third_party', 'unverified_external')),
    availability   TEXT NOT NULL DEFAULT 'pending' CHECK (availability IN ('pending', 'fetched', 'failed', 'unavailable', 'too_large', 'unsupported_type', 'not_fetched_policy')),
    last_error     TEXT,
    duplicate_of   TEXT REFERENCES document(id),
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX document_company_kind ON document(company_id, kind);

  CREATE TABLE document_version (
    id                TEXT PRIMARY KEY,
    document_id       TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    content_sha256    TEXT NOT NULL,
    byte_size         INTEGER NOT NULL CHECK (byte_size > 0),
    mime_type         TEXT NOT NULL,
    final_url         TEXT NOT NULL,
    fetched_at        TEXT NOT NULL,
    blob_path         TEXT NOT NULL,
    extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'extracted', 'partial', 'no_text_layer', 'failed')),
    extraction_error  TEXT,
    extractor_version TEXT,
    page_count        INTEGER,
    UNIQUE (document_id, content_sha256)
  );
  CREATE INDEX document_version_hash ON document_version(content_sha256);

  CREATE TABLE document_segment (
    version_id      TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
    ordinal         INTEGER NOT NULL,
    page_number     INTEGER CHECK (page_number IS NULL OR page_number > 0),
    section_heading TEXT,
    location_label  TEXT NOT NULL,                       -- 'p. 3' or '§ Opening remarks'
    text            TEXT NOT NULL,
    PRIMARY KEY (version_id, ordinal),
    CHECK (page_number IS NOT NULL OR section_heading IS NOT NULL)
  ) WITHOUT ROWID;
  `,

  /* 4 — financial facts with provenance */ `
  CREATE TABLE financial_fact (
    id                  TEXT PRIMARY KEY,
    company_id          TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
    metric              TEXT NOT NULL,
    basis               TEXT NOT NULL CHECK (basis IN (${inList(STATEMENT_BASES)})),
    period_type         TEXT NOT NULL CHECK (period_type IN (${inList(PERIOD_TYPES)})),
    period_start        TEXT NOT NULL,
    period_end          TEXT NOT NULL,
    period_label        TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN (${inList(VALUE_STATUSES)})),
    value               REAL,
    reported_text       TEXT,
    reported_value      REAL,
    unit                TEXT NOT NULL CHECK (unit IN (${inList(UNITS)})),
    reported_scale      TEXT CHECK (reported_scale IS NULL OR reported_scale IN (${inList(UNIT_SCALES)})),
    currency            TEXT,
    source_document_id  TEXT NOT NULL REFERENCES document(id),
    source_location     TEXT NOT NULL,                   -- JSON {page?, section?, tableLabel?, rowLabel?, columnLabel?}
    extraction_method   TEXT NOT NULL CHECK (extraction_method IN (${inList(EXTRACTION_METHODS)})),
    extractor_version   TEXT NOT NULL,
    verification_status TEXT NOT NULL CHECK (verification_status IN (${inList(VERIFICATION_STATUSES)})),
    verification_note   TEXT,
    restated            INTEGER NOT NULL DEFAULT 0 CHECK (restated IN (0, 1)),
    ingested_at         TEXT NOT NULL,
    CHECK ((value IS NULL) = (status IN ('not_reported', 'not_applicable', 'unparseable', 'ambiguous'))),
    CHECK (unit <> 'currency' OR currency IS NOT NULL),
    CHECK (status <> 'reported' OR (reported_value IS NOT NULL AND reported_text IS NOT NULL)),
    CHECK (period_start <= period_end),
    UNIQUE (company_id, metric, basis, period_type, period_end, source_document_id, source_location)
  );
  CREATE INDEX financial_fact_key ON financial_fact(company_id, metric, basis, period_type, period_end);
  `,

  /* 5 — retrieval chunks, management statements, research reports, model-call log */ `
  ALTER TABLE document_version ADD COLUMN index_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending', 'indexed', 'skipped', 'failed'));
  ALTER TABLE document_version ADD COLUMN chunker_version TEXT;

  CREATE TABLE chunk (
    id              TEXT PRIMARY KEY,                    -- '<version_id>:<ordinal>' (stable across re-reads)
    version_id      TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
    document_id     TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
    ordinal         INTEGER NOT NULL,
    page_start      INTEGER,
    page_end        INTEGER,
    section_heading TEXT,
    location_label  TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('prose', 'table', 'mixed')),
    text            TEXT NOT NULL,
    CHECK (page_start IS NULL OR page_end >= page_start)
  );
  CREATE INDEX chunk_version ON chunk(version_id, ordinal);
  CREATE INDEX chunk_company ON chunk(company_id);
  CREATE VIRTUAL TABLE chunk_fts USING fts5(text, section_heading, content='chunk', content_rowid='rowid', tokenize='porter unicode61');
  CREATE TRIGGER chunk_ai AFTER INSERT ON chunk BEGIN
    INSERT INTO chunk_fts(rowid, text, section_heading) VALUES (new.rowid, new.text, coalesce(new.section_heading, ''));
  END;
  CREATE TRIGGER chunk_ad AFTER DELETE ON chunk BEGIN
    INSERT INTO chunk_fts(chunk_fts, rowid, text, section_heading) VALUES ('delete', old.rowid, old.text, coalesce(old.section_heading, ''));
  END;

  CREATE TABLE management_statement (
    id                TEXT PRIMARY KEY,
    company_id        TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
    document_id       TEXT NOT NULL REFERENCES document(id),
    chunk_id          TEXT NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
    quote             TEXT NOT NULL,                     -- verbatim span from the chunk
    speaker           TEXT,
    subject           TEXT NOT NULL,                     -- metric or business subject
    nature            TEXT NOT NULL CHECK (nature IN ('quantitative', 'qualitative')),
    target_low        REAL,
    target_high       REAL,
    target_unit       TEXT CHECK (target_unit IS NULL OR target_unit IN ('percent', 'inr_crore', 'bps', 'count')),
    horizon_text      TEXT,                              -- as stated: 'FY27', 'this year', 'next 2-3 years'
    horizon_period    TEXT,                              -- normalized only when explicit: 'FY27', 'Q3 FY27'
    extraction_method TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    CHECK (nature = 'qualitative' OR target_low IS NOT NULL),
    CHECK (target_high IS NULL OR target_low <= target_high),
    UNIQUE (chunk_id, quote)
  );

  CREATE TABLE research_report (
    id           TEXT PRIMARY KEY,
    company_id   TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
    request      TEXT NOT NULL,                          -- JSON of the validated request
    input_hash   TEXT NOT NULL,                          -- documents + versions + engine version
    status       TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
    report       TEXT NOT NULL,                          -- JSON, schema-validated on write and read
    data_mode    TEXT NOT NULL CHECK (data_mode IN ('live', 'fixture')),
    created_at   TEXT NOT NULL
  );
  CREATE INDEX research_report_company ON research_report(company_id, created_at);

  CREATE TABLE llm_call (
    cache_key      TEXT PRIMARY KEY,                     -- sha256(task, prompt version, model, input)
    task           TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    model          TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('ok', 'invalid_output', 'refused', 'error')),
    output         TEXT,                                 -- validated JSON (status ok only)
    error          TEXT,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    created_at     TEXT NOT NULL
  );
  `,

  /* 6 — alert rules, evaluated events, and their delivery (kept separate) */ `
  CREATE TABLE alert_rule (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('price_move', 'volume_spike', 'announcement')),
    name       TEXT NOT NULL,
    enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    scope      TEXT NOT NULL,                            -- JSON, validated by RuleInputSchema
    params     TEXT NOT NULL,                            -- JSON, validated by RuleInputSchema
    version    INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE alert_event (
    id            TEXT PRIMARY KEY,
    rule_id       TEXT NOT NULL,                         -- no FK: events outlive deleted rules
    rule_version  INTEGER NOT NULL,
    rule_snapshot TEXT NOT NULL,                         -- the rule as it was when it fired
    company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
    signal_id     TEXT NOT NULL,
    subject_key   TEXT NOT NULL,
    dedupe_key    TEXT NOT NULL UNIQUE,                  -- rule + event: one notification per event per rule
    signal        TEXT NOT NULL,                         -- signal and explanation as evaluated
    occurred_at   TEXT NOT NULL,
    evaluated_at  TEXT NOT NULL
  );
  CREATE INDEX alert_event_rule_subject ON alert_event(rule_id, subject_key);
  CREATE INDEX alert_event_time ON alert_event(occurred_at);

  CREATE TABLE alert_delivery (
    event_id     TEXT PRIMARY KEY REFERENCES alert_event(id) ON DELETE CASCADE,
    channel      TEXT NOT NULL CHECK (channel IN ('in_app')),
    status       TEXT NOT NULL CHECK (status IN ('pending', 'seen')),
    created_at   TEXT NOT NULL,
    seen_at      TEXT
  );
  `,

  /* 7 — the watchlist the feed and alerts cover, and simple preferences (single local user; no accounts) */ `
  CREATE TABLE watchlist_entry (
    company_id TEXT PRIMARY KEY REFERENCES company(id) ON DELETE CASCADE,
    added_at   TEXT NOT NULL
  );

  CREATE TABLE preference (
    key        TEXT PRIMARY KEY CHECK (length(key) <= 64),
    value      TEXT NOT NULL CHECK (length(value) <= 2000),
    updated_at TEXT NOT NULL
  );
  `,
];
