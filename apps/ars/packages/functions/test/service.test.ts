import { randomUUID } from 'node:crypto';

import type { MembershipRole } from '@rayfin-app/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { FoundryError, type FoundryInvokeResult } from '../src/foundry.js';
import type { Caller } from '../src/identity.js';
import { SAMPLES } from '../src/samples.js';
import { AppService } from '../src/service.js';
import { agentOutputFor, testConfig } from './helpers.js';
import { MemoryStore } from './memoryStore.js';

// Users used across the PRD AC-04 separation tests.
const USER_A: Caller = { sub: 'sub-user-a', email: 'user.a@ionova.test' };
const USER_B: Caller = { sub: 'sub-user-b', email: 'user.b@ionova.test' };
const REVIEWER: Caller = { sub: 'sub-reviewer', email: 'reviewer@ionova.test' };
const REVIEWER_2: Caller = { sub: 'sub-reviewer-2', email: 'reviewer2@ionova.test' };
const AUDITOR: Caller = { sub: 'sub-auditor', email: 'auditor@ionova.test' };
const EXPORTER: Caller = { sub: 'sub-exporter', email: 'exporter@ionova.test' };
const ADMIN: Caller = { sub: 'sub-admin', email: 'admin@ionova.test' };
const ADMIN_2: Caller = { sub: 'sub-admin-2', email: 'admin2@ionova.test' };
const NOBODY: Caller = { sub: 'sub-nobody', email: 'nobody@ionova.test' };

/** Default agent stub: returns the expected mapping for known samples (a test fake, not the real agent). */
function sampleAgent(): (input: string) => Promise<FoundryInvokeResult> {
  return async (input: string) => {
    const address = JSON.parse(input.split('\n')[1]).address as string;
    const sample = SAMPLES.find((s) => s.address === address);
    const expected = sample?.expected ?? { building: null, street: null, town: null, region: null, postcode: null, country: null };
    return { outputText: agentOutputFor(address, expected), responseId: 'resp_test', model: 'test-model', usage: null, latencyMs: 12, attempts: 1 };
  };
}

let store: MemoryStore;
let config: RuntimeConfig;
let agent: ReturnType<typeof vi.fn>;

function svc(caller: Caller, overrides: Partial<{ correlationId: string }> = {}): AppService {
  return new AppService({
    config,
    store,
    caller,
    correlationId: overrides.correlationId ?? `corr-${caller.sub}`,
    callAgent: agent as unknown as (i: string) => Promise<FoundryInvokeResult>,
    newId: randomUUID,
  });
}

function grant(caller: Caller, role: MembershipRole, bound = true): void {
  const now = new Date();
  store.state.memberships.push({
    id: randomUUID(),
    app_id: 'ars',
    user_email: caller.email,
    user_sub: bound ? caller.sub : null,
    role,
    status: 'active',
    reason: 'test',
    granted_by_email: 'seed@ionova.test',
    granted_by_sub: 'seed',
    granted_at: now,
    revoked_by_email: null,
    revoked_at: null,
    updated_at: now,
  });
}

