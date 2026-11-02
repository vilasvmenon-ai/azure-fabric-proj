import type {
  ApiError,
  DiagnosticsResponse,
  EvaluationSampleResponse,
  FoundryProbeResponse,
  MembershipRole,
  MembershipView,
} from '@rayfin-app/shared';
import { useCallback, useEffect, useState } from 'react';

import { Button, Card, ErrorPanel, Loading, StatusBadge } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session-context';

const ROLES: MembershipRole[] = ['app_user', 'reviewer', 'auditor', 'audit_exporter', 'app_admin', 'super_user'];
const SAMPLE_KEYS = ['india', 'netherlands', 'uae', 'missing-country', 'missing-town', 'injection'];
type Err = { error: ApiError; correlationId?: string } | null;

/** Controlled administrator tooling (APP-06): membership, seed, diagnostics, Foundry readiness, evaluation. */
export function AdminPage() {
  const { can } = useSession();
  return (
    <div className="space-y-6">
      <SuperUserClaim />
      {can('membership.manage') && <Members />}
      {can('config.manage') && <Operations />}
    </div>
  );
}

/** D-57: one-click claim of super_user (app_user + app_admin) when the deployment config lists the caller. */
function SuperUserClaim() {
  const { me, reload } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  if (!me?.superUserAvailable) return null;
  const claim = async () => {
    setBusy(true);
    setError(null);
    const res = await api.claimSuperUser();
    setBusy(false);
    if (res.ok) await reload();
    else setError({ error: res.error, correlationId: res.correlationId });
  };
  return (
    <Card title="Super user (test environments only)">
      <p className="mb-3 text-sm text-muted-foreground">
        Your account is listed in this environment&apos;s deployment configuration as a super user. Claiming adds the <strong>super_user</strong> role
        (app user + app admin) so you can check the system end to end on your own. The claim is recorded in the audit trail. Not available in production.
      </p>
      <Button onClick={() => void claim()} disabled={busy}>
        {busy ? 'Claiming…' : 'Claim super user'}
      </Button>
      {error && (
        <div className="mt-3">
          <ErrorPanel error={error.error} correlationId={error.correlationId} />
        </div>
      )}
    </Card>
  );
}

