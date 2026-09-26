import { useEffect, useState, type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Button } from './Button';
import styles from './Dialog.module.css';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content className={styles.content}>
          <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className={styles.description}>
              {description}
            </RadixDialog.Description>
          ) : null}
          {children}
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the object and the consequence — docs/design.md §4.5. */
  title: string;
  consequence: string;
  confirmLabel: string;
  /** May return a Promise (e.g. a mutation) for an async destructive action. While it's pending,
   * the confirm button shows Button's `loading` state (never native `disabled` — MAJOR-5) and
   * Cancel/Escape/overlay-click are blocked so the dialog can't be dismissed mid-request. On
   * success the dialog closes; on rejection it stays open and shows the error inline instead of
   * closing blind. A plain synchronous `onConfirm` (returning void) keeps the original
   * call-then-close-immediately behaviour unchanged. */
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
}

/** Irreversible, high-blast-radius confirmation (§4.5). No password/step-up prompt is ever
 * added here — Cedar role check alone gates the action, per the product's settled auth model. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel,
  onConfirm,
  danger = false,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start each fresh open with no stale pending/error state from a previous attempt.
  useEffect(() => {
    if (open) {
      setPending(false);
      setError(null);
    }
  }, [open]);

  const handleConfirm = () => {
    setError(null);
    const result = onConfirm();
    if (result && typeof (result as Promise<void>).then === 'function') {
      setPending(true);
      (result as Promise<void>)
        .then(() => {
          setPending(false);
          onOpenChange(false);
        })
        .catch((err: unknown) => {
          setPending(false);
          setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
        });
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
      title={title}
      description={consequence}
      footer={
        <>
          {error ? (
            <p
              role="alert"
              style={{ color: 'var(--bx-status-danger)', marginRight: 'auto', fontSize: 13 }}
            >
              {error}
            </p>
          ) : null}
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={handleConfirm} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
