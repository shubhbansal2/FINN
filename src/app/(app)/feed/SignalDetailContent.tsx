import Link from 'next/link';

import { CATEGORY_LABEL, type Category } from '@/domain/taxonomy';
import type { EvidenceRef, Signal } from '@/push/types';
import { safeDocumentUrl } from '@/ui/evidence';
import { Icon } from '@/ui/Icon';
import { PriorityIndicator } from '@/ui/PriorityIndicator';
import { Provenance } from '@/ui/Provenance';
import { Timestamp } from '@/ui/Timestamp';

import { FirstCutTable } from './FirstCut';
import styles from './SignalDetailContent.module.css';

export function kindLabel(s: Signal): string {
  if (s.kind === 'combination') return 'Combined';
  if (s.kind === 'results') return 'Results';
  if (s.kind === 'price_move') return 'Price move';
  if (s.kind === 'volume_spike') return 'Volume';
  return s.category ? (CATEGORY_LABEL[s.category as Category] ?? s.category) : 'Filing';
}

const filingOf = (s: Signal) => s.explanation.evidence.find((e): e is Extract<EvidenceRef, { kind: 'filing' }> => e.kind === 'filing') ?? null;

function Reported({ signal }: { signal: Signal }) {
  const filing = filingOf(signal);
  // Links come from stored filings; only https URLs are rendered as links.
  const filingUrl = filing ? safeDocumentUrl(filing.url) : null;
  const series = signal.explanation.evidence.filter((e): e is Extract<EvidenceRef, { kind: 'price_series' }> => e.kind === 'price_series');
  const isFiling = signal.kind === 'announcement' || signal.kind === 'results';
  return (
    <dl className={styles.facts}>
      {isFiling ? (
        <div>
          <dt>Filed as</dt>
          <dd>
            <q className={styles.filed}>{signal.headline}</q>
            <span className={styles.meta}>
              <Timestamp iso={signal.occurredAt} prefix="Published" /> · <Timestamp iso={signal.ingestedAt} prefix="stored by FINN" />
            </span>
          </dd>
        </div>
      ) : null}
      {isFiling ? (
        <div>
          <dt>Source</dt>
          <dd>
            {filing && filingUrl ? (
              <a href={filingUrl} target="_blank" rel="noopener noreferrer" className={styles.source}>
                Open the filing ({filing.origin === 'company_issued' ? 'company website' : 'exchange'}) <Icon name="external" size={14} />
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            ) : (
              <span className={styles.warn}>No primary-source document is linked to this filing.</span>
            )}
          </dd>
        </div>
      ) : null}
      {signal.firstCut ? (
        <div>
          <dt>Headline numbers</dt>
          <dd className={styles.firstCut}>
            <FirstCutTable cut={signal.firstCut} />
          </dd>
        </div>
      ) : signal.kind === 'results' ? (
        <div>
          <dt>Reported figures</dt>
          <dd className={styles.muted}>Not extracted yet. Open the filing, or run Research on this company to extract and check its figures.</dd>
        </div>
      ) : null}
      {series.length ? (
        <div>
          <dt>Market data</dt>
          <dd>
            <ul>
              {series.map((s, i) => (
                <li key={i}>
                  {s.label}: <span className={`${styles.mono} num`}>{s.detail}</span>
                </li>
              ))}
            </ul>
            {signal.tradeDate ? <span className={styles.meta}>Session {signal.tradeDate} · end-of-day, not real-time</span> : null}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The full detail of a signal, in three explicitly separate parts:
 * what the sources report, how FINN's rules assessed it, and what is unknown.
 */
export function SignalDetailContent({ signal, nested = [] }: { signal: Signal; nested?: Signal[] }) {
  const e = signal.explanation;
  return (
    <div className={styles.detail}>
      <header className={styles.head}>
        <p className={styles.kicker}>
          <PriorityIndicator priority={signal.tier} showLabel /> · {kindLabel(signal)} · {signal.companyName} <span className={styles.mono}>{signal.symbol}</span>
        </p>
        <p className={styles.what}>{e.what}</p>
        <p className={styles.tags}>
          {signal.dataMode === 'fixture' ? <Provenance kind="demo" /> : null}
          {signal.stale ? <Provenance kind="stale" /> : null}
        </p>
        <nav className={styles.companyLinks} aria-label={`More on ${signal.companyName}`}>
          <Link href={`/research?company=${encodeURIComponent(signal.companyId)}`} className={styles.companyLink}>
            Research {signal.symbol}
          </Link>
          <Link href={`/watchlist#${encodeURIComponent(signal.companyId)}`} className={styles.companyLink}>
            {signal.symbol} on the watchlist
          </Link>
        </nav>
      </header>

      <section aria-label="Reported by the source">
        <h3 className={styles.h}>Reported</h3>
        <Reported signal={signal} />
        {nested.length ? (
          <ul className={styles.nested}>
            {nested.map((n) => (
              <li key={n.id}>
                <p className={styles.kicker}>{kindLabel(n)}</p>
                <p className={styles.nestedHead}>{n.headline}</p>
                <Reported signal={n} />
              </li>
            ))}
          </ul>
        ) : null}
        {signal.duplicates.length ? <p className={styles.meta}>Also filed as {signal.duplicates.map((d) => `“${d.headline}”`).join('; ')}: the same filing, shown once.</p> : null}
      </section>

      <section aria-label="FINN's assessment">
        <h3 className={styles.h}>FINN&apos;s assessment</h3>
        <ul className={styles.why}>
          {e.why.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
        <p className={styles.rules}>
          {e.rules.map((r) => (
            <code key={r}>{r}</code>
          ))}
        </p>
        <p className={styles.meta}>Rule-based ranking from the signal policy. No model wrote any text on this page; the headline is the filed subject.</p>
      </section>

      <section aria-label="Not known">
        <h3 className={styles.h}>Not known</h3>
        <ul className={styles.unknown}>
          {e.unknowns.map((u, i) => (
            <li key={i}>{u}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
