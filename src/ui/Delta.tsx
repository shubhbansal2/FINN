import { directionOf, formatSignedPercent } from './format';
import { Icon } from './Icon';
import styles from './Delta.module.css';

export type DeltaValue =
  | { kind: 'ratio'; value: number }
  /** Not meaningful, e.g. growth from a negative or zero base. */
  | { kind: 'not_meaningful' }
  | { kind: 'missing' };

type DeltaProps = {
  delta: DeltaValue;
  /** Comparison basis shown after the figure, e.g. "QoQ", "YoY", "1D". */
  basis?: string;
  /**
   * `standard`: up is positive-coloured. `inverse`: up is negative-coloured
   * (e.g. debt, days of working capital). `none`: no colour, sign only.
   */
  tone?: 'standard' | 'inverse' | 'none';
  fractionDigits?: number;
};

const SPOKEN = { up: 'up', down: 'down', flat: 'unchanged' } as const;

/**
 * A signed change. Direction is always conveyed three ways: arrow glyph,
 * explicit sign, and an accessible phrase. Colour is the fourth, optional cue.
 */
export function Delta({ delta, basis, tone = 'standard', fractionDigits = 1 }: DeltaProps) {
  if (delta.kind !== 'ratio') {
    const text = delta.kind === 'not_meaningful' ? 'n.m.' : '—';
    const spoken = delta.kind === 'not_meaningful' ? 'not meaningful' : 'not available';
    return (
      <span className={`${styles.root} ${styles.unavailable} num`} title={spoken}>
        <span aria-hidden="true">{text}</span>
        <span className="visually-hidden">{basis ? `${basis} change ${spoken}` : `change ${spoken}`}</span>
        {basis ? (
          <span className={styles.basis} aria-hidden="true">
            {basis}
          </span>
        ) : null}
      </span>
    );
  }

  const direction = directionOf(delta.value, fractionDigits);
  const colour =
    tone === 'none' || direction === 'flat'
      ? styles.neutral
      : (direction === 'up') === (tone === 'standard')
        ? styles.positive
        : styles.negative;
  const formatted = formatSignedPercent(delta.value, fractionDigits);

  return (
    <span className={`${styles.root} ${colour} num`}>
      <span className={styles.glyph} aria-hidden="true">
        {direction === 'up' ? <Icon name="arrowUp" size={12} /> : direction === 'down' ? <Icon name="arrowDown" size={12} /> : <Icon name="minus" size={12} />}
      </span>
      <span aria-hidden="true">{formatted}</span>
      <span className="visually-hidden">
        {direction === 'flat' ? 'unchanged' : `${SPOKEN[direction]} ${formatted.replace(/^[+−]/, '')}`}
        {basis ? ` ${basis}` : ''}
      </span>
      {basis ? (
        <span className={styles.basis} aria-hidden="true">
          {basis}
        </span>
      ) : null}
    </span>
  );
}
