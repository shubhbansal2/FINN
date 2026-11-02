'use client';

import { useCallback, useState } from 'react';

import type { Evidence } from './evidence';
import { EvidenceDrawer } from './EvidenceDrawer';
import { Icon } from './Icon';
import styles from './Citation.module.css';

type CitationProps = {
  evidence: Evidence;
  /** Short visible label, e.g. "Q2 FY27 results, p.3". */
  label: string;
};

/**
 * Inline source reference. Opens the evidence drawer with the passage behind
 * the claim. Unverified sources are visibly distinct (dashed, warning ink).
 */
export function Citation({ evidence, label }: CitationProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const unverified = evidence.verification === 'unverified';

  return (
    <>
      <button
        type="button"
        className={`${styles.cite} ${unverified ? styles.unverified : ''}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="document" size={12} />
        <span>{label}</span>
        <span className="visually-hidden">
          {unverified ? ', unverified source' : ''}. Show source passage
        </span>
      </button>
      {/* Kept mounted so <dialog>.close() runs and focus returns to this button. */}
      <EvidenceDrawer evidence={evidence} open={open} onClose={close} />
    </>
  );
}
