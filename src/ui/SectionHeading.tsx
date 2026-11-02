import type { ReactNode } from 'react';

import styles from './SectionHeading.module.css';

type SectionHeadingProps = {
  children: ReactNode;
  /** Heading level for document outline; visual style is the same. */
  level?: 2 | 3;
  /** Right-aligned slot: counts, freshness, a quiet action. */
  aside?: ReactNode;
  id?: string;
};

/** Editorial section head: heavy rule above, uppercase kicker, optional aside. */
export function SectionHeading({ children, level = 2, aside, id }: SectionHeadingProps) {
  const Tag = level === 2 ? 'h2' : 'h3';
  return (
    <div className={styles.root}>
      <Tag id={id} className={styles.heading}>
        {children}
      </Tag>
      {aside ? <div className={styles.aside}>{aside}</div> : null}
    </div>
  );
}
