import type { OpaqueSession } from '@microsoft/rayfin-auth';
import type { ApiResult, WhoAmIResponse } from '@rayfin-app/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST DOUBLE: the Rayfin Functions API is mocked; no backend is contacted.
const whoAmI = vi.fn<() => Promise<ApiResult<WhoAmIResponse>>>();
vi.mock('@/lib/api', () => ({
  api: { whoAmI: () => whoAmI(), bootstrapAppAdmin: vi.fn() },
  listSamplesViaDataApi: vi.fn(async () => []),
  listMyRecordsViaDataApi: vi.fn(async () => ({ items: [], hasNextPage: false, endCursor: null })),
  newCorrelationId: () => '00000000-0000-4000-8000-000000000000',
}));

import { Root } from './Root';
import type { AuthConfig, IAuthService } from './services/rayfin-auth.service';

const authenticated: OpaqueSession = { user: null, isAuthenticated: true, isAnonymous: false };

function me(overrides: Partial<WhoAmIResponse> = {}): ApiResult<WhoAmIResponse> {
  return {
    ok: true,
    correlationId: 'c',
    data: {
      user: { sub: 's', email: 'user.a@ionova.test' },
      app: { orgId: 'ionova', projectId: 'ai-lab', appId: 'ars', appName: 'Address Structuring Lab', environment: 'dev', release: '1.0.0' },
      roles: ['app_user'],
      permissions: ['address.submit', 'address.read.own', 'address.retry.own'],
      bootstrapAvailable: false,
      superUserAvailable: false,
      faultInjection: null,
      ...overrides,
    },
  };
}

function service(config: AuthConfig = { kind: 'ready' }): IAuthService {
  return {
    config,
    canSignIn: config.kind === 'ready',
    resolveSession: vi.fn(async () => null),
    signIn: vi.fn(async () => authenticated),
  };
}

const appHeading = () => screen.queryByRole('heading', { name: /Address Structuring Lab/ });

describe('app shell behind Fabric sign-in (APP-02)', () => {
  beforeEach(() => {
    window.location.hash = '';
    whoAmI.mockReset();
    whoAmI.mockResolvedValue(me());
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers sign-in without rendering protected content or calling the backend', async () => {
    render(<Root rayfinAuthService={service()} />);
    expect(await screen.findByRole('button', { name: 'Sign in with Microsoft' })).toBeVisible();
    expect(appHeading()).toBeNull();
    expect(whoAmI).not.toHaveBeenCalled();
  });

  it('shows app, environment, user and permitted navigation after sign-in', async () => {
    const auth = service();
    auth.resolveSession = vi.fn(async () => authenticated);
    render(<Root rayfinAuthService={auth} />);
    expect(await screen.findByRole('heading', { name: /Address Structuring Lab/ })).toBeVisible();
    expect(screen.getByText('dev')).toBeVisible();
    expect(screen.getByText('user.a@ionova.test')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Structure an address' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Audit' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull();
  });

  it('shows an access-denied page for a route the user cannot use', async () => {
    window.location.hash = '#/audit';
    const auth = service();
    auth.resolveSession = vi.fn(async () => authenticated);
    render(<Root rayfinAuthService={auth} />);
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeVisible();
  });

  it('explains when the signed-in user has no role in this app', async () => {
    whoAmI.mockResolvedValue(me({ roles: [], permissions: [] }));
    const auth = service();
    auth.resolveSession = vi.fn(async () => authenticated);
    render(<Root rayfinAuthService={auth} />);
    expect(await screen.findByRole('heading', { name: 'No access to this app yet' })).toBeVisible();
  });

  it('shows a clear error with correlation id when the backend check fails', async () => {
    whoAmI.mockResolvedValue({ ok: false, correlationId: 'corr-123', error: { code: 'CONFIG', message: 'Not configured.' } });
    const auth = service();
    auth.resolveSession = vi.fn(async () => authenticated);
    render(<Root rayfinAuthService={auth} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('corr-123');
  });

  it('shows the fault-injection banner in test mode', async () => {
    whoAmI.mockResolvedValue(me({ faultInjection: 'auditWrite' }));
    const auth = service();
    auth.resolveSession = vi.fn(async () => authenticated);
    render(<Root rayfinAuthService={auth} />);
    expect(await screen.findByText(/fault injection/)).toBeVisible();
  });

  it('removes protected content when the session ends', async () => {
    const auth = service();
    auth.resolveSession = vi.fn(async () => authenticated);
    let notify: ((s: OpaqueSession | null) => void) | undefined;
    auth.onSessionChange = vi.fn((l) => {
      notify = l;
      return vi.fn();
    });
    render(<Root rayfinAuthService={auth} />);
    await screen.findByRole('heading', { name: /Address Structuring Lab/ });
    await act(async () => notify?.(null));
    expect(await screen.findByRole('button', { name: 'Sign in with Microsoft' })).toBeVisible();
    expect(appHeading()).toBeNull();
  });

  it('keeps content protected after interactive sign-in fails', async () => {
    const auth = service();
    auth.signIn = vi.fn(async () => {
      throw new Error('Sign-in was cancelled.');
    });
    render(<Root rayfinAuthService={auth} />);
    const button = await screen.findByRole('button', { name: 'Sign in with Microsoft' });
    await act(async () => fireEvent.click(button));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in was cancelled.');
    expect(appHeading()).toBeNull();
  });

  it.each<AuthConfig>([
    { kind: 'not-deployed' },
    { kind: 'incomplete', missing: ['publishableKey'] },
    { kind: 'config-error', message: 'Runtime configuration is unavailable.' },
  ])('fails closed for $kind configuration', async (config) => {
    await act(async () => render(<Root rayfinAuthService={service(config)} />));
    expect(appHeading()).toBeNull();
    expect(whoAmI).not.toHaveBeenCalled();
  });
});
