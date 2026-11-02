'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Citation } from '@/ui/Citation';
import { CommandPalette, type Command } from '@/ui/CommandPalette';
import { ComparisonTable } from '@/ui/ComparisonTable';
import { CompanyId } from '@/ui/CompanyId';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Delta } from '@/ui/Delta';
import { EmptyState } from '@/ui/EmptyState';
import { Metric, MetricGroup } from '@/ui/Metric';
import { PageHeader } from '@/ui/PageHeader';
import { PeriodSelector } from '@/ui/PeriodSelector';
import { PriorityIndicator } from '@/ui/PriorityIndicator';
import { Provenance } from '@/ui/Provenance';
import { SectionHeading } from '@/ui/SectionHeading';
import { SignalRow } from '@/ui/SignalRow';
import { Skeleton } from '@/ui/Skeleton';
import { Timestamp } from '@/ui/Timestamp';
import { applyTheme, readTheme, THEMES, type Theme } from '@/ui/theme';

import {
  GUIDANCE_EVIDENCE,
  HEADLINE,
  RESULTS_EVIDENCE,
  RESULTS_ROWS,
  SPECIMEN_COMPANY,
  SPECIMEN_NOW,
  SPECIMEN_PEER,
  UNVERIFIED_EVIDENCE,
} from './specimens';
import styles from './DesignSystemGallery.module.css';

const WINDOWS = [
  { value: '24h', label: '24h', description: 'Last 24 hours' },
  { value: '3d', label: '3d', description: 'Last 3 days' },
  { value: '7d', label: '7d', description: 'Last 7 days' },
  { value: '30d', label: '30d', description: 'Last 30 days' },
  { value: 'custom', label: 'Custom', description: 'Custom range (not available in specimen)', disabled: true },
] as const;
type WindowValue = (typeof WINDOWS)[number]['value'];

const SWATCHES: { group: string; tokens: string[] }[] = [
  { group: 'Ground', tokens: ['paper', 'surface', 'sunken'] },
  { group: 'Ink', tokens: ['ink', 'ink-2', 'ink-3', 'ink-disabled'] },
  { group: 'Rules', tokens: ['rule', 'rule-input', 'rule-strong'] },
  { group: 'Action', tokens: ['accent', 'accent-hover', 'accent-soft', 'focus'] },
  { group: 'Direction', tokens: ['positive', 'positive-soft', 'negative', 'negative-soft'] },
  { group: 'Signal & health', tokens: ['signal-info', 'warning', 'error', 'stale', 'demo', 'mark'] },
];

const TYPE_ROLES = [
  { role: 'Page title', spec: 'Libre Caslon Text · 400 · 28/32px', sample: <span className={styles.tDisplay}>Brief</span> },
  {
    role: 'Company + ticker',
    spec: 'Libre Franklin 600 · Roboto Mono 500 caps',
    sample: <CompanyId name={SPECIMEN_COMPANY.name} symbol={SPECIMEN_COMPANY.symbol} />,
  },
  {
    role: 'Signal headline',
    spec: 'Libre Caslon Text · 400 · 17px / 1.35',
    sample: <span className={styles.tHeadline}>Board approves Q2 results; consolidated revenue up on the quarter</span>,
  },
  { role: 'Financial value', spec: 'Libre Franklin 500 · tabular · 26px', sample: <span className={`${styles.tValue} num`}>₹1,240 Cr</span> },
  { role: 'Section heading', spec: 'Libre Franklin 600 · 11px caps · 0.08em', sample: <span className={styles.tKicker}>Headline numbers</span> },
  {
    role: 'Supporting text',
    spec: 'Libre Franklin 400 · 13px / 1.5 · ink-2',
    sample: <span className={styles.tSupport}>Figures are consolidated and unaudited, as filed.</span>,
  },
  {
    role: 'Timestamp / source',
    spec: 'Roboto Mono 400 · 12px · ink-3',
    sample: <Timestamp iso="2026-10-30T12:05:00.000Z" />,
  },
];

