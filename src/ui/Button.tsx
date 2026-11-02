import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { Icon, type IconName } from './Icon';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';
type Size = 'md' | 'sm';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  /** Shows a busy state, keeps the label for screen readers and blocks clicks. */
  loading?: boolean;
  /** Text announced while loading, e.g. "Generating report". */
  loadingLabel?: string;
  children?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading = false, loadingLabel, disabled, children, className, type, ...rest },
  ref,
) {
  const classes = [styles.button, styles[variant], styles[size], loading ? styles.loading : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon ? <Icon name={icon} size={16} /> : null}
      <span className={styles.label}>{children}</span>
      {loading && loadingLabel ? <span className="visually-hidden">{loadingLabel}</span> : null}
    </button>
  );
});
