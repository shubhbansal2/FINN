import type { Signal, Tier } from '@/push/types';

/** Feed filters. Pure and client-safe: they operate on the feed data the server sent, nothing else. */

export type FeedFilters = {
  company: string; // 'all' or a company id
  category: string; // 'all' or a taxonomy category
  minPriority: 'all' | Exclude<Tier, 'routine'>;
  kinds: { filings: boolean; price: boolean; volume: boolean };
};

export const DEFAULT_FILTERS: FeedFilters = { company: 'all', category: 'all', minPriority: 'all', kinds: { filings: true, price: true, volume: true } };

const RANK: Record<Tier, number> = { high: 0, medium: 1, low: 2, routine: 3 };

type Filterable = { signal: Signal; children: Signal[] };

const allSignals = (it: Filterable) => [it.signal, ...it.children];

export function matches(it: Filterable, f: FeedFilters): boolean {
  if (f.company !== 'all' && it.signal.companyId !== f.company) return false;
  if (f.minPriority !== 'all' && RANK[it.signal.tier] > RANK[f.minPriority]) return false;
  const signals = allSignals(it);
  if (f.category !== 'all' && !signals.some((s) => s.category === f.category)) return false;
  // An item passes the kind toggles if any of its underlying events is of an enabled kind.
  return signals.some(
    (s) =>
      (f.kinds.filings && (s.kind === 'announcement' || s.kind === 'results')) ||
      (f.kinds.price && s.kind === 'price_move') ||
      (f.kinds.volume && s.kind === 'volume_spike'),
  );
}

export function applyFilters<T extends Filterable>(items: T[], f: FeedFilters): T[] {
  return items.filter((it) => matches(it, f));
}

export function activeFilterCount(f: FeedFilters): number {
  return (
    Number(f.company !== 'all') +
    Number(f.category !== 'all') +
    Number(f.minPriority !== 'all') +
    Number(!f.kinds.filings) +
    Number(!f.kinds.price) +
    Number(!f.kinds.volume)
  );
}
