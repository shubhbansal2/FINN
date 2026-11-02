'use client';

import { useId, useState, type ReactNode } from 'react';

import type { Claim, ReportCell, ResearchReport, StatementView } from '@/research/report';
import { Banner } from '@/ui/Banner';
import { Citation } from '@/ui/Citation';
import { ComparisonTable, type ComparisonCell } from '@/ui/ComparisonTable';
import { CompanyId } from '@/ui/CompanyId';
import { safeDocumentUrl, type ClaimNature, type Evidence } from '@/ui/evidence';
import { formatDateIst, formatInr, formatMultiple, formatNumber, formatPercent, MINUS } from '@/ui/format';
import { Icon } from '@/ui/Icon';
import { Metric, MetricGroup, type MetricComparison } from '@/ui/Metric';
import { PeriodSelector } from '@/ui/PeriodSelector';
import { Provenance } from '@/ui/Provenance';
import { Timestamp } from '@/ui/Timestamp';
import type { DisplayValue } from '@/ui/values';

import { SOURCE_STATE_LABEL } from './StageTracker';
import styles from './ReportView.module.css';

type ModuleEnvelope = { status: 'ok' | 'partial' | 'unavailable'; note: string | null };
type Statement = StatementView;

const KINDS: Evidence['documentKind'][] = ['Annual report', 'Concall transcript', 'Results filing', 'Investor presentation', 'Exchange filing'];

const SCALE_LABEL: Record<string, string> = {
  one: '₹ (rupees)',
  thousand: '₹ thousand',
  lakh: '₹ lakh',
  million: '₹ million',
  crore: '₹ crore',
  billion: '₹ billion',
};

const NATURE: Record<Claim['kind'], ClaimNature> = { sourced_fact: 'reported_fact', quotation: 'quotation', computed: 'computed', inference: 'interpretation' };

function toEvidence(report: ResearchReport, id: string, claim?: Evidence['claim']): Evidence | null {
  const e = report.evidence[id];
  if (!e) return null;
  return {
    documentTitle: e.documentTitle,
    documentKind: KINDS.find((k) => k === e.documentKind) ?? 'Exchange filing',
    filedAtIso: e.publishedAt ?? undefined,
    page: e.page ?? 1,
    passageText: e.passage,
    quote: e.quote ?? undefined,
    pdfUrl: e.url ?? undefined,
    extractionMethod: e.extraction,
    verification: e.verification === 'verified' ? 'verified' : 'unverified',
    verifiedLabel: e.basis === 'arithmetic' ? 'Arithmetic checks passed' : e.basis === 'quote' ? 'Quote located in passage' : 'Verbatim passage',
    dataMode: report.dataMode === 'fixture' ? 'demo' : 'live',
    reported: e.reported
      ? {
          printed: e.reported.printed,
          scaleLabel: SCALE_LABEL[e.reported.scale] ?? e.reported.scale,
          normalized: `${formatInr(e.reported.normalizedInr)} = ₹${formatNumber(e.reported.normalizedInr)}`,
          period: e.reported.period,
          basis: e.reported.basis,
        }
      : undefined,
    claim,
  };
}

const shortSource = (raw: ResearchReport['evidence'][string]) =>
  raw.documentKind === 'Results filing' ? 'Results' : raw.documentKind === 'Concall transcript' ? raw.documentTitle.replace('Earnings call transcript, ', 'Call ') : raw.documentKind;

/** Citation chips for a set of evidence ids. An id that does not resolve is shown as unavailable, never hidden. */
function Cites({ report, ids, max = 3, claim }: { report: ResearchReport; ids: string[]; max?: number; claim?: Evidence['claim'] }) {
  return (
    <span className={styles.cites}>
      {ids.slice(0, max).map((id) => {
        const ev = toEvidence(report, id, claim);
        const raw = report.evidence[id];
        if (!ev || !raw) return <span key={id} className={styles.unresolved}>Source unavailable</span>;
        return <Citation key={id} evidence={ev} label={`${shortSource(raw)}, ${raw.locationLabel}`} />;
      })}
      {ids.length > max ? <span className={styles.more}>+{ids.length - max}</span> : null}
    </span>
  );
}

function ModuleNote({ m }: { m: ModuleEnvelope }) {
  if (!m.note) return null;
  return (
    <p className={styles.note}>
      {m.status === 'partial' ? <span className={styles.status}>Partial</span> : null}
      {m.note}
    </p>
  );
}

