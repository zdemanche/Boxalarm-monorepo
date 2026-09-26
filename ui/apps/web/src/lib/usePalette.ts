import { useCallback, useEffect, useState } from 'react';

export type Palette = 'day' | 'cab';

const STORAGE_KEY = 'bx-palette';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredPalette(): Palette | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'day' || stored === 'cab' ? stored : null;
  } catch {
    return null;
  }
}

function systemPalette(): Palette {
  try {
    return window.matchMedia?.(DARK_QUERY).matches ? 'cab' : 'day';
  } catch {
    return 'day';
  }
}

/** Office defaults to `day`, field defaults to `cab` (docs/design.md §1) — both surfaces let
 * the user switch. Web has no field/office distinction of its own: with no stored choice the
 * CSS follows `prefers-color-scheme` (tokens.ts), so the returned palette is the *effective*
 * one — the stored choice, else the OS scheme. Returning the stored value alone (null when
 * unset) made the toggle read "Switch to cab palette" while cab was already showing
 * (PR #321 review m5). */
export function usePalette(): [Palette, (next: Palette) => void] {
  const [stored, setStored] = useState<Palette | null>(() => readStoredPalette());
  const [system, setSystem] = useState<Palette>(() => systemPalette());

  useEffect(() => {
    if (stored) {
      document.documentElement.setAttribute('data-palette', stored);
    } else {
      document.documentElement.removeAttribute('data-palette');
    }
  }, [stored]);

  useEffect(() => {
    if (stored || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystem(query.matches ? 'cab' : 'day');
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, [stored]);

  const setPalette = useCallback((next: Palette) => {
    setStored(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Per-viewer convenience only; a private window or blocked storage just means the
      // choice doesn't persist across reloads.
    }
  }, []);

  return [stored ?? system, setPalette];
}
