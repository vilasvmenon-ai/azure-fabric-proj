import type { ApiError, Permission, WhoAmIResponse } from '@rayfin-app/shared';
import { createContext, useContext } from 'react';

export interface AppSession {
  me: WhoAmIResponse | null;
  loading: boolean;
  error: (ApiError & { correlationId: string }) | null;
  reload: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

export const SessionContext = createContext<AppSession | null>(null);

export function useSession(): AppSession {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
