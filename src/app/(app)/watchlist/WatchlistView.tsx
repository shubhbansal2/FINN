'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import type { Watchlist, WatchlistRow } from '@/server/watchlist';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Delta } from '@/ui/Delta';
import { EmptyState } from '@/ui/EmptyState';
import { formatInr } from '@/ui/format';
import { PriorityIndicator } from '@/ui/PriorityIndicator';
import { Provenance } from '@/ui/Provenance';
import { Timestamp } from '@/ui/Timestamp';

import styles from './Watchlist.module.css';

const SHORT_STATUS: Record<WatchlistRow['price']['status'], string> = { eod_delayed: 'EOD', cached: 'Cached', stale: 'Stale', unavailable: 'No data', recorded: 'Recorded' };

function Row({ row, dataMode, onRemove, busy }: { row: WatchlistRow; dataMode: 'live' | 'fixture'; onRemove: () => void; busy: boolean }) {
  const p = row.price;
  return (
    <li id={row.id} className={styles.row}>
      <div className={styles.identity}>
        <span className={styles.symbol}>{row.symbol}</span>
        <span className={styles.name}>{row.name}</span>
      </div>
      <div className={styles.price}>
        {p.session !== null ? (
          <>
            <span className="num">{formatInr(p.close, { scale: 'one' })}</span>
            <span title={p.changeNote ?? undefined}>{p.change !== null ? <Delta delta={{ kind: 'ratio', value: p.change }} basis="1D" /> : <Delta delta={{ kind: 'missing' }} basis="1D" />}</span>
            <span className={`${styles.priceMeta} ${p.status === 'stale' || p.status === 'cached' ? styles.warn : ''}`} title={p.statusLabel}>
              {SHORT_STATUS[p.status]} · {p.session}
            </span>
          </>
        ) : (
          <span className={styles.warn}>No price data for this listing</span>
        )}
      </div>
      <div className={styles.signals}>
        {row.signals.top ? (
          <>
            <span className={styles.signalCount}>
              <strong className="num">{row.signals.material}</strong> material · {row.signals.count} total
            </span>
            <span className={styles.topSignal}>
              <PriorityIndicator priority={row.signals.top.tier} /> {row.signals.top.headline}
            </span>
          </>
        ) : (
          <span className={styles.muted}>No signals in the last 7 days</span>
        )}
      </div>
      <div className={styles.research}>
        {row.research.kind === 'stored' ? (
          <span className={styles.muted}>
            <Timestamp iso={row.research.generatedAt} prefix={row.research.status === 'partial' ? 'Partial report' : 'Report'} />
          </span>
        ) : row.research.kind === 'demo' ? (
          <span className={styles.muted}>
            <Provenance kind="demo" /> recorded report
          </span>
        ) : (
          <span className={styles.muted}>{dataMode === 'fixture' ? 'No recorded report' : 'Not researched yet'}</span>
        )}
      </div>
      <div className={styles.actions}>
        <Link className={styles.link} href={`/?company=${encodeURIComponent(row.id)}&window=7d`}>
          Signals
        </Link>
        <Link className={styles.link} href={`/research?company=${encodeURIComponent(row.id)}`}>
          Research
        </Link>
        <Button size="sm" variant="quiet" onClick={onRemove} loading={busy} loadingLabel={`Removing ${row.symbol}`} aria-label={`Remove ${row.symbol} from the watchlist`}>
          Remove
        </Button>
      </div>
    </li>
  );
}

export function WatchlistView({ data, dataMode }: { data: Watchlist; dataMode: 'live' | 'fixture' }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toAdd, setToAdd] = useState('');
  const [, startRefresh] = useTransition();

  async function change(action: 'add' | 'remove', companyId: string) {
    setBusyId(companyId);
    setError(null);
    try {
      const res = await fetch('/api/watchlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, companyId }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `The watchlist was not changed (HTTP ${res.status}).`);
        return;
      }
      if (action === 'add') setToAdd('');
      startRefresh(() => router.refresh());
    } catch (e) {
      setError(`Could not reach the server; the watchlist was not changed (${e instanceof Error ? e.message : 'network error'}).`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={styles.view}>
      {dataMode === 'fixture' ? (
        <p className={styles.mode}>
          <Provenance kind="demo" detail="Prices and filings are recorded fixtures." /> Prices and signals below come from recorded fixtures, not current market data.
        </p>
      ) : null}
      {data.feedError ? <Banner tone="warning" title="Signals could not be computed">{data.feedError} Prices and research status are still shown.</Banner> : null}
      {error ? (
        <Banner tone="error" title="Watchlist not changed">
          {error}
        </Banner>
      ) : null}

      <form
        className={styles.add}
        onSubmit={(e) => {
          e.preventDefault();
          if (toAdd) void change('add', toAdd);
        }}
      >
        <label className={styles.addField}>
          <span className={styles.label}>Add a company</span>
          <select className={styles.select} value={toAdd} onChange={(e) => setToAdd(e.target.value)} disabled={data.available.length === 0}>
            <option value="">{data.available.length ? 'Choose a known company…' : 'Every known company is on the watchlist'}</option>
            {data.available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.symbol} · {c.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={!toAdd} loading={busyId === toAdd && toAdd !== ''} loadingLabel="Adding">
          Add
        </Button>
        <p className={styles.hint}>
          Companies become known once configured or researched. {dataMode === 'live' ? 'To add another NSE company, research it first; FINN verifies the listing before storing it.' : 'Demo mode cannot verify new listings.'}
        </p>
      </form>

      {data.rows.length === 0 ? (
        <EmptyState size="page" title="Your watchlist is empty.">
          The signal feed and alert rules cover watchlist companies only, so they will show nothing until you add one above.
        </EmptyState>
      ) : (
        <>
          <p className={styles.caption}>
            {data.rows.length} {data.rows.length === 1 ? 'company' : 'companies'} · last close (end-of-day) and signals from the last 7 days
          </p>
          <ul className={styles.list} aria-label="Watchlist companies">
            {data.rows.map((r) => (
              <Row key={r.id} row={r} dataMode={dataMode} busy={busyId === r.id} onRemove={() => void change('remove', r.id)} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
