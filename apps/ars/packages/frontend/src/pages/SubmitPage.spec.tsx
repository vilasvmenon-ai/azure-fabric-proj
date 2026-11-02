import type { ApiResult, SubmitAddressResponse } from '@rayfin-app/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// TEST DOUBLE: Rayfin Functions API is mocked; no backend or agent is called.
const submitAddress = vi.fn<(req: { clientRequestId: string; address: string }) => Promise<ApiResult<SubmitAddressResponse>>>();
let ids = 0;
vi.mock('@/lib/api', () => ({
  api: { submitAddress: (req: { clientRequestId: string; address: string }) => submitAddress(req) },
  listSamplesViaDataApi: vi.fn(async () => []),
  newCorrelationId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
}));

import { SubmitPage } from './SubmitPage';

describe('SubmitPage (APP-05)', () => {
  beforeEach(() => {
    submitAddress.mockReset();
    ids = 0;
  });

  it('disables the button while submitting and reuses the request id on resubmission', async () => {
    let resolve!: (v: ApiResult<SubmitAddressResponse>) => void;
    submitAddress.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(
      <MemoryRouter>
        <SubmitPage />
      </MemoryRouter>
    );
    fireEvent.change(screen.getByLabelText(/Unstructured address/), { target: { value: '17 Lotus Lane, India' } });
    const button = screen.getByRole('button', { name: /Structure and save/ });
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole('button', { name: /Structuring/ })).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Structuring/ })));
    expect(submitAddress).toHaveBeenCalledTimes(1);

    await act(async () =>
      resolve({ ok: false, correlationId: 'corr-1', error: { code: 'AI_TIMEOUT', message: 'Timed out.', requestId: '11111111-1111-4111-8111-111111111111' } })
    );
    expect(screen.getByRole('alert')).toHaveTextContent('corr-1');
    expect(screen.getByRole('link', { name: 'Open the saved request' })).toBeVisible();

    // Resubmitting the same unchanged text reuses the same clientRequestId (server dedupes).
    submitAddress.mockResolvedValue({ ok: false, correlationId: 'corr-2', error: { code: 'INTERNAL', message: 'x' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Structure and save/ })));
    expect(submitAddress.mock.calls[1][0].clientRequestId).toBe(submitAddress.mock.calls[0][0].clientRequestId);

    // Editing the address starts a new request id.
    fireEvent.change(screen.getByLabelText(/Unstructured address/), { target: { value: '28 Canal Road, Utrecht, Netherlands' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Structure and save/ })));
    expect(submitAddress.mock.calls[2][0].clientRequestId).not.toBe(submitAddress.mock.calls[0][0].clientRequestId);
  });
});
