import type { ReactNode } from 'react';

import styles from './EmptyState.module.css';

type EmptyStateProps = {
  title: string;
  /** What this means and what (if anything) the user can do. Be specific. */
  children?: ReactNode;
  /** Context such as "Last checked 31 Oct, 15:42 IST". */
  meta?: ReactNode;
  action?: ReactNode;
  /** `quiet` for an empty section inside a page; `page` for a whole view. */
  size?: 'quiet' | 'page';
};

/** An explained absence: says why there is nothing, never just "No data". */
export function EmptyState({ title, children, meta, action, size = 'quiet' }: EmptyStateProps) {
  return (
    <div className={`${styles.root} ${styles[size]}`}>
      <p className={styles.title}>{title}</p>
      {children ? <div className={styles.body}>{children}</div> : null}
      {meta ? <div className={styles.meta}>{meta}</div> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
