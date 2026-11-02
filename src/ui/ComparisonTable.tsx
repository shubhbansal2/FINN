import { useId, type ReactNode } from 'react';

import { Delta, type DeltaValue } from './Delta';
import { Provenance } from './Provenance';
import { formatDisplayValue, MISSING_LABEL, type DisplayValue } from './values';
import styles from './ComparisonTable.module.css';

export type ComparisonCell =
  | { kind: 'value'; value: DisplayValue; derived?: boolean; unverified?: boolean }
  | { kind: 'delta'; delta: DeltaValue; tone?: 'standard' | 'inverse' | 'none' };

export type ComparisonRow = {
  id: string;
  label: string;
  /** Secondary text under the label, e.g. a formula for a derived row. */
  note?: string;
  cells: ComparisonCell[];
  /** Per-row source slot (a Citation), shown in the last column. */
  source?: ReactNode;
  emphasis?: boolean;
};

export type ComparisonColumn = { id: string; label: string; sublabel?: string; kind?: 'value' | 'delta' };

type ComparisonTableProps = {
  caption: string;
  /** Unit statement shown under the caption, e.g. "₹ crore, consolidated". */
  unitNote?: string;
  rowHeader: string;
  columns: ComparisonColumn[];
  rows: ComparisonRow[];
  showSourceColumn?: boolean;
};

function Cell({ cell }: { cell: ComparisonCell }) {
  if (cell.kind === 'delta') return <Delta delta={cell.delta} tone={cell.tone} />;
  const text = formatDisplayValue(cell.value);
  if (text === null) {
    const reason = cell.value.kind === 'missing' ? MISSING_LABEL[cell.value.reason] : '';
    return (
      <span className={styles.missing} title={reason}>
        <span aria-hidden="true">—</span>
        <span className="visually-hidden">{reason}</span>
      </span>
    );
  }
  return (
    <span className={styles.valueWrap}>
      <span className="num">{text}</span>
      {cell.derived ? <span className={styles.marker} title="Derived" aria-label="derived">d</span> : null}
      {cell.unverified ? <Provenance kind="unverified" /> : null}
    </span>
  );
}

/**
 * Dense numeric comparison. On narrow screens the table scrolls horizontally
 * with the row labels pinned, so figures stay in columns rather than reflowing
 * into a stack where they can no longer be compared.
 */
export function ComparisonTable({ caption, unitNote, rowHeader, columns, rows, showSourceColumn = false }: ComparisonTableProps) {
  const captionId = useId();
  return (
    <figure className={styles.figure}>
      <figcaption id={captionId} className={styles.caption}>
        <span className={styles.captionText}>{caption}</span>
        {unitNote ? <span className={styles.unit}>{unitNote}</span> : null}
      </figcaption>
      {/* Focusable so keyboard users can scroll it; labelled so the stop is announced. */}
      <div className={styles.scroller} role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.rowHead}>
                {rowHeader}
              </th>
              {columns.map((column) => (
                <th key={column.id} scope="col" className={styles.num}>
                  <span className={styles.colLabel}>{column.label}</span>
                  {column.sublabel ? <span className={styles.colSub}>{column.sublabel}</span> : null}
                </th>
              ))}
              {showSourceColumn ? (
                <th scope="col" className={styles.sourceHead}>
                  Source
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.emphasis ? styles.emphasis : undefined}>
                <th scope="row" className={styles.rowHead}>
                  <span className={styles.rowLabel}>{row.label}</span>
                  {row.note ? <span className={styles.rowNote}>{row.note}</span> : null}
                </th>
                {row.cells.map((cell, index) => (
                  <td key={columns[index]?.id ?? index} className={styles.num}>
                    <Cell cell={cell} />
                  </td>
                ))}
                {showSourceColumn ? <td className={styles.sourceCell}>{row.source ?? null}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
