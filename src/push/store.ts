import { randomUUID } from 'node:crypto';

import type { Db } from '@/db/connection';
import { ensureWatchlist, factsForDocument, getBars, listCompanies, listListings, pagesOfVersion, latestVersion } from '@/db/repositories';
import { safeDocumentUrl } from '@/ui/evidence';

import { buildFirstCut } from './first-cut';
import { DEFAULT_RULES, RuleInputSchema, type AlertCandidate, type AlertRule, type RuleInput } from './rules';
import type { AnnouncementInputRow, BarSeries, Signal } from './types';

// ------------------------------------------------------------------ rules

type RuleRow = { id: string; kind: string; name: string; enabled: number; scope: string; params: string; version: number; created_at: string; updated_at: string };

function toRule(r: RuleRow): AlertRule | null {
  const parsed = RuleInputSchema.safeParse({ kind: r.kind, name: r.name, enabled: r.enabled === 1, scope: JSON.parse(r.scope) as unknown, params: JSON.parse(r.params) as unknown });
  // A stored rule that no longer validates is skipped rather than evaluated with bad parameters.
  return parsed.success ? { ...parsed.data, id: r.id, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at } : null;
}

export function listRules(db: Db): AlertRule[] {
  return (db.prepare(`SELECT * FROM alert_rule ORDER BY created_at, id`).all() as RuleRow[]).map(toRule).filter((r): r is AlertRule => r !== null);
}

export function getRule(db: Db, id: string): AlertRule | null {
  const row = db.prepare(`SELECT * FROM alert_rule WHERE id = ?`).get(id) as RuleRow | undefined;
  return row ? toRule(row) : null;
}

/** Creates a rule, or replaces one and increments its version. Input is validated here, at the boundary. */
export function saveRule(db: Db, input: unknown, now: string, id?: string): AlertRule {
  const rule: RuleInput = RuleInputSchema.parse(input);
  const existing = id ? (db.prepare(`SELECT version, created_at FROM alert_rule WHERE id = ?`).get(id) as { version: number; created_at: string } | undefined) : undefined;
  if (id && !existing) throw new Error(`Rule ${id} does not exist`);
  const ruleId = id ?? randomUUID();
  db.prepare(
    `INSERT INTO alert_rule (id, kind, name, enabled, scope, params, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, enabled = excluded.enabled, scope = excluded.scope,
       params = excluded.params, version = excluded.version, updated_at = excluded.updated_at`,
  ).run(ruleId, rule.kind, rule.name, rule.enabled ? 1 : 0, JSON.stringify(rule.scope), JSON.stringify(rule.params), (existing?.version ?? 0) + 1, existing?.created_at ?? now, now);
  const saved = getRule(db, ruleId);
  if (!saved) throw new Error('rule was not saved');
  return saved;
}

/** Deletes a rule. Its past alert events are kept (with the rule snapshot they fired under). */
export function deleteRule(db: Db, id: string): boolean {
  return db.prepare(`DELETE FROM alert_rule WHERE id = ?`).run(id).changes > 0;
}

/** Seeds the default rules once, when no rule has ever been created. */
export function ensureDefaultRules(db: Db, now: string): void {
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM alert_rule`).get() as { n: number }).n;
  if (n === 0) for (const r of DEFAULT_RULES) saveRule(db, r, now);
}

// ------------------------------------------------------------------ events and delivery

export type StoredAlert = {
  id: string;
  ruleId: string;
  ruleName: string;
  ruleVersion: number;
  signal: Signal;
  occurredAt: string;
  evaluatedAt: string;
  delivery: { status: 'pending' | 'seen'; seenAt: string | null };
};

/**
 * Persists new alert events and queues their in-app delivery. An event whose
 * dedupe key, or any alternate identity of the same filing, already exists for
 * the rule is skipped: repeated ingestion or evaluation never notifies twice.
 */
export function recordAlerts(db: Db, candidates: AlertCandidate[], now: string): { created: StoredAlert[]; skipped: number } {
  const created: StoredAlert[] = [];
  let skipped = 0;
  const exists = db.prepare(`SELECT 1 FROM alert_event WHERE rule_id = ? AND subject_key = ? LIMIT 1`);
  const insertEvent = db.prepare(
    `INSERT INTO alert_event (id, rule_id, rule_version, rule_snapshot, company_id, signal_id, subject_key, dedupe_key, signal, occurred_at, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
  );
  const insertDelivery = db.prepare(`INSERT INTO alert_delivery (event_id, channel, status, created_at) VALUES (?, 'in_app', 'pending', ?)`);
  db.transaction(() => {
    for (const c of candidates) {
      if ([c.subjectKey, ...c.alternateSubjectKeys].some((k) => exists.get(c.ruleId, k))) {
        skipped += 1;
        continue;
      }
      const id = randomUUID();
      const r = insertEvent.run(id, c.ruleId, c.ruleVersion, JSON.stringify(c.rule), c.signal.companyId, c.signal.id, c.subjectKey, c.dedupeKey, JSON.stringify(c.signal), c.signal.occurredAt, now);
      if (r.changes === 0) {
        skipped += 1;
        continue;
      }
      insertDelivery.run(id, now);
      created.push({ id, ruleId: c.ruleId, ruleName: c.rule.name, ruleVersion: c.ruleVersion, signal: c.signal, occurredAt: c.signal.occurredAt, evaluatedAt: now, delivery: { status: 'pending', seenAt: null } });
    }
  })();
  return { created, skipped };
}

