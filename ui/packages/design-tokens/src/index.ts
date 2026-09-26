export const palette = {
  day: {
    background: '#ffffff',
    foreground: '#101114',
    // Deepened from the original #C77D28/#1F8A4C/#B8860B (which only cleared the 3:1 large-text
    // bar) so every semantic color clears 4.5:1 normal-text AA unconditionally - several screens
    // use these as small/regular-weight status labels, not just large headers or button fills.
    accent: '#A56721',
    error: '#C41E3A',
    success: '#1E864A',
    warning: '#976E09',
  },
  cab: {
    background: '#0b0b0d',
    foreground: '#d6d8dd',
    accent: '#E8A94A',
    error: '#E05252',
    success: '#4CAF6D',
    warning: '#F0B860',
  },
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 } as const;

// Generous line-height (>= 1.4) for outdoor-glare and low-light legibility, per N7.3.
export const typography = {
  size: { xs: 12, sm: 14, base: 16, lg: 20, xl: 24, xxl: 32, display: 40 },
  lineHeight: 1.4,
} as const;

// N3.5 baseline: 44x44pt (iOS) / 48x48dp (Android). Oversized applies to the truck-check
// runner and alert-response screens specifically, per architecture.md's explicit callout
// that those are used gloved and in a moving vehicle.
export const touchTarget = {
  baseline: { ios: 44, android: 48 },
  oversized: { ios: 56, android: 60 },
} as const;

export const radius = { default: 8, card: 12 } as const;

export const elevation = {
  level0: { shadowOpacity: 0, shadowRadius: 0, androidElevation: 0 },
  level1: { shadowOpacity: 0.08, shadowRadius: 4, androidElevation: 2 },
  level2: { shadowOpacity: 0.16, shadowRadius: 12, androidElevation: 6 },
} as const;

// Sizes only — the icon set itself (Phosphor) is added where it's first consumed, since it
// pulls in react-native-svg as a peer dependency requiring native linking.
export const iconSize = { sm: 16, md: 24, lg: 32 } as const;

export type PaletteName = keyof typeof palette;

// Widened shape of a single resolved palette (palette.day or palette.cab) — use this, not
// `typeof palette.day`, whenever a value is chosen at runtime (e.g. `scheme === 'dark' ?
// palette.cab : palette.day`), since that expression's type is a union of both literal palette
// types, not either one alone.
export type PaletteColors = Record<keyof (typeof palette)['day'], string>;

// "Command console" design system additions (docs/design.md §2, docs/a11y-spec.md §1.1-1.2).
// Additive only — `palette` and `spacing` above keep their original shape and values so the
// pre-existing component and its tests don't break. Every ratio below is verified in
// index.test.ts against `meetsAA` rather than asserted in a comment.
export const surfacePalette = {
  cab: {
    bg: palette.cab.background,
    surface: '#16171a',
    surfaceRaised: '#1f2126',
    fg: palette.cab.foreground,
    fgMuted: '#a3a8b2',
    fgFaint: '#7c828d',
    border: '#6b7078',
    borderStrong: '#9aa0aa',
    borderDecorative: '#2a2d33',
    focus: '#ffd166',
    focusGap: palette.cab.background,
    scrim: 'rgba(0,0,0,0.72)',
    skeleton: '#2a2d33',
  },
  day: {
    bg: palette.day.background,
    surface: '#f4f5f7',
    surfaceRaised: '#eceef1',
    fg: palette.day.foreground,
    fgMuted: '#4d525b',
    fgFaint: '#5b616b',
    border: '#767b85',
    borderStrong: '#4d525b',
    borderDecorative: '#e4e6ea',
    focus: '#101114',
    focusGap: palette.day.background,
    scrim: 'rgba(16,17,20,0.55)',
    skeleton: '#e4e6ea',
  },
} as const;

export const statusPalette = {
  cab: {
    danger: '#ff6b5e',
    warning: '#ffc247',
    caution: '#ff9b3d',
    ok: '#5ddb8a',
    info: '#7cc4ff',
    neutral: '#a3a8b2',
  },
  day: {
    danger: '#c02418',
    warning: '#6f4c00',
    caution: '#8a4a00',
    ok: '#0f6c34',
    info: '#0b57d0',
    neutral: '#4d525b',
  },
} as const;

export type StatusRole = keyof (typeof statusPalette)['day'];

