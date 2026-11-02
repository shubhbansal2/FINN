'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import styles from './Dialog.module.css';

type DialogProps = {
  open: boolean;
  onClose: () => void;
  /** `drawer`: right panel on wide screens, bottom sheet on compact. `center`: modal. `palette`: top-anchored. */
  variant?: 'drawer' | 'center' | 'palette';
  /** id of the element that names the dialog. */
  labelledBy: string;
  describedBy?: string;
  /** Element to focus on open; defaults to the first focusable element. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Set false for dialogs where a stray backdrop tap must not dismiss (confirmations). */
  closeOnBackdrop?: boolean;
  /** `alertdialog` for confirmations that interrupt the user. */
  role?: 'dialog' | 'alertdialog';
  /** False blocks Escape and backdrop dismissal, e.g. while a confirmed action is running. */
  dismissible?: boolean;
  children: ReactNode;
};

/**
 * Thin wrapper over the native <dialog> element. `showModal()` gives us focus
 * containment, an inert background, Escape-to-close, and focus restoration on
 * close, without a focus-trap dependency.
 *
 * The element is portalled to <body>, so a dialog owned by an inline control
 * (a citation inside a paragraph) never ends up nested in phrasing content.
 * Nothing renders on the server; dialogs are closed on first paint anyway.
 */
export function Dialog({
  open,
  onClose,
  variant = 'center',
  labelledBy,
  describedBy,
  initialFocusRef,
  closeOnBackdrop = true,
  role,
  dismissible = true,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const closingFromProp = useRef(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      initialFocusRef?.current?.focus();
    } else if (!open && dialog.open) {
      // The parent already knows; don't echo this close back through onClose.
      closingFromProp.current = true;
      dialog.close();
    }
  }, [open, initialFocusRef, mounted]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Fires for Escape, form[method=dialog] submits and programmatic close().
    const handleClose = () => {
      if (closingFromProp.current) {
        closingFromProp.current = false;
        return;
      }
      onClose();
    };
    // Escape fires `cancel` first; blocking it keeps the dialog open while dismissal is not allowed.
    const handleCancel = (event: Event) => {
      if (!dismissible) event.preventDefault();
    };
    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('cancel', handleCancel);
    };
  }, [onClose, dismissible, mounted]);

  if (!mounted) return null;

  return createPortal(
    <dialog
      ref={ref}
      className={`${styles.dialog} ${styles[variant]}`}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      role={role === 'alertdialog' ? 'alertdialog' : undefined}
      onClick={(event) => {
        // A click whose target is the <dialog> itself landed on the backdrop area.
        if (closeOnBackdrop && dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.panel}>{children}</div>
    </dialog>,
    document.body,
  );
}
