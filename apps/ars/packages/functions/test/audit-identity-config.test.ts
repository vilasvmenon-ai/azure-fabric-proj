import { describe, expect, it } from 'vitest';

import { buildAuditRow, GENESIS_HASH, verifyAuditChain, type AuditRow } from '../src/audit.js';
import { activeFault, cleanSecretValue, parseRuntimeConfig } from '../src/config.js';
import { callerFromClaims, decodeJwtClaims, resolveCaller } from '../src/identity.js';
import { testConfig } from './helpers.js';

const ctx = { orgId: 'ionova', projectId: 'ai-lab', appId: 'ars', environment: 'dev', release: '1' };

function chain(n: number): AuditRow[] {
  const rows: AuditRow[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push(
      buildAuditRow(
        { action: 'x', objectType: 'T', objectId: String(i), outcome: 'SUCCESS', actorSub: 's', actorEmail: 'a@b.c', correlationId: 'corr-0001', details: { i } },
        ctx,
        i,
        i === 1 ? GENESIS_HASH : rows[i - 2].event_hash,
        `00000000-0000-4000-8000-00000000000${i}`,
        new Date(Date.UTC(2026, 9, 26, 10, 0, i))
      )
    );
  }
  return rows;
}

describe('audit hash chain', () => {
  it('verifies an intact chain', () => {
    expect(verifyAuditChain(chain(4))).toMatchObject({ intact: true, checked: 4 });
  });
  it('detects an edited event', () => {
    const rows = chain(3);
    rows[1] = { ...rows[1], outcome: 'FAILURE' };
    expect(verifyAuditChain(rows)).toMatchObject({ intact: false, firstBrokenSeq: 2 });
  });
  it('detects a deleted event', () => {
    const rows = chain(3);
    rows.splice(1, 1);
    expect(verifyAuditChain(rows)).toMatchObject({ intact: false, firstBrokenSeq: 2 });
  });
  it('rejects oversized details', () => {
    expect(() =>
      buildAuditRow({ action: 'x', objectType: 'T', objectId: null, outcome: 'SUCCESS', actorSub: null, actorEmail: null, correlationId: 'c', details: { big: 'x'.repeat(3000) } }, ctx, 1, GENESIS_HASH, 'id', new Date())
    ).toThrow();
  });
});

const jwt = (claims: Record<string, unknown>) =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

describe('caller identity', () => {
  it('decodes sub and email', () => {
    expect(callerFromClaims(decodeJwtClaims(jwt({ sub: 'u1', email: 'A@B.com', exp: 2e9 })), 1e9)).toEqual({ sub: 'u1', email: 'a@b.com' });
  });
  it('reads the email from a Rayfin managed-hosting token (xms_attr.{appId}.rfn_email) and keeps the raw sub', () => {
    const managed = {
      sub: '/tenants/t1/workspaces/w1/appbackends/a1/users/0f8fad5b-d9cb-469f-a165-70867728950e',
      idtyp: 'fmi',
      exp: 2e9,
      xms_attr: { 'f29a149f-0d00-4ef4-b61d-81d920786338': { rfn_email: 'Vilas@ionova.ai' } },
    };
    expect(callerFromClaims(managed, 1e9)).toEqual({ sub: managed.sub, email: 'vilas@ionova.ai' });
  });

  it('rejects expired tokens, missing sub or email', () => {
    expect(() => callerFromClaims({ sub: 'u1', email: 'a@b.c', exp: 10 }, 20)).toThrow(/expired/);
    expect(() => callerFromClaims({ email: 'a@b.c' }, 0)).toThrow();
    expect(() => callerFromClaims({ sub: 'u1' }, 0)).toThrow(/email/);
    expect(() => decodeJwtClaims('garbage')).toThrow();
  });
  it('denies when the live data-API probe rejects the token', async () => {
    await expect(resolveCaller(jwt({ sub: 'u', email: 'a@b.c' }), async () => Promise.reject(new Error('401')), 0)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(resolveCaller(undefined, async () => undefined)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('runtime configuration', () => {
  const valid = () => JSON.parse(JSON.stringify(testConfig()));
  it('parses a valid configuration and splits the server port', () => {
    const raw = valid();
    raw.sql.server = 'abc.database.fabric.microsoft.com,1433';
    const c = parseRuntimeConfig(JSON.stringify(raw));
    expect(c.sql).toMatchObject({ server: 'abc.database.fabric.microsoft.com', port: 1433 });
  });
  it('rejects placeholders, bad endpoints and missing values', () => {
    const a = valid();
    a.foundry.projectEndpoint = 'https://YOUR-RESOURCE.services.ai.azure.com/api/projects/x';
    expect(() => parseRuntimeConfig(JSON.stringify(a))).toThrow(/placeholder/);
    const b = valid();
    b.foundry.projectEndpoint = 'https://example.com/other';
    expect(() => parseRuntimeConfig(JSON.stringify(b))).toThrow(/projectEndpoint/);
    expect(() => parseRuntimeConfig(undefined)).toThrow(/not set/);
    expect(() => parseRuntimeConfig('{')).toThrow(/JSON/);
  });
  it('accepts a value stored with a UTF-8 BOM and trailing newline (PowerShell 5.1 stdin piping)', () => {
    const raw = '﻿' + JSON.stringify(valid()) + '\r\n';
    expect(parseRuntimeConfig(raw).appId).toBe('ars');
    expect(cleanSecretValue('﻿s3cr3t~value\r\n')).toBe('s3cr3t~value');
    expect(cleanSecretValue(undefined)).toBe('');
  });

  it('rejects superUserEmails in prod (D-57)', () => {
    const prod = { ...valid(), environment: 'prod', superUserEmails: ['a@b.c'] };
    expect(() => parseRuntimeConfig(JSON.stringify(prod))).toThrow(/superUserEmails is not allowed in prod/);
    expect(parseRuntimeConfig(JSON.stringify({ ...valid(), environment: 'dev', superUserEmails: ['A@B.c'] })).superUserEmails).toEqual(['a@b.c']);
  });

  it('ignores fault injection outside local and dev', () => {
    expect(activeFault(testConfig({ environment: 'prod', faultInjection: 'auditWrite' }))).toBe('none');
    expect(activeFault(testConfig({ environment: 'uat', faultInjection: 'auditWrite' }))).toBe('none');
    expect(activeFault(testConfig({ environment: 'dev', faultInjection: 'auditWrite' }))).toBe('auditWrite');
    expect(activeFault(testConfig({ environment: 'local', faultInjection: 'aiTimeout' }))).toBe('aiTimeout');
  });

  it('allows a SQL login only for the local Docker stack (D-56)', () => {
    const local = valid();
    local.environment = 'local';
    local.sql = { server: 'localhost', port: 14330, database: 'appdb', auth: 'sqlLogin', user: 'sa', trustServerCertificate: true };
    expect(parseRuntimeConfig(JSON.stringify(local)).sql).toMatchObject({ server: 'localhost', port: 14330, auth: 'sqlLogin', user: 'sa', trustServerCertificate: true });
    for (const env of ['dev', 'uat', 'prod']) {
      const deployed = { ...local, environment: env };
      expect(() => parseRuntimeConfig(JSON.stringify(deployed))).toThrow(/only allowed when environment is local/);
    }
  });

  it('defaults to the Rayfin Entra token and never trusts a server certificate in deployed environments', () => {
    const c = parseRuntimeConfig(JSON.stringify({ ...valid(), sql: { ...valid().sql, trustServerCertificate: true } }));
    expect(c.sql).toMatchObject({ auth: 'entraToken', user: null, trustServerCertificate: false });
  });
});