// Widened shapes, same rationale as `PaletteColors` above: use these, not `typeof
// surfacePalette.day` / `typeof statusPalette.day`, whenever a palette is chosen at runtime.
export type SurfaceColors = Record<keyof (typeof surfacePalette)['day'], string>;
export type StatusColors = Record<StatusRole, string>;

// Opaque chip fill/label pairs, taken verbatim from a11y-spec.md §1.2's approved chip table
// (each pair independently clears 7.6:1+ label:fill). `StatusChip` was previously drawing
// `statusPalette` text on a `color-mix(status 14%, transparent)` background composited over
// whatever surface it sat on - on the day palette that dropped as low as 4.14:1 on a hovered
// DataTable row, below the 4.5:1 AA floor, despite the PR's "AA by construction" claim. These
// fills are fully opaque, so label:fill contrast holds regardless of what's behind the chip;
// the spec deliberately allows fill-vs-page contrast to be low (1.1-1.8:1) because the chip's
// boundary is carried by `surfacePalette.border`, never by the fill. a11y-spec's table has one
// row for "Pending / warn / offline" - both `warning` and `caution` map onto it, since the doc
// doesn't distinguish a separate caution tier.
export const statusChipPalette = {
  cab: {
    ok: { fill: '#0c3f22', onFill: '#d6f5e2' },
    danger: { fill: '#7a1109', onFill: '#ffe9e6' },
    warning: { fill: '#4a3300', onFill: '#ffeec2' },
    caution: { fill: '#4a3300', onFill: '#ffeec2' },
    info: { fill: '#0a2c4a', onFill: '#d9ecff' },
    neutral: { fill: '#26282e', onFill: '#d6d8dd' },
  },
  day: {
    ok: { fill: '#e3f5ea', onFill: '#0b4f26' },
    danger: { fill: '#fde7e5', onFill: '#8c1a10' },
    warning: { fill: '#fdf0d5', onFill: '#5a3d00' },
    caution: { fill: '#fdf0d5', onFill: '#5a3d00' },
    info: { fill: '#e5efff', onFill: '#0a459f' },
    neutral: { fill: '#eceef1', onFill: '#33383f' },
  },
} as const;

export type StatusChipColors = Record<StatusRole, { fill: string; onFill: string }>;

export const typeScale = {
  display: { size: 28, lineHeight: 34, weight: 700 },
  title: { size: 22, lineHeight: 30, weight: 700 },
  heading: { size: 18, lineHeight: 26, weight: 600 },
  subheading: { size: 15, lineHeight: 22, weight: 600 },
  body: { size: 15, lineHeight: 22, weight: 400 },
  bodyDense: { size: 13, lineHeight: 18, weight: 400 },
  label: { size: 13, lineHeight: 18, weight: 600 },
  caption: { size: 12, lineHeight: 16, weight: 400 },
  mono: { size: 13, lineHeight: 18, weight: 500 },
} as const;

// Extends the existing five-step `spacing` scale without altering it (docs/design.md §2.5).
export const spacingScale = {
  '2xs': 2,
  xs: spacing.xs,
  sm: spacing.sm,
  md: spacing.md,
  lg: spacing.lg,
  xl: spacing.xl,
  '2xl': 64,
  '3xl': 96,
} as const;

export const radiusScale = { none: 0, sm: 4, md: 8, lg: 12, pill: 999 } as const;

export const elevationShadow = {
  raised: { day: '0 1px 2px rgba(16,17,20,0.10)', cab: 'none' },
  overlay: { day: '0 8px 24px rgba(16,17,20,0.18)', cab: 'none' },
} as const;

export const motion = {
  duration: { instant: 0, fast: 120, base: 200, slow: 320 },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0, 1)',
    accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  },
} as const;

export const targetSize = { office: 44, field: 56, gap: 8 } as const;

export const breakpoints = { xs: 0, sm: 480, md: 768, lg: 1024, xl: 1440, xxl: 1920 } as const;

// System fonts only — no webfont, no remote asset (design.md §2.4: "Font stacks — system only, no
// webfont, no remote asset"). Both surfaces render off the platform's default UI/monospace faces;
// nothing here is ever linked as a webfont, self-hosted or otherwise, on web or native.
export const fontStack = {
  ui: '-apple-system, "SF Pro Text", Roboto, "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, monospace',
} as const;
