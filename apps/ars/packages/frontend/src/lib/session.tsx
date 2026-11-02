import type { ApiResult, Permission, WhoAmIResponse } from '@rayfin-app/shared';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { api } from './api';
import { SessionContext, type AppSession } from './session-context';


/**
 * Loads the caller's app identity, business roles and permissions from the
 * trusted `whoAmI` function. The UI only hides actions the server would
 * refuse; the server enforces every permission independently (APP-02).
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<WhoAmIResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppSession['error']>(null);

  const apply = useCallback((result: ApiResult<WhoAmIResponse>) => {
    if (result.ok) {
      setMe(result.data);
      setError(null);
    } else {
      setMe(null);
      setError({ ...result.error, correlationId: result.correlationId });
    }
    setLoading(false);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    apply(await api.whoAmI());
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    void api.whoAmI().then((r) => !cancelled && apply(r));
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const can = useCallback((p: Permission) => Boolean(me?.permissions.includes(p)), [me]);

  return <SessionContext.Provider value={{ me, loading, error, reload, can }}>{children}</SessionContext.Provider>;
}
