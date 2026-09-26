import { spacing } from '@boxalarm/design-tokens';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from './theme';

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
}

/** Common screen chrome — safe area + ground colour from the active palette. Field posture: no
 * side gutter smaller than `spacing.lg` (docs/design.md §1 spacing rhythm). */
export function Screen({ children, scroll = true }: ScreenProps) {
  const theme = useTheme();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      {scroll ? (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, flexGrow: 1 }}>
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, padding: spacing.lg }}>{children}</View>
      )}
    </SafeAreaView>
  );
}