const NATURE_TAG: Record<Claim['kind'], ReactNode> = {
  sourced_fact: null,
  quotation: null,
  computed: <Provenance kind="derived" detail="Computed by FINN from reported figures." />,
  inference: <Provenance kind="inference" />,
};

function ClaimList({ report, claims }: { report: ResearchReport; claims: Claim[] }) {
  return (
    <ul className={styles.claims}>
      {claims.map((c, i) => (
        <li key={i} className={styles.claim}>
          {c.kind === 'quotation' ? <q className={styles.quote}>{c.text}</q> : <span>{c.text}</span>} {NATURE_TAG[c.kind]}{' '}
          <Cites report={report} ids={c.evidenceIds} claim={{ text: c.text, kind: NATURE[c.kind] }} />
        </li>
      ))}
    </ul>
  );
}

function cellValue(c: ReportCell, ratioAs: 'percent' | 'multiple' = 'percent'): DisplayValue {
  if (c.state === 'missing') return { kind: 'missing', reason: 'not_reported' };
  if (c.state === 'conflict') return { kind: 'missing', reason: 'conflicting_sources' };
  if (c.unit === 'inr') return { kind: 'currency', valueInr: c.value, scale: 'crore' };
  return ratioAs === 'multiple' ? { kind: 'multiple', value: c.value } : { kind: 'percent', ratio: c.value };
}

function toComparisonCell(c: ReportCell): ComparisonCell {
  return { kind: 'value', value: cellValue(c), derived: c.state === 'value' && c.formula !== null, unverified: c.state === 'value' && !c.verified };
}

