'use client';

import { useId, useRef } from 'react';

import { Dialog } from './Dialog';
import { CLAIM_NATURE_LABEL, highlightQuote, safeDocumentUrl, type Evidence } from './evidence';
import { Icon } from './Icon';
import { Provenance } from './Provenance';
import { Timestamp } from './Timestamp';
import styles from './EvidenceDrawer.module.css';

type EvidenceDrawerProps = {
  evidence: Evidence;
  open: boolean;
  onClose: () => void;
};

/**
 * Shows the exact passage behind a figure or claim. Passage text is rendered as
 * React text nodes only; filing content is never interpreted as markup.
 */
export function EvidenceDrawer({ evidence, open, onClose }: EvidenceDrawerProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const passage = highlightQuote(evidence.passageText, evidence.quote);
  const pdfUrl = safeDocumentUrl(evidence.pdfUrl, evidence.page);

  return (
    <Dialog open={open} onClose={onClose} variant="drawer" labelledBy={titleId} initialFocusRef={closeRef}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <p className={styles.kicker}>
            Source · {evidence.documentKind}
            {evidence.fiscalLabel ? ` · ${evidence.fiscalLabel}` : ''}
          </p>
          <h2 id={titleId} className={styles.title}>
            {evidence.documentTitle}
          </h2>
        </div>
        <button ref={closeRef} type="button" className={styles.close} onClick={onClose} aria-label="Close source">
          <Icon name="close" />
        </button>
      </header>

      <dl className={styles.facts}>
        <div>
          <dt>Page</dt>
          <dd className="num">{evidence.page}</dd>
        </div>
        {evidence.filedAtIso ? (
          <div>
            <dt>Filed</dt>
            <dd>
              <Timestamp iso={evidence.filedAtIso} precision="date" />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Extraction</dt>
          <dd>{evidence.extractionMethod}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd className={styles.badges}>
            {evidence.verification === 'verified' ? <span className={styles.verified}>{evidence.verifiedLabel ?? 'Quote verified'}</span> : <Provenance kind="unverified" />}
            {evidence.dataMode === 'demo' ? <Provenance kind="demo" /> : null}
          </dd>
        </div>
      </dl>

      <div className={styles.body}>
        {evidence.claim ? (
          <div className={styles.claim}>
            <p className={styles.claimKind}>
              Supports · <span className={styles[evidence.claim.kind]}>{CLAIM_NATURE_LABEL[evidence.claim.kind].label}</span>
            </p>
            <p className={styles.claimText}>{evidence.claim.text}</p>
            <p className={styles.claimNote}>{CLAIM_NATURE_LABEL[evidence.claim.kind].description}</p>
          </div>
        ) : null}
        {evidence.reported ? (
          <dl className={styles.reported} aria-label="Reported value">
            <div>
              <dt>As printed</dt>
              <dd className="num">{evidence.reported.printed}</dd>
            </div>
            <div>
              <dt>Stated unit</dt>
              <dd>{evidence.reported.scaleLabel}</dd>
            </div>
            <div>
              <dt>Shown as</dt>
              <dd className="num">{evidence.reported.normalized}</dd>
            </div>
            <div>
              <dt>Period · basis</dt>
              <dd>
                {evidence.reported.period} · {evidence.reported.basis}
              </dd>
            </div>
          </dl>
        ) : null}
        <p className={styles.passageLabel}>Passage, page {evidence.page}</p>
        <blockquote className={styles.passage}>
          {passage.found ? (
            <>
              {passage.before}
              <mark>{passage.match}</mark>
              {passage.after}
            </>
          ) : (
            passage.text
          )}
        </blockquote>
        {evidence.quote && !passage.found ? (
          <p className={styles.notice} role="note">
            The cited span could not be located in this passage. Treat the claim as unverified.
          </p>
        ) : null}
      </div>

      <footer className={styles.footer}>
        {pdfUrl ? (
          <a className={styles.open} href={pdfUrl} target="_blank" rel="noopener noreferrer">
            Open document at page {evidence.page}
            <Icon name="external" size={16} />
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : (
          <p className={styles.noLink}>Original document link unavailable.</p>
        )}
      </footer>
    </Dialog>
  );
}
