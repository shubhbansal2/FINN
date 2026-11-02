import type { Change, FirstCutLine, ResultsFirstCut } from '@/push/types';
import { ComparisonTable, type ComparisonCell } from '@/ui/ComparisonTable';
import { safeDocumentUrl } from '@/ui/evidence';
import { formatInr, formatSignedPercent } from '@/ui/format';
import { Icon } from '@/ui/Icon';

import styles from './SignalDetailContent.module.css';

const valueCell = (line: FirstCutLine, value: number | null): ComparisonCell => ({
  kind: 'value',
  value: value === null ? { kind: 'missing', reason: line.derived ? 'not_computable' : 'not_reported' } : { kind: 'currency', valueInr: value },
  derived: line.derived,
  unverified: value !== null && !line.verified,
});

/**
 * Revenue, EBITDA, PBT and PAT for the quarter, with QoQ and YoY first so they
 * stay on screen on a phone; the comparison quarters follow for checking.
 */
export function FirstCutTable({ cut }: { cut: ResultsFirstCut }) {
  const link = cut.url ? safeDocumentUrl(cut.url) : null;
  return (
    <>
      <ComparisonTable
        caption={`Results first cut · ${cut.quarter.label}`}
        unitNote={`₹ crore · ${cut.basis} · as filed`}
        rowHeader="Line"
        columns={[
          { id: 'q', label: cut.quarter.label },
          { id: 'qoq', label: 'QoQ', sublabel: `vs ${cut.previousLabel}`, kind: 'delta' },
          { id: 'yoy', label: 'YoY', sublabel: `vs ${cut.yearAgoLabel}`, kind: 'delta' },
          { id: 'prev', label: cut.previousLabel },
          { id: 'ago', label: cut.yearAgoLabel },
        ]}
        rows={cut.lines.map((line) => ({
          id: line.metric,
          label: line.label,
          note: line.derived ? 'PBT + finance costs + D&A' : (line.note ?? undefined),
          emphasis: line.metric === 'pat',
          cells: [valueCell(line, line.current), { kind: 'delta', delta: line.qoq }, { kind: 'delta', delta: line.yoy }, valueCell(line, line.previous), valueCell(line, line.yearAgo)],
        }))}
      />
      <span className={styles.meta}>
        Read by FINN&apos;s results parser from the filing&apos;s own columns, with its arithmetic checked.{' '}
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" className={styles.source}>
            {cut.page ? `Statement on p. ${cut.page}` : 'Open the statement'} <Icon name="external" size={14} />
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : null}
      </span>
    </>
  );
}

const pct = (c: Change) => (c.kind === 'ratio' ? formatSignedPercent(c.value) : null);

/** One line for the feed row, e.g. "Revenue ₹2,58,027 Cr (+5.0% YoY) · PAT ₹18,165 Cr (+9.3% YoY)". */
export function firstCutSummary(cut: ResultsFirstCut): string {
  const parts = cut.lines
    .filter((l) => (l.metric === 'revenue' || l.metric === 'pat') && l.current !== null)
    .map((l) => {
      const yoy = pct(l.yoy);
      return `${l.label} ${formatInr(l.current as number)}${yoy ? ` (${yoy} YoY)` : ''}`;
    });
  return parts.length ? `${cut.quarter.label}: ${parts.join(' · ')}` : `${cut.quarter.label} results read from the filing.`;
}

/** The change a row shows without a click: revenue YoY, else PAT YoY. */
export function headlineChange(cut: ResultsFirstCut): { label: string; change: Change } | null {
  for (const metric of ['revenue', 'pat'] as const) {
    const line = cut.lines.find((l) => l.metric === metric);
    if (line && line.yoy.kind === 'ratio') return { label: metric === 'revenue' ? 'Rev YoY' : 'PAT YoY', change: line.yoy };
  }
  return null;
}
