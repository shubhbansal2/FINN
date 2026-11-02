'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';

import { ResearchReportSchema, type ResearchReport } from '@/research/report';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { formatDateTimeIst } from '@/ui/format';

import { ReportView } from './ReportView';
import { StageTracker } from './StageTracker';
import styles from './ResearchWorkspace.module.css';

type Candidate = { id: string; name: string; nseSymbol: string | null };

const STAGES = ['retrieving', 'extracting', 'validating', 'analysing'] as const;

/** The job payload as the server sends it; validated before anything renders. */
const JobSchema = z.object({
  id: z.string(),
  company: z.object({ id: z.string(), name: z.string(), symbol: z.string() }),
  status: z.enum(['running', 'complete', 'partial', 'failed']),
  stage: z.enum(STAGES).nullable(),
  log: z.array(z.object({ at: z.string(), stage: z.enum(STAGES), message: z.string() })),
  sources: ResearchReportSchema.shape.sources,
  report: ResearchReportSchema.nullable(),
  cached: z.boolean(),
  demo: z.object({ recordedAt: z.string() }).nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type JobView = z.infer<typeof JobSchema>;

/** The canonical company reference shared with the feed and watchlist. */
export type CompanyRef = { id: string; name: string; symbol: string };
export type HistoryEntry = { company: CompanyRef; kind: 'stored' | 'demo'; generatedAt: string | null; status: 'complete' | 'partial' | 'failed' | null };

type State =
  | { kind: 'idle' }
  | { kind: 'resolving'; ticker: string }
  | { kind: 'rejected'; message: string; errorKind: string; candidates?: Candidate[] }
  /** `stored`: a report saved by an earlier run, opened without re-running anything. */
  | { kind: 'job'; job: JobView; pollError: string | null; stored: boolean };

const POLL_MS = 1500;

async function readJob(res: Response): Promise<{ job: JobView } | { error: string; errorKind: string; candidates?: Candidate[] }> {
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (json as { error?: { kind?: string; message?: string; candidates?: Candidate[] } } | null)?.error;
    return { error: err?.message ?? `Request failed (HTTP ${res.status}).`, errorKind: err?.kind ?? 'http', candidates: err?.candidates };
  }
  const parsed = JobSchema.safeParse((json as { job?: unknown } | null)?.job);
  if (!parsed.success) return { error: 'The server returned research in an unexpected shape; nothing is shown rather than a partial render.', errorKind: 'invalid_response' };
  return { job: parsed.data };
}

type Props = {
  suggestions: CompanyRef[];
  history: HistoryEntry[];
  /** Company preselected by the URL (from a signal, the watchlist or search). */
  initial: CompanyRef | null;
  unknownCompany: string | null;
  dataMode: 'live' | 'fixture';
};

export function ResearchWorkspace({ suggestions, history, initial, unknownCompany, dataMode }: Props) {
  const [ticker, setTicker] = useState(initial?.symbol ?? '');
  const [question, setQuestion] = useState('');
  const [period, setPeriod] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Each run gets a token; a superseded run's responses are ignored.
  const runToken = useRef(0);

  useEffect(() => () => void (runToken.current += 1), []);

  // Opening /research?company=… shows that company straight away.
  useEffect(() => {
    if (initial) void openCompany(initial);
    // Runs once per mounted company; the page remounts this component when the company changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function poll(id: string, token: number) {
    while (runToken.current === token) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (runToken.current !== token) return;
      let res: Response;
      try {
        res = await fetch(`/api/research/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
      } catch {
        setState((s) => (s.kind === 'job' ? { ...s, pollError: 'Lost contact with the server; retrying.' } : s));
        continue;
      }
      const out = await readJob(res);
      if (runToken.current !== token) return;
      if ('error' in out) {
        setState((s) => (s.kind === 'job' ? { ...s, job: { ...s.job, status: 'failed', error: out.error }, pollError: null } : s));
        return;
      }
      setState({ kind: 'job', job: out.job, pollError: null, stored: false });
      if (out.job.status !== 'running') return;
    }
  }

  /** Starts research. `display` is what the search box shows; `t` may be a canonical company id. */
  async function run(symbol: string, display = symbol) {
    const t = symbol.trim();
    if (!t) return;
    const token = ++runToken.current;
    setTicker(display.trim());
    setState({ kind: 'resolving', ticker: display.trim() });
    let res: Response;
    try {
      res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticker: t, question: question.trim() || undefined, period: period.trim() || undefined }),
      });
    } catch (e) {
      if (runToken.current === token) setState({ kind: 'rejected', errorKind: 'network', message: `Could not reach the server (${e instanceof Error ? e.message : 'network error'}).` });
      return;
    }
    const out = await readJob(res);
    if (runToken.current !== token) return;
    if ('error' in out) {
      setState({ kind: 'rejected', message: out.error, errorKind: out.errorKind, candidates: out.candidates });
      return;
    }
    setState({ kind: 'job', job: out.job, pollError: null, stored: false });
    if (out.job.status === 'running') void poll(out.job.id, token);
  }

  /** Opens the stored report for a company without running research again. */
  async function openStored(company: CompanyRef) {
    const token = ++runToken.current;
    setTicker(company.symbol);
    setState({ kind: 'resolving', ticker: company.symbol });
    let res: Response;
    try {
      res = await fetch(`/api/research?ticker=${encodeURIComponent(company.id)}`, { cache: 'no-store' });
    } catch (e) {
      if (runToken.current === token) setState({ kind: 'rejected', errorKind: 'network', message: `Could not reach the server (${e instanceof Error ? e.message : 'network error'}).` });
      return;
    }
    const json: unknown = await res.json().catch(() => null);
    if (runToken.current !== token) return;
    const parsed = ResearchReportSchema.safeParse((json as { report?: unknown } | null)?.report);
    if (!res.ok || !parsed.success) {
      // No usable stored report: run research instead of showing nothing.
      void run(company.id, company.symbol);
      return;
    }
    const r = parsed.data;
    setState({
      kind: 'job',
      stored: true,
      pollError: null,
      job: { id: 'stored', company, status: r.status, stage: 'analysing', log: [], sources: r.sources, report: r, cached: true, demo: null, error: null, startedAt: r.generatedAt, finishedAt: r.generatedAt },
    });
  }

  function openCompany(company: CompanyRef) {
    const stored = dataMode === 'live' && history.some((h) => h.company.id === company.id && h.kind === 'stored');
    return stored ? openStored(company) : run(company.id, company.symbol);
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void run(ticker);
  };

  const backToSearch = () => {
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  };

  const busy = state.kind === 'resolving' || (state.kind === 'job' && state.job.status === 'running');
  const job = state.kind === 'job' ? state.job : null;
  const report: ResearchReport | null = job && job.status !== 'running' ? job.report : null;

  return (
    <div className={styles.workspace}>
      <form ref={formRef} className={styles.form} onSubmit={onSubmit} aria-label="Research request">
        <label className={`${styles.field} ${styles.primary}`}>
          <span className={styles.label}>Company</span>
          <input
            ref={inputRef}
            className={`${styles.input} ${styles.search}`}
            name="ticker"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="NSE symbol or company name, e.g. RELIANCE"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={60}
            required
          />
        </label>
        <details className={styles.options}>
          <summary>Question or period (optional)</summary>
          {dataMode === 'fixture' ? (
            <p className={styles.optionNote}>Not available in demo mode: recorded reports were generated without a question or period limit, so these would be ignored. They work in live mode.</p>
          ) : null}
          <fieldset className={styles.optionFields} disabled={dataMode === 'fixture'}>
            <label className={styles.field}>
              <span className={styles.label}>Question</span>
              <input className={styles.input} name="question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. What is the capex plan?" maxLength={500} />
            </label>
            <label className={`${styles.field} ${styles.narrow}`}>
              <span className={styles.label}>Up to period</span>
              <input className={styles.input} name="period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="Q2 FY27" maxLength={8} pattern="(Q[1-4] )?FY\d{2}" title='A period like "Q2 FY27" or "FY26"' />
            </label>
          </fieldset>
        </details>
        <Button type="submit" variant="primary" loading={busy} loadingLabel={state.kind === 'resolving' ? 'Resolving' : 'Researching'}>
          Research
        </Button>
      </form>

      {unknownCompany && state.kind === 'idle' ? (
        <Banner tone="warning" title="Company not recognised">
          No company with the identifier “{unknownCompany}” is known to FINN. Search for it by NSE symbol or name above.
        </Banner>
      ) : null}

      {state.kind === 'idle' && history.length ? (
        <section className={styles.history} aria-labelledby="research-history">
          <h2 id="research-history" className={styles.label}>
            {dataMode === 'live' ? 'Recent research' : 'Recorded demo reports'}
          </h2>
          <ul className={styles.historyList}>
            {history.map((h) => (
              <li key={h.company.id}>
                <button type="button" className={styles.historyItem} onClick={() => void openCompany(h.company)}>
                  <span className={styles.historySymbol}>{h.company.symbol}</span>
                  <span className={styles.historyName}>{h.company.name}</span>
                  <span className={styles.historyMeta}>
                    {h.kind === 'demo' ? 'Recorded from a live run' : h.generatedAt ? `${h.status === 'partial' ? 'Partial · ' : ''}${formatDateTimeIst(h.generatedAt)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.kind === 'idle' ? (
        <>
          <EmptyState title="Start with a company." meta={dataMode === 'fixture' ? 'Demo mode: only reports recorded from earlier live runs are available.' : 'Live mode: any NSE symbol that can be verified.'}>
            FINN first confirms which listed company you mean, then retrieves its results filings, recent earnings-call transcripts, the latest annual report and a presentation from exchange and company sources, and builds each section only from what those documents say.
          </EmptyState>
          {suggestions.length ? (
            <div className={styles.suggestions}>
              <span className={styles.label}>Research list</span>
              {suggestions.map((s) => (
                <Button key={s.id} size="sm" variant="secondary" onClick={() => void openCompany(s)} title={s.name}>
                  {s.symbol}
                </Button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {state.kind === 'resolving' ? (
        <p className={styles.resolving} role="status">
          Confirming which listed company “{state.ticker}” refers to…
        </p>
      ) : null}

      {state.kind === 'rejected' && state.errorKind === 'no_demo_report' ? (
        <Banner tone="demo" title="No recorded report for this company">
          {state.message}
          {history.length ? (
            <span className={styles.candidates}>
              {history.map((h) => (
                <Button key={h.company.id} size="sm" onClick={() => void openCompany(h.company)}>
                  {h.company.symbol} · {h.company.name}
                </Button>
              ))}
            </span>
          ) : null}
        </Banner>
      ) : null}

      {state.kind === 'rejected' && state.errorKind !== 'no_demo_report' ? (
        <Banner
          tone={['not_found', 'ambiguous', 'unverifiable', 'invalid_input'].includes(state.errorKind) ? 'warning' : 'error'}
          title={state.candidates?.length ? 'More than one company matches' : state.errorKind === 'not_found' || state.errorKind === 'invalid_input' ? 'Company not found' : state.errorKind === 'unverifiable' ? 'Company not verified' : 'Research could not start'}
        >
          {state.message}
          {state.candidates?.length ? (
            <span className={styles.candidates}>
              {state.candidates.map((c) => (
                <Button key={c.id} size="sm" onClick={() => c.nseSymbol && void run(c.nseSymbol)} disabled={!c.nseSymbol}>
                  {c.nseSymbol ?? c.id} · {c.name}
                </Button>
              ))}
            </span>
          ) : null}
        </Banner>
      ) : null}

      {job ? (
        <>
          <div className={styles.returnBar}>
            <span className={styles.current}>
              <span className={styles.currentSymbol}>{job.company.symbol}</span>
              <span className={styles.currentName}>{job.company.name}</span>
            </span>
            <Button size="sm" variant="quiet" icon="search" onClick={backToSearch}>
              Change company
            </Button>
          </div>
          {job.demo ? (
            <Banner tone="demo" title="Recorded demo report">
              Recorded {formatDateTimeIst(job.demo.recordedAt)} from a live run against exchange filings. Every figure and quote links to the original BSE document. It is not refreshed in demo mode.
            </Banner>
          ) : null}
          {state.kind === 'job' && state.stored && report ? (
            <Banner
              tone="info"
              title="Stored report"
              action={
                <Button size="sm" onClick={() => void run(job.company.id, job.company.symbol)}>
                  Run again
                </Button>
              }
            >
              Generated {formatDateTimeIst(report.generatedAt)} and saved on this server. Run again to check for newer filings.
            </Banner>
          ) : null}
          {!job.demo && !(state.kind === 'job' && state.stored) ? <StageTracker job={job} pollError={state.kind === 'job' ? state.pollError : null} /> : null}
          {job.status === 'failed' ? (
            <Banner tone="error" title="Research failed">
              {job.error ?? 'Research did not finish.'} No report is shown, because a report built from part of the run could not be checked as a whole.
            </Banner>
          ) : null}
          {report ? <ReportView report={report} cached={job.cached} /> : null}
        </>
      ) : null}
    </div>
  );
}
