import { randomUUID } from 'node:crypto';

import {
  AudienceType,
  UserDataFunctions,
  type RayfinContext,
} from '@microsoft/fabric-user-data-functions';
import type {
  ApiResult,
  AuditChainResponse,
  AuditEventView,
  AuditExportResponse,
  AuditSearchRequest,
  BaseRequest,
  DiagnosticsResponse,
  EvaluationSampleRequest,
  EvaluationSampleResponse,
  FoundryProbeResponse,
  GrantMembershipRequest,
  ListRecordsRequest,
  MembershipView,
  Page,
  RecordDetail,
  RecordSummary,
  RequestIdRequest,
  RevokeMembershipRequest,
  SeedResponse,
  SubmitAddressRequest,
  SubmitAddressResponse,
  SubmitReviewRequest,
  UniversalAppSchema,
  WhoAmIResponse,
} from '@rayfin-app/shared';

import { activeFault, cleanSecretValue, LOCAL_SQL_PASSWORD_SECRET, parseRuntimeConfig, RUNTIME_CONFIG_SECRET } from './config.js';
import { AppError, categoryFor } from './errors.js';
import { invokeAgent } from './foundry.js';
import { FOUNDRY_CLIENT_SECRET_NAME, getFoundryTokenWithServicePrincipal } from './foundryToken.js';
import { resolveCaller } from './identity.js';
import { AppService } from './service.js';
import { SqlStore, type SqlConnectionAuth } from './sqlStore.js';
import { logEvent } from './telemetry.js';

/**
 * Address Structuring Lab — Rayfin Functions.
 *
 * Every function:
 *  - takes one `req` object (correlation id + operation input),
 *  - returns ApiResult<T> ({ok, data|error, correlationId}) with sanitized errors,
 *  - resolves the caller from the invocation's Rayfin token and business roles
 *    from the app database (never from the browser),
 *  - uses `ctx.Tokens.Sql` (app identity) for the app database and, where
 *    declared, `ctx.Tokens.AzureAI` (app identity) for the existing Foundry agent.
 *
 * Audiences are declared inline on each handler's RayfinContext annotation, as
 * the Rayfin type generator requires.
 */
const udf = new UserDataFunctions();

const CORRELATION_RE = /^[A-Za-z0-9-]{8,64}$/;

type SqlContext = RayfinContext<UniversalAppSchema, AudienceType.Sql>;

