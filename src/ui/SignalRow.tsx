import Link from 'next/link';
import type { ReactNode } from 'react';

import { CompanyId } from './CompanyId';
import { PriorityIndicator, type Priority } from './PriorityIndicator';
import { Timestamp } from './Timestamp';
import styles from './SignalRow.module.css';

type SignalRowProps = {
  priority: Priority;
  company: { name: string; symbol: string };
  /** Category label from the FINN taxonomy, e.g. "Results", "Management change". */
  category: string;
  headline: string;
  /** One-line, sourced summary. Omit rather than pad. */
  summary?: ReactNode;
  occurredAtIso: string;
  /** Precision of the event time: EOD alerts are per trading day. */
  timePrecision?: 'datetime' | 'date';
  /** Right-hand figure, e.g. a Delta for a price alert. */
  figure?: ReactNode;
  /** Source chips and provenance badges. */
  meta?: ReactNode;
  /** Primary action: opening the signal's detail. Provide href or onSelect. */
  href?: string;
  onSelect?: () => void;
  selected?: boolean;
  unread?: boolean;
};

/**
 * One item in the Brief. A typeset line, not a card: priority bars in the
 * gutter, company and category as a kicker, the headline in serif, and
 * provenance in mono beneath. The headline is the row's single primary target
 * (stretched over the row), so citations inside stay independently clickable.
 */
export function SignalRow({
  priority,
  company,
  category,
  headline,
  summary,
  occurredAtIso,
  timePrecision = 'datetime',
  figure,
  meta,
  href,
  onSelect,
  selected = false,
  unread = false,
}: SignalRowProps) {
  const classes = [styles.row, styles[priority], selected ? styles.selected : '', unread ? styles.unread : '']
    .filter(Boolean)
    .join(' ');

  const headlineContent = (
    <>
      {unread ? <span className="visually-hidden">Unread: </span> : null}
      {headline}
    </>
  );

  return (
    <article className={classes} aria-current={selected ? 'true' : undefined}>
      <div className={styles.gutter}>
        <PriorityIndicator priority={priority} />
      </div>
      <div className={styles.main}>
        <p className={styles.kicker}>
          <CompanyId name={company.name} symbol={company.symbol} />
          <span className={styles.category}>{category}</span>
        </p>
        <h3 className={styles.headline}>
          {href ? (
            <Link href={href} className={styles.target}>
              {headlineContent}
            </Link>
          ) : onSelect ? (
            <button type="button" className={styles.target} onClick={onSelect} aria-pressed={selected}>
              {headlineContent}
            </button>
          ) : (
            headlineContent
          )}
        </h3>
        {summary ? <p className={styles.summary}>{summary}</p> : null}
        <div className={styles.meta}>
          <Timestamp iso={occurredAtIso} precision={timePrecision} />
          {meta}
        </div>
      </div>
      {figure ? <div className={styles.figure}>{figure}</div> : null}
    </article>
  );
}
