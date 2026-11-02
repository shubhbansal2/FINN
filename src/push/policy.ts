import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { CATEGORIES, CATEGORY_LABEL, type Category } from '@/domain/taxonomy';

import { isIncoming, lower, TIERS, type AnnouncementInputRow, type EvidenceRef, type Signal, type Tier } from './types';

const TierSchema = z.enum(TIERS);

const ContentRuleSchema = z.object({
  id: z.string().regex(/^[a-z_]+\.[a-z_.]+$/),
  category: z.enum(CATEGORIES),
  pattern: z.string().min(2).max(400),
  tier: TierSchema,
  reason: z.string().min(5).max(300),
});

const CombinationSchema = z.object({
  id: z.string().min(1),
  requires: z.array(z.enum(['announcement', 'results', 'price_move', 'volume_spike'])).min(2),
  /** Maximum distance in trading sessions between the component events (0 = same session). */
  sessionWindow: z.number().int().min(0).max(5),
  minAnnouncementTier: TierSchema.optional(),
  tier: TierSchema,
  reason: z.string().min(5),
});

export const SignalPolicySchema = z.object({
  categoryTiers: z.record(z.enum(CATEGORIES), TierSchema).refine((r) => CATEGORIES.every((c) => c in r), 'every category needs a tier'),
  contentRules: z.array(ContentRuleSchema),
  ambiguousTier: TierSchema,
  /** Lower a filing by one tier when no primary-source document is linked. */
  missingEvidencePenalty: z.boolean(),
  staleAfterHours: z.number().positive().max(24 * 31),
  duplicateWindowHours: z.number().nonnegative().max(72),
  prices: z.object({
    /** Which series daily returns use. `adjusted_close` falls back to `close` (with a note) when unavailable. */
    series: z.enum(['adjusted_close', 'close']),
    movePct: z.number().positive().max(50),
    highMoveMultiple: z.number().min(1).max(10),
    maxSessionGapDays: z.number().int().min(1).max(30),
    /** If adjusted and raw returns differ by more than this (pp), a corporate action is assumed between the sessions. */
    corporateActionGapPct: z.number().positive().max(50),
  }),
  volume: z.object({
    multiple: z.number().min(1).max(50),
    highMultiple: z.number().min(1).max(100),
    lookbackSessions: z.number().int().min(5).max(250),
    minHistorySessions: z.number().int().min(3).max(250),
    minVolumeShares: z.number().int().min(0),
  }).refine((v) => v.minHistorySessions <= v.lookbackSessions, 'minHistorySessions must not exceed lookbackSessions'),
  combinations: z.array(CombinationSchema),
});

export type SignalPolicy = z.infer<typeof SignalPolicySchema>;

export class PolicyError extends Error {
  override name = 'PolicyError';
}