const signed = (v: number, digits = 1) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(digits)}`;

/* ---------- Sections ---------- */

type SectionProps = {
  n: number;
  title: string;
  defaultOpen: boolean;
  /** One line shown while collapsed, so a closed section still says what it holds. */
  summary?: string;
  aside?: ReactNode;
  children: ReactNode;
};

/** A numbered, collapsible report section. The heading button is the toggle; controls sit beside it. */
function Section({ n, title, defaultOpen, summary, aside, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={`${id}-h`}>
      <div className={styles.sectionHead}>
        <h2 id={`${id}-h`} className={styles.sectionTitle}>
          <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={`${id}-b`} onClick={() => setOpen((o) => !o)}>
            <span className={styles.sectionNum}>{n}</span>
            <span>{title}</span>
            <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true" />
          </button>
        </h2>
        {open && aside ? <div className={styles.aside}>{aside}</div> : null}
      </div>
      {!open && summary ? <p className={styles.collapsed}>{summary}</p> : null}
      <div id={`${id}-b`} hidden={!open} className={styles.sectionBody}>
        {children}
      </div>
    </section>
  );
}

/** A section with nothing meaningful to show: one line saying why, no empty scaffolding. */
function Unavailable({ n, title, reason, children }: { n: number; title: string; reason: string; children?: ReactNode }) {
  return (
    <section className={`${styles.section} ${styles.unavailable}`} aria-label={`${title}: not available`}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>
          <span className={styles.toggleStatic}>
            <span className={styles.sectionNum}>{n}</span>
            <span>{title}</span>
          </span>
        </h2>
        <span className={styles.unavailableTag}>Not available</span>
      </div>
      <p className={styles.unavailableReason}>{reason}</p>
      {children}
    </section>
  );
}

/* ---------- 1. Identity and business ---------- */

const ROLE_LABEL: Record<string, string> = { portfolio: 'Portfolio holding', research: 'Research list', ad_hoc: 'Not in coverage list (researched on request)' };

function Overview({ report, open }: { report: ResearchReport; open: boolean }) {
  const m = report.modules.snapshot;
  const used = report.sources.filter((s) => s.state === 'used').length;
  return (
    <Section n={1} title="Company and business" defaultOpen={open} summary={m.data ? `${m.data.claims.length} sourced points` : 'Identity only; business description unavailable'}>
      <dl className={styles.identity}>
        <div>
          <dt>NSE</dt>
          <dd className="num">{report.company.nseSymbol ?? '—'}</dd>
        </div>
        <div>
          <dt>BSE</dt>
          <dd className="num">{report.company.bseCode ?? '—'}</dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>{ROLE_LABEL[report.company.role] ?? report.company.role}</dd>
        </div>
        <div>
          <dt>Documents used</dt>
          <dd className="num">
            {used} of {report.sources.length}
          </dd>
        </div>
      </dl>
      {m.data ? (
        <>
          <p className={styles.kicker}>{m.data.mode === 'model' ? 'Business overview · written by the model from cited passages' : 'Business overview · passages quoted from the filings'}</p>
          <ClaimList report={report} claims={m.data.claims} />
        </>
      ) : (
        <p className={styles.missing}>Business description not available: {m.note ?? 'no supporting passages were found.'}</p>
      )}
    </Section>
  );
}

/* ---------- 2. Trajectory highlights ---------- */

type Highlight = NonNullable<ResearchReport['modules']['trajectory']['data']>['highlights'][number];

function comparisonsOf(h: Highlight): MetricComparison[] {
  return h.comparisons
    .filter((c) => c.kind === 'ratio')
    .map((c) => ({
      basis: c.basis,
      delta: c.value !== null ? { kind: 'ratio', value: c.value } : c.reason?.includes('negative base') ? { kind: 'not_meaningful' } : { kind: 'missing' },
    }));
}

function Trajectory({ report, open }: { report: ResearchReport; open: boolean }) {
  const m = report.modules.trajectory;
  const highlights = m.data?.highlights ?? [];
  if (!m.data || highlights.length === 0) {
    return <Unavailable n={2} title="Financial trajectory" reason={m.note ?? 'No quarterly figures were extracted.'} />;
  }
  const first = highlights[0];
  return (
    <Section n={2} title="Financial trajectory" defaultOpen={open} summary={first ? `${first.period}, ${first.basis}` : undefined}>
      <p className={styles.note}>
        Latest reported quarter: <strong>{first?.period}</strong> · {first?.basis}. Comparisons are computed by FINN from the reported figures for the matching periods; a dash means the comparison period was not in the retrieved filings.
      </p>
      <MetricGroup label={`Headline figures, ${first?.period ?? ''}`}>
        {highlights.map((h) => {
          const pp = h.comparisons.find((c) => c.kind === 'pp');
          const derived = h.cell.state === 'value' && h.cell.formula ? { formula: h.cell.formula } : undefined;
          const ids = h.cell.state === 'missing' ? [] : h.cell.evidenceIds;
          return (
            <Metric
              key={h.key}
              label={h.label.replace(' (derived)', '')}
              value={cellValue(h.cell)}
              size="lg"
              comparisons={comparisonsOf(h)}
              derived={derived}
              unverified={h.cell.state === 'value' && !h.cell.verified ? { reason: 'Figure did not pass arithmetic checks and was not confirmed elsewhere.' } : undefined}
              source={
                <>
                  {pp ? (
                    <span className={styles.pp}>
                      {pp.value !== null ? (
                        <>
                          <span className="num">{signed(pp.value)} pp</span> {pp.basis}
                        </>
                      ) : (
                        <>— {pp.basis}</>
                      )}
                    </span>
                  ) : null}
                  <Cites report={report} ids={ids} max={1} claim={{ text: `${h.label} for ${h.period} (${h.basis})`, kind: derived ? 'computed' : 'reported_fact' }} />
                  {h.comparisons
                    .filter((c) => c.value === null && c.reason)
                    .map((c) => (
                      <span key={c.basis} className={styles.whyMissing}>
                        {c.basis} not shown: {c.reason}.
                      </span>
                    ))}
                </>
              }
            />
          );
        })}
      </MetricGroup>
    </Section>
  );
}

/* ---------- 3. Performance table ---------- */

const TYPE_LABEL: Record<string, string> = { quarter: 'Quarter', half_year: 'Half-year', nine_months: 'Nine months', financial_year: 'Full year' };
type PeriodView = 'quarters' | 'cumulative' | 'all';

const NOT_TABULATED = [
  { key: 'cash_from_operations', label: 'Operating cash flow' },
  { key: 'capex', label: 'Capital expenditure' },
  { key: 'free_cash_flow', label: 'Free cash flow' },
  { key: 'borrowings', label: 'Debt' },
] as const;

function PerformanceTable({ report, open }: { report: ResearchReport; open: boolean }) {
  const tables = report.modules.trajectory.data?.tables ?? [];
  const [basis, setBasis] = useState<'consolidated' | 'standalone'>(tables[0]?.basis ?? 'consolidated');
  const [view, setView] = useState<PeriodView>('quarters');
  const table = tables.find((t) => t.basis === basis) ?? tables[0];
  if (!table) return <Unavailable n={3} title="Financial performance" reason={report.modules.trajectory.note ?? 'No financial figures were extracted.'} />;

  const hasQuarters = table.columns.some((c) => c.type === 'quarter');
  const hasCumulative = table.columns.some((c) => c.type !== 'quarter');
  const effective: PeriodView = hasQuarters && hasCumulative ? view : 'all';
  const keep = table.columns.map((c) => effective === 'all' || (effective === 'quarters') === (c.type === 'quarter'));
  const columns = table.columns.filter((_, i) => keep[i]);
  const bsItems = report.modules.balanceSheet.data?.items ?? [];

  const controls = (
    <span className={styles.controls}>
      {hasQuarters && hasCumulative ? (
        <PeriodSelector
          label="Periods"
          hideLabel
          value={view}
          onChange={setView}
          options={[
            { value: 'quarters', label: 'Quarters' },
            { value: 'cumulative', label: 'H1 / 9M / FY' },
            { value: 'all', label: 'All' },
          ]}
        />
      ) : null}
      {tables.length > 1 ? (
        <PeriodSelector
          label="Basis"
          hideLabel
          value={basis}
          onChange={setBasis}
          options={tables.map((t) => ({ value: t.basis, label: t.basis === 'consolidated' ? 'Consolidated' : 'Standalone' }))}
        />
      ) : null}
    </span>
  );

  return (
    <Section n={3} title="Financial performance" defaultOpen={open} summary={`${table.columns.length} periods · ${table.basis}`} aside={controls}>
      <ModuleNote m={report.modules.trajectory} />
      <ComparisonTable
        caption={`${report.company.name} · ${table.basis} · periods as reported`}
        unitNote={`₹ crore, converted from the filing's stated unit · ${table.basis} basis · ratios in %`}
        rowHeader="Line item"
        columns={columns.map((c) => ({ id: `${c.type}:${c.end}`, label: c.label, sublabel: `${TYPE_LABEL[c.type] ?? c.type} to ${formatDateIst(`${c.end}T12:00:00Z`)}` }))}
        rows={table.rows.map((r) => {
          const cells = r.cells.filter((_, i) => keep[i]);
          const firstWithEvidence = cells.find((c) => c.state !== 'missing' && c.evidenceIds.length > 0);
          const derived = cells.find((c) => c.state === 'value' && c.formula);
          return {
            id: r.key,
            label: r.label,
            note: derived && derived.state === 'value' ? (derived.formula ?? undefined)?.split(' (')[0] : undefined,
            cells: cells.map(toComparisonCell),
            source:
              firstWithEvidence && firstWithEvidence.state !== 'missing' ? (
                <Cites report={report} ids={firstWithEvidence.evidenceIds} max={1} claim={{ text: `${r.label}, ${table.basis}`, kind: derived ? 'computed' : 'reported_fact' }} />
              ) : null,
          };
        })}
        showSourceColumn
      />
      <div className={styles.absent}>
        <p className={styles.kicker}>Not in this table</p>
        <ul>
          {NOT_TABULATED.map((row) => {
            const item = bsItems.find((i) => i.key === row.key);
            const why =
              item?.cell.state === 'value'
                ? `shown under Balance sheet and cash quality (${item.period ?? 'period as reported'}).`
                : item?.cell.state === 'missing'
                  ? `${item.cell.reason}.`
                  : 'the cash-flow statement is not extracted from the retrieved filings yet.';
            return (
              <li key={row.key}>
                <strong>{row.label}</strong>: {why}
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}

/* ---------- 4. Balance sheet ---------- */

function BalanceSheet({ report, open }: { report: ResearchReport; open: boolean }) {
  const m = report.modules.balanceSheet;
  const items = m.data?.items ?? [];
  const present = items.filter((i) => i.cell.state === 'value');
  const absent = items.filter((i) => i.cell.state !== 'value');
  const absentList = absent.length ? (
    <ul className={styles.absentList}>
      {absent.map((i) => (
        <li key={i.key}>
          <strong>{i.label}</strong>: {i.cell.state === 'value' ? '' : i.cell.reason}
        </li>
      ))}
    </ul>
  ) : null;
  if (present.length === 0) return <Unavailable n={4} title="Balance sheet and cash quality" reason={m.note ?? 'No balance-sheet or cash-flow figures were extracted.'}>{absentList}</Unavailable>;
  return (
    <Section n={4} title="Balance sheet and cash quality" defaultOpen={open} summary={`${present.length} of ${items.length} measures available`}>
      <ModuleNote m={m} />
      <dl className={styles.items}>
        {present.map((i) => (
          <div key={i.key} className={styles.item}>
            <dt>
              {i.label}
              {i.period ? <span className={styles.period}>{i.period}</span> : null}
              <span className={styles.explain}>{i.explanation}</span>
            </dt>
            <dd>
              {i.cell.state === 'value' ? (
                <>
                  <span className="num">{i.cell.unit === 'inr' ? formatInr(i.cell.value) : i.key === 'interest_coverage' ? formatMultiple(i.cell.value) : formatPercent(i.cell.value)}</span>{' '}
                  {i.cell.formula ? <Provenance kind="derived" detail={i.cell.formula} /> : null}{' '}
                  <Cites report={report} ids={i.cell.evidenceIds} max={2} claim={{ text: `${i.label}${i.period ? `, ${i.period}` : ''}`, kind: i.cell.formula ? 'computed' : 'reported_fact' }} />
                </>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      {absentList ? (
        <div className={styles.absent}>
          <p className={styles.kicker}>Not available</p>
          {absentList}
        </div>
      ) : null}
    </Section>
  );
}

/* ---------- 5. Guidance ---------- */

const SUBJECT_LABEL: Record<string, string> = {
  revenue_growth: 'Revenue growth',
  revenue: 'Revenue',
  ebitda_margin: 'EBITDA margin',
  margin: 'Margin',
  ebitda: 'EBITDA',
  pat: 'Profit',
  capex: 'Capex',
  volume: 'Volumes and capacity',
  debt: 'Debt',
  guidance_policy: 'Guidance policy',
  business: 'Business outlook',
};

/** Target as stated. A bare count carries no unit of its own, so it points back to the quote rather than inventing one. */
function targetText(s: Statement): string | null {
  if (!s.target) return null;
  const n = s.target.low === s.target.high ? `${s.target.low}` : `${s.target.low}–${s.target.high}`;
  switch (s.target.unit) {
    case 'percent':
      return `${n}%`;
    case 'inr_crore':
      return `₹${n} Cr`;
    case 'bps':
      return `${n} bps`;
    default:
      return `${n} (unit as quoted)`;
  }
}

function callDate(report: ResearchReport, s: Statement): string | null {
  const iso = report.evidence[s.evidenceId]?.publishedAt;
  return iso ? formatDateIst(iso) : null;
}

function StatementQuote({ report, s }: { report: ResearchReport; s: Statement }) {
  return (
    <>
      <q className={styles.quote}>{s.quote}</q>
      <span className={styles.attribution}>
        {s.speaker ?? 'Speaker not named in transcript'} · {s.callLabel}
        {callDate(report, s) ? ` · ${callDate(report, s)}` : ''} <Cites report={report} ids={[s.evidenceId]} claim={{ text: 'Management statement, quoted verbatim', kind: 'quotation' }} />
      </span>
    </>
  );
}

function Guidance({ report, open }: { report: ResearchReport; open: boolean }) {
  const m = report.modules.guidance;
  const statements = m.data?.statements ?? [];
  if (statements.length === 0) return <Unavailable n={5} title="Management guidance" reason={m.note ?? 'No forward-looking statements were found in the retrieved transcripts.'} />;
  const quantitative = statements.filter((s) => s.nature === 'quantitative');
  const qualitative = statements.filter((s) => s.nature !== 'quantitative');
  return (
    <Section n={5} title="Management guidance" defaultOpen={open} summary={`${quantitative.length} with numeric targets · ${qualitative.length} qualitative`} aside={<span className={styles.count}>{statements.length} statements</span>}>
      <ModuleNote m={m} />
      {quantitative.length ? (
        <>
          <p className={styles.kicker}>With a numeric target</p>
          <ul className={styles.guidance}>
            {quantitative.map((s) => (
              <li key={s.id} className={styles.guidanceItem}>
                <span className={styles.subject}>
                  {SUBJECT_LABEL[s.subject] ?? s.subject.replace(/_/g, ' ')}
                  {targetText(s) ? <span className="num"> · {targetText(s)}</span> : null}
                  {s.horizonText ? ` · ${s.horizonText}` : ' · no horizon stated'}
                </span>
                <StatementQuote report={report} s={s} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className={styles.missing}>No statement in the retrieved calls gives a numeric target.</p>
      )}
      {qualitative.length ? (
        <details className={styles.details}>
          <summary>Qualitative commentary ({qualitative.length})</summary>
          <ul className={styles.guidance}>
            {qualitative.map((s) => (
              <li key={s.id} className={styles.guidanceItem}>
                <span className={styles.subject}>{SUBJECT_LABEL[s.subject] ?? s.subject.replace(/_/g, ' ')}</span>
                <StatementQuote report={report} s={s} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

/* ---------- 6. Scorecard ---------- */

type Verdict = Statement['evaluation']['verdict'];

/** Careful wording: what the numbers show relative to what was said, never a grade. */
function assessment(s: Statement): { label: string; tone: 'aligned' | 'above' | 'below' | 'open' } {
  const range = s.target ? s.target.low !== s.target.high : false;
  const v: Verdict = s.evaluation.verdict;
  switch (v) {
    case 'met':
      return { label: range ? 'Within the stated range' : 'In line with the stated target', tone: 'aligned' };
    case 'exceeded':
      return { label: range ? 'Above the stated range' : 'Above the stated target', tone: 'above' };
    case 'missed':
      return { label: range ? 'Below the stated range' : 'Below the stated target', tone: 'below' };
    case 'awaiting_results':
      return { label: 'Not yet reported', tone: 'open' };
    case 'actual_unavailable':
      return { label: 'Outcome not available', tone: 'open' };
    case 'not_evaluable':
      return { label: 'Not assessable', tone: 'open' };
  }
}

function ScoredStatement({ report, s }: { report: ResearchReport; s: Statement }) {
  const a = assessment(s);
  const e = s.evaluation;
  return (
    <li className={styles.scored}>
      <div className={styles.said}>
        <p className={styles.kicker}>Said</p>
        <StatementQuote report={report} s={s} />
      </div>
      <dl className={styles.scoreGrid}>
        <div>
          <dt>Target</dt>
          <dd className="num">{targetText(s) ?? '—'}</dd>
        </div>
        <div>
          <dt>Horizon</dt>
          <dd>{s.horizonPeriod ?? (s.horizonText ? `“${s.horizonText}”` : 'Not stated')}</dd>
        </div>
        <div>
          <dt>Actual</dt>
          <dd>
            {e.actualPercent !== null ? (
              <>
                <span className="num">{e.actualPercent.toFixed(1)}%</span> {e.actualVerified === false ? <Provenance kind="unverified" /> : null}{' '}
                <Cites report={report} ids={e.actualEvidenceIds} max={1} claim={{ text: e.reason, kind: 'computed' }} />
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt>Variance</dt>
          <dd className="num">{e.variancePp !== null ? `${signed(e.variancePp)} pp` : '—'}</dd>
        </div>
      </dl>
      <p className={styles.assessment}>
        <span className={`${styles.assessLabel} ${styles[a.tone]}`}>{a.label}</span>
        <span className={styles.assessReason}>{e.reason}</span>
      </p>
    </li>
  );
}

function Scorecard({ report, open }: { report: ResearchReport; open: boolean }) {
  const m = report.modules.scorecard;
  const statements = report.modules.guidance.data?.statements ?? [];
  const byId = new Map(statements.map((s) => [s.id, s]));
  const calls = m.data?.calls ?? [];
  const narrative = new Map((report.modules.narrative.data?.items ?? []).map((i) => [i.statementId, i.related]));
  if (!m.data || calls.length === 0) return <Unavailable n={6} title="Narrative vs numbers" reason={m.note ?? 'No earnings-call transcripts were available to score.'} />;

  const scoredAll = calls.flatMap((c) => c.statementIds.map((id) => byId.get(id)).filter((s): s is Statement => !!s && s.nature === 'quantitative'));
  const tally = (pred: (s: Statement) => boolean) => scoredAll.filter(pred).length;
  const assessable = tally((s) => ['met', 'exceeded', 'missed'].includes(s.evaluation.verdict));

  return (
    <Section
      n={6}
      title="Narrative vs numbers"
      defaultOpen={open}
      summary={`${scoredAll.length} numeric statements across ${calls.length} calls · ${assessable} assessable`}
      aside={<span className={styles.count}>{calls.length} calls</span>}
    >
      <ModuleNote m={m} />
      <p className={styles.tally}>
        Of {scoredAll.length} statements with a numeric target, {assessable} could be checked against a reported figure:{' '}
        <span className="num">{tally((s) => s.evaluation.verdict === 'met')}</span> in line or within range, <span className="num">{tally((s) => s.evaluation.verdict === 'exceeded')}</span> above,{' '}
        <span className="num">{tally((s) => s.evaluation.verdict === 'missed')}</span> below. <span className="num">{tally((s) => s.evaluation.verdict === 'awaiting_results')}</span> refer to periods not yet reported;{' '}
        <span className="num">{tally((s) => s.evaluation.verdict === 'not_evaluable' || s.evaluation.verdict === 'actual_unavailable')}</span> cannot be assessed from the filings.
      </p>
      {calls.map((call) => {
        const rows = call.statementIds.map((id) => byId.get(id)).filter((s): s is Statement => !!s);
        const scored = rows.filter((s) => s.nature === 'quantitative');
        const commentary = rows.filter((s) => s.nature !== 'quantitative');
        const first = rows[0];
        return (
          <div key={call.documentId} className={styles.call}>
            <h3 className={styles.callTitle}>
              {call.callLabel}
              {call.inferredQuarter ? (
                <span className={styles.inferred} title="Inferred from the call month: the latest quarter that had ended before it. Not stated in the transcript metadata.">
                  likely {call.inferredQuarter} results
                </span>
              ) : null}
              <span className={styles.callMeta}>
                {first && callDate(report, first) ? `${callDate(report, first)} · ` : ''}
                {scored.length} numeric · {commentary.length} qualitative
              </span>
            </h3>
            {scored.length ? (
              <ol className={styles.scoredList}>
                {scored.map((s) => (
                  <ScoredStatement key={s.id} report={report} s={s} />
                ))}
              </ol>
            ) : (
              <p className={styles.missing}>No numeric targets were stated on this call.</p>
            )}
            {commentary.length ? (
              <details className={styles.details}>
                <summary>Qualitative commentary from this call ({commentary.length}), shown beside the reported figures</summary>
                <ul className={styles.pairs}>
                  {commentary.map((s) => {
                    const related = narrative.get(s.id) ?? [];
                    return (
                      <li key={s.id} className={styles.pair}>
                        <div>
                          <p className={styles.kicker}>Said</p>
                          <StatementQuote report={report} s={s} />
                        </div>
                        <div>
                          <p className={styles.kicker}>Reported</p>
                          {related.length ? <ClaimList report={report} claims={related} /> : <p className={styles.missing}>No reported figure in the retrieved filings bears directly on this.</p>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ) : null}
          </div>
        );
      })}
    </Section>
  );
}

/* ---------- 7. Bull vs bear ---------- */

function BullBear({ report, open }: { report: ResearchReport; open: boolean }) {
  const m = report.modules.bullBear;
  if (!m.data || (m.data.bull.length === 0 && m.data.bear.length === 0)) return <Unavailable n={7} title="Bull and bear case" reason={m.note ?? 'No supported points could be drawn from the sources.'} />;
  return (
    <Section n={7} title="Bull and bear case" defaultOpen={open} summary={`${m.data.bull.length} bull · ${m.data.bear.length} bear`}>
      <ModuleNote m={m} />
      <p className={styles.note}>{m.data.mode === 'model' ? 'Written by the model; each point cites the passages or figures it rests on, and points that failed verification were removed.' : 'Computed observations from reported figures; no model was used.'}</p>
      <div className={styles.columns}>
        <div>
          <p className={styles.kicker}>Bull</p>
          {m.data.bull.length ? <ClaimList report={report} claims={m.data.bull} /> : <p className={styles.missing}>No supported points.</p>}
        </div>
        <div>
          <p className={styles.kicker}>Bear</p>
          {m.data.bear.length ? <ClaimList report={report} claims={m.data.bear} /> : <p className={styles.missing}>No supported points.</p>}
        </div>
      </div>
    </Section>
  );
}

/* ---------- 8. Sources ---------- */

const ORIGIN_LABEL: Record<string, string> = { exchange_filed: 'Exchange-filed', company_issued: 'Company-issued' };

function Sources({ report, open }: { report: ResearchReport; open: boolean }) {
  const used = report.sources.filter((s) => s.state === 'used').length;
  const evidenceCount = Object.keys(report.evidence).length;
  return (
    <Section n={8} title="Sources and evidence" defaultOpen={open} summary={`${used} of ${report.sources.length} documents used · ${evidenceCount} evidence items`}>
      <p className={styles.note}>
        {evidenceCount} evidence items back the figures and quotes above; each opens the page and passage it came from. Documents are fetched from the exchange and stored with their checksum.
      </p>
      <ul className={styles.sources}>
        {report.sources.map((s) => {
          const href = safeDocumentUrl(s.url);
          return (
            <li key={s.documentId} className={styles.source}>
              <span className={`${styles.sourceState} ${s.state === 'used' ? styles.used : styles.notUsed}`}>{SOURCE_STATE_LABEL[s.state]}</span>
              <span className={styles.sourceMain}>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className={styles.sourceLink}>
                    {s.title}
                    <Icon name="external" size={12} />
                    <span className="visually-hidden"> (opens in a new tab)</span>
                  </a>
                ) : (
                  s.title
                )}
                <span className={styles.callMeta}>
                  {ORIGIN_LABEL[s.origin] ?? s.origin}
                  {s.publishedAt ? ` · filed ${formatDateIst(s.publishedAt)}` : ''}
                  {s.pages ? ` · ${s.pages} pages` : ''}
                  {s.detail ? ` · ${s.detail}` : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className={styles.note}>
        Model: {report.model.configured ? report.model.description : 'not configured; sections that need one fall back to quoted passages or computed observations'}
        {report.model.calls.length ? ` · ${report.model.calls.length} calls (${report.model.calls.filter((c) => c.cached).length} cached)` : ''}.
      </p>
      {report.diagnostics.length ? (
        <details className={styles.details}>
          <summary>{report.diagnostics.length} processing notes</summary>
          <ul className={styles.diagnostics}>
            {report.diagnostics.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

/* ---------- Report ---------- */

const MODULE_TITLE: Partial<Record<keyof ResearchReport['modules'], string>> = {
  snapshot: 'business overview',
  trajectory: 'financial figures',
  balanceSheet: 'balance sheet',
  guidance: 'guidance',
  scorecard: 'scorecard',
  bullBear: 'bull and bear case',
};

const isWide = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 720px)').matches;

export function ReportView({ report, cached }: { report: ResearchReport; cached: boolean }) {
  // Wide screens open every section; on a phone the first three are open and the rest summarise themselves.
  const [wide] = useState(isWide);
  const open = (n: number) => wide || n <= 3;
  const m = report.modules;
  const missing = (Object.keys(MODULE_TITLE) as (keyof ResearchReport['modules'])[]).filter((k) => m[k].status === 'unavailable').map((k) => MODULE_TITLE[k]);
  const sourcesFailed = report.sources.filter((s) => s.state !== 'used' && s.state !== 'not_attempted');
  const failedCalls = report.model.calls.filter((c) => c.status.startsWith('failed'));

  return (
    <article className={styles.report} aria-label={`Research report: ${report.company.name}`}>
      <header className={styles.header}>
        <CompanyId name={report.company.name} symbol={report.company.nseSymbol ?? report.company.bseCode ?? report.company.id} size="title" />
        <p className={styles.meta}>
          <Timestamp iso={report.generatedAt} prefix="Generated" />
          {cached ? <span>· reused (sources unchanged since last run)</span> : null}
          {report.dataMode === 'fixture' ? <Provenance kind="demo" /> : null}
        </p>
      </header>

      {report.status === 'partial' ? (
        <Banner tone="warning" title={`Partial research${missing.length ? `: no ${missing.join(', ')}` : ''}${sourcesFailed.length ? ` · ${sourcesFailed.length} source(s) unavailable` : ''}`}>
          Each section says what is missing and why. Nothing is filled in from outside the cited documents.
        </Banner>
      ) : null}

      {failedCalls.length ? (
        <Banner tone="warning" title={`${failedCalls.length} model call${failedCalls.length === 1 ? '' : 's'} failed`}>
          {failedCalls.map((c) => c.task.replace(/_/g, ' ')).join(', ')}: the affected sections fell back to quoted passages or computed observations, or are marked unavailable. Running research again retries the model.
        </Banner>
      ) : null}

      <Overview report={report} open={open(1)} />

      {report.request.question ? (
        <section className={styles.section} aria-label="Your question">
          <p className={styles.kicker}>Your question</p>
          <p className={styles.question}>{report.request.question}</p>
          <ModuleNote m={m.question} />
          {m.question.data ? <ClaimList report={report} claims={m.question.data.claims} /> : null}
        </section>
      ) : null}

      <Trajectory report={report} open={open(2)} />
      <PerformanceTable report={report} open={open(3)} />
      <BalanceSheet report={report} open={open(4)} />
      <Guidance report={report} open={open(5)} />
      <Scorecard report={report} open={open(6)} />
      <BullBear report={report} open={open(7)} />
      <Sources report={report} open={open(8)} />
    </article>
  );
}
