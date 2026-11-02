import styles from './Skeleton.module.css';

type SkeletonProps = {
  /** Text announced to assistive tech while loading. */
  label: string;
  /** Number of placeholder rows. */
  rows?: number;
  /** `signal` mirrors a SignalRow's shape; `lines` is generic text. */
  shape?: 'signal' | 'lines' | 'metrics';
};

/**
 * Placeholder in the shape of the content that is coming, so the layout does
 * not jump when it arrives. The pulse is disabled under reduced motion.
 */
export function Skeleton({ label, rows = 3, shape = 'lines' }: SkeletonProps) {
  return (
    <div className={styles.root} role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <div aria-hidden="true">
        {shape === 'metrics' ? (
          <div className={styles.metrics}>
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className={styles.metric}>
                <span className={`${styles.bar} ${styles.w40}`} />
                <span className={`${styles.bar} ${styles.tall} ${styles.w70}`} />
                <span className={`${styles.bar} ${styles.w50}`} />
              </div>
            ))}
          </div>
        ) : (
          Array.from({ length: rows }, (_, i) =>
            shape === 'signal' ? (
              <div key={i} className={styles.signal}>
                <span className={styles.dot} />
                <div className={styles.stack}>
                  <span className={`${styles.bar} ${styles.w30}`} />
                  <span className={`${styles.bar} ${styles.tall} ${i % 2 ? styles.w70 : styles.w90}`} />
                  <span className={`${styles.bar} ${styles.w40}`} />
                </div>
              </div>
            ) : (
              <span key={i} className={`${styles.bar} ${styles.line} ${i === rows - 1 ? styles.w60 : styles.w100}`} />
            ),
          )
        )}
      </div>
    </div>
  );
}
