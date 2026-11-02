import type { Permission } from '@rayfin-app/shared';
import type { ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { ErrorPanel, Loading } from './components/ui';
import { SessionProvider } from './lib/session';
import { useSession } from './lib/session-context';
import { AdminPage } from './pages/AdminPage';
import { AuditPage } from './pages/AuditPage';
import { RecordDetailPage } from './pages/RecordDetailPage';
import { RecordsPage } from './pages/RecordsPage';
import { AccessDeniedPage, NoMembershipPage, NotFoundPage } from './pages/StatusPages';
import { SubmitPage } from './pages/SubmitPage';

/**
 * Hash routing is used because Fabric Apps static hosting does not document
 * an SPA fallback for deep links (docs/DECISIONS.md D-46).
 */
function Guard({ any, children }: { any: Permission[]; children: ReactNode }) {
  const { can } = useSession();
  return any.some((p) => can(p)) ? <>{children}</> : <AccessDeniedPage />;
}

function StartRedirect() {
  const { can } = useSession();
  if (can('address.submit')) return <Navigate to="/submit" replace />;
  if (can('address.read.all')) return <Navigate to="/records" replace />;
  if (can('audit.read')) return <Navigate to="/audit" replace />;
  if (can('membership.manage') || can('config.manage')) return <Navigate to="/admin" replace />;
  return <NoMembershipPage />;
}

function Routed() {
  const { me, loading, error, reload } = useSession();
  if (loading && !me) return <div className="p-6"><Loading label="Checking your access…" /></div>;
  if (!me && error)
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorPanel error={error} correlationId={error.correlationId} onRetry={() => void reload()} />
      </div>
    );
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<StartRedirect />} />
        <Route path="submit" element={<Guard any={['address.submit']}><SubmitPage /></Guard>} />
        <Route path="records" element={<Guard any={['address.read.own', 'address.read.all']}><RecordsPage /></Guard>} />
        <Route path="records/:id" element={<Guard any={['address.read.own', 'address.read.all']}><RecordDetailPage /></Guard>} />
        <Route path="audit" element={<Guard any={['audit.read']}><AuditPage /></Guard>} />
        <Route path="admin" element={<Guard any={['membership.manage', 'config.manage']}><AdminPage /></Guard>} />
        <Route path="denied" element={<AccessDeniedPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

function App() {
  return (
    <SessionProvider>
      <HashRouter>
        <Routed />
      </HashRouter>
    </SessionProvider>
  );
}

export default App;
