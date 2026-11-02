import { AppError } from './errors.js';

/**
 * Non-secret runtime configuration (docs/DECISIONS.md D-50).
 *
 * Supplied as one JSON value in the Rayfin function secret
 * `IONOVA_RUNTIME_CONFIG` (set by scripts/32-Set-RuntimeConfig.ps1 with
 * `rayfin secret set --stdin`), or locally through
 * packages/functions/local.settings.json `Values`. It contains endpoints and
 * identifiers only: every downstream call uses a Rayfin-issued token.
 */
export const RUNTIME_CONFIG_SECRET = 'IONOVA_RUNTIME_CONFIG';

/**
 * Local-only: password of the Rayfin Docker provider's SQL container, read from
 * local.settings.json `Values`. Never set on a deployed item; rejected unless
 * environment is 'local' (docs/LOCAL-TESTING.md, D-56).
 */
export const LOCAL_SQL_PASSWORD_SECRET = 'IONOVA_LOCAL_SQL_PASSWORD';

export type FaultInjection = 'none' | 'auditWrite' | 'storageWrite' | 'aiTimeout';
export type Environment = 'local' | 'dev' | 'uat' | 'prod';

export interface RuntimeConfig {
  orgId: string;
  projectId: string;
  appId: string;
  appName: string;
  environment: Environment;
  release: string;
  ownerEmail: string;
  foundry: {
    projectEndpoint: string;
    agentName: string;
    agentVersionLabel: string | null;
    apiVersion: string;
    timeoutMs: number;
    maxRetries: number;
    totalBudgetMs: number;
    /**
     * 'servicePrincipal' (D-03a): Foundry is in a different Entra tenant from Fabric; the function
     * gets a Foundry-tenant token with a service principal whose secret is a Rayfin function secret.
     * 'rayfinAppIdentity' (D-03): same tenant; uses ctx.Tokens.AzureAI (Fabric App item owner).
     */
    auth: 'servicePrincipal' | 'rayfinAppIdentity';
    /** servicePrincipal only (non-secret identifiers). */
    servicePrincipal: { tenantId: string; clientId: string } | null;
  };
  sql: {
    server: string;
    port: number;
    database: string;
    schema: string;
    /** 'entraToken' (Rayfin ctx.Tokens.Sql) everywhere except the local Docker stack. */
    auth: 'entraToken' | 'sqlLogin';
    /** sqlLogin only. */
    user: string | null;
    /** sqlLogin only: the local container uses a self-signed certificate. */
    trustServerCertificate: boolean;
  };
  bootstrapAdminEmails: string[];
  /** D-57: emails allowed to claim super_user (app_user + app_admin). Rejected when environment is 'prod'. */
  superUserEmails: string[];
  /** Ignored unless environment is 'local' or 'dev' (D-44). */
  faultInjection: FaultInjection;
}

const ENDPOINT_RE = /^https:\/\/[A-Za-z0-9.-]+\/api\/projects\/[A-Za-z0-9_.-]+\/?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,98}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

function fail(detail: string): never {
  throw new AppError('CONFIG', `The app's runtime configuration is invalid: ${detail}. Ask a project administrator to rerun scripts/32-Set-RuntimeConfig.ps1.`);
}

function str(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || !value.trim()) fail(`${path}${key} is required`);
  if (/YOUR-|<|>/.test(value)) fail(`${path}${key} still contains a placeholder`);
  return value.trim();
}

