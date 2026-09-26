import type { HTMLAttributes, ReactNode } from 'react';
import type { StatusRole } from '@boxalarm/design-tokens';
import { STATUS_ICON } from './icons';
import styles from './Chip.module.css';

interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  status: StatusRole;
  /** The word — always shown; colour and glyph are never the sole carrier (N7.1). */
  children: ReactNode;
}

/** Colour + glyph + word, per docs/design.md §2.3 / docs/a11y-spec.md §1.8. Never render a
 * status with colour alone — every call site supplies the word as `children`.
 *
 * Fill/label use the opaque `--bx-chip-fill-*` / `--bx-chip-onfill-*` pairs (a11y-spec.md §1.2),
 * not the status hue on a translucent tint of itself — a translucent fill's rendered contrast
 * depends on whatever surface the chip sits on, which measured below AA on Cards and hovered
 * DataTable rows (MAJOR-6). The opaque pair is a fixed, tested ratio regardless of placement. */
export function StatusChip({ status, children, className, style, ...rest }: StatusChipProps) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={[styles.chip, className].filter(Boolean).join(' ')}
      style={{
        color: `var(--bx-chip-onfill-${status})`,
        background: `var(--bx-chip-fill-${status})`,
        ...style,
      }}
      data-status={status}
      {...rest}
    >
      <Icon size={13} aria-hidden="true" />
      {children}
    </span>
  );
}

export function Badge({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={[styles.badge, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </span>
  );
}
