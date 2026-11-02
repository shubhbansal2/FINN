'use client';

import type { JobView } from './ResearchWorkspace';
import styles from './StageTracker.module.css';

const STAGES = [
  { key: 'retrieving', label: 'Retrieving sources' },
  { key: 'extracting', label: 'Extracting documents' },
  { key: 'validating', label: 'Validating financial facts' },
  { key: 'analysing', label: 'Preparing analysis' },
] as const;

const OUTCOME = { running: null, complete: 'Complete', partial: 'Partially complete', failed: 'Failed' } as const;

export const SOURCE_STATE_LABEL: Record<JobView['sources'][number]['state'], string> = {
  used: 'Used',
  download_failed: 'Download failed',
  no_text: 'No readable text',
  extraction_failed: 'Extraction failed',
  not_attempted: 'Not attempted',
};

type StepState = 'done' | 'current' | 'pending' | 'failed';

/**
 * Where a research run is. Stages come from the engine's own progress events;
 * nothing here is a timer or an estimate.
 */
export function StageTracker({ job, pollError }: { job: JobView; pollError: string | null }) {
  const currentIndex = job.stage ? STAGES.findIndex((s) => s.key === job.stage) : -1;
  const stepState = (i: number): StepState => {
    if (job.status === 'complete' || job.status === 'partial') return 'done';
    if (i < currentIndex) return 'done';
    if (i === Math.max(currentIndex, 0)) return job.status === 'failed' ? 'failed' : 'current';
    return 'pending';
  };
  const lastMessage = (key: string) => [...job.log].reverse().find((l) => l.stage === key)?.message ?? null;
  const outcome = OUTCOME[job.status];
  const used = job.sources.filter((s) => s.state === 'used').length;

  return (
    <section className={styles.root} aria-labelledby="research-status">
      <div className={styles.head}>
        <h2 id="research-status" className={styles.title}>
          Research status
        </h2>
        <p className={`${styles.outcome} ${styles[job.status]}`} role="status" aria-live="polite">
          {outcome ?? `${STAGES[Math.max(currentIndex, 0)]?.label ?? 'Starting'}…`}
        </p>
      </div>
      <ol className={styles.steps}>
        {STAGES.map((s, i) => {
          const st = stepState(i);
          const msg = st === 'pending' ? null : lastMessage(s.key);
          return (
            <li key={s.key} className={`${styles.step} ${styles[st]}`} aria-current={st === 'current' ? 'step' : undefined}>
              <span className={styles.marker} aria-hidden="true" />
              <span className={styles.stepLabel}>
                {s.label}
                <span className="visually-hidden">{st === 'done' ? ', done' : st === 'current' ? ', in progress' : st === 'failed' ? ', failed' : ', not started'}</span>
              </span>
              {msg ? <span className={styles.message}>{msg}</span> : null}
            </li>
          );
        })}
      </ol>
      {pollError ? <p className={styles.warn}>{pollError}</p> : null}
      {job.sources.length ? (
        <details className={styles.sources} open={job.status === 'running'}>
          <summary>
            Sources processed: {job.sources.length} · {used} used
          </summary>
          <ul>
            {job.sources.map((s) => (
              <li key={s.documentId} className={styles.source}>
                <span className={`${styles.state} ${s.state === 'used' ? styles.ok : styles.bad}`}>{SOURCE_STATE_LABEL[s.state]}</span>
                <span className={styles.sourceTitle}>
                  {s.title}
                  {s.detail ? <span className={styles.detail}> · {s.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {job.status === 'running' ? <p className={styles.hint}>The report appears once every section has been checked against its sources. A first run downloads several filings and can take a minute or two.</p> : null}
    </section>
  );
}
