import { radius, targetSize, typeScale } from '@boxalarm/design-tokens';
import {
  ActivityIndicator,
  Text,
  TouchableOpacity,
  type GestureResponderEvent,
} from 'react-native';
import { useTheme } from './theme';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'field' | 'alert';

interface ButtonProps {
  label: string;
  onPress: (event: GestureResponderEvent) => void;
  variant?: ButtonVariant;
  /** 'field' = the 56dp glove-sized floor; 'alert' = the 72dp alert-path floor
   * (docs/a11y-spec.md §1.11 target-size tokens). */
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
}

const SIZE_HEIGHT: Record<ButtonSize, number> = { field: targetSize.field, alert: 72 };

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'field',
  disabled = false,
  loading = false,
  fullWidth = false,
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const background =
    variant === 'primary' ? theme.fg : variant === 'danger' ? theme.status.danger : 'transparent';
  const border = variant === 'secondary' ? theme.borderStrong : background;
  const labelColor = variant === 'secondary' ? theme.fg : theme.bg;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={{
        minHeight: SIZE_HEIGHT[size],
        width: fullWidth ? '100%' : undefined,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
        paddingHorizontal: 20,
        borderRadius: radius.default,
        backgroundColor: background,
        borderWidth: variant === 'secondary' ? 1 : 0,
        borderColor: border,
        opacity: isDisabled ? 0.45 : 1,
      }}
    >
      {loading ? <ActivityIndicator color={labelColor} /> : null}
      <Text
        style={{
          color: labelColor,
          fontSize: typeScale.label.size,
          fontWeight: '700',
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}
