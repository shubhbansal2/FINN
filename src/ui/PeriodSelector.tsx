'use client';

import { useId, useRef, type KeyboardEvent } from 'react';

import styles from './PeriodSelector.module.css';

export type PeriodOption<T extends string> = { value: T; label: string; description?: string; disabled?: boolean };

type PeriodSelectorProps<T extends string> = {
  label: string;
  options: readonly PeriodOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Hide the visible label (it remains the group's accessible name). */
  hideLabel?: boolean;
  /** `stacked`: label above, options sharing the full width (for narrow places such as the rail). */
  layout?: 'inline' | 'stacked';
};

/**
 * Segmented control implemented as an ARIA radio group with roving focus:
 * Tab enters on the selected option, arrow keys move and select, Home/End jump.
 */
export function PeriodSelector<T extends string>({ label, options, value, onChange, hideLabel = false, layout = 'inline' }: PeriodSelectorProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled);

  const move = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const pos = enabled.findIndex(({ i }) => i === currentIndex);
    let next: number | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = enabled[(pos + 1) % enabled.length]?.i;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = enabled[(pos - 1 + enabled.length) % enabled.length]?.i;
        break;
      case 'Home':
        next = enabled[0]?.i;
        break;
      case 'End':
        next = enabled[enabled.length - 1]?.i;
        break;
      default:
        return;
    }
    event.preventDefault();
    const option = next === undefined ? undefined : options[next];
    if (next === undefined || !option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };

  const labelId = useId();

  return (
    <div className={`${styles.root} ${layout === 'stacked' ? styles.stacked : ''}`}>
      <span id={labelId} className={hideLabel ? 'visually-hidden' : styles.label}>
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className={styles.group}>
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              disabled={option.disabled}
              className={styles.option}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => move(event, index)}
            >
              {option.label}
              {/* The visible label starts the accessible name (WCAG 2.5.3); the description extends it. */}
              {option.description ? <span className="visually-hidden">, {option.description}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
