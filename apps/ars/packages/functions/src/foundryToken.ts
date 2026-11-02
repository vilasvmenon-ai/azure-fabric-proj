import { FoundryError } from './foundry.js';

/**
 * Cross-tenant Foundry access (docs/DECISIONS.md D-03a).
 *
 * Fabric (ioNova tenant) and the existing Foundry project (a different tenant)
 * live in separate Microsoft Entra tenants. The Rayfin `ctx.Tokens.AzureAI`
 * token is issued in the Fabric tenant and is rejected by Foundry, so the
 * function obtains a token IN THE FOUNDRY TENANT with the OAuth 2.0
 * client-credentials grant of a dedicated service principal that holds only
 * the "Azure AI User" role on the Foundry project.
 *
 * The client secret is a Rayfin function secret (`rayfin secret set --stdin`);
 * it never appears in source, configuration files, logs or the browser.
 */
export const FOUNDRY_CLIENT_SECRET_NAME = 'IONOVA_FOUNDRY_CLIENT_SECRET';
export const FOUNDRY_SCOPE = 'https://ai.azure.com/.default';

export interface ServicePrincipalConfig {
  tenantId: string;
  clientId: string;
}

interface CachedToken {
  key: string;
  token: string;
  expiresAt: number;
}

// Per-process cache: a warm Functions worker reuses the token until 5 minutes before expiry.
let cache: CachedToken | null = null;

export function clearFoundryTokenCache(): void {
  cache = null;
}

export interface TokenDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export async function getFoundryTokenWithServicePrincipal(
  sp: ServicePrincipalConfig,
  clientSecret: string,
  deps: TokenDeps = {}
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const key = `${sp.tenantId}:${sp.clientId}`;
  if (cache && cache.key === key && cache.expiresAt - 5 * 60_000 > now()) return cache.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(sp.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: sp.clientId,
        client_secret: clientSecret,
        scope: FOUNDRY_SCOPE,
      }).toString(),
      signal: controller.signal,
    });
  } catch {
    throw new FoundryError(controller.signal.aborted ? 'timeout' : 'unavailable', null, 0);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // 400/401 from Entra: wrong tenant/client id, or an expired/revoked secret. Never log the body (it may echo identifiers).
    throw new FoundryError(res.status >= 500 ? 'unavailable' : 'auth', res.status, 0);
  }
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!body || typeof body.access_token !== 'string') throw new FoundryError('auth', res.status, 0);
  const lifetime = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in ?? 3600);
  cache = { key, token: body.access_token, expiresAt: now() + (Number.isFinite(lifetime) ? lifetime : 3600) * 1000 };
  return body.access_token;
}