async function run<T>(
  op: string,
  req: BaseRequest | undefined,
  ctx: SqlContext,
  aiToken: (() => string) | null,
  work: (svc: AppService) => Promise<T>
): Promise<ApiResult<T>> {
  const correlationId =
    typeof req?.correlationId === 'string' && CORRELATION_RE.test(req.correlationId) ? req.correlationId : randomUUID();
  const started = Date.now();
  let store: SqlStore | undefined;
  let aiLatencyMs: number | undefined;
  try {
    // Non-secret runtime configuration lives in one Rayfin function secret
    // (D-50). It is deliberately read with getSecret: the name is set by the
    // deployment script, after the first deploy has created the item.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const config = parseRuntimeConfig(ctx.getSecret(RUNTIME_CONFIG_SECRET));

    const caller = await resolveCaller(ctx.accessToken, () =>
      ctx.getDataClient().SampleAddress.select(['id']).first(1).execute()
    );

    const fault = activeFault(config);
    let auth: SqlConnectionAuth;
    if (config.sql.auth === 'sqlLogin') {
      // Local Docker stack only; config.ts rejects sqlLogin outside environment 'local'.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const password = cleanSecretValue(ctx.getSecret(LOCAL_SQL_PASSWORD_SECRET));
      if (!password) throw new AppError('CONFIG', `Local SQL password ${LOCAL_SQL_PASSWORD_SECRET} is not set in local.settings.json.`);
      auth = { kind: 'sqlLogin', user: config.sql.user ?? '', password, trustServerCertificate: config.sql.trustServerCertificate };
    } else {
      auth = { kind: 'entraToken', token: ctx.Tokens.Sql };
    }
    try {
      store = await SqlStore.connect({
        server: config.sql.server,
        port: config.sql.port,
        database: config.sql.database,
        schema: config.sql.schema,
        auth,
        appId: config.appId,
        auditContext: {
          orgId: config.orgId,
          projectId: config.projectId,
          appId: config.appId,
          environment: config.environment,
          release: config.release,
        },
        fault,
      });
    } catch {
      throw new AppError('STORAGE_FAILURE', 'The app database is unavailable. Try again later.');
    }

    const foundryCfg =
      fault === 'aiTimeout'
        ? { ...config.foundry, timeoutMs: 1, maxRetries: 0 }
        : config.foundry;
    const svc = new AppService({
      config,
      store,
      caller,
      correlationId,
      newId: randomUUID,
      callAgent: async (input) => {
        if (!aiToken) throw new AppError('CONFIG', 'This operation is not allowed to call the address service.');
        let token: string;
        if (config.foundry.auth === 'servicePrincipal' && config.foundry.servicePrincipal) {
          // Cross-tenant Foundry (D-03a): token issued in the Foundry tenant by a dedicated service principal.
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          const secret = cleanSecretValue(ctx.getSecret(FOUNDRY_CLIENT_SECRET_NAME));
          if (!secret) throw new AppError('CONFIG', `The Foundry service principal secret ${FOUNDRY_CLIENT_SECRET_NAME} is not set. Ask a project administrator to run scripts/41-Setup-FoundryServicePrincipal.ps1.`);
          token = await getFoundryTokenWithServicePrincipal(config.foundry.servicePrincipal, secret);
        } else {
          token = aiToken();
        }
        const result = await invokeAgent(foundryCfg, token, input);
        aiLatencyMs = result.latencyMs;
        return result;
      },
    });

    const data = await work(svc);
    logEvent('op.completed', { op, correlationId, outcome: 'success', durationMs: Date.now() - started, aiLatencyMs, release: config.release });
    return { ok: true, data, correlationId };
  } catch (err) {
    if (err instanceof AppError) {
      logEvent('op.failed', { op, correlationId, outcome: 'failure', code: err.code, failureCategory: categoryFor(err.code), durationMs: Date.now() - started, aiLatencyMs });
      return { ok: false, error: err.toApiError(), correlationId };
    }
    logEvent('op.failed', { op, correlationId, outcome: 'failure', code: 'INTERNAL', failureCategory: 'internal', errorName: err instanceof Error ? err.name : 'unknown', durationMs: Date.now() - started });
    return {
      ok: false,
      error: { code: 'INTERNAL', message: 'An unexpected error occurred. Quote the correlation ID when you contact support.' },
      correlationId,
    };
  } finally {
    if (store) await store.close().catch(() => undefined);
  }
}

// --- Session ------------------------------------------------------------------

