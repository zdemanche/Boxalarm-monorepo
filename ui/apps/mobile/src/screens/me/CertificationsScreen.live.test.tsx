import { render, waitFor } from '@testing-library/react-native';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { ApiError, apiRequest } from '../../lib/apiClient';
import { CertificationsScreen } from './CertificationsScreen';

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

test('a 403 shows an access error and never the mock certifications (M6)', async () => {
  mockApiRequest.mockRejectedValue(
    new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, traceId: 't' }),
  );

  const { findByRole, queryByText } = await render(<CertificationsScreen />);

  const alert = await findByRole('alert');
  expect(alert.props.children).toBe('You do not have access to these certifications.');
  expect(queryByText('FF1')).toBeNull();
  expect(queryByText(/Sample data/)).toBeNull();
});

test('a network failure shows a retryable error, not sample data (M6)', async () => {
  mockApiRequest.mockRejectedValue(new TypeError('Network request failed'));

  const { findByRole, queryByText } = await render(<CertificationsScreen />);

  const alert = await findByRole('alert');
  expect(alert.props.children).toBe(
    'Certifications could not be loaded. Check your connection and try again.',
  );
  expect(queryByText('FF1')).toBeNull();
});

test('live certifications render without the sample-data label', async () => {
  mockApiRequest.mockResolvedValue({
    json: async () => [
      {
        certId: 'c-1',
        certType: 'EMT-B',
        issuingAuthority: 'State',
        expiryDate: '2030-01-01',
        status: 'CURRENT',
      },
    ],
  });

  const { findByText, queryByText } = await render(<CertificationsScreen />);

  expect(await findByText('EMT-B')).toBeTruthy();
  await waitFor(() => expect(queryByText(/Sample data/)).toBeNull());
});
