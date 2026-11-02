'use client';

import { useState } from 'react';

import type { Signal } from '@/push/types';
import { Provenance } from '@/ui/Provenance';
import { SignalRow } from '@/ui/SignalRow';

import { firstCutSummary } from './feed/FirstCut';
import { peopleSummary } from './feed/People';
import { kindLabel, SignalDetailContent } from './feed/SignalDetailContent';
import styles from './SignalDetail.module.css';

/** A signal row that expands in place to its full detail (used in the Alerts inbox). */
export function SignalItem({ signal, nested = [], alerted = false }: { signal: Signal; nested?: Signal[]; alerted?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <SignalRow
        priority={signal.tier}
        company={{ name: signal.companyName, symbol: signal.symbol }}
        category={kindLabel(signal)}
        headline={signal.headline}
        summary={(signal.firstCut ? firstCutSummary(signal.firstCut) : null) ?? (signal.people ? peopleSummary(signal.people) : null) ?? signal.explanation.why[signal.explanation.why.length - 1]}
        occurredAtIso={signal.occurredAt}
        timePrecision={signal.tradeDate ? 'date' : 'datetime'}
        onSelect={() => setOpen((o) => !o)}
        selected={open}
        meta={
          <>
            {signal.dataMode === 'fixture' ? <Provenance kind="demo" /> : null}
            {signal.stale ? <Provenance kind="stale" /> : null}
            {alerted ? <span className={styles.alerted}>Alerted</span> : null}
            <span className={styles.small}>{open ? 'Hide detail' : 'Detail'}</span>
          </>
        }
      />
      {open ? (
        <div className={styles.detail}>
          <SignalDetailContent signal={signal} nested={nested} />
        </div>
      ) : null}
    </div>
  );
}