export function parsePolicy(raw: unknown): SignalPolicy {
  const r = SignalPolicySchema.safeParse(raw);
  if (!r.success) throw new PolicyError(`Invalid signal policy: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  for (const rule of r.data.contentRules) {
    try {
      new RegExp(rule.pattern, 'i');
    } catch (e) {
      throw new PolicyError(`content rule ${rule.id}: invalid pattern (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return r.data;
}

export function loadPolicy(file = path.join(process.cwd(), 'config', 'signal-policy.json')): SignalPolicy {
  return parsePolicy(JSON.parse(readFileSync(file, 'utf8')));
}

const hash = (s: string) => {
  // Small stable FNV-1a hash for ids; collisions only merge display ids, never data.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};
export const signalId = (kind: string, key: string) => `${kind}:${hash(key)}`;

/** Tier for a category. The schema guarantees every category is present; `routine` is a defensive floor. */
export const categoryTier = (policy: SignalPolicy, c: Category): Tier => policy.categoryTiers[c] ?? 'routine';

const isPrimary = (o: AnnouncementInputRow['documentOrigin']) => o === 'exchange_filed' || o === 'company_issued';

/**
 * Initial tier for one announcement, from category, then content, then
 * evidence. Every adjustment appends its reason and rule id.
 */
export function rankAnnouncement(a: AnnouncementInputRow, policy: SignalPolicy, now: Date): Signal {
  const category = (CATEGORIES as readonly string[]).includes(a.category) ? (a.category as Category) : 'unclassified';
  const why: string[] = [];
  const rules: string[] = [];
  const unknowns: string[] = [];
  let tier: Tier;

  if (a.classificationStatus === 'ambiguous') {
    tier = policy.ambiguousTier;
    why.push(`Category unclear from the filed subject${a.secondary.length ? ` (could be ${a.secondary.map((c) => CATEGORY_LABEL[c as Category] ?? c).join(' or ')})` : ''}.`);
    rules.push('classification:ambiguous');
  } else if (a.classificationStatus === 'routine') {
    tier = 'routine';
    why.push('Routine compliance filing.');
    rules.push('classification:routine');
  } else if (a.classificationStatus === 'no_match') {
    tier = categoryTier(policy, 'unclassified');
    why.push('No category rule matched the filed subject.');
    rules.push('classification:no_match');
  } else {
    tier = categoryTier(policy, category);
    why.push(`${CATEGORY_LABEL[category]} filings start at ${tier} priority.`);
    rules.push(`category:${category}`);
  }

  // Content: first matching rule for the category, against the subject and any downloaded text.
  const content = `${a.title}\n${a.attachmentText ?? ''}`;
  const rule = policy.contentRules.find((r) => r.category === category && new RegExp(r.pattern, 'i').test(content));
  if (rule && a.classificationStatus === 'matched') {
    tier = rule.tier;
    why.push(rule.reason);
    rules.push(`content:${rule.id}`);
  }

  const evidence: EvidenceRef[] = [];
  if (a.documentUrl && isPrimary(a.documentOrigin)) {
    evidence.push({ kind: 'filing', label: 'Exchange filing', url: a.documentUrl, origin: a.documentOrigin === 'company_issued' ? 'company_issued' : 'exchange_filed' });
  } else if (policy.missingEvidencePenalty && tier !== 'routine') {
    tier = lower(tier);
    why.push('No primary-source document is linked, so it ranks one level lower.');
    rules.push('evidence:missing');
  }
  if (!a.attachmentText) unknowns.push('FINN ranked this from the filed subject only; the attachment has not been read.');
  if (category === 'results' && !a.firstCut && TIERS.indexOf(tier) <= 1) unknowns.push('No headline figures from this filing have been read and checked yet.');
  if (category === 'management_change' && TIERS.indexOf(tier) <= 1) {
    if (!a.people) unknowns.push('FINN has not yet read who changes in this filing.');
    else if (a.people.length === 0) unknowns.push('FINN could not identify, from the filing text, who changes.');
    else if (a.people.some((p) => isIncoming(p) && p.background.length === 0)) unknowns.push('The filing gives no background for some incoming people.');
  }
  if (a.firstCut) {
    const left = a.firstCut.lines.filter((l) => l.current === null).map((l) => l.label);
    if (left.length) unknowns.push(`${left.join(', ')} for the quarter ${left.length === 1 ? 'is' : 'are'} not shown: ${a.firstCut.lines.find((l) => l.current === null)?.note ?? 'not available'}.`);
    unknowns.push('The first cut is read from the results statement only: segment detail, one-off items and management commentary are not in it.');
  }

  const stale = now.getTime() - Date.parse(a.publishedAt) > policy.staleAfterHours * 3_600_000;
  const isResults = category === 'results' && rules.every((r) => !r.startsWith('content:results.'));

  return {
    id: signalId('ann', a.id),
    kind: isResults ? 'results' : 'announcement',
    companyId: a.companyId,
    companyName: a.companyName,
    symbol: a.symbol,
    tier,
    occurredAt: a.publishedAt,
    ingestedAt: a.ingestedAt,
    tradeDate: null,
    headline: a.title,
    category,
    explanation: {
      what: `${a.companyName} filed "${a.title}".`,
      why,
      rules,
      evidence,
      unknowns,
    },
    components: [],
    measure: null,
    duplicates: [],
    stale,
    firstCut: a.firstCut,
    people: a.people,
    dataMode: a.dataMode,
  };
}

