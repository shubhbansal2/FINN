import type { ReactNode } from 'react';

import styles from './PageHeader.module.css';

type PageHeaderProps = {
  title: string;
  /** Context line above the title, e.g. the date the Brief covers. */
  kicker?: ReactNode;
  /** One sentence on what this view is for. */
  description?: ReactNode;
  /** Controls aligned to the title on wide screens (period selector, actions). */
  controls?: ReactNode;
};

export function PageHeader({ title, kicker, description, controls }: PageHeaderProps) {
  return (
    <header className={styles.root}>
      <div className={styles.text}>
        {kicker ? <p className={styles.kicker}>{kicker}</p> : null}
        <h1 className={styles.title}>{title}</h1>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {controls ? <div className={styles.controls}>{controls}</div> : null}
    </header>
  );
}
