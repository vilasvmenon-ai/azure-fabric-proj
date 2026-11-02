/**
 * Shared access-control conventions for the Address Structuring Lab entities.
 *
 * Rayfin supports only the built-in `authenticated` and `anonymous` roles and
 * policies built from `.eq()` on `claims.sub`, `claims.email` and
 * `claims.role`. Business roles are therefore resolved by trusted server code
 * (see packages/functions/src/authz.ts), never by these policies.
 *
 * SERVER_ONLY_LOCK: every entity must declare at least one permission, so
 * server-only entities grant `read` to `authenticated` behind a policy that
 * compares the caller's `sub` with a constant column value that no Rayfin
 * subject can equal. No create, update or delete is granted to any client
 * role. Functions write these tables through the Rayfin `ctx.Tokens.Sql`
 * application token instead (docs/DECISIONS.md D-21, D-22).
 */
export const SERVER_ONLY_LOCK = 'ionova:server-only';
