import type { ApiError } from '@rayfin-app/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, ErrorPanel } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session-context';

export function AccessDeniedPage() {
  return (
    <Card title="Access denied">
      <p className="text-sm">You do not have permission to open this page. If you need it, ask the app administrator to grant the right role.</p>
      <Link className="mt-3 inline-block text-sm text-primary underline" to="/">
        Go to your start page
      </Link>
    </Card>
  );
}

export function NotFoundPage() {
  return (
    <Card title="Page not found">
      <Link className="text-sm text-primary underline" to="/">
        Go to your start page
      </Link>
    </Card>
  );
}

/**
 * Signed in to Fabric but holding no business role in this app. Offers the
 * one-time bootstrap only when the server says it is available.
 */
export function NoMembershipPage() {
  const { me, reload } = useSession();
  const [error, setError] = useState<{ error: ApiError; correlationId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const bootstrap = async () => {
    setBusy(true);
    const res = await api.bootstrapAppAdmin();
    setBusy(false);
    if (res.ok) await reload();
    else setError({ error: res.error, correlationId: res.correlationId });
  };
  return (
    <Card title="No access to this app yet">
      <p className="text-sm">
        You are signed in as <strong>{me?.user.email}</strong>, but you have no role in {me?.app.appName}. Ask the app administrator to grant access.
      </p>
      {me?.bootstrapAvailable && (
        <div className="mt-4 rounded border border-border p-3 text-sm">
          <p className="mb-2">This app has no administrator yet and your account is listed as a bootstrap administrator in the deployment configuration.</p>
          <Button onClick={() => void bootstrap()} disabled={busy}>
            {busy ? 'Setting up…' : 'Become the first app administrator'}
          </Button>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <ErrorPanel error={error.error} correlationId={error.correlationId} />
        </div>
      )}
    </Card>
  );
}
