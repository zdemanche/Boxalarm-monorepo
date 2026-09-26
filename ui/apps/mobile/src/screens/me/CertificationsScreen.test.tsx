import { render } from '@testing-library/react-native';
import { palette } from '@boxalarm/design-tokens';
import { CertificationsScreen } from './CertificationsScreen';

test('lists each certification with its type and status', async () => {
  const { findByText, findAllByText } = await render(<CertificationsScreen />);

  expect(await findByText('FF1')).toBeTruthy();
  expect((await findAllByText('Current')).length).toBeGreaterThan(0);
  expect(await findByText('Hazmat Ops')).toBeTruthy();
  expect(await findByText('Expired')).toBeTruthy();
});

test('an expired certification renders its status in the error color', async () => {
  const { findByText } = await render(<CertificationsScreen />);

  const expiredLabel = await findByText('Expired');
  expect(expiredLabel).toHaveStyle({ color: palette.day.error });
});

test('a current certification renders its status in the success color', async () => {
  const { findAllByText } = await render(<CertificationsScreen />);

  const [currentLabel] = await findAllByText('Current');
  expect(currentLabel).toHaveStyle({ color: palette.day.success });
});

test('signed-out fallback data is labelled as sample data (M6)', async () => {
  const { findByText } = await render(<CertificationsScreen />);

  expect(await findByText('Sample data. Sign in to see your certifications.')).toBeTruthy();
});