udf.func(
  'whoAmI',
  async (req: BaseRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<WhoAmIResponse>> =>
    run('whoAmI', req, ctx, null, (svc) => svc.whoAmI()),
  []
);

udf.func(
  'bootstrapAppAdmin',
  async (req: BaseRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<MembershipView>> =>
    run('bootstrapAppAdmin', req, ctx, null, (svc) => svc.bootstrapAppAdmin()),
  []
);

udf.func(
  'claimSuperUser',
  async (req: BaseRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<MembershipView>> =>
    run('claimSuperUser', req, ctx, null, (svc) => svc.claimSuperUser()),
  []
);

// --- Address workflow ------------------------------------------------------------

udf.func(
  'submitAddress',
  async (
    req: SubmitAddressRequest,
    ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql | AudienceType.AzureAI>
  ): Promise<ApiResult<SubmitAddressResponse>> =>
    run('submitAddress', req, ctx, () => ctx.Tokens.AzureAI, (svc) => svc.submitAddress(req)),
  []
);

udf.func(
  'retryProcessing',
  async (
    req: RequestIdRequest,
    ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql | AudienceType.AzureAI>
  ): Promise<ApiResult<RecordDetail>> =>
    run('retryProcessing', req, ctx, () => ctx.Tokens.AzureAI, (svc) => svc.retryProcessing(req)),
  []
);

udf.func(
  'getRequestStatus',
  async (req: RequestIdRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<RecordSummary>> =>
    run('getRequestStatus', req, ctx, null, (svc) => svc.getRequestStatus(req)),
  []
);

udf.func(
  'listRecords',
  async (req: ListRecordsRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<Page<RecordSummary>>> =>
    run('listRecords', req, ctx, null, (svc) => svc.listRecords(req)),
  []
);

udf.func(
  'getRecord',
  async (req: RequestIdRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<RecordDetail>> =>
    run('getRecord', req, ctx, null, (svc) => svc.getRecord(req)),
  []
);

udf.func(
  'submitReview',
  async (req: SubmitReviewRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<RecordDetail>> =>
    run('submitReview', req, ctx, null, (svc) => svc.submitReview(req)),
  []
);

// --- Audit -------------------------------------------------------------------------

udf.func(
  'searchAudit',
  async (req: AuditSearchRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<Page<AuditEventView>>> =>
    run('searchAudit', req, ctx, null, (svc) => svc.searchAudit(req)),
  []
);

udf.func(
  'exportAudit',
  async (req: AuditSearchRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<AuditExportResponse>> =>
    run('exportAudit', req, ctx, null, (svc) => svc.exportAudit(req)),
  []
);

udf.func(
  'verifyAuditChain',
  async (req: BaseRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<AuditChainResponse>> =>
    run('verifyAuditChain', req, ctx, null, (svc) => svc.verifyAuditChain()),
  []
);

// --- Membership administration --------------------------------------------------------

udf.func(
  'listMembers',
  async (req: BaseRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<MembershipView[]>> =>
    run('listMembers', req, ctx, null, (svc) => svc.listMembers()),
  []
);

udf.func(
  'grantMembership',
  async (req: GrantMembershipRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<MembershipView>> =>
    run('grantMembership', req, ctx, null, (svc) => svc.grantMembership(req)),
  []
);

udf.func(
  'revokeMembership',
  async (req: RevokeMembershipRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<MembershipView>> =>
    run('revokeMembership', req, ctx, null, (svc) => svc.revokeMembership(req)),
  []
);

// --- Configuration, readiness and evaluation ---------------------------------------------

udf.func(
  'seedSampleData',
  async (req: BaseRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<SeedResponse>> =>
    run('seedSampleData', req, ctx, null, (svc) => svc.seedSampleData()),
  []
);

udf.func(
  'diagnostics',
  async (req: BaseRequest, ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql>): Promise<ApiResult<DiagnosticsResponse>> =>
    run('diagnostics', req, ctx, null, (svc) => svc.diagnostics()),
  []
);

udf.func(
  'probeFoundry',
  async (
    req: BaseRequest,
    ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql | AudienceType.AzureAI>
  ): Promise<ApiResult<FoundryProbeResponse>> =>
    run('probeFoundry', req, ctx, () => ctx.Tokens.AzureAI, (svc) => svc.probeFoundry()),
  []
);

udf.func(
  'runEvaluationSample',
  async (
    req: EvaluationSampleRequest,
    ctx: RayfinContext<UniversalAppSchema, AudienceType.Sql | AudienceType.AzureAI>
  ): Promise<ApiResult<EvaluationSampleResponse>> =>
    run('runEvaluationSample', req, ctx, () => ctx.Tokens.AzureAI, (svc) => svc.runEvaluationSample(req)),
  []
);