export function listAlerts(db: Db, opts: { limit?: number; status?: 'pending' | 'seen' } = {}): StoredAlert[] {
  const rows = db
    .prepare(
      `SELECT e.*, d.status, d.seen_at FROM alert_event e JOIN alert_delivery d ON d.event_id = e.id
       WHERE (@status IS NULL OR d.status = @status) ORDER BY e.occurred_at DESC, e.id LIMIT @limit`,
    )
    .all({ status: opts.status ?? null, limit: opts.limit ?? 100 }) as {
    id: string;
    rule_id: string;
    rule_version: number;
    rule_snapshot: string;
    signal: string;
    occurred_at: string;
    evaluated_at: string;
    status: 'pending' | 'seen';
    seen_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    ruleId: r.rule_id,
    ruleName: (JSON.parse(r.rule_snapshot) as { name?: string }).name ?? 'Deleted rule',
    ruleVersion: r.rule_version,
    signal: JSON.parse(r.signal) as Signal,
    occurredAt: r.occurred_at,
    evaluatedAt: r.evaluated_at,
    delivery: { status: r.status, seenAt: r.seen_at },
  }));
}

/** Marks in-app deliveries as seen. Returns how many changed. */
export function acknowledgeAlerts(db: Db, eventIds: string[], now: string): number {
  const stmt = db.prepare(`UPDATE alert_delivery SET status = 'seen', seen_at = ? WHERE event_id = ? AND status = 'pending'`);
  let n = 0;
  db.transaction(() => {
    for (const id of eventIds) n += stmt.run(now, id).changes;
  })();
  return n;
}

export function alertedSignalIds(db: Db): Set<string> {
  return new Set((db.prepare(`SELECT DISTINCT signal_id FROM alert_event`).all() as { signal_id: string }[]).map((r) => r.signal_id));
}

// ------------------------------------------------------------------ digest inputs

/** Announcements and price series for the watchlist, shaped for the pure engine. */
export function loadSignalInputs(db: Db, opts: { since: string; until: string; dataMode: 'live' | 'fixture' }): { announcements: AnnouncementInputRow[]; series: BarSeries[]; watchlist: Set<string> } {
  ensureWatchlist(db, opts.until);
  const companies = listCompanies(db, { watchlist: true });
  const watchlist = new Set(companies.map((c) => c.id));
  const byId = new Map(companies.map((c) => [c.id, c]));

  const rows = db
    .prepare(
      `SELECT a.*, c.category, c.status AS cstatus, c.secondary,
         d.id AS doc_id, d.origin, d.duplicate_of
       FROM announcement a
       LEFT JOIN announcement_classification c ON c.announcement_id = a.id
         AND c.version = (SELECT version FROM announcement_classification WHERE announcement_id = a.id ORDER BY classified_at DESC LIMIT 1)
       LEFT JOIN document d ON d.source_url = a.document_url
       WHERE a.published_at >= ? AND a.published_at < ?
       ORDER BY a.published_at DESC`,
    )
    .all(opts.since, opts.until) as {
    id: string;
    company_id: string;
    title: string;
    published_at: string;
    ingested_at: string;
    document_url: string | null;
    category: string | null;
    cstatus: AnnouncementInputRow['classificationStatus'] | null;
    secondary: string | null;
    doc_id: string | null;
    origin: AnnouncementInputRow['documentOrigin'];
    duplicate_of: string | null;
  }[];

  const announcements: AnnouncementInputRow[] = rows
    .filter((r) => watchlist.has(r.company_id))
    .map((r) => {
      const company = byId.get(r.company_id);
      const version = r.doc_id ? latestVersion(db, r.doc_id) : null;
      const text = version && (version.extraction_status === 'extracted' || version.extraction_status === 'partial') ? pagesOfVersion(db, version.id).slice(0, 2).map((p) => p.text).join('\n').slice(0, 4_000) : null;
      const documentUrl = r.document_url;
      // Only the filing's own facts: the first cut never mixes in figures from another document.
      const firstCut =
        r.doc_id && r.category === 'results' && !r.duplicate_of
          ? buildFirstCut(factsForDocument(db, r.doc_id), (page) => (documentUrl ? safeDocumentUrl(documentUrl, page ?? undefined) : null))
          : null;
      return {
        id: r.id,
        documentId: r.doc_id,
        companyId: r.company_id,
        companyName: company?.name ?? r.company_id,
        symbol: company?.nseSymbol ?? company?.bseCode ?? r.company_id,
        title: r.title,
        publishedAt: r.published_at,
        ingestedAt: r.ingested_at,
        category: r.category ?? 'unclassified',
        classificationStatus: r.cstatus ?? 'no_match',
        secondary: r.secondary ? (JSON.parse(r.secondary) as string[]) : [],
        documentUrl: r.document_url,
        documentOrigin: r.origin,
        duplicateOfDocument: r.duplicate_of,
        attachmentText: text,
        firstCut,
        dataMode: opts.dataMode,
      };
    });

  // Prices: NSE listing where present, BSE otherwise. Enough history before `since` for the volume baseline.
  const historyFrom = new Date(Date.parse(opts.since) - 60 * 86_400_000).toISOString().slice(0, 10);
  const listings = listListings(db, { watchlist: true });
  const nse = new Set(listings.filter((l) => l.exchange === 'NSE').map((l) => l.company_id));
  const series: BarSeries[] = listings
    .filter((l) => l.exchange === 'NSE' || !nse.has(l.company_id))
    .map((l) => {
      const company = byId.get(l.company_id);
      return {
        companyId: l.company_id,
        companyName: company?.name ?? l.company_id,
        symbol: company?.nseSymbol ?? l.symbol,
        listingId: l.id,
        bars: getBars(db, l.id, { from: historyFrom }).filter((b) => b.tradeDate <= opts.until.slice(0, 10)),
        dataMode: opts.dataMode,
      };
    })
    .filter((s) => s.bars.length > 0);

  return { announcements, series, watchlist };
}
