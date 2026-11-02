import { formatAge, formatDateIst, formatDateTimeIst } from './format';
import styles from './Timestamp.module.css';

type TimestampProps = {
  iso: string;
  /** `datetime` shows date and time; `date` for EOD data where time is meaningless. */
  precision?: 'datetime' | 'date';
  /** Reference time for a relative age. Passed in so render output is deterministic. */
  relativeTo?: string;
  prefix?: string;
};

/** Absolute IST time in mono; optional relative age, never shown without the absolute value. */
export function Timestamp({ iso, precision = 'datetime', relativeTo, prefix }: TimestampProps) {
  const absolute = precision === 'date' ? formatDateIst(iso) : formatDateTimeIst(iso);
  return (
    <span className={styles.root}>
      {prefix ? `${prefix} ` : null}
      <time dateTime={iso} title={absolute}>
        {relativeTo ? (
          <>
            {formatAge(iso, relativeTo)}
            <span className={styles.secondary}> · {absolute}</span>
          </>
        ) : (
          absolute
        )}
      </time>
    </span>
  );
}
