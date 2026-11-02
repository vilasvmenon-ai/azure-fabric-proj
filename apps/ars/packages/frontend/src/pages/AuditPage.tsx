import type { ApiError, AuditChainResponse, AuditEventView, AuditSearchRequest } from '@rayfin-app/shared';
import { useCallback, useEffect, useState } from 'react';

import { Button, Card, ErrorPanel, Loading, StatusBadge } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session-context';

type Filters = Omit<AuditSearchRequest, 'correlationId' | 'page' | 'pageSize'>;

/** Read-only audit viewer (AUD-05). Filters and paging run on the server. */
export function AuditPage() {
  const { can } = useSession();
  const [draft, setDraft] = useState<Filters>({});
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AuditEventView[] | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [error, setError] = useState<{ error: ApiError; correlationId?: string } | null>(null);
  const [chain, setChain] = useState<AuditChainResponse | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    const res = await api.searchAudit({ ...filters, page, pageSize: 50 });
    if (res.ok) {
      setError(null);
      setItems(res.data.items);
      setHasNext(res.data.hasNextPage);
    } else setError({ error: res.error, correlationId: res.correlationId });
  }, [filters, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const toIso = (local?: string) => (local ? new Date(local).toISOString() : undefined);

  const apply = () => {
    setItems(null);
    setPage(1);
    setFilters({ ...draft, fromUtc: toIso(draft.fromUtc), toUtc: toIso(draft.toUtc) });
  };

  const exportCsv = async () => {
    setExporting(true);
    const res = await api.exportAudit(filters);
    setExporting(false);
    if (!res.ok) return setError({ error: res.error, correlationId: res.correlationId });
    const blob = new Blob([res.data.content], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = res.data.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const verify = async () => {
    const res = await api.verifyAuditChain();
    if (res.ok) setChain(res.data);
    else setError({ error: res.error, correlationId: res.correlationId });
  };

  const input = (key: keyof Filters, label: string, type = 'text') => (
    <label className="text-sm">
      {label}
      <input
        type={type}
        className="mt-1 w-full rounded border border-input bg-background px-2 py-1"
        value={(draft[key] as string | undefined) ?? ''}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value || undefined }))}
      />
    </label>
  );

  return (
    <div className="space-y-6">
      <Card
        title="Audit events"
        actions={
          <div className="flex gap-2">
            {can('audit.verify') && (
              <Button variant="secondary" onClick={() => void verify()}>
                Verify integrity
              </Button>
            )}
            {can('audit.export') && (
              <Button variant="secondary" onClick={() => void exportCsv()} disabled={exporting}>
                {exporting ? 'Exporting…' : 'Export CSV'}
              </Button>
            )}
          </div>
        }
      >
        {chain && (
          <p role="status" className={`mb-4 rounded p-2 text-sm ${chain.intact ? 'bg-green-100 text-green-900' : 'bg-red-100 text-red-900'}`}>
            {chain.intact
              ? `Audit chain intact: ${chain.checked} events verified.`
              : `Audit chain BROKEN at event ${chain.firstBrokenSeq}: ${chain.reason}. Escalate to the project administrator.`}
          </p>
        )}
        <form
          className="mb-4 grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          {input('actorEmail', 'Actor email')}
          {input('action', 'Action (e.g. address.processed)')}
          <label className="text-sm">
            Outcome
            <select
              className="mt-1 w-full rounded border border-input bg-background px-2 py-1"
              value={draft.outcome ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, outcome: (e.target.value || undefined) as Filters['outcome'] }))}
            >
              <option value="">Any</option>
              <option>SUCCESS</option>
              <option>DENIED</option>
              <option>FAILURE</option>
            </select>
          </label>
          {input('correlationIdFilter', 'Correlation ID')}
          {input('fromUtc', 'From', 'datetime-local')}
          {input('toUtc', 'To', 'datetime-local')}
          <div className="sm:col-span-3">
            <Button type="submit">Apply filters</Button>
          </div>
        </form>
        {error && <ErrorPanel error={error.error} correlationId={error.correlationId} onRetry={() => void load()} />}
        {!error && !items && <Loading />}
        {items && items.length === 0 && <p className="text-sm text-muted-foreground">No events match.</p>}
        {items && items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Audit events</caption>
              <thead>
                <tr className="border-b border-border text-xs uppercase text-muted-foreground">
                  <th scope="col" className="py-2 pr-3">#</th>
                  <th scope="col" className="py-2 pr-3">Time (local)</th>
                  <th scope="col" className="py-2 pr-3">Actor</th>
                  <th scope="col" className="py-2 pr-3">Action</th>
                  <th scope="col" className="py-2 pr-3">Object</th>
                  <th scope="col" className="py-2 pr-3">Outcome</th>
                  <th scope="col" className="py-2 pr-3">Correlation ID</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3">{e.seq}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDate(e.occurredAt)}</td>
                    <td className="py-2 pr-3">{e.actorEmail ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {e.action}
                      {e.details && <pre className="mt-1 max-w-md overflow-x-auto text-xs text-muted-foreground">{JSON.stringify(e.details)}</pre>}
                    </td>
                    <td className="py-2 pr-3">
                      {e.objectType}
                      {e.objectId ? <span className="block text-xs text-muted-foreground">{e.objectId}</span> : null}
                    </td>
                    <td className="py-2 pr-3"><StatusBadge value={e.outcome} /></td>
                    <td className="py-2 pr-3"><code className="text-xs">{e.correlationId}</code></td>
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
    </div>
  );
}
