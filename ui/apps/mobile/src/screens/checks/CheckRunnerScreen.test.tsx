import { touchTarget } from '@boxalarm/design-tokens';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { launchCamera } from 'react-native-image-picker';
import { CheckRunnerScreen } from './CheckRunnerScreen';
import { mockChecksRepository } from '../../features/checks/mockChecksRepository';

const mockLaunchCamera = launchCamera as jest.Mock;

const mockRoute = { params: { apparatusId: 'APP-ENGINE-2' } };
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useRoute: () => mockRoute,
  useNavigation: () => ({ goBack: jest.fn(), navigate: mockNavigate }),
}));

beforeEach(() => {
  mockNavigate.mockClear();
});

test('lists every item from the apparatus\u2019s checklist template', async () => {
  const { findByText } = await render(<CheckRunnerScreen />);

  expect(await findByText('Tires and wheels')).toBeTruthy();
  expect(await findByText('SCBA units present and charged')).toBeTruthy();
});

test('marking every item pass enables completing the check', async () => {
  const { findByText, findAllByText, queryByRole } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  expect(queryByRole('button', { name: 'Complete check' })).toBeNull();

  const passButtons = await findAllByText('Pass');
  for (const button of passButtons) {
    await act(async () => {
      fireEvent.press(button);
    });
  }

  expect(await findByText('Complete check')).toBeTruthy();
});

test('completing the check submits optimistically and confirms immediately, no spinner wait', async () => {
  const submitSpy = jest.spyOn(mockChecksRepository, 'submitChecklistRun');
  const { findByText, findAllByText } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  const passButtons = await findAllByText('Pass');
  for (const button of passButtons) {
    await act(async () => {
      fireEvent.press(button);
    });
  }
  await act(async () => {
    fireEvent.press(await findByText('Complete check'));
  });

  expect(await findByText(/check complete/i)).toBeTruthy();
  expect(submitSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      apparatusId: 'APP-ENGINE-2',
      itemResults: expect.arrayContaining([expect.objectContaining({ code: 'TIRES', pass: true })]),
    }),
  );
  submitSpy.mockRestore();
});

test('linking to defect report carries the apparatus id along', async () => {
  const { findByText } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  fireEvent.press(await findByText('Report a defect'));
  expect(mockNavigate).toHaveBeenCalledWith('DefectReport', { apparatusId: 'APP-ENGINE-2' });
});

test('announces check completion for screen reader users, since the screen swaps entirely', async () => {
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByText, findAllByText } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  const passButtons = await findAllByText('Pass');
  for (const button of passButtons) {
    await act(async () => {
      fireEvent.press(button);
    });
  }
  await act(async () => {
    fireEvent.press(await findByText('Complete check'));
  });

  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/check complete/i));
  announceSpy.mockRestore();
});

test('report a defect meets the N3.5 baseline touch target, not just its text height', async () => {
  const { findByRole } = await render(<CheckRunnerScreen />);

  const link = await findByRole('button', { name: 'Report a defect' });
  expect(link.props.style.minHeight).toBe(touchTarget.baseline.ios);
});

test('an item requiring a photo cannot be marked pass or fail until a photo is captured', async () => {
  const templateSpy = jest
    .spyOn(mockChecksRepository, 'getChecklistTemplate')
    .mockResolvedValueOnce({
      templateId: 'CT-PHOTO',
      name: 'Photo-required check',
      items: [{ code: 'SCBA', label: 'SCBA units present and charged', requiresPhoto: true }],
    });

  mockLaunchCamera.mockResolvedValueOnce({
    didCancel: false,
    assets: [{ uri: 'file:///tmp/scba.jpg', fileName: 'scba.jpg', type: 'image/jpeg' }],
  });
  const { findByText, findByRole } = await render(<CheckRunnerScreen />);
  await findByText('SCBA units present and charged');

  expect((await findByRole('button', { name: 'Pass' })).props.accessibilityState.disabled).toBe(
    true,
  );

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Add photo' }));
  });

  expect(await findByRole('button', { name: 'Photo captured' })).toBeTruthy();
  expect((await findByRole('button', { name: 'Pass' })).props.accessibilityState.disabled).toBe(
    false,
  );

  templateSpy.mockRestore();
});

test('a camera error surfaces to the crew instead of silently leaving the item ungated', async () => {
  const templateSpy = jest
    .spyOn(mockChecksRepository, 'getChecklistTemplate')
    .mockResolvedValueOnce({
      templateId: 'CT-PHOTO',
      name: 'Photo-required check',
      items: [{ code: 'SCBA', label: 'SCBA units present and charged', requiresPhoto: true }],
    });
  mockLaunchCamera.mockResolvedValueOnce({ didCancel: false, errorCode: 'camera_unavailable' });

  const { findByText, findByRole } = await render(<CheckRunnerScreen />);
  await findByText('SCBA units present and charged');

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Add photo' }));
  });

  expect(await findByText('camera_unavailable')).toBeTruthy();
  expect((await findByRole('button', { name: 'Pass' })).props.accessibilityState.disabled).toBe(
    true,
  );

  templateSpy.mockRestore();
});

test('a checklist API error shows a message and retry instead of a blank screen (M10)', async () => {
  const { ApiError } = jest.requireActual('../../lib/apiClient');
  const templateSpy = jest
    .spyOn(mockChecksRepository, 'getChecklistTemplate')
    .mockRejectedValueOnce(
      new ApiError({ type: 'about:blank', title: 'Server Error', status: 500, traceId: 't' }),
    );

  const { findByRole, findByText } = await render(<CheckRunnerScreen />);

  expect((await findByRole('alert')).props.children).toBe('The checklist could not be loaded.');
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Try again' }));
  });
  expect(await findByText('Tires and wheels')).toBeTruthy();

  templateSpy.mockRestore();
});

test('a failed local save does not confirm the check, and a retry reuses the idempotency key (C1)', async () => {
  const submitSpy = jest
    .spyOn(mockChecksRepository, 'submitChecklistRun')
    .mockRejectedValueOnce(new Error('storage full'));
  const { findByText, findAllByText, findByRole, queryByText } = await render(
    <CheckRunnerScreen />,
  );

  await findByText('Tires and wheels');
  for (const button of await findAllByText('Pass')) {
    await act(async () => {
      fireEvent.press(button);
    });
  }
  await act(async () => {
    fireEvent.press(await findByText('Complete check'));
  });

  expect((await findByRole('alert')).props.children).toBe(
    'The check could not be saved on this device. Try again.',
  );
  expect(queryByText(/^check complete$/i)).toBeNull();

  await act(async () => {
    fireEvent.press(await findByText('Complete check'));
  });
  expect(await findByRole('header')).toBeTruthy();
  const [first, second] = submitSpy.mock.calls;
  expect(second?.[0].idempotencyKey).toBe(first?.[0].idempotencyKey);
  submitSpy.mockRestore();
});
