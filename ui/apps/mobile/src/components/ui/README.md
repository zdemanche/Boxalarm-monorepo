# Boxalarm mobile component library — "Command console" (field posture)

Import from `../components/ui`. Every component reads colour from `useTheme()`
(`@boxalarm/design-tokens`'s `surfacePalette`/`statusPalette`) rather than a literal — `cab` on a
dark OS scheme, `day` otherwise (no manual override on native yet). No webfont: native uses the
platform default face via `typeScale`'s sizes/weights.

Field posture is glove-sized by default — `Button`'s `field` size is the 56dp floor
(`targetSize.field`); its `alert` size is the 72dp alert-path floor.

## useTheme / statusColor

```tsx
const theme = useTheme(); // { bg, surface, surfaceRaised, fg, fgMuted, fgFaint, border,
                           //   borderStrong, borderDecorative, focus, focusGap, scrim,
                           //   skeleton, status: { ok, warning, caution, danger, info, neutral } }
```

## Screen

```tsx
<Screen>
  <Text>...</Text>
</Screen>
```

Safe-area + palette background + `spacing.lg` padding. Pass `scroll={false}` for a screen that
manages its own scrolling (e.g. a `FlatList`).

## Button

```tsx
<Button label="Send test alert" onPress={handleSelfTest} loading={sending} fullWidth />
<Button label="Report a defect" variant="secondary" onPress={openDefect} />
```

Props: `variant?: 'primary' | 'secondary' | 'danger'`, `size?: 'field' | 'alert'`, `disabled?`,
`loading?`, `fullWidth?`.

## Card / Stat

```tsx
<Card title="Today's shifts">...</Card>
<Stat label="Apparatus in service" value="4 / 5" alarm={outOfService > 0} />
```

## StatusChip

```tsx
<StatusChip status="ok" label="In service" />
<StatusChip status="danger" label="Out of service" />
```

`status: 'ok' | 'warning' | 'caution' | 'danger' | 'info' | 'neutral'`. Glyph + word + colour,
never colour alone (docs/design.md §2.3) — rendered as a text glyph rather than an icon library,
since this repo has no `react-native-svg` link step to verify in CI (no Xcode/Android SDK here).
