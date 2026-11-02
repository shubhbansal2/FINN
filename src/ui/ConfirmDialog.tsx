'use client';

import { useId, useRef } from 'react';

import { Button } from './Button';
import { Dialog } from './Dialog';
import styles from './ConfirmDialog.module.css';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  /** Plain statement of the consequence: what changes, and whether it can be undone. */
  consequence: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for destructive or costly actions. */
  tone?: 'default' | 'danger';
  /** True while the confirmed action runs; keeps the dialog open and blocks re-submits. */
  busy?: boolean;
  busyLabel?: string;
  /** Error from the last attempt, shown inline; the dialog stays open so the user can retry. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirmation for actions with consequences. Focus starts on Cancel so a
 * reflexive Enter never triggers the action; backdrop taps do not dismiss.
 */
export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  busyLabel,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      dismissible={!busy}
      variant="center"
      labelledBy={titleId}
      describedBy={bodyId}
      initialFocusRef={cancelRef}
      closeOnBackdrop={false}
      role="alertdialog"
    >
      <div className={styles.body}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p id={bodyId} className={styles.consequence}>
          {consequence}
        </p>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className={styles.actions}>
        <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} loadingLabel={busyLabel}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
