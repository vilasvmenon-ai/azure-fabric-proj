import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearFoundryTokenCache, FOUNDRY_SCOPE, getFoundryTokenWithServicePrincipal } from '../src/foundryToken.js';
import { parseRuntimeConfig } from '../src/config.js';
import { testConfig } from './helpers.js';

const sp = { tenantId: '26919914-5baa-4bb7-b4c8-c39efb7fa94e', clientId: '11111111-2222-4333-8444-555555555555' };
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('cross-tenant Foundry token (D-03a)', () => {
  beforeEach(() => clearFoundryTokenCache());

  it('uses the client-credentials grant in the FOUNDRY tenant with the ai.azure.com scope', async () => {
    const fetchImpl = vi.fn(async () => ok({ access_token: 'tok-1', expires_in: 3599 }));
    const token = await getFoundryTokenWithServicePrincipal(sp, 'secret-value', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(token).toBe('tok-1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://login.microsoftonline.com/${sp.tenantId}/oauth2/v2.0/token`);
    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: sp.clientId, client_secret: 'secret-value', scope: FOUNDRY_SCOPE });
  });

  it('reuses a cached token until 5 minutes before expiry', async () => {
    let t = 0;
    const now = () => t;
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({ access_token: 'a', expires_in: 3600 })).mockResolvedValueOnce(ok({ access_token: 'b', expires_in: 3600 }));
    expect(await getFoundryTokenWithServicePrincipal(sp, 's', { fetchImpl, now })).toBe('a');
    t = 50 * 60_000;
    expect(await getFoundryTokenWithServicePrincipal(sp, 's', { fetchImpl, now })).toBe('a');
    t = 56 * 60_000;
    expect(await getFoundryTokenWithServicePrincipal(sp, 's', { fetchImpl, now })).toBe('b');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps an expired or wrong secret to an auth failure without exposing the response', async () => {
    const fetchImpl = vi.fn(async () => ok({ error: 'invalid_client', error_description: 'AADSTS7000222 secret expired' }, 401));
    await expect(getFoundryTokenWithServicePrincipal(sp, 's', { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('maps an Entra outage to unavailable', async () => {
    const fetchImpl = vi.fn(async () => ok({}, 503));
    await expect(getFoundryTokenWithServicePrincipal(sp, 's', { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('Foundry auth configuration', () => {
  const raw = () => JSON.parse(JSON.stringify(testConfig()));

  it('defaults to the service principal mode and requires GUID identifiers', () => {
    expect(parseRuntimeConfig(JSON.stringify(raw())).foundry).toMatchObject({ auth: 'servicePrincipal', servicePrincipal: sp });
    const bad = raw();
    bad.foundry.servicePrincipal.clientId = 'not-a-guid';
    expect(() => parseRuntimeConfig(JSON.stringify(bad))).toThrow(/GUIDs/);
    const missing = raw();
    delete missing.foundry.servicePrincipal;
    expect(() => parseRuntimeConfig(JSON.stringify(missing))).toThrow(/servicePrincipal/);
  });

  it('supports the same-tenant Rayfin app identity mode without service principal values', () => {
    const same = raw();
    same.foundry.auth = 'rayfinAppIdentity';
    delete same.foundry.servicePrincipal;
    expect(parseRuntimeConfig(JSON.stringify(same)).foundry).toMatchObject({ auth: 'rayfinAppIdentity', servicePrincipal: null });
  });

  it('never accepts a client secret inside the runtime configuration', () => {
    // The secret lives only in the Rayfin secret IONOVA_FOUNDRY_CLIENT_SECRET; extra fields are ignored and not returned.
    const withSecret = raw();
    withSecret.foundry.servicePrincipal.clientSecret = 'should-not-be-here';
    expect(JSON.stringify(parseRuntimeConfig(JSON.stringify(withSecret)))).not.toContain('should-not-be-here');
  });
});
