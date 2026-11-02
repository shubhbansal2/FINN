'use client';

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import { CATEGORY_LABEL, type Category } from '@/domain/taxonomy';
import type { Feed, FeedItem } from '@/push/feed';
import type { Signal } from '@/push/types';
import { Button } from '@/ui/Button';
import { Delta } from '@/ui/Delta';
import { Dialog } from '@/ui/Dialog';
import { EmptyState } from '@/ui/EmptyState';
import { Icon } from '@/ui/Icon';
import { Provenance } from '@/ui/Provenance';
import { SignalRow } from '@/ui/SignalRow';
import { Timestamp } from '@/ui/Timestamp';

import { activeFilterCount, applyFilters, DEFAULT_FILTERS, type FeedFilters } from './filters';
import { firstCutSummary, headlineChange } from './FirstCut';
import styles from './FeedView.module.css';
import { kindLabel, SignalDetailContent } from './SignalDetailContent';

/** Viewport check after mount; the server and first client render assume a narrow screen. */
function useWide(query = '(min-width: 1080px)') {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return wide;
}

/** The figure a row shows without a click: the move, the volume multiple, or a verified reported figure. */
function Measure({ signal }: { signal: Signal }) {
  if (signal.measure?.kind === 'change') return <Delta delta={{ kind: 'ratio', value: signal.measure.value }} basis="1D" />;
  if (signal.measure?.kind === 'multiple') return <span className={`${styles.multiple} num`}>{signal.measure.value.toFixed(1)}× vol</span>;
  const headline = signal.firstCut ? headlineChange(signal.firstCut) : null;
  if (headline) return <Delta delta={headline.change} basis={headline.label} />;
  return null;
}

/** Whether the row's event has a source FINN can link to. */
function SourceTag({ signal, items }: { signal: Signal; items: Signal[] }) {
  const all = [signal, ...items];
  const filing = all.some((s) => s.explanation.evidence.some((e) => e.kind === 'filing'));
  const market = all.some((s) => s.kind === 'price_move' || s.kind === 'volume_spike');
  const isFiling = all.some((s) => s.kind === 'announcement' || s.kind === 'results');
  return (
    <span className={styles.sourceTags}>
      {isFiling ? filing ? <span className={styles.tag}>Filing linked</span> : <span className={`${styles.tag} ${styles.tagWarn}`}>No document</span> : null}
      {market ? <span className={styles.tag}>EOD data</span> : null}
    </span>
  );
}

function Row({ item, selected, onSelect }: { item: FeedItem; selected: boolean; onSelect: () => void }) {
  const s = item.signal;
  return (
    <SignalRow
      priority={s.tier}
      company={{ name: s.companyName, symbol: s.symbol }}
      category={kindLabel(s)}
      headline={s.headline}
      summary={s.firstCut ? firstCutSummary(s.firstCut) : s.explanation.why[s.explanation.why.length - 1]}
      occurredAtIso={s.occurredAt}
      timePrecision={s.tradeDate ? 'date' : 'datetime'}
      figure={<Measure signal={s} />}
      onSelect={onSelect}
      selected={selected}
      meta={
        <>
          <SourceTag signal={s} items={item.children} />
          {s.stale ? <Provenance kind="stale" /> : null}
          {item.alerted ? <span className={styles.alerted}>Alerted</span> : null}
          {s.dataMode === 'fixture' ? <Provenance kind="demo" /> : null}
        </>
      }
    />
  );
}