function num(obj: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = obj[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Normalise a secret value read from the Rayfin secret bag: strip a leading
 * UTF-8 byte-order mark (Windows PowerShell 5.1 adds one when piping to
 * `rayfin secret set --stdin`) and surrounding whitespace/newlines.
 */
export function cleanSecretValue(raw: string | undefined | null): string {
  return (raw ?? '').replace(/^﻿/, '').trim();
}

/** Parse and validate the configuration JSON. Throws AppError('CONFIG'). */
export function parseRuntimeConfig(rawInput: string | undefined | null): RuntimeConfig {
  const raw = cleanSecretValue(rawInput);
  if (!raw) fail(`${RUNTIME_CONFIG_SECRET} is not set`);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    fail(`${RUNTIME_CONFIG_SECRET} is not valid JSON`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('expected a JSON object');
  const o = data as Record<string, unknown>;
  const foundry = (o.foundry ?? {}) as Record<string, unknown>;
  const sqlCfg = (o.sql ?? {}) as Record<string, unknown>;

  const environment = str(o, 'environment', '');
  if (!['local', 'dev', 'uat', 'prod'].includes(environment)) fail('environment must be local, dev, uat or prod');

  for (const key of ['orgId', 'projectId', 'appId'] as const) {
    if (!SLUG_RE.test(str(o, key, ''))) fail(`${key} must use lowercase letters, numbers and hyphens`);
  }

  const projectEndpoint = str(foundry, 'projectEndpoint', 'foundry.');
  if (!ENDPOINT_RE.test(projectEndpoint)) {
    fail('foundry.projectEndpoint must be the project endpoint copied from Foundry, including /api/projects/<project>');
  }
  const agentName = str(foundry, 'agentName', 'foundry.');
  if (!NAME_RE.test(agentName)) fail('foundry.agentName contains unsupported characters');
  const agentVersionLabel =
    typeof foundry.agentVersionLabel === 'string' && foundry.agentVersionLabel.trim()
      ? foundry.agentVersionLabel.trim()
      : null;
  const apiVersion = typeof foundry.apiVersion === 'string' && foundry.apiVersion ? foundry.apiVersion : 'v1';
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const foundryAuth = foundry.auth === 'rayfinAppIdentity' ? 'rayfinAppIdentity' : 'servicePrincipal';
  let servicePrincipal: { tenantId: string; clientId: string } | null = null;
  if (foundryAuth === 'servicePrincipal') {
    const sp = (foundry.servicePrincipal ?? {}) as Record<string, unknown>;
    const tenantId = str(sp, 'tenantId', 'foundry.servicePrincipal.');
    const clientId = str(sp, 'clientId', 'foundry.servicePrincipal.');
    if (!GUID_RE.test(tenantId) || !GUID_RE.test(clientId)) fail('foundry.servicePrincipal tenantId and clientId must be GUIDs');
    servicePrincipal = { tenantId, clientId };
  }

  // Accept "host" or "host,port" (the Fabric serverFqdn form).
  const serverRaw = str(sqlCfg, 'server', 'sql.');
  const [host, portText] = serverRaw.split(',');
  const port = typeof sqlCfg.port === 'number' ? sqlCfg.port : portText ? Number(portText) : 1433;
  if (!/^[A-Za-z0-9.-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) fail('sql.server must be the SQL database serverFqdn');
  const database = str(sqlCfg, 'database', 'sql.');
  const schema = typeof sqlCfg.schema === 'string' && sqlCfg.schema ? sqlCfg.schema : 'dbo';
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(schema)) fail('sql.schema is not a valid identifier');
  const sqlAuth = sqlCfg.auth === 'sqlLogin' ? 'sqlLogin' : 'entraToken';
  // SQL logins exist only for the local Docker container; deployed apps must use the Rayfin token.
  if (sqlAuth === 'sqlLogin' && environment !== 'local') fail('sql.auth "sqlLogin" is only allowed when environment is local');
  const sqlUser = sqlAuth === 'sqlLogin' ? str(sqlCfg, 'user', 'sql.') : null;
  const trustServerCertificate = sqlAuth === 'sqlLogin' && sqlCfg.trustServerCertificate === true;

  const bootstrap = Array.isArray(o.bootstrapAdminEmails) ? o.bootstrapAdminEmails : [];
  const bootstrapAdminEmails = bootstrap
    .filter((e): e is string => typeof e === 'string' && e.includes('@'))
    .map((e) => e.trim().toLowerCase());

  const superRaw = Array.isArray(o.superUserEmails) ? o.superUserEmails : [];
  const superUserEmails = superRaw
    .filter((e): e is string => typeof e === 'string' && e.includes('@'))
    .map((e) => e.trim().toLowerCase());
  if (superUserEmails.length && environment === 'prod') fail('superUserEmails is not allowed in prod');

  const fi = typeof o.faultInjection === 'string' ? o.faultInjection : 'none';
  if (!['none', 'auditWrite', 'storageWrite', 'aiTimeout'].includes(fi)) fail('faultInjection is not recognised');

  return {
    orgId: str(o, 'orgId', ''),
    projectId: str(o, 'projectId', ''),
    appId: str(o, 'appId', ''),
    appName: typeof o.appName === 'string' && o.appName ? o.appName : 'Address Structuring Lab',
    environment: environment as RuntimeConfig['environment'],
    release: str(o, 'release', ''),
    ownerEmail: str(o, 'ownerEmail', '').toLowerCase(),
    foundry: {
      projectEndpoint: projectEndpoint.replace(/\/$/, ''),
      agentName,
      agentVersionLabel,
      apiVersion,
      timeoutMs: num(foundry, 'timeoutMs', 60_000, 1_000, 120_000),
      maxRetries: num(foundry, 'maxRetries', 1, 0, 2),
      totalBudgetMs: num(foundry, 'totalBudgetMs', 150_000, 5_000, 200_000),
      auth: foundryAuth,
      servicePrincipal,
    },
    sql: { server: host, port, database, schema, auth: sqlAuth, user: sqlUser, trustServerCertificate },
    bootstrapAdminEmails,
    superUserEmails,
    faultInjection: fi as FaultInjection,
  };
}

/** Fault injection is honoured only in local and dev (D-44). */
export function activeFault(config: RuntimeConfig): FaultInjection {
  return config.environment === 'dev' || config.environment === 'local' ? config.faultInjection : 'none';
}
