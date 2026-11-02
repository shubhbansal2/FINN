import type { Db } from '@/db/connection';
import { err, ok, type Result } from '@/domain/result';

import { buildDigest, parseWindow, suppressDuplicates, type Digest } from './digest';
import { loadPolicy, rankAnnouncement, type SignalPolicy } from './policy';
import { evaluateRules } from './rules';
import { alertedSignalIds, ensureDefaultRules, listRules, loadSignalInputs, recordAlerts, type StoredAlert } from './store';

/**
 * Push service: composes storage with the pure engine. Nothing here runs in
 * the background. The digest and alert evaluation happen when the Brief or
 * Alerts screen loads, or when `npm run finn -- alerts:evaluate` is run.
 */

/** Alerts consider events from this many days back; older events are never (re)notified. */
export const ALERT_HORIZON_DAYS = 10;

export function getDigest(db: Db, opts: { window?: string | null; now: Date; dataMode: 'live' | 'fixture'; policy?: SignalPolicy }): Result<Digest, string> {
  const window = parseWindow(opts.window, opts.now);
  if (!window.ok) return err(window.error);
  const policy = opts.policy ?? loadPolicy();
  // Load from before the window too, so "latest before the window" and combinations at the edge work.
  const since = new Date(Math.min(Date.parse(window.value.from), opts.now.getTime() - 30 * 86_400_000)).toISOString();
  const inputs = loadSignalInputs(db, { since, until: window.value.to, dataMode: opts.dataMode });
  return ok(buildDigest({ ...inputs, policy, window: window.value, now: opts.now, alertedSignalIds: alertedSignalIds(db) }));
}

export type EvaluationSummary = { evaluatedAt: string; rules: number; created: StoredAlert[]; skippedDuplicates: number; since: string };

/** Evaluates enabled rules over recent data and records new alerts. Idempotent for unchanged data. */
export function evaluateAlerts(db: Db, opts: { now: Date; dataMode: 'live' | 'fixture'; policy?: SignalPolicy }): EvaluationSummary {
  const now = opts.now.toISOString();
  ensureDefaultRules(db, now);
  const policy = opts.policy ?? loadPolicy();
  const since = new Date(opts.now.getTime() - ALERT_HORIZON_DAYS * 86_400_000).toISOString();
  const inputs = loadSignalInputs(db, { since, until: now, dataMode: opts.dataMode });
  const ranked = inputs.announcements.map((row) => ({ row, signal: rankAnnouncement(row, policy, opts.now) }));
  const { kept } = suppressDuplicates(ranked, policy);
  const rules = listRules(db);
  const candidates = evaluateRules({ rules, series: inputs.series, announcements: kept, watchlist: inputs.watchlist, policy, since });
  const { created, skipped } = recordAlerts(db, candidates, now);
  return { evaluatedAt: now, rules: rules.filter((r) => r.enabled).length, created, skippedDuplicates: skipped, since };
}