function Members() {
  const { me } = useSession();
  const [rows, setRows] = useState<MembershipView[] | null>(null);
  const [error, setError] = useState<Err>(null);
  const [form, setForm] = useState({ userEmail: '', role: 'app_user' as MembershipRole, reason: '' });
  const [busy, setBusy] = useState(false);

  const apply = useCallback((res: Awaited<ReturnType<typeof api.listMembers>>) => {
    if (res.ok) setRows(res.data);
    else setError({ error: res.error, correlationId: res.correlationId });
  }, []);
  const load = useCallback(() => api.listMembers().then(apply), [apply]);

  useEffect(() => {
    let cancelled = false;
    void api.listMembers().then((r) => !cancelled && apply(r));
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const grant = async () => {
    setBusy(true);
    setError(null);
    const res = await api.grantMembership(form);
    setBusy(false);
    if (res.ok) {
      setForm({ userEmail: '', role: 'app_user', reason: '' });
      void load();
    } else setError({ error: res.error, correlationId: res.correlationId });
  };

  const revoke = async (m: MembershipView) => {
    const reason = window.prompt(`Reason for revoking ${m.role} from ${m.userEmail}?`);
    if (!reason) return;
    const res = await api.revokeMembership({ membershipId: m.id, reason });
    if (res.ok) void load();
    else setError({ error: res.error, correlationId: res.correlationId });
  };

  return (
    <Card title="App membership">
      <p className="mb-4 text-sm text-muted-foreground">
        Grants are by sign-in email and bind to the user on first use. End users also need <strong>Run and interact</strong> sharing on this Fabric App item (not workspace membership). You cannot change your own roles.
      </p>
      <form
        className="mb-4 grid gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          void grant();
        }}
      >
        <label className="text-sm sm:col-span-2">
          User email
          <input type="email" required className="mt-1 w-full rounded border border-input bg-background px-2 py-1" value={form.userEmail} onChange={(e) => setForm((f) => ({ ...f, userEmail: e.target.value }))} />
        </label>
        <label className="text-sm">
          Role
          <select className="mt-1 w-full rounded border border-input bg-background px-2 py-1" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as MembershipRole }))}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Reason / approval
          <input required maxLength={500} className="mt-1 w-full rounded border border-input bg-background px-2 py-1" value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
        </label>
        <div className="sm:col-span-4">
          <Button type="submit" disabled={busy}>
            {busy ? 'Granting…' : 'Grant role'}
          </Button>
        </div>
      </form>
      {error && <ErrorPanel error={error.error} correlationId={error.correlationId} />}
      {!rows && !error && <Loading />}
      {rows && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-muted-foreground">
                <th scope="col" className="py-2 pr-3">User</th>
                <th scope="col" className="py-2 pr-3">Role</th>
                <th scope="col" className="py-2 pr-3">Status</th>
                <th scope="col" className="py-2 pr-3">Granted</th>
                <th scope="col" className="py-2 pr-3">Reason</th>
                <th scope="col" className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-b border-border/60">
                  <td className="py-2 pr-3">
                    {m.userEmail}
                    {!m.bound && <span className="block text-xs text-muted-foreground">not signed in yet</span>}
                  </td>
                  <td className="py-2 pr-3">{m.role}</td>
                  <td className="py-2 pr-3"><StatusBadge value={m.status.toUpperCase()} /></td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {formatDate(m.grantedAt)}
                    <span className="block text-xs text-muted-foreground">by {m.grantedByEmail}</span>
                  </td>
                  <td className="py-2 pr-3">{m.reason}</td>
                  <td className="py-2">
                    {m.status === 'active' && m.userEmail !== me?.user.email && (
                      <Button variant="danger" onClick={() => void revoke(m)}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Operations() {
  const [error, setError] = useState<Err>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [diag, setDiag] = useState<DiagnosticsResponse | null>(null);
  const [probe, setProbe] = useState<FoundryProbeResponse | null>(null);
  const [evals, setEvals] = useState<EvaluationSampleResponse[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async <T,>(label: string, fn: () => Promise<{ ok: true; data: T; correlationId: string } | { ok: false; error: ApiError; correlationId: string }>, onOk: (d: T) => void) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    const res = await fn();
    setBusy(null);
    if (res.ok) onOk(res.data);
    else setError({ error: res.error, correlationId: res.correlationId });
  };

  const runAllEvals = async () => {
    setEvals([]);
    for (const key of SAMPLE_KEYS) {
      // Sequential: each call is one live agent invocation.
      await run(`eval:${key}`, () => api.runEvaluationSample({ sampleId: key }), (d) => setEvals((e) => [...e, d]));
    }
  };

  return (
    <Card title="Operations and readiness">
      <div className="mb-4 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!!busy} onClick={() => void run('seed', api.seedSampleData, (d) => setMessage(`Seed complete: app configuration upserted, ${d.samplesUpserted} synthetic samples.`))}>
          Seed sample data
        </Button>
        <Button variant="secondary" disabled={!!busy} onClick={() => void run('diag', api.diagnostics, setDiag)}>
          Run diagnostics
        </Button>
        <Button variant="secondary" disabled={!!busy} onClick={() => void run('probe', api.probeFoundry, setProbe)}>
          Probe existing Foundry agent
        </Button>
        <Button variant="secondary" disabled={!!busy} onClick={() => void runAllEvals()}>
          Run evaluation (6 live calls)
        </Button>
      </div>
      {busy && <Loading label={`Running ${busy}…`} />}
      {message && <p role="status" className="mb-3 rounded bg-green-100 p-2 text-sm text-green-900">{message}</p>}
      {error && <ErrorPanel error={error.error} correlationId={error.correlationId} />}
      {diag && (
        <div className="mt-4 text-sm">
          <h3 className="font-semibold">Diagnostics (release {diag.release}, {diag.environment})</h3>
          <dl className="mt-2 grid grid-cols-[14rem_1fr] gap-1">
            {Object.entries(diag.config).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-all">{String(v)}</dd>
              </div>
            ))}
          </dl>
          <ul className="mt-3">
            {diag.schema.map((t) => (
              <li key={t.table}>
                {t.present && t.missingColumns.length === 0 ? '✔' : '✖'} {t.table}
                {t.missingColumns.length > 0 && <span className="text-destructive"> missing: {t.missingColumns.join(', ')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {probe && (
        <p className={`mt-4 rounded p-2 text-sm ${probe.reachable && probe.contractValid ? 'bg-green-100 text-green-900' : 'bg-red-100 text-red-900'}`}>
          Agent {probe.agentName}: {probe.reachable ? 'reachable' : 'NOT reachable'}, contract {probe.contractValid ? 'valid' : 'INVALID'}, {probe.aiLatencyMs} ms, {probe.attempts} attempt(s)
          {probe.model ? `, model ${probe.model}` : ''}. {probe.validationErrors.join(' ')}
        </p>
      )}
      {evals.length > 0 && (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase text-muted-foreground">
              <th scope="col" className="py-2 pr-3">Sample</th>
              <th scope="col" className="py-2 pr-3">Contract</th>
              <th scope="col" className="py-2 pr-3">All fields match</th>
              <th scope="col" className="py-2">Mismatches</th>
            </tr>
          </thead>
          <tbody>
            {evals.map((e) => (
              <tr key={e.sampleId} className="border-b border-border/60">
                <td className="py-2 pr-3">{e.label}</td>
                <td className="py-2 pr-3">{e.contractValid ? 'valid' : 'invalid'}</td>
                <td className="py-2 pr-3">{e.allMatch ? 'yes' : 'no'}</td>
                <td className="py-2">
                  {e.fieldResults
                    .filter((f) => !f.match)
                    .map((f) => `${f.field}: expected ${f.expected ?? 'null'}, got ${f.actual ?? 'null'}`)
                    .join('; ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
