import type { Permission } from '@rayfin-app/shared';
import { NavLink, Outlet } from 'react-router-dom';

import { getRayfinClient } from '@/lib/rayfin-client';
import { useSession } from '@/lib/session-context';
import { cn } from '@/lib/utils';

const NAV: { to: string; label: string; any: Permission[] }[] = [
  { to: '/submit', label: 'Structure an address', any: ['address.submit'] },
  { to: '/records', label: 'Records', any: ['address.read.own', 'address.read.all'] },
  { to: '/audit', label: 'Audit', any: ['audit.read'] },
  { to: '/admin', label: 'Administration', any: ['membership.manage', 'config.manage'] },
];

async function signOut() {
  const client = await getRayfinClient();
  await client.auth.signOut();
  window.location.hash = '#/';
  window.location.reload();
}

/** App shell (APP-02): app + environment identity, current user, permitted navigation, sign-out. */
export function AppShell() {
  const { me, can } = useSession();
  if (!me) return null;
  const items = NAV.filter((n) => n.any.some((p) => can(p)));
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-card focus:p-2">
        Skip to content
      </a>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              {me.app.orgId} · {me.app.projectId}
            </p>
            <h1 className="text-lg font-semibold">
              {me.app.appName}{' '}
              <span className="ml-1 rounded bg-muted px-2 py-0.5 align-middle text-xs font-medium uppercase" title="Environment">
                {me.app.environment}
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <div className="text-right">
              <p className="font-medium">{me.user.email}</p>
              <p className="text-xs text-muted-foreground">{me.roles.length ? me.roles.join(', ').replace(/_/g, ' ') : 'no app role'}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg border border-border px-3 py-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav aria-label="Main" className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                cn(
                  'whitespace-nowrap border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive ? 'border-primary font-semibold text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      {me.faultInjection && (
        <div role="alert" className="bg-destructive px-4 py-2 text-center text-sm font-semibold text-destructive-foreground">
          TEST MODE: fault injection “{me.faultInjection}” is active in this dev environment. Failures you see are deliberate.
        </div>
      )}
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-6 text-xs text-muted-foreground">
        Release {me.app.release} · App {me.app.appId} · Address structuring is proposed by the existing Foundry agent; fields are checked for presence and text evidence only.
      </footer>
    </div>
  );
}
