import type {
  ApiResult,
  AuditSearchRequest,
  EvaluationSampleRequest,
  GrantMembershipRequest,
  ListRecordsRequest,
  RequestIdRequest,
  RevokeMembershipRequest,
  SampleAddressView,
  SubmitAddressRequest,
  SubmitReviewRequest,
} from '@rayfin-app/shared';

import { getRayfinClient } from './rayfin-client';

/**
 * Typed calls to the app's Rayfin Functions.
 *
 * Every call carries a browser-generated correlation id (LOG-01) and always
 * resolves to an ApiResult: transport failures (FunctionsError, NetworkError)
 * are mapped to a safe error carrying the same correlation id, so the UI has
 * one error path. React components never see raw model output.
 */
type Client = Awaited<ReturnType<typeof getRayfinClient>>;
type WithoutCorrelation<T> = Omit<T, 'correlationId'>;

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

async function call<T>(
  invoke: (client: Client, correlationId: string) => Promise<ApiResult<T>>,
  timeoutMs?: number
): Promise<ApiResult<T>> {
  const correlationId = newCorrelationId();
  try {
    const client = await getRayfinClient();
    const result = await (timeoutMs
      ? Promise.race([
          invoke(client, correlationId),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
        ])
      : invoke(client, correlationId));
    return result;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const timedOut = err instanceof Error && err.message === 'timeout';
    return {
      ok: false,
      correlationId,
      error: {
        code: timedOut ? 'AI_TIMEOUT' : 'INTERNAL',
        message: timedOut
          ? 'The request took too long. It may still complete; check My records before resubmitting.'
          : name === 'NetworkError'
            ? 'The app could not reach its backend. Check your connection and try again.'
            : 'The request failed before the app could respond. Try again, and quote the correlation ID if it keeps happening.',
      },
    };
  }
}

/** Address submission can include an AI call; allow up to the platform ceiling. */
const AI_TIMEOUT_MS = 245_000;

export const api = {
  whoAmI: () => call((c, correlationId) => c.functions.whoAmI.invoke({ req: { correlationId } })),
  bootstrapAppAdmin: () => call((c, correlationId) => c.functions.bootstrapAppAdmin.invoke({ req: { correlationId } })),
  claimSuperUser: () => call((c, correlationId) => c.functions.claimSuperUser.invoke({ req: { correlationId } })),

  submitAddress: (req: WithoutCorrelation<SubmitAddressRequest>) =>
    call((c, correlationId) => c.functions.submitAddress.invoke({ req: { ...req, correlationId } }, { timeoutMs: AI_TIMEOUT_MS }), AI_TIMEOUT_MS + 5_000),
  retryProcessing: (req: WithoutCorrelation<RequestIdRequest>) =>
    call((c, correlationId) => c.functions.retryProcessing.invoke({ req: { ...req, correlationId } }, { timeoutMs: AI_TIMEOUT_MS }), AI_TIMEOUT_MS + 5_000),
  getRequestStatus: (req: WithoutCorrelation<RequestIdRequest>) =>
    call((c, correlationId) => c.functions.getRequestStatus.invoke({ req: { ...req, correlationId } })),
  listRecords: (req: WithoutCorrelation<ListRecordsRequest>) =>
    call((c, correlationId) => c.functions.listRecords.invoke({ req: { ...req, correlationId } })),
  getRecord: (req: WithoutCorrelation<RequestIdRequest>) =>
    call((c, correlationId) => c.functions.getRecord.invoke({ req: { ...req, correlationId } })),
  submitReview: (req: WithoutCorrelation<SubmitReviewRequest>) =>
    call((c, correlationId) => c.functions.submitReview.invoke({ req: { ...req, correlationId } })),

  searchAudit: (req: WithoutCorrelation<AuditSearchRequest>) =>
    call((c, correlationId) => c.functions.searchAudit.invoke({ req: { ...req, correlationId } })),
  exportAudit: (req: WithoutCorrelation<AuditSearchRequest>) =>
    call((c, correlationId) => c.functions.exportAudit.invoke({ req: { ...req, correlationId } })),
  verifyAuditChain: () => call((c, correlationId) => c.functions.verifyAuditChain.invoke({ req: { correlationId } })),

  listMembers: () => call((c, correlationId) => c.functions.listMembers.invoke({ req: { correlationId } })),
  grantMembership: (req: WithoutCorrelation<GrantMembershipRequest>) =>
    call((c, correlationId) => c.functions.grantMembership.invoke({ req: { ...req, correlationId } })),
  revokeMembership: (req: WithoutCorrelation<RevokeMembershipRequest>) =>
    call((c, correlationId) => c.functions.revokeMembership.invoke({ req: { ...req, correlationId } })),

  seedSampleData: () => call((c, correlationId) => c.functions.seedSampleData.invoke({ req: { correlationId } })),
  diagnostics: () => call((c, correlationId) => c.functions.diagnostics.invoke({ req: { correlationId } })),
  probeFoundry: () =>
    call((c, correlationId) => c.functions.probeFoundry.invoke({ req: { correlationId } }, { timeoutMs: AI_TIMEOUT_MS }), AI_TIMEOUT_MS + 5_000),
  runEvaluationSample: (req: WithoutCorrelation<EvaluationSampleRequest>) =>
    call((c, correlationId) => c.functions.runEvaluationSample.invoke({ req: { ...req, correlationId } }, { timeoutMs: AI_TIMEOUT_MS }), AI_TIMEOUT_MS + 5_000),
};

/** Synthetic samples through the generated data API (readable by signed-in users). */
export async function listSamplesViaDataApi(): Promise<SampleAddressView[]> {
  const client = await getRayfinClient();
  const rows = await client.data.SampleAddress.select(['id', 'label', 'address', 'sort_order']).orderBy({ sort_order: 'asc' }).execute();
  return rows.map((r) => ({ id: r.id, label: r.label, address: r.address }));
}