export function DesignSystemGallery() {
  const [briefWindow, setBriefWindow] = useState<WindowValue>('24h');
  // Preview only: starts from the saved app theme and never saves its own choice.
  const [theme, setTheme] = useState<Theme | null>(null);
  const [selectedSignal, setSelectedSignal] = useState<string>('results');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [failNext, setFailNext] = useState(false);
  const [confirmOutcome, setConfirmOutcome] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setTheme(readTheme()), []);
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  // Restore the saved app theme when leaving this page.
  useEffect(
    () => () => {
      applyTheme(readTheme());
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const specimenCommands = useMemo<Command[]>(
    () => [
      {
        id: 'co:specimen',
        label: SPECIMEN_COMPANY.name,
        hint: SPECIMEN_COMPANY.symbol,
        group: 'Companies (specimen)',
        keywords: ['results'],
        perform: () => setLastCommand(`Selected ${SPECIMEN_COMPANY.symbol}`),
      },
      {
        id: 'co:example',
        label: SPECIMEN_PEER.name,
        hint: SPECIMEN_PEER.symbol,
        group: 'Companies (specimen)',
        perform: () => setLastCommand(`Selected ${SPECIMEN_PEER.symbol}`),
      },
      {
        id: 'act:window',
        label: 'Set Brief window to 7 days',
        group: 'Actions',
        keywords: ['period'],
        perform: () => {
          setBriefWindow('7d');
          setLastCommand('Window set to 7d');
        },
      },
    ],
    [],
  );

  // Specimen of an action with consequences: runs for 1.2s and changes nothing.
  const confirm = () => {
    setConfirmBusy(true);
    setConfirmError(null);
    timer.current = setTimeout(() => {
      setConfirmBusy(false);
      if (failNext) {
        setConfirmError('The rule could not be deleted: storage is unavailable. Nothing was changed.');
        setFailNext(false);
        return;
      }
      setConfirmOpen(false);
      setConfirmOutcome('Confirmed. (Specimen: nothing was deleted.)');
    }, 1200);
  };

  return (
    <div className={styles.page}>
      <PageHeader
        kicker="Development route"
        title="Design system"
        description="Tokens and foundational components in their states. Every figure here is a specimen for a fictional company."
        controls={<PeriodSelector label="Theme" options={THEMES} value={theme ?? 'system'} onChange={setTheme} />}
      />

      <div className={styles.lead}>
        <Banner tone="info" title="Specimen values, not market data">
          Companies, filings and figures on this page are fictional and internally consistent so the components can be
          judged. Nothing here is fetched.
        </Banner>
      </div>

      <section className={styles.section} aria-labelledby="ds-type">
        <SectionHeading id="ds-type">Typography</SectionHeading>
        <dl className={styles.typeList}>
          {TYPE_ROLES.map((t) => (
            <div key={t.role} className={styles.typeRow}>
              <dt>
                <span className={styles.typeRole}>{t.role}</span>
                <span className={styles.typeSpec}>{t.spec}</span>
              </dt>
              <dd>{t.sample}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="ds-colour">
        <SectionHeading id="ds-colour" aside="--color-*">
          Colour
        </SectionHeading>
        <div className={styles.swatchGroups}>
          {SWATCHES.map((group) => (
            <div key={group.group}>
              <p className={styles.subhead}>{group.group}</p>
              <ul className={styles.swatches}>
                {group.tokens.map((token) => (
                  <li key={token} className={styles.swatch}>
                    <span className={styles.chip} style={{ background: `var(--color-${token})` }} aria-hidden="true" />
                    <code>{token}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="ds-buttons">
        <SectionHeading id="ds-buttons">Buttons</SectionHeading>
        <div className={styles.matrix}>
          {(['primary', 'secondary', 'quiet', 'danger'] as const).map((variant) => (
            <div key={variant} className={styles.matrixRow}>
              <span className={styles.matrixLabel}>{variant}</span>
              <Button variant={variant}>Default</Button>
              <Button variant={variant} disabled>
                Disabled
              </Button>
              <Button variant={variant} loading loadingLabel="Working">
                Loading
              </Button>
              <Button variant={variant} size="sm">
                Small
              </Button>
            </div>
          ))}
        </div>
        <p className={styles.note}>Hover, pressed and focus states are live: point at, press, or Tab to any control.</p>
      </section>

      <section className={styles.section} aria-labelledby="ds-ids">
        <SectionHeading id="ds-ids">Identifiers, priority, provenance</SectionHeading>
        <div className={styles.columns}>
          <div className={styles.stack}>
            <p className={styles.subhead}>Company</p>
            <CompanyId name={SPECIMEN_COMPANY.name} symbol={SPECIMEN_COMPANY.symbol} />
            <CompanyId name={SPECIMEN_PEER.name} symbol={SPECIMEN_PEER.symbol} showExchange />
            <CompanyId name={SPECIMEN_COMPANY.name} symbol={SPECIMEN_COMPANY.symbol} size="title" />
          </div>
          <div className={styles.stack}>
            <p className={styles.subhead}>Priority</p>
            {(['high', 'medium', 'low', 'routine'] as const).map((p) => (
              <PriorityIndicator key={p} priority={p} showLabel />
            ))}
          </div>
          <div className={styles.stack}>
            <p className={styles.subhead}>Provenance</p>
            <div className={styles.inlineList}>
              {(['live', 'cached', 'stale', 'demo', 'derived', 'unverified', 'inference'] as const).map((k) => (
                <Provenance key={k} kind={k} />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="ds-metrics">
        <SectionHeading id="ds-metrics" aside="Q2 FY27 · consolidated">
          Financial metrics
        </SectionHeading>
        <MetricGroup label="Headline numbers, specimen">
          <Metric
            size="lg"
            label="Revenue"
            value={{ kind: 'currency', valueInr: HEADLINE.revenue.valueInr }}
            comparisons={[
              { basis: 'QoQ', delta: HEADLINE.revenue.qoq },
              { basis: 'YoY', delta: HEADLINE.revenue.yoy },
            ]}
            source={<Citation evidence={RESULTS_EVIDENCE} label="Q2 FY27 results, p.3" />}
          />
          <Metric
            size="lg"
            label="EBITDA margin"
            value={{ kind: 'percent', ratio: HEADLINE.ebitdaMargin.ratio }}
            derived={{ formula: 'EBITDA ÷ revenue from operations.' }}
          />
          <Metric
            size="lg"
            label="PAT"
            value={{ kind: 'currency', valueInr: HEADLINE.pat.valueInr }}
            comparisons={[
              { basis: 'QoQ', delta: HEADLINE.pat.qoq },
              { basis: 'YoY', delta: HEADLINE.pat.yoy },
            ]}
          />
          <Metric size="lg" label="EBITDA (bank)" value={{ kind: 'missing', reason: 'not_applicable' }} />
        </MetricGroup>

        <p className={styles.subhead}>Deltas</p>
        <div className={styles.inlineList}>
          <Delta delta={{ kind: 'ratio', value: 0.0508 }} basis="QoQ" />
          <Delta delta={{ kind: 'ratio', value: -0.0625 }} basis="1D" />
          <Delta delta={{ kind: 'ratio', value: 0.0004 }} basis="1D" />
          <Delta delta={{ kind: 'ratio', value: 0.12 }} basis="Debt" tone="inverse" />
          <Delta delta={{ kind: 'not_meaningful' }} basis="YoY" />
          <Delta delta={{ kind: 'missing' }} basis="YoY" />
        </div>
        <p className={styles.note}>
          Direction is carried by arrow, sign and wording; colour is additive. “n.m.” marks growth from a zero or negative
          base. The third delta rounds to 0.0% and is shown as unchanged.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="ds-table">
        <SectionHeading id="ds-table">Comparison table</SectionHeading>
        <ComparisonTable
          caption="Results first cut · Q2 FY27"
          unitNote="₹ crore · consolidated · unaudited"
          rowHeader="Line item"
          columns={[
            { id: 'q2', label: 'Q2 FY27', sublabel: 'Jul–Sep 26' },
            { id: 'q1', label: 'Q1 FY27', sublabel: 'Apr–Jun 26' },
            { id: 'q2ly', label: 'Q2 FY26', sublabel: 'Jul–Sep 25' },
            { id: 'qoq', label: 'QoQ', kind: 'delta' },
            { id: 'yoy', label: 'YoY', kind: 'delta' },
          ]}
          rows={RESULTS_ROWS.map((row) => ({
            ...row,
            source: <Citation evidence={RESULTS_EVIDENCE} label="p.3" />,
          }))}
          showSourceColumn
        />
        <p className={styles.note}>
          On narrow screens the table scrolls sideways with line items pinned, so columns stay comparable. A dashed “d”
          marks derived figures.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="ds-signals">
        <SectionHeading id="ds-signals" aside={<PeriodSelector label="Window" options={WINDOWS} value={briefWindow} onChange={setBriefWindow} hideLabel />}>
          Signal rows
        </SectionHeading>
        <p className={styles.note}>
          Window selected: <strong>{WINDOWS.find((w) => w.value === briefWindow)?.description}</strong>. Selecting a row marks it
          as the one shown in a detail pane.
        </p>
        <div>
          <SignalRow
            priority="high"
            company={SPECIMEN_COMPANY}
            category="Results"
            headline="Q2 results: revenue ₹1,240 Cr, PAT ₹131 Cr"
            summary="Consolidated, unaudited. EBITDA derived from PBT, finance costs and D&A."
            occurredAtIso="2026-10-30T12:05:00.000Z"
            figure={<Delta delta={HEADLINE.revenue.yoy} basis="Rev YoY" />}
            meta={
              <>
                <Citation evidence={RESULTS_EVIDENCE} label="Results filing, p.3" />
                <Provenance kind="demo" />
              </>
            }
            selected={selectedSignal === 'results'}
            onSelect={() => setSelectedSignal('results')}
            unread
          />
          <SignalRow
            priority="high"
            company={SPECIMEN_PEER}
            category="Price move"
            headline="Closed down beyond the ±5% threshold on 2.8× average volume"
            summary="Unusual end-of-day move. No filing in the window explains it."
            occurredAtIso="2026-10-30T10:00:00.000Z"
            timePrecision="date"
            figure={<Delta delta={{ kind: 'ratio', value: -0.0625 }} basis="1D" />}
            meta={<Provenance kind="demo" />}
            selected={selectedSignal === 'price'}
            onSelect={() => setSelectedSignal('price')}
          />
          <SignalRow
            priority="medium"
            company={SPECIMEN_COMPANY}
            category="Credit rating"
            headline="Rating agency reaffirms long-term rating; outlook revised to positive"
            occurredAtIso="2026-10-29T06:40:00.000Z"
            meta={<Citation evidence={UNVERIFIED_EVIDENCE} label="Filing, p.1" />}
            selected={selectedSignal === 'rating'}
            onSelect={() => setSelectedSignal('rating')}
          />
          <SignalRow
            priority="routine"
            company={SPECIMEN_PEER}
            category="Routine"
            headline="4 routine filings: ESOP allotment, compliance certificates"
            occurredAtIso="2026-10-29T04:15:00.000Z"
            selected={selectedSignal === 'routine'}
            onSelect={() => setSelectedSignal('routine')}
          />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="ds-evidence">
        <SectionHeading id="ds-evidence">Citations and evidence drawer</SectionHeading>
        <div className={styles.prose}>
          <p>
            Management guided to EBITDA margins of 19–20% for FY27{' '}
            <Citation evidence={GUIDANCE_EVIDENCE} label="Q1 FY27 call, p.7" />. Q2 delivered{' '}
            <span className="num">20.0%</span> <Provenance kind="derived" />.
          </p>
          <p>
            A claim whose quote cannot be found in the cited passage{' '}
            <Citation evidence={UNVERIFIED_EVIDENCE} label="Q1 FY27 call, p.7" /> opens with a warning.
          </p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="ds-states">
        <SectionHeading id="ds-states">Loading, empty, error and stale states</SectionHeading>
        <div className={styles.columns}>
          <div>
            <p className={styles.subhead}>Signal list loading</p>
            <Skeleton label="Loading filings" shape="signal" rows={2} />
          </div>
          <div>
            <p className={styles.subhead}>Metrics loading</p>
            <Skeleton label="Loading headline numbers" shape="metrics" rows={2} />
          </div>
          <div>
            <p className={styles.subhead}>Text loading</p>
            <Skeleton label="Loading section" rows={3} />
          </div>
        </div>
        <div className={styles.columns}>
          <EmptyState
            title="Nothing filed in this window."
            meta={<Timestamp iso="2026-11-01T09:05:00.000Z" relativeTo={SPECIMEN_NOW} prefix="Last checked" />}
            action={
              <Button size="sm" onClick={() => setBriefWindow('7d')}>
                Widen to 7 days
              </Button>
            }
          >
            No portfolio company filed between the selected times.
          </EmptyState>
          <EmptyState title="No guidance found in the last four transcripts.">
            Searched for outlook, guidance and target statements. Shown as missing, not inferred.
          </EmptyState>
        </div>
        <div className={styles.banners}>
          <Banner tone="error" title="BSE announcements unavailable" action={
              <Button size="sm" onClick={() => setLastCommand("Retry requested. (Specimen: nothing is fetched on this page.)")}>
                Retry
              </Button>
            }>
            The last 3 attempts timed out. Showing nothing for filings rather than a partial list.
          </Banner>
          <Banner tone="stale" title="Prices as of 29 Oct close">
            The latest expected session is 30 Oct. Alerts may be missing for that day.
          </Banner>
          <Banner tone="warning" title="2 figures failed consistency checks">
            PBT − tax does not equal PAT within tolerance. Marked unverified in the table.
          </Banner>
          <Banner tone="demo" title="Recorded fixtures, captured 31 Oct 2026">
            This view is running on recorded provider responses, not live data.
          </Banner>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="ds-overlays">
        <SectionHeading id="ds-overlays">Command palette and confirmation</SectionHeading>
        <div className={styles.inlineList}>
          <Button icon="search" onClick={() => setPaletteOpen(true)}>
            Open palette
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmOutcome(null);
              setConfirmError(null);
              setConfirmOpen(true);
            }}
          >
            Delete alert rule…
          </Button>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={failNext} onChange={(e) => setFailNext(e.target.checked)} />
            Make the next confirmation fail
          </label>
        </div>
        <p className={styles.note} role="status">
          {lastCommand ?? confirmOutcome ?? 'Ctrl/⌘ K or “/” also opens the palette anywhere in the app.'}
        </p>
      </section>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={specimenCommands}
        placeholder="Search specimen companies and actions…"
      />
      <ConfirmDialog
        open={confirmOpen}
        title="Delete this alert rule?"
        consequence="Price-move alerts above ±5% will stop for the whole portfolio. Past alerts stay in the log. This cannot be undone."
        confirmLabel="Delete rule"
        tone="danger"
        busy={confirmBusy}
        busyLabel="Deleting rule"
        error={confirmError}
        onConfirm={confirm}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
