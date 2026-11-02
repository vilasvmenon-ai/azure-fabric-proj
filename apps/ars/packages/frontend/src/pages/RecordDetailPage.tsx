import type { AddressFields, ApiError, RecordDetail, ReviewDecision } from '@rayfin-app/shared';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Button, Card, ErrorPanel, FieldTable, Loading, StatusBadge } from '@/components/ui';
import { FIELD_LABELS, formatDate } from '@/lib/format';
import { api } from '@/lib/api';

type Err = { error: ApiError; correlationId?: string } | null;

/** Record and review detail (APP-03, APP-06, DATA-03). */
export function RecordDetailPage() {
  const { id = '' } = useParams();
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [error, setError] = useState<Err>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((res: Awaited<ReturnType<typeof api.getRecord>>) => {
    if (res.ok) {
      setError(null);
      setRecord(res.data);
    } else {
      setRecord(null);
      setError({ error: res.error, correlationId: res.correlationId });
    }
  }, []);
  const load = useCallback(() => api.getRecord({ requestId: id }).then(apply), [id, apply]);

  useEffect(() => {
    let cancelled = false;
    void api.getRecord({ requestId: id }).then((r) => !cancelled && apply(r));
    return () => {
      cancelled = true;
    };
  }, [id, apply]);

  const retry = async () => {
    setBusy(true);
    const res = await api.retryProcessing({ requestId: id });
    setBusy(false);
    if (res.ok) setRecord(res.data);
    else {
      setError({ error: res.error, correlationId: res.correlationId });
      void api.getRecord({ requestId: id }).then((r) => r.ok && setRecord(r.data));
    }
  };

  if (!record && !error) return <Loading />;
  if (!record && error) return <ErrorPanel error={error.error} correlationId={error.correlationId} onRetry={() => void load()} />;
  if (!record) return null;

  return (
    <div className="space-y-6">
      {error && <ErrorPanel error={error.error} correlationId={error.correlationId} />}
      <Card
        title="Address record"
        actions={
          record.canRetry ? (
            <Button onClick={() => void retry()} disabled={busy} aria-busy={busy}>
              {busy ? 'Retrying…' : 'Retry processing'}
            </Button>
          ) : null
        }
      >
        <div className="mb-4 flex flex-wrap gap-2">
          <StatusBadge value={record.processingStatus} />
          <StatusBadge value={record.decision} />
          <StatusBadge value={record.reviewStatus} />
          <span className="text-xs text-muted-foreground self-center">version {record.version}</span>
        </div>
        <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="font-medium">Original input</dt>
          <dd className="whitespace-pre-wrap rounded bg-muted p-2">{record.originalAddress}</dd>
          <dt className="font-medium">Submitted by</dt>
          <dd>{record.creatorEmail}</dd>
          <dt className="font-medium">Created / updated</dt>
          <dd>
            {formatDate(record.createdAt)} / {formatDate(record.updatedAt)}
          </dd>
          <dt className="font-medium">Correlation ID</dt>
          <dd>
            <code className="select-all">{record.correlationId}</code>
          </dd>
          {record.errorCode && (
            <>
              <dt className="font-medium">Last error</dt>
              <dd>{record.errorCode}</dd>
            </>
          )}
        </dl>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Current fields (after review)">
          <FieldTable fields={record.currentFields} compare={record.result?.fields ?? null} />
        </Card>
        <Card title="Model output (immutable)">
          {record.result ? (
            <div className="space-y-3">
              <StatusBadge value={record.result.validationOutcome} />
              {record.result.validationErrors.length > 0 && (
                <ul className="list-disc pl-5 text-sm text-destructive">
                  {record.result.validationErrors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
              <FieldTable fields={record.result.fields} evidence={record.result.evidence} />
              <p className="text-xs text-muted-foreground">
                Agent {record.result.agentName}
                {record.result.agentVersionLabel ? `@${record.result.agentVersionLabel}` : ''} · contract {record.result.promptContractVersion} · {record.result.aiLatencyMs} ms
                {record.result.responseId ? ` · response ${record.result.responseId}` : ''}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No model output saved yet.</p>
          )}
        </Card>
      </div>

      {record.canReview && <ReviewForm record={record} onSaved={setRecord} onConflict={() => void load()} />}

      <Card title="Review history">
        {record.reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reviews yet.</p>
        ) : (
          <ol className="space-y-3">
            {record.reviews.map((r) => (
              <li key={r.id} className="rounded border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge value={r.decision} />
                  <span>{r.reviewerEmail}</span>
                  <span className="text-muted-foreground">{formatDate(r.createdAt)} · version {r.recordVersion}</span>
                </div>
                {r.comments && <p className="mt-2 whitespace-pre-wrap">{r.comments}</p>}
                {Object.keys(r.changedFields).length > 0 && (
                  <ul className="mt-2 text-xs text-muted-foreground">
                    {Object.entries(r.changedFields).map(([f, c]) => (
                      <li key={f}>
                        {f}: {c.from ?? '—'} → {c.to ?? '—'}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function ReviewForm({ record, onSaved, onConflict }: { record: RecordDetail; onSaved: (r: RecordDetail) => void; onConflict: () => void }) {
  const base: AddressFields = record.currentFields ?? { building: null, street: null, town: null, region: null, postcode: null, country: null };
  const [edits, setEdits] = useState<Record<keyof AddressFields, string>>(() =>
    Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v ?? ''])) as Record<keyof AddressFields, string>
  );
  const [decision, setDecision] = useState<ReviewDecision>('APPROVED');
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    const fieldEdits: Partial<AddressFields> = {};
    for (const k of Object.keys(edits) as (keyof AddressFields)[]) {
      const v = edits[k].trim() || null;
      if (v !== base[k]) fieldEdits[k] = v;
    }
    const res = await api.submitReview({ requestId: record.id, expectedVersion: record.version, decision, comments: comments || undefined, fieldEdits });
    setBusy(false);
    if (res.ok) {
      onSaved(res.data);
      setComments('');
    } else setError({ error: res.error, correlationId: res.correlationId });
  };

  return (
    <Card title="Review">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium">Corrected fields (leave unchanged to keep)</legend>
          {(Object.keys(FIELD_LABELS) as (keyof AddressFields)[]).map((k) => (
            <label key={k} className="text-sm">
              {FIELD_LABELS[k]}
              <input
                className="mt-1 w-full rounded border border-input bg-background px-2 py-1"
                value={edits[k]}
                maxLength={k === 'country' ? 2 : 200}
                onChange={(e) => setEdits((s) => ({ ...s, [k]: k === 'country' ? e.target.value.toUpperCase() : e.target.value }))}
              />
            </label>
          ))}
        </fieldset>
        <label className="block text-sm">
          Decision
          <select className="mt-1 block rounded border border-input bg-background px-2 py-1" value={decision} onChange={(e) => setDecision(e.target.value as ReviewDecision)}>
            <option value="APPROVED">Approve</option>
            <option value="NEEDS_CHANGES">Needs changes</option>
            <option value="REJECTED">Reject</option>
            <option value="COMMENT">Comment only</option>
          </select>
        </label>
        <label className="block text-sm">
          Comments
          <textarea className="mt-1 w-full rounded border border-input bg-background px-2 py-1" rows={3} maxLength={2000} value={comments} onChange={(e) => setComments(e.target.value)} />
        </label>
        {error && (
          <div>
            <ErrorPanel error={error.error} correlationId={error.correlationId} />
            {error.error.code === 'CONFLICT' && (
              <Button variant="secondary" className="mt-2" onClick={onConflict}>
                Reload latest version
              </Button>
            )}
          </div>
        )}
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {busy ? 'Saving…' : `Save review (version ${record.version})`}
        </Button>
      </form>
    </Card>
  );
}
