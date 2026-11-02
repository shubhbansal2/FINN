import Link from 'next/link';

import type { Metadata } from 'next';

import { getPreference } from '@/db/repositories';
import { getFeed, type SourceStatus } from '@/push/feed';
import { evaluateAlerts } from '@/push/service';
import { runtime } from '@/server/runtime';
import { Banner } from '@/ui/Banner';
import { EmptyState } from '@/ui/EmptyState';
import { PageHeader } from '@/ui/PageHeader';
import { Provenance } from '@/ui/Provenance';
import { Timestamp } from '@/ui/Timestamp';

import styles from './Brief.module.css';
import { FeedView } from './feed/FeedView';
import { WindowSelector } from './WindowSelector';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Signals' };

const WINDOWS = ['24h', '3d', '7d', '30d'];

const STATE_LABEL: Record<SourceStatus['state'], string> = { current: 'Current', stale: 'Stale', partial: 'Partial', unavailable: 'Unavailable', recorded: 'Recorded' };

function SourceStrip({ sources }: { sources: SourceStatus[] }) {
  return (
    <ul className={styles.sources} aria-label="Data freshness">
      {sources.map((s) => (
        <li key={s.source} className={`${styles.source} ${styles[s.state]}`}>
          <span className={styles.sourceState}>{STATE_LABEL[s.state]}</span>
          <span className={styles.sourceLabel}>{s.label}</span>
          <span className={styles.sourceAsOf}>
            {s.asOf ? s.source === 'prices' ? `${s.state === 'recorded' ? 'latest recorded ' : ''}session ${s.asOf}` : <Timestamp iso={s.asOf} prefix={s.state === 'recorded' ? 'latest recorded filing' : 'as of'} /> : 'never fetched'}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ window?: string; company?: string }> }) {
  const { window: requested, company } = await searchParams;
  const rt = runtime();
  const now = rt.clock();
  // No window in the URL: use the last one chosen (saved preference), else 24 hours.
  let saved: string | null = null;
  try {
    saved = getPreference(rt.db, 'signals.window');
  } catch (e) {
    console.error('preference read failed', e);
  }
  const windowParam = requested ?? (saved && WINDOWS.includes(saved) ? saved : undefined);

  // Rules are evaluated when this page loads; FINN does not watch markets in the background.
  // A failure here must not hide the feed, so it is reported rather than thrown.
  let evaluationError: string | null = null;
  let newAlerts = 0;
  try {
    newAlerts = evaluateAlerts(rt.db, { now, dataMode: rt.mode }).created.length;
  } catch (e) {
    console.error('alert evaluation failed', e);
    evaluationError = 'Alert rules could not be evaluated on this load; the feed below is unaffected.';
  }

  const feed = getFeed(rt.db, { window: windowParam, now, dataMode: rt.mode });
  if (!feed.ok) {
    return (
      <>
        <PageHeader title="Signals" controls={<WindowSelector value="24h" />} />
        <Banner tone="error" title="This window cannot be shown">
          {feed.error} <Link href="/">Show the last 24 hours</Link>.
        </Banner>
      </>
    );
  }
  const f = feed.value;
  // "Material" means high or medium priority; low-priority signals are counted separately, not claimed as material.
  const material = f.counts.high + f.counts.medium;
  const degraded = f.sources.filter((s) => s.state !== 'current' && s.state !== 'recorded');

  const status = (
    <>
      {f.dataMode === 'fixture' ? (
        <>
          <Provenance kind="demo" detail="Recorded provider responses; not current market data." />
          <span className={styles.evaluated}>
            <Timestamp iso={now.toISOString()} prefix="Demo clock fixed at" />
          </span>
        </>
      ) : null}
      <SourceStrip sources={f.sources} />
      <span className={styles.evaluated}>Alerts evaluated on page load{newAlerts ? ` · ${newAlerts} new` : ''}</span>
    </>
  );

  const header = (
    <>
      <PageHeader
        title="Signals"
        kicker={
          <>
            {f.watchlist.label} · {f.window.label}
          </>
        }
        description={
          <>
            <strong className={styles.count}>{material}</strong> material signal{material === 1 ? '' : 's'} ({f.counts.high} high, {f.counts.medium} medium)
            {f.counts.low ? ` · ${f.counts.low} low` : ''}. Ranked by significance; routine filings collapsed.
          </>
        }
        controls={<WindowSelector value={windowParam ?? '24h'} />}
      />
      {/* Wide screens show the full status row; phones get one line, so the top signal stays near the top. */}
      <div className={`${styles.statusRow} ${styles.statusWide}`}>{status}</div>
      <details className={styles.statusCompact}>
        <summary>
          {f.dataMode === 'fixture' ? <Provenance kind="demo" /> : null}
          <span className={styles.compactLine}>
            {f.sources.map((s) => `${s.source === 'prices' ? 'Prices' : 'Filings'} ${STATE_LABEL[s.state].toLowerCase()}`).join(' · ')}
            {newAlerts ? ` · ${newAlerts} new alert${newAlerts === 1 ? '' : 's'}` : ''}
          </span>
          <span className={styles.compactMore}>Details</span>
        </summary>
        <div className={styles.statusRow}>{status}</div>
      </details>
      {degraded.map((s) => (
        <Banner key={s.source} tone={s.state === 'stale' ? 'stale' : s.state === 'unavailable' ? 'error' : 'warning'} title={`${s.label}: ${STATE_LABEL[s.state].toLowerCase()}`}>
          {s.detail}
          {s.failed.length ? ` Affected: ${s.failed.slice(0, 8).join(', ')}${s.failed.length > 8 ? '…' : ''}.` : ''} Signals from the remaining sources are shown below.
        </Banner>
      ))}
      {evaluationError ? <Banner tone="warning" title={evaluationError} /> : null}
    </>
  );

  if (f.items.length === 0 && f.routine.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          size="page"
          title="Nothing was filed or flagged in this window."
          meta={f.latestBefore ? <Timestamp iso={f.latestBefore.occurredAt} prefix="Latest material filing before this window:" /> : undefined}
          action={
            <Link className={styles.widen} href="/?window=7d">
              Show the last 7 days
            </Link>
          }
        >
          {f.watchlist.companies.length === 0
            ? 'Your watchlist is empty, so there is nothing to monitor. Add companies on the Watchlist page.'
            : `${f.latestBefore ? `${f.latestBefore.companyName}: “${f.latestBefore.headline}”. ` : ''}No watchlist company filed, and no price or volume rule fired for sessions closing in this window.`}
        </EmptyState>
      </>
    );
  }

  const notWatched = company && !f.watchlist.companies.some((c) => c.id === company);
  return (
    <FeedView
      feed={f}
      initialCompany={company}
      header={
        <>
          {header}
          {notWatched ? (
            <Banner tone="info" title="That company is not on your watchlist">
              Signals cover watchlist companies only, so all watchlist signals are shown. <Link href="/watchlist">Add it on the Watchlist page</Link> or <Link href={`/research?company=${encodeURIComponent(company)}`}>open its research</Link>.
            </Banner>
          ) : null}
        </>
      }
    />
  );
}
