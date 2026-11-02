import type { ApiError, ProcessingStatus, RecordSummary, ReviewStatus } from '@rayfin-app/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, ErrorPanel, Loading, StatusBadge } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session-context';

const PROCESSING: ProcessingStatus[] = ['PROCESSING', 'COMPLETED', 'FAILED_AI', 'FAILED_VALIDATION', 'FAILED_STORAGE', 'FAILED_AUDIT'];
const REVIEW: ReviewStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_CHANGES'];

/**
 * Records list (APP-06). Both scopes call the listRecords function: "My records"
 * filters on the caller's sub server-side, "All records" needs address.read.all.
 * (The generated data API's owner policy returned no rows on Fabric-hosted
 * sessions even when creator_sub matched the session sub; D-55 revised.)
 */
export function RecordsPage() {
  const { can } = useSession();
  const canAll = can('address.read.all');
  const canMine = can('address.read.own');
  const [scope, setScope] = useState<'mine' | 'all'>(canMine ? 'mine' : 'all');
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | ''>('');
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus | ''>('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<RecordSummary[] | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [error, setError] = useState<{ error: ApiError; correlationId?: string } | null>(null);

  type Loaded =
    | { ok: true; items: RecordSummary[]; hasNext: boolean }
    | { ok: false; error: ApiError; correlationId?: string };

  // Fetch without touching state; `apply` sets state after the call resolves.
  const fetchPage = useCallback(async (): Promise<Loaded> => {
    const res = await api.listRecords({ scope, page, pageSize: 25, processingStatus: processingStatus || undefined, reviewStatus: reviewStatus || undefined });
    return res.ok
      ? { ok: true, items: res.data.items, hasNext: res.data.hasNextPage }
      : { ok: false, error: res.error, correlationId: res.correlationId };
  }, [scope, page, processingStatus, reviewStatus]);

  const apply = useCallback((r: Loaded) => {
    if (!r.ok) return setError({ error: r.error, correlationId: r.correlationId });
    setError(null);
    setItems(r.items);
    setHasNext(r.hasNext);
  }, []);

  const load = useCallback(() => fetchPage().then(apply), [fetchPage, apply]);

  useEffect(() => {
    let cancelled = false;
    void fetchPage().then((r) => !cancelled && apply(r));
    return () => {
      cancelled = true;
    };
  }, [fetchPage, apply]);

  const reset = () => {
    setItems(null);
    setPage(1);
  };

  return (
    <Card
      title="Records"
      actions={
        canMine && canAll ? (
          <div role="group" aria-label="Scope" className="flex gap-1">
            {(['mine', 'all'] as const).map((s) => (
              <Button key={s} variant={scope === s ? 'primary' : 'secondary'} onClick={() => (setScope(s), reset())} aria-pressed={scope === s}>
                {s === 'mine' ? 'My records' : 'All records'}
              </Button>
            ))}
          </div>
        ) : null
      }
    >
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-2">
          Processing
          <select className="rounded border border-input bg-background px-2 py-1" value={processingStatus} onChange={(e) => (setProcessingStatus(e.target.value as ProcessingStatus | ''), reset())}>
            <option value="">Any</option>
            {PROCESSING.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Review
          <select className="rounded border border-input bg-background px-2 py-1" value={reviewStatus} onChange={(e) => (setReviewStatus(e.target.value as ReviewStatus | ''), reset())}>
            <option value="">Any</option>
            {REVIEW.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      {error && <ErrorPanel error={error.error} correlationId={error.correlationId} onRetry={() => void load()} />}
      {!error && !items && <Loading />}
      {items && items.length === 0 && <p className="text-sm text-muted-foreground">No records match.</p>}
      {items && items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Address records</caption>
            <thead>
              <tr className="border-b border-border text-xs uppercase text-muted-foreground">
                <th scope="col" className="py-2 pr-3">Address</th>
                {scope === 'all' && <th scope="col" className="py-2 pr-3">Submitted by</th>}
                <th scope="col" className="py-2 pr-3">Processing</th>
                <th scope="col" className="py-2 pr-3">Review</th>
                <th scope="col" className="py-2 pr-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b border-border/60">
                  <td className="py-2 pr-3">
                    <Link className="text-primary underline" to={`/records/${r.id}`}>
                      {r.addressExcerpt}
                    </Link>
                  </td>
                  {scope === 'all' && <td className="py-2 pr-3">{r.creatorEmail}</td>}
                  <td className="py-2 pr-3"><StatusBadge value={r.processingStatus} /></td>
                  <td className="py-2 pr-3"><StatusBadge value={r.reviewStatus} /></td>
                  <td className="py-2 pr-3 whitespace-nowrap">{formatDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </Button>
        <span className="text-sm">Page {page}</span>
        <Button variant="secondary" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
          Next
        </Button>
      </div>
    </Card>
  );
}
