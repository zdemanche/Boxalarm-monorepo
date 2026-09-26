import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Skeleton } from './Skeleton';

afterEach(cleanup);

test('announces the loading state to assistive tech while the bars stay decorative (m8)', () => {
  const { container } = render(<Skeleton lines={2} />);

  expect(screen.getByRole('status').textContent).toBe('Loading…');
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(container.querySelector('[aria-busy="true"][aria-hidden="true"]')).toBeNull();
});
