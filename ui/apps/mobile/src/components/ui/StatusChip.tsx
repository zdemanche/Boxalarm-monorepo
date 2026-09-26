import { typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { Text, View } from 'react-native';
import { useTheme } from './theme';

// Text glyphs, not an icon library — no react-native-svg dependency to link natively in this
// repo (CI here has no Xcode/Android SDK to build against). Shape, not colour, still carries
// the meaning alongside the word, per docs/design.md §2.3.
const STATUS_GLYPH: Record<StatusRole, string> = {
  ok: '●',
  warning: '◐',
  caution: '▲',
  danger: '⊠',
  info: '⬆',
  neutral: '○',
};

interface StatusChipProps {
  status: StatusRole;
  label: string;
}

export function StatusChip({ status, label }: StatusChipProps) {
  const theme = useTheme();
  const color = theme.status[status];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: color,
      }}
    >
      <Text style={{ color, fontSize: typeScale.label.size }} accessible={false}>
        {STATUS_GLYPH[status]}
      </Text>
      <Text style={{ color, fontSize: typeScale.label.size, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}
