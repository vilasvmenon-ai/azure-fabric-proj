import type { ApiError, RecordDetail, SampleAddressView } from '@rayfin-app/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, ErrorPanel, FieldTable, StatusBadge } from '@/components/ui';
import { api, listSamplesViaDataApi, newCorrelationId } from '@/lib/api';

const MAX = 2000;

/** Address input and result screen (APP-03, APP-05, APP-06). */
export function SubmitPage() {
  const [address, setAddress] = useState('');
  const [samples, setSamples] = useState<SampleAddressView[]>([]);
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [error, setError] = useState<{ error: ApiError; correlationId: string } | null>(null);
  // One request id per distinct submission: a double click or resend reuses it,
  // so the server returns the same record instead of creating a duplicate.
  const requestIdRef = useRef<string>(newCorrelationId());

  useEffect(() => {
    listSamplesViaDataApi()
      .then(setSamples)
      .catch(() => setSamples([]));
  }, []);

  const onChange = (value: string) => {
    setAddress(value);
    requestIdRef.current = newCorrelationId();
  };

  const submit = async () => {
    if (busy) return;
    const trimmed = address.trim();
    if (!trimmed) {
      setError({ error: { code: 'VALIDATION', message: 'Enter an address.' }, correlationId: '' });
      return;
    }
    setBusy(true);
    setError(null);
    setRecord(null);
    const res = await api.submitAddress({ clientRequestId: requestIdRef.current, address: trimmed });
    setBusy(false);
    if (res.ok) {
      setRecord(res.data.record);
      setDuplicate(res.data.duplicate);
    } else {
      setError({ error: res.error, correlationId: res.correlationId });
    }
  };

  const failedRequestId = error?.error.requestId;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Structure an address">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {samples.length > 0 && (
            <div className="mb-3">
              <label htmlFor="sample" className="mb-1 block text-sm font-medium">
                Approved synthetic sample (optional)
              </label>
              <select
                id="sample"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                defaultValue=""
                onChange={(e) => {
                  const s = samples.find((x) => x.id === e.target.value);
                  if (s) onChange(s.address);
                }}
              >
                <option value="">Choose a sample…</option>
                {samples.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label htmlFor="address" className="mb-1 block text-sm font-medium">
            Unstructured address <span className="text-destructive">*</span>
          </label>
          <textarea
            id="address"
            required
            maxLength={MAX}
            rows={5}
            value={address}
            onChange={(e) => onChange(e.target.value)}
            aria-describedby="address-help"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p id="address-help" className="mt-1 text-xs text-muted-foreground">
            {address.length}/{MAX} characters. Use synthetic or approved test data only during the trial.
          </p>
          <Button type="submit" className="mt-4" disabled={busy || !address.trim()} aria-busy={busy}>
            {busy ? 'Structuring… (this can take up to a minute)' : 'Structure and save'}
          </Button>
        </form>
        {error && (
          <div className="mt-4">
            <ErrorPanel error={error.error} correlationId={error.correlationId || undefined} />
            {failedRequestId && (
              <p className="mt-2 text-sm">
                <Link className="text-primary underline" to={`/records/${failedRequestId}`}>
                  Open the saved request
                </Link>
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="Result">
        {!record && !busy && <p className="text-sm text-muted-foreground">Submit an address to see the proposed fields.</p>}
        {busy && (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            Calling the address service and saving the result…
          </p>
        )}
        {record && (
          <div className="space-y-4">
            {duplicate && (
              <p className="rounded bg-muted p-2 text-sm">This request was already submitted; showing the saved record instead of creating a duplicate.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <StatusBadge value={record.processingStatus} />
              <StatusBadge value={record.decision} />
              <StatusBadge value={record.reviewStatus} />
            </div>
            <FieldTable fields={record.result?.fields ?? null} evidence={record.result?.evidence ?? null} />
            {record.result?.checks.length ? (
              <ul className="text-sm">
                {record.result.checks.map((c) => (
                  <li key={c.name}>
                    {c.passed ? '✔' : '✖'} {c.name}
                  </li>
                ))}
              </ul>
            ) : null}
            {record.result?.notes.length ? (
              <div className="text-sm">
                <p className="font-medium">Agent notes</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {record.result.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Agent {record.result?.agentName} · {record.result?.aiLatencyMs} ms · Correlation ID <code>{record.correlationId}</code>
            </p>
            <Link className="text-sm text-primary underline" to={`/records/${record.id}`}>
              Open record
            </Link>
          </div>
        )}
      </Card>
    </div>
  );
}
