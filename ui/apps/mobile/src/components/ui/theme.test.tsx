import { palette } from '@boxalarm/design-tokens';
import { renderHook } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { useTheme } from './theme';

// The legacy screens pick `scheme === 'dark' ? palette.cab : palette.day`; useTheme must resolve
// every scheme the same way so the tab bar and the screen beneath it agree (PR #321 m5).
const legacyPick = (scheme: ReactNative.ColorSchemeName) =>
  scheme === 'dark' ? palette.cab : palette.day;

test.each(['light', 'dark', null, undefined] as ReactNative.ColorSchemeName[])(
  'useTheme matches the legacy palette pick for scheme %p',
  async (scheme) => {
    const spy = jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
    const { result } = await renderHook(() => useTheme());
    expect(result.current.bg).toBe(legacyPick(scheme).background);
    spy.mockRestore();
  },
);
