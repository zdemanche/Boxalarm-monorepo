import {
  statusPalette,
  surfacePalette,
  type StatusColors,
  type StatusRole,
  type SurfaceColors,
} from '@boxalarm/design-tokens';
import { useColorScheme } from 'react-native';

export type SurfaceTheme = SurfaceColors & { status: StatusColors };

/** The OS scheme is the only switch available on native today (no manual override control
 * exists yet on this surface): `dark` -> `cab`, anything else -> `day`. An unknown (null)
 * scheme resolves to `day`, the same as every screen still on the legacy
 * `scheme === 'dark' ? palette.cab : palette.day` selection, so the tab bar and the screen
 * under it can never disagree (PR #321 review m5). */
export function useTheme(): SurfaceTheme {
  const scheme = useColorScheme();
  const palette = scheme === 'dark' ? 'cab' : 'day';
  return { ...surfacePalette[palette], status: statusPalette[palette] };
}

export function statusColor(theme: SurfaceTheme, role: StatusRole): string {
  return theme.status[role];
}
