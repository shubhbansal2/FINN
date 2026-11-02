import { normalizeTitle } from '@/domain/announcements';
import { err, ok, type Result } from '@/domain/result';

import { marketSignals } from './anomalies';
import { rankAnnouncement, signalId, type SignalPolicy } from './policy';
import { TIER_RANK, raise, type AnnouncementInputRow, type BarSeries, type Signal, type SignalKind, type Tier } from './types';

// ------------------------------------------------------------------ windows

export type DigestWindow = { from: string; to: string; label: string };

const PRESETS: Record<string, { hours: number; label: string }> = {
  '24h': { hours: 24, label: 'Last 24 hours' },
  '3d': { hours: 72, label: 'Last 3 days' },
  '7d': { hours: 168, label: 'Last 7 days' },
  '30d': { hours: 720, label: 'Last 30 days' },
};
export const WINDOW_PRESETS = Object.keys(PRESETS) as ('24h' | '3d' | '7d' | '30d')[];
const MAX_CUSTOM_DAYS = 31;

/** IST midnight of a calendar date, as a UTC instant. */
const istMidnightUtc = (date: string) => new Date(Date.parse(`${date}T00:00:00+05:30`)).toISOString();

/**
 * A digest window: a preset ("24h", default) ending now, or a custom IST
 * date range "YYYY-MM-DD..YYYY-MM-DD" (inclusive, ≤ 31 days). Bounds are
 * half-open [from, to) in UTC so an event exactly at `to` is not counted twice.
 */