function FilterControls({ filters, setFilters, feed }: { filters: FeedFilters; setFilters: (f: FeedFilters) => void; feed: Feed }) {
  const ids = { company: useId(), category: useId(), priority: useId() };
  const categories = useMemo(() => {
    const present = new Set([...feed.items, ...feed.routine.map((r) => ({ signal: r, children: [] as Signal[] }))].flatMap((it) => [it.signal, ...it.children]).map((s) => s.category).filter((c): c is string => !!c));
    return [...present].sort();
  }, [feed]);
  const toggle = (k: keyof FeedFilters['kinds']) => setFilters({ ...filters, kinds: { ...filters.kinds, [k]: !filters.kinds[k] } });
  return (
    <div className={styles.filters} role="group" aria-label="Filter the feed">
      <label className={styles.field} htmlFor={ids.company}>
        <span className={styles.label}>Company</span>
        <select id={ids.company} className={styles.select} value={filters.company} onChange={(e) => setFilters({ ...filters, company: e.target.value })}>
          <option value="all">All companies</option>
          {feed.watchlist.companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.symbol} · {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field} htmlFor={ids.category}>
        <span className={styles.label}>Category</span>
        <select id={ids.category} className={styles.select} value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c as Category] ?? c}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field} htmlFor={ids.priority}>
        <span className={styles.label}>Priority</span>
        <select id={ids.priority} className={styles.select} value={filters.minPriority} onChange={(e) => setFilters({ ...filters, minPriority: e.target.value as FeedFilters['minPriority'] })}>
          <option value="all">All</option>
          <option value="high">High only</option>
          <option value="medium">Medium and above</option>
          <option value="low">Low and above</option>
        </select>
      </label>
      <div className={styles.field}>
        <span className={styles.label}>Show</span>
        <div className={styles.toggles}>
          {(
            [
              ['filings', 'Filings'],
              ['price', 'Price moves'],
              ['volume', 'Volume'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className={styles.toggle} aria-pressed={filters.kinds[k]} onClick={() => toggle(k)}>
              {filters.kinds[k] ? <Icon name="check" size={14} /> : null}
              {label}
            </button>
          ))}
        </div>
      </div>
      {activeFilterCount(filters) ? (
        <Button size="sm" variant="quiet" onClick={() => setFilters(DEFAULT_FILTERS)}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

export function FeedView({ feed, header, initialCompany }: { feed: Feed; header: ReactNode; initialCompany?: string }) {
  // A company passed in the URL (from the watchlist) preselects the company filter.
  const [filters, setFilters] = useState<FeedFilters>(() => ({ ...DEFAULT_FILTERS, company: initialCompany && feed.watchlist.companies.some((c) => c.id === initialCompany) ? initialCompany : 'all' }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const wide = useWide();
  const filterTitle = useId();
  const detailTitle = useId();

  const items = useMemo(() => applyFilters(feed.items, filters), [feed.items, filters]);
  const routine = useMemo(() => applyFilters(feed.routine.map((s) => ({ signal: s, children: [] as Signal[] })), filters), [feed.routine, filters]);
  const nActive = activeFilterCount(filters);

  // On wide screens the detail pane always shows something: the selection, else the top item.
  const selected = items.find((i) => i.signal.id === selectedId) ?? routine.find((r) => r.signal.id === selectedId) ?? (wide ? items[0] : undefined);
  const lead = items[0];

  const detail = selected ? <SignalDetailContent signal={selected.signal} nested={selected.children} /> : null;

  return (
    <div className={styles.feed}>
      {header}

      <div className={styles.desktopFilters}>
        <FilterControls filters={filters} setFilters={setFilters} feed={feed} />
      </div>
      <div className={styles.mobileBar}>
        <Button size="sm" icon="settings" onClick={() => setFiltersOpen(true)} aria-haspopup="dialog">
          Filters{nActive ? ` (${nActive})` : ''}
        </Button>
        <span className={styles.showing}>
          {items.length} of {feed.items.length} signals
        </span>
      </div>

      {feed.items.length > 0 && items.length === 0 && routine.length === 0 ? (
        <EmptyState title="No signals match these filters." action={<Button size="sm" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</Button>}>
          {feed.items.length} signal(s) in this window are hidden by the current filters.
        </EmptyState>
      ) : null}

      {/* Mobile: the most important event, with its reason and evidence visible, before the rest of the feed. */}
      {lead ? (
        <section className={styles.lead} aria-label="Most important signal">
          <p className={styles.leadKicker}>Top signal</p>
          <button type="button" className={styles.leadButton} onClick={() => setSelectedId(lead.signal.id)}>
            <span className={styles.leadMeta}>
              {lead.signal.companyName} <span className={styles.mono}>{lead.signal.symbol}</span> · {kindLabel(lead.signal)}
            </span>
            <span className={styles.leadHeadline}>{lead.signal.headline}</span>
          </button>
          <p className={styles.leadWhy}>{lead.signal.explanation.why.join(' ')}</p>
          <div className={styles.leadEvidence}>
            <Measure signal={lead.signal} />
            <SourceTag signal={lead.signal} items={lead.children} />
            <Timestamp iso={lead.signal.occurredAt} precision={lead.signal.tradeDate ? 'date' : 'datetime'} />
          </div>
          <Button size="sm" variant="secondary" onClick={() => setSelectedId(lead.signal.id)}>
            Evidence and details
          </Button>
        </section>
      ) : null}

      <div className={styles.layout}>
        <div className={styles.list}>
          {items.length ? (
            <ol className={styles.items} aria-label="Signals, most significant first">
              {items.map((it, i) => (
                <li key={it.signal.id} className={i === 0 ? styles.firstItem : undefined}>
                  <Row item={it} selected={selected?.signal.id === it.signal.id} onSelect={() => setSelectedId(it.signal.id)} />
                </li>
              ))}
            </ol>
          ) : null}
          {routine.length ? (
            <details className={styles.routine}>
              <summary>
                {routine.length} routine filing{routine.length === 1 ? '' : 's'} (compliance paperwork, collapsed)
              </summary>
              <ol className={styles.items}>
                {routine.map((r) => (
                  <li key={r.signal.id}>
                    <Row item={{ ...r, alerted: false }} selected={selected?.signal.id === r.signal.id} onSelect={() => setSelectedId(r.signal.id)} />
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
        {wide ? (
          <aside className={styles.detailPane} aria-label="Signal detail">
            {detail ?? <p className={styles.showing}>Select a signal to see its source and reasoning.</p>}
          </aside>
        ) : null}
      </div>

      {!wide ? (
        <Dialog open={!!selectedId && !!selected} onClose={() => setSelectedId(null)} variant="drawer" labelledBy={detailTitle}>
          <div className={styles.sheet}>
            <div className={styles.sheetHead}>
              <h2 id={detailTitle} className={styles.sheetTitle}>
                Signal detail
              </h2>
              <button type="button" className={styles.close} onClick={() => setSelectedId(null)} aria-label="Close signal detail">
                <Icon name="close" />
              </button>
            </div>
            <div className={styles.sheetBody}>{detail}</div>
          </div>
        </Dialog>
      ) : null}

      <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} variant="drawer" labelledBy={filterTitle}>
        <div className={styles.sheet}>
          <div className={styles.sheetHead}>
            <h2 id={filterTitle} className={styles.sheetTitle}>
              Filter the feed
            </h2>
            <button type="button" className={styles.close} onClick={() => setFiltersOpen(false)} aria-label="Close filters">
              <Icon name="close" />
            </button>
          </div>
          <div className={styles.sheetBody}>
            <FilterControls filters={filters} setFilters={setFilters} feed={feed} />
            <Button variant="primary" onClick={() => setFiltersOpen(false)}>
              Show {items.length} signal{items.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
