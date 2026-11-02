import type { ReactNode } from 'react';

import { Delta, type DeltaValue } from './Delta';
import { Provenance } from './Provenance';
import { formatDisplayValue, MISSING_LABEL, type DisplayValue } from './values';
import styles from './Metric.module.css';

export type MetricComparison = { basis: string; delta: DeltaValue };

type MetricProps = {
  label: string;
  value: DisplayValue;
  comparisons?: MetricComparison[];
  /** Colour rule for comparisons (see Delta). */
  tone?: 'standard' | 'inverse' | 'none';
  derived?: { formula: string };
  unverified?: { reason: string };
  size?: 'lg' | 'md';
  /** Citation or footnote slot, rendered under the figure. */
  source?: ReactNode;
};

/**
 * A single headline figure with its comparisons. Rendered as a description
 * list item so a row of metrics reads as label/value pairs to screen readers.
 */
export function Metric({ label, value, comparisons = [], tone = 'standard', derived, unverified, size = 'md', source }: MetricProps) {
  const text = formatDisplayValue(value);
  return (
    <div className={`${styles.root} ${styles[size]}`}>
      <dt className={styles.label}>
        {label}
        {derived ? <Provenance kind="derived" detail={derived.formula} /> : null}
        {unverified ? <Provenance kind="unverified" detail={unverified.reason} /> : null}
      </dt>
      <dd className={styles.body}>
        {text === null ? (
          <span className={`${styles.value} ${styles.missing}`}>
            <span aria-hidden="true">—</span>
            <span className={styles.missingReason}>{value.kind === 'missing' ? MISSING_LABEL[value.reason] : ''}</span>
          </span>
        ) : (
          <span className={`${styles.value} num`}>{text}</span>
        )}
        {comparisons.length > 0 ? (
          <span className={styles.comparisons}>
            {comparisons.map((c) => (
              <Delta key={c.basis} delta={c.delta} basis={c.basis} tone={tone} />
            ))}
          </span>
        ) : null}
        {source ? <span className={styles.source}>{source}</span> : null}
      </dd>
    </div>
  );
}

/** Wraps a set of Metrics in the <dl> they require, laid out as an aligned strip. */
export function MetricGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <dl className={styles.group} aria-label={label}>
      {children}
    </dl>
  );
}
