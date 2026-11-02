import styles from './Provenance.module.css';

/**
 * Where a value or view came from. Every data-bearing surface shows one of
 * these when it is anything other than a verified, live, reported figure.
 */
export type ProvenanceKind = 'live' | 'cached' | 'stale' | 'demo' | 'derived' | 'unverified' | 'inference';

const LABEL: Record<ProvenanceKind, string> = {
  live: 'Live',
  cached: 'Cached',
  stale: 'Stale',
  demo: 'Demo data',
  derived: 'Derived',
  unverified: 'Unverified',
  inference: 'Analysis',
};

const DESCRIPTION: Record<ProvenanceKind, string> = {
  live: 'Fetched from the provider in the latest successful run.',
  cached: 'Served from the last successful fetch.',
  stale: 'Older than the expected update interval.',
  demo: 'Recorded fixture, not current market data.',
  derived: 'Computed by FINN from reported figures.',
  unverified: 'Failed or has not passed FINN’s consistency checks.',
  inference: 'FINN’s analytical inference, not a sourced statement.',
};

type ProvenanceProps = {
  kind: ProvenanceKind;
  /** Extra context appended to the tooltip, e.g. the formula or age. */
  detail?: string;
};

export function Provenance({ kind, detail }: ProvenanceProps) {
  const description = detail ? `${DESCRIPTION[kind]} ${detail}` : DESCRIPTION[kind];
  return (
    <span className={`${styles.root} ${styles[kind]}`} title={description}>
      {LABEL[kind]}
      <span className="visually-hidden">: {description}</span>
    </span>
  );
}