async function expectError(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => {
      throw new Error(`expected ${code}`);
    },
    (e) => e
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

const submit = (caller: Caller, address = SAMPLES[0].address, clientRequestId = randomUUID()) =>
  svc(caller).submitAddress({ clientRequestId, address });

beforeEach(() => {
  config = testConfig();
  store = new MemoryStore({ orgId: config.orgId, projectId: config.projectId, appId: config.appId, environment: config.environment, release: config.release });
  agent = vi.fn(sampleAgent());
  grant(USER_A, 'app_user');
  grant(USER_B, 'app_user');
  grant(REVIEWER, 'reviewer');
  grant(REVIEWER_2, 'reviewer');
  grant(AUDITOR, 'auditor');
  grant(EXPORTER, 'audit_exporter');
  grant(ADMIN, 'app_admin');
  grant(ADMIN_2, 'app_admin');
});

describe('address workflow (AC-03)', () => {
  it('submits, structures, saves and returns the record with the original input preserved', async () => {
    const res = await submit(USER_A);
    expect(res.duplicate).toBe(false);
    expect(res.record).toMatchObject({ processingStatus: 'COMPLETED', reviewStatus: 'PENDING', decision: 'FIELDS_PRESENT', version: 1, originalAddress: SAMPLES[0].address });
    expect(res.record.result?.validationOutcome).toBe('VALID');
    expect(res.record.currentFields).toEqual(SAMPLES[0].expected);
    expect(store.state.audit.map((a) => a.action)).toEqual(['address.submitted', 'address.processed']);
    // Audit never contains the address text (AUD-02).
    expect(JSON.stringify(store.state.audit)).not.toContain('Lotus Lane');
    expect(await svc(AUDITOR).verifyAuditChain()).toMatchObject({ intact: true, checked: 2 });
  });

  it('flags NEEDS_REVIEW when town or country is missing', async () => {
    const res = await submit(USER_A, SAMPLES[3].address);
    expect(res.record.decision).toBe('NEEDS_REVIEW');
  });

  it('validates input on the server', async () => {
    const e1 = await expectError(svc(USER_A).submitAddress({ clientRequestId: randomUUID(), address: '   ' }), 'VALIDATION');
    expect(e1.extra.fieldErrors?.address).toBeTruthy();
    await expectError(svc(USER_A).submitAddress({ clientRequestId: randomUUID(), address: 'x'.repeat(2001) }), 'VALIDATION');
    await expectError(svc(USER_A).submitAddress({ clientRequestId: 'not-a-uuid', address: 'x' }), 'VALIDATION');
    expect(agent).not.toHaveBeenCalled();
  });

  it('prevents duplicate submission with the same request identifier (AC-05)', async () => {
    const id = randomUUID();
    const first = await submit(USER_A, SAMPLES[0].address, id);
    const second = await submit(USER_A, SAMPLES[0].address, id);
    expect(second.duplicate).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(store.state.requests).toHaveLength(1);
  });

  it('preserves invalid agent output and flags it (AI-04)', async () => {
    agent.mockResolvedValueOnce({ outputText: '{"fields":{}}', responseId: null, model: null, usage: null, latencyMs: 1, attempts: 1 });
    const err = await expectError(submit(USER_A), 'AI_INVALID_OUTPUT');
    const req = store.state.requests[0];
    expect(err.extra.requestId).toBe(req.id);
    expect(req.processing_status).toBe('FAILED_VALIDATION');
    expect(store.state.results[0]).toMatchObject({ validation_outcome: 'INVALID', raw_output_excerpt: '{"fields":{}}' });
  });
});

describe('failure handling (AC-05)', () => {
  it('AI timeout leaves a recoverable FAILED_AI request, and the owner can retry', async () => {
    agent.mockRejectedValueOnce(new FoundryError('timeout', null, 2));
    const err = await expectError(submit(USER_A), 'AI_TIMEOUT');
    const id = err.extra.requestId!;
    expect(store.state.requests[0]).toMatchObject({ processing_status: 'FAILED_AI', error_code: 'AI_TIMEOUT' });
    expect((await svc(USER_A).getRecord({ requestId: id })).canRetry).toBe(true);

    await expectError(svc(USER_B).retryProcessing({ requestId: id }), 'NOT_FOUND');
    const retried = await svc(USER_A).retryProcessing({ requestId: id });
    expect(retried.processingStatus).toBe('COMPLETED');
    // A second retry is refused: nothing to recover.
    await expectError(svc(USER_A).retryProcessing({ requestId: id }), 'DUPLICATE_IN_PROGRESS');
  });

  it('audit-write failure never reports success and leaves the request FAILED_AUDIT', async () => {
    store.failBusinessAudit = true;
    const err = await expectError(submit(USER_A), 'AUDIT_FAILURE');
    expect(store.state.requests[0]).toMatchObject({ id: err.extra.requestId, processing_status: 'FAILED_AUDIT' });
    expect(store.state.results).toHaveLength(0); // rolled back with the failed audit
    expect(store.state.audit.map((a) => a.action)).toEqual(['address.submitted', 'address.processing_failed']);

    store.failBusinessAudit = false;
    const retried = await svc(USER_A).retryProcessing({ requestId: err.extra.requestId! });
    expect(retried.processingStatus).toBe('COMPLETED');
  });

  it('nothing is saved when even the submission audit cannot be written', async () => {
    store.failAllAudit = true;
    await expectError(submit(USER_A), 'AUDIT_FAILURE');
    expect(store.state.requests).toHaveLength(0);
    expect(agent).not.toHaveBeenCalled();
  });

  it('storage failure leaves FAILED_STORAGE and no result', async () => {
    store.failStorage = true;
    await expectError(submit(USER_A), 'STORAGE_FAILURE');
    expect(store.state.requests[0].processing_status).toBe('FAILED_STORAGE');
    expect(store.state.results).toHaveLength(0);
  });
});

describe('review and concurrency (DATA-03)', () => {
  it('records reviewer edits separately from the model output and original input', async () => {
    const { record } = await submit(USER_A, SAMPLES[3].address);
    const after = await svc(REVIEWER).submitReview({ requestId: record.id, expectedVersion: 1, decision: 'APPROVED', comments: 'Country confirmed', fieldEdits: { country: 'IN' } });
    expect(after).toMatchObject({ reviewStatus: 'APPROVED', version: 2 });
    expect(after.currentFields?.country).toBe('IN');
    expect(after.result?.fields?.country).toBeNull(); // model output unchanged
    expect(after.originalAddress).toBe(SAMPLES[3].address);
    expect(after.reviews[0]).toMatchObject({ decision: 'APPROVED', changedFields: { country: { from: null, to: 'IN' } }, recordVersion: 2 });
  });

  it('rejects a stale concurrent review with CONFLICT and the current version', async () => {
    const { record } = await submit(USER_A);
    await svc(REVIEWER).submitReview({ requestId: record.id, expectedVersion: 1, decision: 'APPROVED' });
    const err = await expectError(svc(REVIEWER_2).submitReview({ requestId: record.id, expectedVersion: 1, decision: 'REJECTED' }), 'CONFLICT');
    expect(err.extra.currentVersion).toBe(2);
    expect(store.state.reviews).toHaveLength(1);
  });

  it('requires a comment or change for comment-only reviews', async () => {
    const { record } = await submit(USER_A);
    await expectError(svc(REVIEWER).submitReview({ requestId: record.id, expectedVersion: 1, decision: 'COMMENT' }), 'VALIDATION');
  });
});

describe('access separation (ACC-04)', () => {
  it('unassigned users have no roles and are denied, with an audited denial', async () => {
    const me = await svc(NOBODY).whoAmI();
    expect(me.roles).toEqual([]);
    await expectError(submit(NOBODY), 'ACCESS_DENIED');
    await expectError(svc(NOBODY).listRecords({ scope: 'mine' }), 'ACCESS_DENIED');
    expect(store.state.audit.filter((a) => a.outcome === 'DENIED').length).toBe(2);
  });

  it('a user cannot read another user’s record by altering the id; reviewers can', async () => {
    const { record } = await submit(USER_A);
    await expectError(svc(USER_B).getRecord({ requestId: record.id }), 'NOT_FOUND');
    await expectError(svc(AUDITOR).getRecord({ requestId: record.id }), 'NOT_FOUND');
    await expectError(svc(ADMIN).getRecord({ requestId: record.id }), 'NOT_FOUND'); // app admin: no record access by default
    expect((await svc(REVIEWER).getRecord({ requestId: record.id })).id).toBe(record.id);
    const mine = await svc(USER_B).listRecords({ scope: 'mine' });
    expect(mine.items).toHaveLength(0);
  });

  it('only reviewers list all records and only reviewers review', async () => {
    const { record } = await submit(USER_A);
    await expectError(svc(USER_A).listRecords({ scope: 'all' }), 'ACCESS_DENIED');
    expect((await svc(REVIEWER).listRecords({ scope: 'all' })).items).toHaveLength(1);
    await expectError(svc(USER_A).submitReview({ requestId: record.id, expectedVersion: 1, decision: 'APPROVED' }), 'ACCESS_DENIED');
    await expectError(submit(REVIEWER), 'ACCESS_DENIED');
  });

  it('auditors read audit but cannot export; exporters can and the export is audited', async () => {
    await submit(USER_A);
    expect((await svc(AUDITOR).searchAudit({})).items.length).toBeGreaterThan(0);
    await expectError(svc(REVIEWER).searchAudit({}), 'ACCESS_DENIED');
    await expectError(svc(AUDITOR).exportAudit({}), 'ACCESS_DENIED');
    const exp = await svc(EXPORTER).exportAudit({ action: 'address.submitted' });
    expect(exp.rowCount).toBe(1);
    expect(exp.content.split('\r\n')[0]).toContain('correlation_id');
    expect(store.state.audit.at(-1)?.action).toBe('audit.exported');
  });

  it('finds events by correlation id for support look-up', async () => {
    await svc(USER_A, { correlationId: 'support-case-0001' }).submitAddress({ clientRequestId: randomUUID(), address: SAMPLES[0].address });
    const page = await svc(AUDITOR).searchAudit({ correlationIdFilter: 'support-case-0001' });
    expect(page.items.map((e) => e.action).sort()).toEqual(['address.processed', 'address.submitted']);
  });

  it('detects tampering with stored audit events', async () => {
    await submit(USER_A);
    store.state.audit[0].actor_email = 'someone.else@ionova.test';
    expect(await svc(AUDITOR).verifyAuditChain()).toMatchObject({ intact: false, firstBrokenSeq: 1 });
  });
});

describe('membership administration (ORG-03, ACC-03)', () => {
  it('binds an email-only membership to the caller on first use', async () => {
    const newUser: Caller = { sub: 'sub-new', email: 'new@ionova.test' };
    grant(newUser, 'app_user', false);
    expect((await svc(newUser).whoAmI()).roles).toEqual(['app_user']);
    expect(store.state.memberships.find((m) => m.user_email === newUser.email)?.user_sub).toBe('sub-new');
    // A different subject presenting the same email is not granted the role.
    expect((await svc({ sub: 'sub-imposter', email: newUser.email }).whoAmI()).roles).toEqual([]);
  });

  it('prevents self-assignment and self-revocation', async () => {
    await expectError(svc(ADMIN).grantMembership({ userEmail: ADMIN.email, role: 'reviewer', reason: 'x' }), 'ACCESS_DENIED');
    const own = store.state.memberships.find((m) => m.user_email === ADMIN.email)!;
    await expectError(svc(ADMIN).revokeMembership({ membershipId: own.id, reason: 'x' }), 'ACCESS_DENIED');
  });

  it('non-admins cannot manage membership', async () => {
    await expectError(svc(REVIEWER).grantMembership({ userEmail: 'x@ionova.test', role: 'app_user', reason: 'x' }), 'ACCESS_DENIED');
  });

  it('revocation removes access and locks the user’s own records from the data API', async () => {
    const { record } = await submit(USER_A);
    const m = store.state.memberships.find((x) => x.user_email === USER_A.email)!;
    await svc(ADMIN).revokeMembership({ membershipId: m.id, reason: 'left project' });
    expect(store.state.requests.find((r) => r.id === record.id)?.owner_status).toBe('revoked');
    expect(store.state.results[0].owner_status).toBe('revoked');
    await expectError(svc(USER_A).getRecord({ requestId: record.id }), 'NOT_FOUND');
    await expectError(submit(USER_A), 'ACCESS_DENIED');
    // Re-granting restores own-record access.
    await svc(ADMIN_2).grantMembership({ userEmail: USER_A.email, role: 'app_user', reason: 'rejoined' });
    expect(store.state.requests.find((r) => r.id === record.id)?.owner_status).toBe('active');
  });

  it('bootstrap creates the first app admin only once and only for configured emails', async () => {
    store.state.memberships = store.state.memberships.filter((m) => m.role !== 'app_admin');
    await expectError(svc(NOBODY).bootstrapAppAdmin(), 'ACCESS_DENIED');
    expect((await svc(ADMIN).whoAmI()).bootstrapAvailable).toBe(true);
    await svc(ADMIN).bootstrapAppAdmin();
    expect((await svc(ADMIN).whoAmI()).roles).toEqual(['app_admin']);
    await expectError(svc(ADMIN).bootstrapAppAdmin(), 'ACCESS_DENIED');
  });
});

describe('super_user role (D-57)', () => {
  it('a listed admin can claim super_user once, gaining app_user + app_admin permissions and an audit event', async () => {
    const before = await svc(ADMIN).whoAmI();
    expect(before.superUserAvailable).toBe(true);
    await svc(ADMIN).claimSuperUser();
    const after = await svc(ADMIN).whoAmI();
    expect(after.roles.sort()).toEqual(['app_admin', 'super_user']);
    expect(after.permissions).toEqual(expect.arrayContaining(['address.submit', 'address.read.own', 'membership.manage', 'config.manage']));
    expect(after.permissions).not.toContain('address.read.all');
    expect(after.permissions).not.toContain('audit.read');
    expect(after.superUserAvailable).toBe(false);
    expect(store.state.audit.at(-1)?.action).toBe('membership.super_user_claimed');
    await expectError(svc(ADMIN).claimSuperUser(), 'ACCESS_DENIED');
  });

  it('lets the super user run the full address flow on their own records', async () => {
    await svc(ADMIN).claimSuperUser();
    const { record } = await submit(ADMIN);
    expect(record.processingStatus).toBe('COMPLETED');
    expect((await svc(ADMIN).getRecord({ requestId: record.id })).id).toBe(record.id);
    expect((await svc(ADMIN).listRecords({ scope: 'mine' })).items).toHaveLength(1);
    await expectError(svc(ADMIN).listRecords({ scope: 'all' }), 'ACCESS_DENIED');
  });

  it('is refused for unlisted users and in prod', async () => {
    await expectError(svc(NOBODY).claimSuperUser(), 'ACCESS_DENIED');
    config = testConfig({ environment: 'prod' });
    expect((await svc(ADMIN).whoAmI()).superUserAvailable).toBe(false);
    await expectError(svc(ADMIN).claimSuperUser(), 'ACCESS_DENIED');
  });

  it('cannot be self-granted through membership management', async () => {
    await expectError(svc(ADMIN).grantMembership({ userEmail: ADMIN.email, role: 'super_user', reason: 'x' }), 'ACCESS_DENIED');
  });
});

describe('configuration, seed and evaluation (DATA-05, AI-06)', () => {
  it('seeds idempotently with synthetic samples only', async () => {
    await svc(ADMIN).seedSampleData();
    await svc(ADMIN).seedSampleData();
    expect(store.state.samples).toHaveLength(6);
    expect(store.state.configs).toHaveLength(1);
    expect(store.state.requests).toHaveLength(0);
  });

  it('runs a fixed evaluation sample against the agent and compares each field', async () => {
    const r = await svc(ADMIN).runEvaluationSample({ sampleId: 'uae' });
    expect(r.allMatch).toBe(true);
    expect(r.fieldResults.find((f) => f.field === 'postcode')).toMatchObject({ expected: null, actual: null, match: true });
  });

  it('reports a Foundry probe failure without throwing', async () => {
    agent.mockRejectedValueOnce(new FoundryError('auth', 403, 1));
    const r = await svc(ADMIN).probeFoundry();
    expect(r).toMatchObject({ reachable: false, contractValid: false });
    expect(r.validationErrors[0]).toContain('403');
  });

  it('surfaces active fault injection only in dev', async () => {
    config = testConfig({ faultInjection: 'auditWrite' });
    expect((await svc(USER_A).whoAmI()).faultInjection).toBe('auditWrite');
    config = testConfig({ environment: 'prod', faultInjection: 'auditWrite' });
    expect((await svc(USER_A).whoAmI()).faultInjection).toBeNull();
  });
});
