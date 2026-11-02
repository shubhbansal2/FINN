import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon';
import styles from './Banner.module.css';

export type BannerTone = 'error' | 'stale' | 'warning' | 'info' | 'demo';

const ICON: Record<BannerTone, IconName> = {
  error: 'alert',
  stale: 'clock',
  warning: 'alert',
  info: 'info',
  demo: 'info',
};

const TONE_LABEL: Record<BannerTone, string> = {
  error: 'Error',
  stale: 'Stale data',
  warning: 'Warning',
  info: 'Note',
  demo: 'Demo data',
};

type BannerProps = {
  tone: BannerTone;
  title: string;
  children?: ReactNode;
  /** e.g. a retry Button. */
  action?: ReactNode;
};

/**
 * Inline status strip for data-health conditions. Errors are announced
 * assertively; everything else politely. Tone is named in text, not just colour.
 */
export function Banner({ tone, title, children, action }: BannerProps) {
  return (
    <div className={`${styles.root} ${styles[tone]}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className={styles.icon}>
        <Icon name={ICON[tone]} size={16} />
      </span>
      <div className={styles.text}>
        <p className={styles.title}>
          <span className={styles.tone}>{TONE_LABEL[tone]}</span>
          <span className={styles.sep} aria-hidden="true">
            ·
          </span>
          {title}
        </p>
        {children ? <div className={styles.body}>{children}</div> : null}
      </div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
