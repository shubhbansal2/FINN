import { z } from 'zod';

import { CATEGORIES } from '@/domain/taxonomy';

import { evaluatePriceMove, evaluateVolumeSpike, sessionCloseUtc } from './anomalies';
import type { SignalPolicy } from './policy';
import { TIER_RANK, TIERS, type BarSeries, type Signal } from './types';

/**
 * User alert rules. Evaluation (this file) is pure: it turns rules plus data
 * into alert candidates with deterministic dedupe keys. Persisting events and
 * delivering them are separate steps (store.ts), so re-running evaluation on
 * the same data can never notify twice.
 */

const Scope = z.discriminatedUnion('type', [z.object({ type: z.literal('watchlist') }), z.object({ type: z.literal('companies'), companyIds: z.array(z.string().min(1)).min(1).max(50) })]);

const Common = {
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  scope: Scope,
};

export const RuleInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('price_move'),
    ...Common,
    params: z.object({ thresholdPct: z.number().min(0.5).max(50), direction: z.enum(['both', 'up', 'down']), minVolumeShares: z.number().int().min(0).max(1e10) }),
  }),
  z.object({
    kind: z.literal('volume_spike'),
    ...Common,
    params: z
      .object({ multiple: z.number().min(1.2).max(50), lookbackSessions: z.number().int().min(5).max(120), minHistorySessions: z.number().int().min(3).max(120), minVolumeShares: z.number().int().min(0).max(1e10) })
      .refine((p) => p.minHistorySessions <= p.lookbackSessions, { message: 'minimum history cannot exceed the lookback', path: ['minHistorySessions'] }),
  }),
  z.object({
    kind: z.literal('announcement'),
    ...Common,
    params: z.object({ categories: z.array(z.enum(CATEGORIES)).min(1), minTier: z.enum(TIERS) }),
  }),
]);
export type RuleInput = z.infer<typeof RuleInputSchema>;
export type AlertRule = RuleInput & { id: string; version: number; createdAt: string; updatedAt: string };

export const DEFAULT_RULES: RuleInput[] = [
  { kind: 'price_move', name: 'Daily move beyond ±5%', enabled: true, scope: { type: 'watchlist' }, params: { thresholdPct: 5, direction: 'both', minVolumeShares: 0 } },
  { kind: 'volume_spike', name: 'Volume above 2× its 20-session average', enabled: true, scope: { type: 'watchlist' }, params: { multiple: 2, lookbackSessions: 20, minHistorySessions: 15, minVolumeShares: 0 } },
  {
    kind: 'announcement',
    name: 'Material filings',
    enabled: true,
    scope: { type: 'watchlist' },
    params: { categories: ['results', 'ma', 'management_change', 'fund_raise', 'litigation', 'credit_rating', 'pledging'], minTier: 'medium' },
  },
];

export type AlertCandidate = {
  ruleId: string;
  ruleVersion: number;
  rule: AlertRule;
  signal: Signal;
  /** The event the rule fired on, independent of the rule's parameters. */
  subjectKey: string;
  /** Keys of the same event under another identity (suppressed duplicate filings). */
  alternateSubjectKeys: string[];
  /** Unique per (rule, event): re-evaluation and rule edits never re-notify the same event. */
  dedupeKey: string;
};

const inScope = (rule: AlertRule, companyId: string, watchlist: ReadonlySet<string>) => (rule.scope.type === 'watchlist' ? watchlist.has(companyId) : rule.scope.companyIds.includes(companyId));

export function evaluateRules(input: {
  rules: AlertRule[];
  series: BarSeries[];
  /** Ranked, de-duplicated announcement signals (from the digest pipeline). */
  announcements: Signal[];
  watchlist: ReadonlySet<string>;
  policy: SignalPolicy;
  /** Only events at or after this instant are evaluated. */
  since: string;
}): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  for (const rule of input.rules.filter((r) => r.enabled)) {
    const make = (signal: Signal, subjectKey: string, alternates: string[] = []): AlertCandidate => ({
      ruleId: rule.id,
      ruleVersion: rule.version,
      rule,
      signal,
      subjectKey,
      alternateSubjectKeys: alternates,
      dedupeKey: `${rule.id}|${subjectKey}`,
    });

    if (rule.kind === 'announcement') {
      for (const s of input.announcements) {
        if (s.occurredAt < input.since || !inScope(rule, s.companyId, input.watchlist)) continue;
        if (!s.category || !(rule.params.categories as string[]).includes(s.category)) continue;
        if (TIER_RANK[s.tier] > TIER_RANK[rule.params.minTier]) continue;
        out.push(make(s, `ann:${s.id}`, s.duplicates.map((d) => `ann:${d.id}`)));
      }
      continue;
    }

    for (const series of input.series) {
      if (!inScope(rule, series.companyId, input.watchlist)) continue;
      series.bars.forEach((bar, i) => {
        if (sessionCloseUtc(bar.tradeDate) < input.since) return;
        const subjectKey = `${rule.kind === 'price_move' ? 'px' : 'vol'}:${series.listingId}:${bar.tradeDate}`;
        const r =
          rule.kind === 'price_move'
            ? evaluatePriceMove(series, i, { ...input.policy.prices, movePct: rule.params.thresholdPct, direction: rule.params.direction, minVolumeShares: rule.params.minVolumeShares })
            : evaluateVolumeSpike(series, i, { ...input.policy.volume, multiple: rule.params.multiple, lookbackSessions: rule.params.lookbackSessions, minHistorySessions: rule.params.minHistorySessions, minVolumeShares: rule.params.minVolumeShares });
        if (r.status === 'signal') {
          const signal = { ...r.signal, explanation: { ...r.signal.explanation, why: [`Alert rule "${rule.name}" (v${rule.version}) fired.`, ...r.signal.explanation.why] } };
          out.push(make(signal, subjectKey));
        }
      });
    }
  }
  return out;
}
