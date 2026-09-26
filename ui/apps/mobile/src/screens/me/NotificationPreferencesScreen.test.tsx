import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { NotificationPreferencesScreen } from './NotificationPreferencesScreen';

jest.mock('../../lib/apiClient', () => {
  const actual = jest.requireActual('../../lib/apiClient');
  return { ...actual, apiRequest: jest.fn() };
});
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.com' },
}));

const mockApiRequest = apiRequest as jest.Mock;
const mockUseOptionalAuth = useOptionalAuth as jest.Mock;

const mockAuthValue: AuthContextValue = {
  roles: ['MEMBER'],
  memberId: 'MBR-0001',
  isAuthenticated: true,
  isLoading: false,
  signIn: jest.fn(),
  signOut: jest.fn(),
  getAccessToken: jest.fn().mockResolvedValue('access-token'),
  renewSilently: jest.fn().mockResolvedValue('access-token'),
};

beforeEach(() => {
  mockApiRequest.mockReset();
  mockUseOptionalAuth.mockReturnValue(mockAuthValue);
});

test('renders the certification expiry preference from the API', async () => {
  mockApiRequest.mockImplementation(async (path: string) => {
    if (path === 'notifications/preferences') {
      return {
        json: async () => ({
          preferences: [{ category: 'CERT_EXPIRY', channels: { push: false, email: true } }],
        }),
      };
    }
    return { json: async () => ({}) };
  });

  const { findByLabelText } = await render(<NotificationPreferencesScreen />);

  const toggle = await findByLabelText('Certification expiry push notifications');
  expect(toggle.props.value).toBe(false);
});

test('shows an error message instead of hanging when the preferences fetch fails', async () => {
  mockApiRequest.mockRejectedValue(new Error('network error'));

  const { findByRole } = await render(<NotificationPreferencesScreen />);

  const alert = await findByRole('alert');
  expect(alert.props.children).toBe(
    'Notification preferences could not be loaded. Check your connection and try again.',
  );
});

test('a failed save reverts the optimistic toggle and tells the member (M11)', async () => {
  mockApiRequest.mockImplementation(async (path: string, _tokens: unknown, init?: RequestInit) => {
    if (path === 'notifications/preferences' && init?.method === 'PUT') {
      throw new Error('network error');
    }
    return {
      json: async () => ({
        preferences: [{ category: 'CERT_EXPIRY', channels: { push: true, email: true } }],
      }),
    };
  });

  const { findByLabelText, findByRole } = await render(<NotificationPreferencesScreen />);
  const toggle = await findByLabelText('Certification expiry push notifications');
  await waitFor(() => expect(toggle.props.value).toBe(true));

  await act(async () => {
    fireEvent(toggle, 'valueChange', false);
  });

  expect((await findByRole('alert')).props.children).toBe(
    'Your change was not saved. Check your connection and try again.',
  );
  expect((await findByLabelText('Certification expiry push notifications')).props.value).toBe(true);
});
