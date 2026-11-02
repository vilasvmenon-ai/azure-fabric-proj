import { AppError } from './errors.js';

/**
 * Caller identity for a function invocation (D-13).
 *
 * The Rayfin docs say the invocation's Rayfin JWT is `ctx.accessToken` and
 * that its `sub` claim is the stable user id. The docs do not say whether the
 * Functions host validates that token before the handler runs, so after
 * decoding it we prove it is live by making one Rayfin data-client call with
 * it (`probe`): the Rayfin data API rejects forged or expired tokens.
 */
export interface Caller {
  sub: string;
  email: string;
}

function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AppError('UNAUTHENTICATED', 'Your session is not valid. Sign in again.');
  try {
    const claims = JSON.parse(base64UrlDecode(parts[1]));
    if (!claims || typeof claims !== 'object') throw new Error('not an object');
    return claims as Record<string, unknown>;
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Your session is not valid. Sign in again.');
  }
}

/**
 * Rayfin managed-hosting (Fabric) tokens nest the email at `xms_attr.{appId}.rfn_email`
 * (same rule as @microsoft/rayfin-auth `extractEmailFromToken`); standard tokens use `email`.
 */
function nestedRayfinEmail(claims: Record<string, unknown>): string | undefined {
  const attrs = claims.xms_attr;
  if (!attrs || typeof attrs !== 'object') return undefined;
  for (const value of Object.values(attrs as Record<string, unknown>)) {
    const email = value && typeof value === 'object' ? (value as Record<string, unknown>).rfn_email : undefined;
    if (typeof email === 'string' && email.includes('@')) return email;
  }
  return undefined;
}

export function callerFromClaims(claims: Record<string, unknown>, nowSeconds: number): Caller {
  // The RAW sub is kept (for managed tokens it is a path ending in /users/<id>): Rayfin data
  // policies compare @claims.sub with stored owner columns, so both must use the same value.
  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  const emailClaim = [claims.email, nestedRayfinEmail(claims), claims.preferred_username, claims.upn].find(
    (v): v is string => typeof v === 'string' && v.includes('@')
  );
  const exp = typeof claims.exp === 'number' ? claims.exp : null;
  if (!sub || sub.length > 200) throw new AppError('UNAUTHENTICATED', 'Your session has no user identity. Sign in again.');
  if (exp !== null && exp < nowSeconds) throw new AppError('UNAUTHENTICATED', 'Your session has expired. Sign in again.');
  if (!emailClaim) throw new AppError('UNAUTHENTICATED', 'Your session has no email address, so app membership cannot be checked.');
  return { sub, email: emailClaim.trim().toLowerCase() };
}

export async function resolveCaller(
  accessToken: string | undefined,
  probe: () => Promise<unknown>,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<Caller> {
  if (!accessToken) throw new AppError('UNAUTHENTICATED', 'Sign in to use this app.');
  const caller = callerFromClaims(decodeJwtClaims(accessToken), nowSeconds);
  try {
    await probe();
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Your session could not be verified. Sign in again.');
  }
  return caller;
}
