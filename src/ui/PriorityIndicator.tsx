import styles from './PriorityIndicator.module.css';

export type Priority = 'high' | 'medium' | 'low' | 'routine';

const LEVEL: Record<Priority, number> = { high: 3, medium: 2, low: 1, routine: 0 };
const LABEL: Record<Priority, string> = { high: 'High', medium: 'Medium', low: 'Low', routine: 'Routine' };

type PriorityIndicatorProps = {
  priority: Priority;
  /** Show the word next to the bars. The name is always available to assistive tech. */
  showLabel?: boolean;
};

/**
 * Three ink bars, filled from the bottom up. Priority is carried by count and
 * weight, not hue, so it never competes with the colours used for direction.
 */
export function PriorityIndicator({ priority, showLabel = false }: PriorityIndicatorProps) {
  const level = LEVEL[priority];
  return (
    <span className={`${styles.root} ${styles[priority]}`}>
      <span className={styles.bars} aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} className={n <= level ? styles.on : styles.off} />
        ))}
      </span>
      {showLabel ? (
        <span className={styles.label}>{LABEL[priority]}</span>
      ) : (
        <span className="visually-hidden">{LABEL[priority]} priority</span>
      )}
    </span>
  );
}
