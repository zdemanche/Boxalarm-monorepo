import styles from './Skeleton.module.css';

interface SkeletonProps {
  lines?: number;
}

/** Matches the final layout shape rather than a bare spinner (Moonaan standard). Static, not
 * shimmering — an animated skeleton carries no information the reduced-motion alternative
 * would need to replace, so there is nothing to gate on prefers-reduced-motion here. */
export function Skeleton({ lines = 3 }: SkeletonProps) {
  // The bars are decorative and hidden from assistive tech; the visually-hidden status text is
  // what a screen reader hears. aria-hidden on the busy region itself used to hide the loading
  // state entirely (PR #321 review m8).
  return (
    <div aria-busy="true">
      <span role="status" className={styles.srOnly}>
        Loading…
      </span>
      <div aria-hidden="true">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className={styles.line} />
        ))}
      </div>
    </div>
  );
}

export function SkeletonBlock({ height = 120 }: { height?: number }) {
  return <div aria-hidden="true" className={styles.block} style={{ height }} />;
}
