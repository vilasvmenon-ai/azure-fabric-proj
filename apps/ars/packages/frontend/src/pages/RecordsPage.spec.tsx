import type { ApiResult, ListRecordsRequest, Page, RecordSummary } from '@rayfin-app/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// TEST DOUBLE: the Rayfin Functions API and the session are mocked; no backend is contacted.
const listRecords = vi.fn<(req: Omit<ListRecordsRequest, 'correlationId'>) => Promise<ApiResult<Page<RecordSummary>>>>();
let permissions: string[] = [];
vi.mock('@/lib/api', () => ({
  api: { listRecords: (req: Omit<ListRecordsRequest, 'correlationId'>) => listRecords(req) },
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ can: (p: string) => permissions.includes(p) }),
}));

import { RecordsPage } from './RecordsPage';

const record: RecordSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  creatorEmail: 'user.a@ionova.test',
  addressExcerpt: '28 Canal Road, Utrecht, 3511 AA, Netherlands',
  processingStatus: 'COMPLETED',
  reviewStatus: 'PENDING',
  decision: 'FIELDS_PRESENT',
  version: 1,
  createdAt: '2026-11-02T07:36:17.000Z',
  updatedAt: '2026-11-02T07:36:17.000Z',
};

function ok(items: RecordSummary[]): ApiResult<Page<RecordSummary>> {
  return { ok: true, correlationId: 'c', data: { items, page: 1, pageSize: 25, hasNextPage: false } } as ApiResult<Page<RecordSummary>>;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <RecordsPage />
    </MemoryRouter>
  );

describe('RecordsPage (APP-06)', () => {
  beforeEach(() => {
    listRecords.mockReset();
    listRecords.mockResolvedValue(ok([record]));
  });

  it('lists the caller\'s own records through the listRecords function', async () => {
    permissions = ['address.read.own'];
    await act(async () => renderPage());
    expect(listRecords).toHaveBeenCalledWith(expect.objectContaining({ scope: 'mine', page: 1 }));
    expect(screen.getByRole('link', { name: /28 Canal Road/ })).toHaveAttribute('href', `/records/${record.id}`);
    expect(screen.queryByText('No records match.')).toBeNull();
  });

  it('passes filters to the server and switches to all records for a reviewer', async () => {
    permissions = ['address.read.own', 'address.read.all'];
    await act(async () => renderPage());
    await act(async () => fireEvent.change(screen.getByLabelText('Review'), { target: { value: 'PENDING' } }));
    expect(listRecords).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'mine', reviewStatus: 'PENDING' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'All records' })));
    expect(listRecords).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'all' }));
    expect(screen.getByText('user.a@ionova.test')).toBeVisible();
  });

  it('shows the server error with its correlation id', async () => {
    permissions = ['address.read.own'];
    listRecords.mockResolvedValue({ ok: false, correlationId: 'corr-9', error: { code: 'INTERNAL', message: 'Failed.' } });
    await act(async () => renderPage());
    expect(screen.getByRole('alert')).toHaveTextContent('corr-9');
  });
});