export function parseWindow(input: string | null | undefined, now: Date): Result<DigestWindow, string> {
  const raw = (input ?? '24h').trim();
  const preset = PRESETS[raw];
  if (preset) return ok({ from: new Date(now.getTime() - preset.hours * 3_600_000).toISOString(), to: now.toISOString(), label: preset.label });
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(raw);
  if (!m?.[1] || !m[2]) return err(`Unknown window "${raw.slice(0, 40)}". Use 24h, 3d, 7d, 30d or YYYY-MM-DD..YYYY-MM-DD.`);
  const from = istMidnightUtc(m[1]);
  const endNext = new Date(Date.parse(`${m[2]}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const to = istMidnightUtc(endNext);
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from >= to) return err('The window start must be on or before its end.');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_CUSTOM_DAYS) return err(`Custom windows are limited to ${MAX_CUSTOM_DAYS} days.`);
  return ok({ from, to, label: `${m[1]} to ${m[2]} (IST)` });
}

// ------------------------------------------------------------------ ranking

const KIND_ORDER: Record<SignalKind, number> = { combination: 0, results: 1, announcement: 2, price_move: 3, volume_spike: 4 };

/** Total, stable order: tier, freshness, newest first, kind, id. Equivalent inputs always rank identically. */
export function compareSignals(a: Signal, b: Signal): number {
  return (
    TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
    Number(a.stale) - Number(b.stale) ||
    b.occurredAt.localeCompare(a.occurredAt) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.id.localeCompare(b.id)
  );
}

// ------------------------------------------------------------------ duplicates

type RankedAnnouncement = { signal: Signal; row: AnnouncementInputRow };

/**
 * Same filing surfaced more than once: same attachment URL, byte-identical
 * attachment, or same normalized subject within the duplicate window. The
 * strongest copy is kept; the others are listed under it, not dropped.
 */
export function suppressDuplicates(items: RankedAnnouncement[], policy: SignalPolicy): { kept: Signal[]; suppressed: number } {
  const byCompany = new Map<string, RankedAnnouncement[]>();
  for (const it of items) byCompany.set(it.row.companyId, [...(byCompany.get(it.row.companyId) ?? []), it]);
  const kept: Signal[] = [];
  let suppressed = 0;
  for (const list of byCompany.values()) {
    const ordered = [...list].sort((a, b) => compareSignals(a.signal, b.signal));
    const keptHere: RankedAnnouncement[] = [];
    for (const it of ordered) {
      const dup = keptHere.find(
        (k) =>
          (it.row.documentUrl && it.row.documentUrl === k.row.documentUrl) ||
          (it.row.duplicateOfDocument !== null && it.row.duplicateOfDocument === k.row.documentId) ||
          (k.row.duplicateOfDocument !== null && k.row.duplicateOfDocument === it.row.documentId) ||
          (normalizeTitle(it.row.title) === normalizeTitle(k.row.title) && Math.abs(Date.parse(it.row.publishedAt) - Date.parse(k.row.publishedAt)) <= policy.duplicateWindowHours * 3_600_000),
      );
      if (dup) {
        dup.signal.duplicates.push({ id: it.signal.id, headline: it.signal.headline, occurredAt: it.signal.occurredAt });
        suppressed += 1;
      } else {
        keptHere.push(it);
      }
    }
    kept.push(...keptHere.map((k) => k.signal));
  }
  return { kept, suppressed };
}

// ------------------------------------------------------------------ combinations

const weekday = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;

/** The trading session an event falls in: a filing after the 15:30 IST close, or on a weekend, belongs to the next weekday session. */
export function sessionOf(occurredAt: string): string {
  const ist = new Date(Date.parse(occurredAt) + 330 * 60_000);
  let d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minutes >= 15 * 60 + 30 || !weekday(d)) {
    do d = new Date(d.getTime() + 86_400_000);
    while (!weekday(d));
  }
  return d.toISOString().slice(0, 10);
}

/** Weekday distance between two sessions (exchange holidays not modelled). */
export function sessionDistance(a: string, b: string): number {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  let n = 0;
  for (let d = new Date(`${lo}T00:00:00Z`); d.toISOString().slice(0, 10) < hi; d = new Date(d.getTime() + 86_400_000)) {
    if (weekday(new Date(d.getTime() + 86_400_000))) n += 1;
  }
  return n;
}

const matchesKind = (s: Signal, k: string) => (k === 'announcement' ? s.kind === 'announcement' || s.kind === 'results' : s.kind === k);

export function combineSignals(signals: Signal[], policy: SignalPolicy): Signal[] {
  const out: Signal[] = [];
  const byCompany = new Map<string, Signal[]>();
  for (const s of signals) byCompany.set(s.companyId, [...(byCompany.get(s.companyId) ?? []), s]);

  for (const rule of policy.combinations) {
    for (const list of byCompany.values()) {
      const pools = rule.requires.map((k) =>
        list.filter((s) => matchesKind(s, k) && (!rule.minAnnouncementTier || (s.kind !== 'announcement' && s.kind !== 'results') || TIER_RANK[s.tier] <= TIER_RANK[rule.minAnnouncementTier])),
      );
      if (pools.some((p) => p.length === 0)) continue;
      // Anchor on each signal of the first required kind; pick the closest match of each other kind.
      for (const anchor of pools[0] ?? []) {
        const anchorSession = anchor.tradeDate ?? sessionOf(anchor.occurredAt);
        const parts = [anchor];
        for (const pool of pools.slice(1)) {
          const best = pool
            .map((s) => ({ s, d: sessionDistance(anchorSession, s.tradeDate ?? sessionOf(s.occurredAt)) }))
            .filter((x) => x.d <= rule.sessionWindow)
            .sort((a, b) => a.d - b.d || a.s.id.localeCompare(b.s.id))[0];
          if (!best) break;
          parts.push(best.s);
        }
        if (parts.length !== rule.requires.length) continue;
        const components = [...parts].sort((a, b) => a.id.localeCompare(b.id));
        const first = components[0] as Signal;
        const tier = components.reduce<Tier>((t, c) => raise(t, c.tier), rule.tier);
        const latest = components.reduce((a, c) => (c.occurredAt > a.occurredAt ? c : a), first);
        out.push({
          id: signalId('combo', `${rule.id}:${components.map((c) => c.id).join('+')}`),
          kind: 'combination',
          companyId: first.companyId,
          companyName: first.companyName,
          symbol: first.symbol,
          tier,
          occurredAt: latest.occurredAt,
          ingestedAt: components.reduce((a, c) => (c.ingestedAt > a ? c.ingestedAt : a), ''),
          tradeDate: components.find((c) => c.tradeDate)?.tradeDate ?? null,
          headline: components.map((c) => c.headline).join(' · '),
          category: components.find((c) => c.category)?.category ?? null,
          explanation: {
            what: `${first.companyName}: ${components.map((c) => c.headline).join('; ')}.`,
            why: [rule.reason],
            rules: [`combination:${rule.id}`, ...components.flatMap((c) => c.explanation.rules)],
            evidence: components.flatMap((c) => c.explanation.evidence),
            unknowns: ['These events are shown together because they are close in time. Co-occurrence is not evidence that one caused the other.', ...new Set(components.flatMap((c) => c.explanation.unknowns))],
          },
          components: components.map((c) => c.id),
          measure: components.find((c) => c.kind === 'price_move')?.measure ?? components.find((c) => c.measure)?.measure ?? null,
          duplicates: [],
          stale: components.every((c) => c.stale),
          // A combination that includes a results filing keeps its headline numbers.
          firstCut: components.find((c) => c.firstCut)?.firstCut ?? null,
          people: components.find((c) => c.people)?.people ?? null,
          dataMode: first.dataMode,
        });
      }
    }
  }
  // The same component set can be reached from different anchors, and two rules can share a
  // component (filing + move, move + volume). Overlapping combinations merge into one so an
  // event is never shown twice; every component and every reason is kept.
  return mergeOverlapping([...new Map(out.map((s) => [s.id, s])).values()], new Map(signals.map((s) => [s.id, s])));
}

function mergeOverlapping(combos: Signal[], byId: Map<string, Signal>): Signal[] {
  const merged: Signal[] = [];
  for (const c of [...combos].sort((a, b) => a.id.localeCompare(b.id))) {
    const hit = merged.find((m) => m.companyId === c.companyId && m.components.some((id) => c.components.includes(id)));
    if (!hit) {
      merged.push({ ...c, components: [...c.components], explanation: { ...c.explanation, why: [...c.explanation.why], rules: [...c.explanation.rules], evidence: [...c.explanation.evidence], unknowns: [...c.explanation.unknowns] } });
      continue;
    }
    hit.components = [...new Set([...hit.components, ...c.components])].sort();
    hit.tier = raise(hit.tier, c.tier);
    hit.occurredAt = hit.occurredAt > c.occurredAt ? hit.occurredAt : c.occurredAt;
    hit.explanation.why = [...new Set([...hit.explanation.why, ...c.explanation.why])];
    hit.explanation.rules = [...new Set([...hit.explanation.rules, ...c.explanation.rules])];
    hit.explanation.unknowns = [...new Set([...hit.explanation.unknowns, ...c.explanation.unknowns])];
    const seen = new Set(hit.explanation.evidence.map((e) => JSON.stringify(e)));
    for (const e of c.explanation.evidence) if (!seen.has(JSON.stringify(e))) hit.explanation.evidence.push(e);
  }
  // Ids and text are recomputed from the final component set, so the result is independent of merge order.
  return merged.map((m) => {
    const parts = m.components.map((id) => byId.get(id)).filter((x): x is Signal => !!x).sort(compareSignals);
    return {
      ...m,
      id: signalId('combo', m.components.join('+')),
      headline: parts.map((p) => p.headline).join(' · '),
      explanation: { ...m.explanation, what: `${m.companyName}: ${parts.map((p) => p.headline).join('; ')}.` },
      stale: parts.every((p) => p.stale),
    };
  });
}

// ------------------------------------------------------------------ digest

export type DigestItem = { signal: Signal; children: Signal[]; alerted: boolean };
export type CompanyGroup = { companyId: string; companyName: string; symbol: string; topTier: Tier; items: DigestItem[]; routine: Signal[] };

export type Digest = {
  window: DigestWindow;
  generatedAt: string;
  groups: CompanyGroup[];
  counts: Record<Tier, number> & { total: number; duplicatesSuppressed: number; routineCollapsed: number };
  /** Data gaps that prevented a rule from being evaluated (missing sessions, short history). */
  notes: string[];
  /** The most recent material signal before the window, so an empty window still says something useful. */
  latestBefore: { headline: string; companyName: string; occurredAt: string } | null;
  dataMode: 'live' | 'fixture' | 'mixed' | 'none';
};

export type DigestInput = {
  announcements: AnnouncementInputRow[];
  series: BarSeries[];
  policy: SignalPolicy;
  window: DigestWindow;
  now: Date;
  /** Signal ids that already produced an alert event. */
  alertedSignalIds?: ReadonlySet<string>;
};

export function buildDigest(input: DigestInput): Digest {
  const { policy, window, now } = input;
  const inWindow = (t: string) => t >= window.from && t < window.to;

  const ranked = input.announcements.map((row) => ({ row, signal: rankAnnouncement(row, policy, now) }));
  const { kept, suppressed } = suppressDuplicates(ranked.filter((r) => inWindow(r.row.publishedAt)), policy);

  // Market signals need the session before the window too, so a move on the first day can still combine.
  const market = marketSignals(input.series, policy, window);
  const base = [...kept, ...market.signals];
  const combos = combineSignals(base, policy).filter((c) => inWindow(c.occurredAt));
  const inCombo = new Set(combos.flatMap((c) => c.components));
  const alerted = input.alertedSignalIds ?? new Set<string>();

  const byId = new Map(base.map((s) => [s.id, s]));
  const top = [...combos, ...base.filter((s) => !inCombo.has(s.id))];

  const groups = new Map<string, CompanyGroup>();
  for (const s of top.sort(compareSignals)) {
    const g = groups.get(s.companyId) ?? { companyId: s.companyId, companyName: s.companyName, symbol: s.symbol, topTier: s.tier, items: [], routine: [] };
    if (s.tier === 'routine') g.routine.push(s);
    else g.items.push({ signal: s, children: s.components.map((id) => byId.get(id)).filter((c): c is Signal => !!c).sort(compareSignals), alerted: alerted.has(s.id) || s.components.some((c) => alerted.has(c)) });
    if (TIER_RANK[s.tier] < TIER_RANK[g.topTier]) g.topTier = s.tier;
    groups.set(s.companyId, g);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => {
    const fa = a.items[0]?.signal ?? a.routine[0];
    const fb = b.items[0]?.signal ?? b.routine[0];
    return fa && fb ? compareSignals(fa, fb) : a.companyName.localeCompare(b.companyName);
  });

  const counts = { high: 0, medium: 0, low: 0, routine: 0, total: 0, duplicatesSuppressed: suppressed, routineCollapsed: 0 };
  for (const s of top) {
    counts[s.tier] += 1;
    counts.total += 1;
  }
  counts.routineCollapsed = counts.routine;

  const before = ranked
    .filter((r) => r.row.publishedAt < window.from && r.signal.tier !== 'routine')
    .sort((a, b) => b.row.publishedAt.localeCompare(a.row.publishedAt))[0];
  const modes = new Set([...input.announcements.map((a) => a.dataMode), ...input.series.map((s) => s.dataMode)]);

  return {
    window,
    generatedAt: now.toISOString(),
    groups: orderedGroups,
    counts,
    notes: market.notes.slice(0, 50),
    latestBefore: before ? { headline: before.row.title, companyName: before.row.companyName, occurredAt: before.row.publishedAt } : null,
    dataMode: modes.size === 0 ? 'none' : modes.size > 1 ? 'mixed' : ([...modes][0] as 'live' | 'fixture'),
  };
}
