import type {
  AddressFields,
  AddressResultView,
  AuditChainResponse,
  AuditEventView,
  AuditExportResponse,
  AuditSearchRequest,
  DiagnosticsResponse,
  EvaluationSampleRequest,
  EvaluationSampleResponse,
  FoundryProbeResponse,
  GrantMembershipRequest,
  ListRecordsRequest,
  MembershipRole,
  MembershipView,
  Page,
  Permission,
  ProcessingStatus,
  RecordDetail,
  RecordSummary,
  RequestIdRequest,
  ReviewDecision,
  ReviewStatus,
  ReviewView,
  RevokeMembershipRequest,
  SeedResponse,
  SubmitAddressRequest,
  SubmitAddressResponse,
  SubmitReviewRequest,
  WhoAmIResponse,
} from '@rayfin-app/shared';

import { sha256Hex, verifyAuditChain, GENESIS_HASH, type AuditDraft, type AuditRow } from './audit.js';
import { ALL_ROLES, hasPermission, permissionsFor } from './authz.js';
import { activeFault, type RuntimeConfig } from './config.js';
import {
  buildAgentInput,
  evaluateChecks,
  FIELD_NAMES,
  MAX_ADDRESS_LENGTH,
  parseAgentOutput,
  PROMPT_CONTRACT_VERSION,
  validateFieldEdits,
} from './contract.js';
import { AppError, deny, invalid, notFound } from './errors.js';
import { FoundryError, type FoundryInvokeResult } from './foundry.js';
import type { Caller } from './identity.js';
import { SAMPLES } from './samples.js';
import { EXPECTED_COLUMNS } from './sqlNames.js';
import {
  AuditWriteError,
  DuplicateKeyError,
  type MembershipRow,
  type RequestRow,
  type ResultRow,
  type ReviewRow,
  type Store,
} from './store.js';

/**
 * Business operations. Every public method:
 *  1. resolves the caller's business roles from AppMembership (never claims),
 *  2. checks the permission on the server and audits denials,
 *  3. performs the operation through the Store, with business change and
 *     audit event in one transaction where the operation changes state.
 *
 * Pure with respect to the platform: tokens, SQL and Foundry are injected so
 * the same code runs in unit tests (with fakes) and in Fabric.
 */
export interface ServiceDeps {
  config: RuntimeConfig;
  store: Store;
  caller: Caller;
  correlationId: string;
  callAgent: (inputText: string) => Promise<FoundryInvokeResult>;
  now?: () => Date;
  newId: () => string;
}

const STALE_PROCESSING_MS = 5 * 60 * 1000;
const RETRYABLE_STATUSES: ProcessingStatus[] = ['FAILED_AI', 'FAILED_VALIDATION', 'FAILED_STORAGE', 'FAILED_AUDIT'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]{1,200}@[^\s@]{1,100}\.[^\s@]{2,}$/;
const PROCESSING_STATUSES: ProcessingStatus[] = ['RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED_AI', 'FAILED_VALIDATION', 'FAILED_STORAGE', 'FAILED_AUDIT'];
const REVIEW_STATUSES: ReviewStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_CHANGES'];
const REVIEW_DECISIONS: ReviewDecision[] = ['APPROVED', 'REJECTED', 'NEEDS_CHANGES', 'COMMENT'];
const MAX_EXPORT_ROWS = 5000;

export class AppService {
  private roles: MembershipRole[] | null = null;
  private readonly now: () => Date;

  constructor(private readonly d: ServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // Identity, roles and authorization
  // ---------------------------------------------------------------------------

  private get agentRef(): string {
    const f = this.d.config.foundry;
    return `${f.projectEndpoint}#agent=${f.agentName}${f.agentVersionLabel ? `@${f.agentVersionLabel}` : ''}`;
  }

  private draft(partial: Omit<AuditDraft, 'actorSub' | 'actorEmail' | 'correlationId'>): AuditDraft {
    return {
      actorSub: this.d.caller.sub,
      actorEmail: this.d.caller.email,
      correlationId: this.d.correlationId,
      ...partial,
    };
  }

  /** Resolve active roles; binds unbound rows to the caller's sub (D-14). */
  async loadRoles(): Promise<MembershipRole[]> {
    if (this.roles) return this.roles;
    const rows = await this.d.store.listActiveMembershipsByEmail(this.d.caller.email);
    const unbound = rows.filter((r) => !r.user_sub);
    const mismatched = rows.filter((r) => r.user_sub && r.user_sub !== this.d.caller.sub);
    if (unbound.length) {
      await this.d.store.bindMembershipSub(
        unbound.map((r) => r.id),
        this.d.caller.sub,
        this.now(),
        this.draft({
          action: 'membership.bound',
          objectType: 'AppMembership',
          objectId: unbound.map((r) => r.id).join(',').slice(0, 100),
          outcome: 'SUCCESS',
          details: { roles: unbound.map((r) => r.role) },
        })
      );
    }
    if (mismatched.length) {
      await this.d.store.appendAudit(
        this.draft({
          action: 'membership.subject_mismatch',
          objectType: 'AppMembership',
          objectId: mismatched[0].id,
          outcome: 'DENIED',
          details: { count: mismatched.length },
        })
      );
    }
    this.roles = [...new Set(rows.filter((r) => !mismatched.includes(r)).map((r) => r.role))].filter((r) =>
      ALL_ROLES.includes(r)
    );
    return this.roles;
  }

  private async require(permission: Permission, operation: string, objectId: string | null = null): Promise<MembershipRole[]> {
    const roles = await this.loadRoles();
    if (!hasPermission(roles, permission)) {
      await this.auditDenied(operation, permission, objectId);
      throw deny();
    }
    return roles;
  }

  private async auditDenied(operation: string, permission: string, objectId: string | null): Promise<void> {
    await this.d.store.appendAudit(
      this.draft({
        action: 'access.denied',
        objectType: 'Operation',
        objectId,
        outcome: 'DENIED',
        details: { operation, permission },
      })
    );
  }

  async whoAmI(): Promise<WhoAmIResponse> {
    const roles = await this.loadRoles();
    const c = this.d.config;
    const bootstrapAvailable =
      c.bootstrapAdminEmails.includes(this.d.caller.email) && (await this.d.store.countActiveAdmins()) === 0;
    const fault = activeFault(c);
    const superUserAvailable =
      c.environment !== 'prod' && c.superUserEmails.includes(this.d.caller.email) && !roles.includes('super_user');
    return {
      user: { sub: this.d.caller.sub, email: this.d.caller.email },
      app: {
        orgId: c.orgId,
        projectId: c.projectId,
        appId: c.appId,
        appName: c.appName,
        environment: c.environment,
        release: c.release,
      },
      roles,
      permissions: permissionsFor(roles),
      bootstrapAvailable,
      superUserAvailable,
      faultInjection: fault === 'none' ? null : fault,
    };
  }

  // ---------------------------------------------------------------------------
  // Address workflow
  // ---------------------------------------------------------------------------

  async submitAddress(req: SubmitAddressRequest): Promise<SubmitAddressResponse> {
    const roles = await this.require('address.submit', 'submitAddress');
    const address = typeof req?.address === 'string' ? req.address.trim() : '';
    const fieldErrors: Record<string, string> = {};
    if (!address) fieldErrors.address = 'Enter an address.';
    else if (address.length > MAX_ADDRESS_LENGTH) fieldErrors.address = `Keep the address to ${MAX_ADDRESS_LENGTH} characters or fewer.`;
    if (typeof req?.clientRequestId !== 'string' || !UUID_RE.test(req.clientRequestId)) {
      fieldErrors.clientRequestId = 'A request identifier (UUID) is required.';
    }
    if (Object.keys(fieldErrors).length) throw invalid('Check the highlighted fields.', fieldErrors);

    const clientRequestId = req.clientRequestId.toLowerCase();
    const requestKey = `${this.d.caller.sub}:${clientRequestId}`;
    const existing = await this.d.store.findRequestByKey(requestKey);
    if (existing) {
      return { duplicate: true, record: await this.detail(existing, roles) };
    }

    const now = this.now();
    const row: RequestRow = {
      id: this.d.newId(),
      app_id: this.d.config.appId,
      creator_sub: this.d.caller.sub,
      creator_email: this.d.caller.email,
      client_request_id: clientRequestId,
      request_key: requestKey,
      original_address: address,
      input_sha256: sha256Hex(address),
      processing_status: 'PROCESSING',
      review_status: 'PENDING',
      decision: 'NONE',
      current_fields_json: null,
      version: 0,
      owner_status: 'active',
      correlation_id: this.d.correlationId,
      error_code: null,
      created_at: now,
      updated_at: now,
    };
    try {
      await this.d.store.insertRequest(
        row,
        this.draft({
          action: 'address.submitted',
          objectType: 'AddressRequest',
          objectId: row.id,
          outcome: 'SUCCESS',
          details: { inputSha256: row.input_sha256, length: address.length },
        })
      );
    } catch (err) {
      if (err instanceof DuplicateKeyError) {
        const winner = await this.d.store.findRequestByKey(requestKey);
        if (winner) return { duplicate: true, record: await this.detail(winner, roles) };
      }
      if (err instanceof AuditWriteError) {
        throw new AppError('AUDIT_FAILURE', 'The request could not be recorded because the audit store is unavailable. Nothing was saved; try again later.');
      }
      throw new AppError('STORAGE_FAILURE', 'The request could not be saved. Nothing was processed; try again later.');
    }

    const record = await this.process(row, roles);
    return { duplicate: false, record };
  }

  async retryProcessing(req: RequestIdRequest): Promise<RecordDetail> {
    const roles = await this.require('address.retry.own', 'retryProcessing', req?.requestId ?? null);
    const row = await this.getVisibleRequest(req?.requestId, roles, 'retryProcessing');
    if (row.creator_sub !== this.d.caller.sub) {
      await this.auditDenied('retryProcessing', 'address.retry.own', row.id);
      throw deny('Only the person who submitted the address can retry it.');
    }
    const staleBefore = new Date(this.now().getTime() - STALE_PROCESSING_MS);
    const claimed = await this.d.store.claimForProcessing(row.id, RETRYABLE_STATUSES, staleBefore, this.now());
    if (!claimed) {
      throw new AppError('DUPLICATE_IN_PROGRESS', 'This request is already being processed or does not need a retry.', { requestId: row.id });
    }
    await this.d.store.appendAudit(
      this.draft({ action: 'address.retry_started', objectType: 'AddressRequest', objectId: row.id, outcome: 'SUCCESS', details: { previousStatus: row.processing_status } })
    );
    return this.process({ ...row, processing_status: 'PROCESSING' }, roles);
  }

  /** Invoke the agent, validate, persist result + audit atomically. */
  private async process(row: RequestRow, roles: MembershipRole[]): Promise<RecordDetail> {
    const started = Date.now();
    let ai: FoundryInvokeResult;
    try {
      ai = await this.d.callAgent(buildAgentInput(row.original_address));
    } catch (err) {
      const kind = err instanceof FoundryError ? err.kind : 'unavailable';
      const code = kind === 'timeout' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE';
      await this.markFailed(row.id, 'FAILED_AI', code, {
        kind,
        status: err instanceof FoundryError ? err.status : null,
        attempts: err instanceof FoundryError ? err.attempts : null,
      });
      throw new AppError(
        code,
        code === 'AI_TIMEOUT'
          ? 'The address service did not respond in time. Your request was saved; use Retry to try again.'
          : 'The address service is unavailable or refused the request. Your request was saved; use Retry later.',
        { requestId: row.id }
      );
    }

    const parsed = parseAgentOutput(ai.outputText, row.original_address);
    const value = parsed.ok ? parsed.value : parsed.partial;
    const fields = parsed.ok ? parsed.value.fields : null;
    const { decision } = evaluateChecks(fields);
    const notesJson = value ? boundedJson(value.notes, 4000) : null;
    const result: ResultRow = {
      id: this.d.newId(),
      request_id: row.id,
      app_id: this.d.config.appId,
      creator_sub: row.creator_sub,
      owner_status: row.owner_status,
      validation_outcome: parsed.ok ? 'VALID' : 'INVALID',
      validation_errors_json: parsed.ok ? null : boundedJson(parsed.errors, 2000),
      fields_json: value ? boundedJson(value.fields, 2000) : null,
      evidence_json: value ? boundedJson(value.evidence, 2000) : null,
      notes_json: notesJson,
      decision,
      agent_name: this.d.config.foundry.agentName,
      agent_version_label: this.d.config.foundry.agentVersionLabel,
      prompt_contract_version: PROMPT_CONTRACT_VERSION,
      response_id: ai.responseId,
      model: ai.model,
      raw_output_sha256: sha256Hex(ai.outputText),
      raw_output_excerpt: ai.outputText.slice(0, 4000),
      ai_latency_ms: Math.max(0, Math.round(ai.latencyMs)),
      processing_ms: Math.max(0, Date.now() - started),
      usage_json: ai.usage ? JSON.stringify(ai.usage).slice(0, 500) : null,
      created_at: this.now(),
    };

    try {
      await this.d.store.completeProcessing({
        requestId: row.id,
        result,
        processingStatus: parsed.ok ? 'COMPLETED' : 'FAILED_VALIDATION',
        decision,
        currentFieldsJson: fields ? JSON.stringify(fields) : null,
        now: this.now(),
        audit: this.draft({
          action: parsed.ok ? 'address.processed' : 'address.output_rejected',
          objectType: 'AddressRequest',
          objectId: row.id,
          outcome: parsed.ok ? 'SUCCESS' : 'FAILURE',
          agentRef: this.agentRef,
          promptContractVersion: PROMPT_CONTRACT_VERSION,
          details: {
            resultId: result.id,
            decision,
            validationErrorCount: parsed.ok ? 0 : parsed.errors.length,
            presentFields: fields ? FIELD_NAMES.filter((f) => fields[f] !== null) : [],
            aiLatencyMs: result.ai_latency_ms,
            attempts: ai.attempts,
            responseId: ai.responseId,
          },
        }),
      });
    } catch (err) {
      const auditFailed = err instanceof AuditWriteError;
      const code = auditFailed ? 'AUDIT_FAILURE' : 'STORAGE_FAILURE';
      await this.markFailed(row.id, auditFailed ? 'FAILED_AUDIT' : 'FAILED_STORAGE', code, { stage: 'complete' });
      throw new AppError(
        code,
        auditFailed
          ? 'The result could not be recorded because the audit store is unavailable. It was not saved as complete; use Retry later.'
          : 'The result could not be saved. It was not marked complete; use Retry later.',
        { requestId: row.id }
      );
    }

    if (!parsed.ok) {
      throw new AppError(
        'AI_INVALID_OUTPUT',
        "The address service's output did not pass validation. It was saved and flagged; a reviewer can inspect it, or you can retry.",
        { requestId: row.id }
      );
    }
    const fresh = await this.d.store.getRequest(row.id);
    return this.detail(fresh ?? row, roles);
  }

  /** Best effort: record the failure with audit; if audit also fails, record the status alone. */
  private async markFailed(requestId: string, status: ProcessingStatus, code: string, details: Record<string, unknown>): Promise<void> {
    const now = this.now();
    const audit = this.draft({
      action: 'address.processing_failed',
      objectType: 'AddressRequest',
      objectId: requestId,
      outcome: 'FAILURE',
      agentRef: this.agentRef,
      details: { status, code, ...details },
    });
    try {
      await this.d.store.failProcessing(requestId, status, code, now, audit);
    } catch {
      try {
        await this.d.store.failProcessing(requestId, status, code, now, null);
      } catch {
        // The request stays PROCESSING; it becomes retryable once stale.
      }
    }
  }

  async getRequestStatus(req: RequestIdRequest): Promise<RecordSummary> {
    const roles = await this.loadRoles();
    const row = await this.getVisibleRequest(req?.requestId, roles, 'getRequestStatus');
    return summary(row);
  }

  async getRecord(req: RequestIdRequest): Promise<RecordDetail> {
    const roles = await this.loadRoles();
    const row = await this.getVisibleRequest(req?.requestId, roles, 'getRecord');
    return this.detail(row, roles);
  }

  async listRecords(req: ListRecordsRequest): Promise<Page<RecordSummary>> {
    const scope = req?.scope === 'all' ? 'all' : 'mine';
    await this.require(scope === 'all' ? 'address.read.all' : 'address.read.own', `listRecords:${scope}`);
    const { page, pageSize } = paging(req?.page, req?.pageSize, 50);
    if (req?.processingStatus && !PROCESSING_STATUSES.includes(req.processingStatus)) throw invalid('Unknown processing status.');
    if (req?.reviewStatus && !REVIEW_STATUSES.includes(req.reviewStatus)) throw invalid('Unknown review status.');
    const rows = await this.d.store.listRequests(
      {
        creatorSub: scope === 'mine' ? this.d.caller.sub : undefined,
        processingStatus: req?.processingStatus,
        reviewStatus: req?.reviewStatus,
      },
      (page - 1) * pageSize,
      pageSize + 1
    );
    return { items: rows.slice(0, pageSize).map(summary), page, pageSize, hasNextPage: rows.length > pageSize };
  }

  async submitReview(req: SubmitReviewRequest): Promise<RecordDetail> {
    const roles = await this.require('review.update', 'submitReview', req?.requestId ?? null);
    const row = await this.getVisibleRequest(req?.requestId, roles, 'submitReview');
    const errors: Record<string, string> = {};
    if (!REVIEW_DECISIONS.includes(req?.decision)) errors.decision = 'Choose a decision.';
    if (!Number.isInteger(req?.expectedVersion) || req.expectedVersion < 1) errors.expectedVersion = 'Reload the record and try again.';
    const comments = typeof req?.comments === 'string' ? req.comments.trim() : '';
    if (comments.length > 2000) errors.comments = 'Keep comments to 2000 characters or fewer.';
    const edits = validateFieldEdits(req?.fieldEdits);
    if (!edits.ok) Object.assign(errors, edits.errors);
    if (Object.keys(errors).length) throw invalid('Check the highlighted fields.', errors);
    if (row.processing_status !== 'COMPLETED' && row.processing_status !== 'FAILED_VALIDATION') {
      throw invalid('Only processed records can be reviewed.');
    }

    const current = parseFields(row.current_fields_json) ?? emptyFields();
    const next: AddressFields = { ...current, ...(edits.ok ? edits.value : {}) };
    const changed: Record<string, { from: string | null; to: string | null }> = {};
    for (const f of FIELD_NAMES) if (current[f] !== next[f]) changed[f] = { from: current[f], to: next[f] };
    if (req.decision === 'COMMENT' && !comments && !Object.keys(changed).length) {
      throw invalid('Add a comment or change a field.', { comments: 'Required for a comment-only review.' });
    }
    const reviewStatus: ReviewStatus = req.decision === 'COMMENT' ? row.review_status : req.decision;
    const review: ReviewRow = {
      id: this.d.newId(),
      request_id: row.id,
      app_id: this.d.config.appId,
      reviewer_sub: this.d.caller.sub,
      reviewer_email: this.d.caller.email,
      decision: req.decision,
      comments: comments || null,
      changed_fields_json: Object.keys(changed).length ? boundedJson(changed, 2000) : null,
      record_version: req.expectedVersion + 1,
      created_at: this.now(),
    };
    const outcome = await this.d.store
      .applyReview({
        requestId: row.id,
        expectedVersion: req.expectedVersion,
        currentFieldsJson: JSON.stringify(next),
        reviewStatus,
        review,
        now: this.now(),
        audit: this.draft({
          action: 'review.updated',
          objectType: 'AddressRequest',
          objectId: row.id,
          outcome: 'SUCCESS',
          details: { decision: req.decision, changedFields: Object.keys(changed), recordVersion: review.record_version, reviewId: review.id },
        }),
      })
      .catch((err) => {
        if (err instanceof AuditWriteError) {
          throw new AppError('AUDIT_FAILURE', 'The review was not saved because the audit store is unavailable. Try again later.', { requestId: row.id });
        }
        throw new AppError('STORAGE_FAILURE', 'The review could not be saved. Try again later.', { requestId: row.id });
      });
    if (!outcome.ok) {
      throw new AppError('CONFLICT', 'Someone else updated this record. Reload it to see the latest version, then apply your review again.', {
        requestId: row.id,
        currentVersion: outcome.currentVersion ?? undefined,
      });
    }
    const fresh = await this.d.store.getRequest(row.id);
    return this.detail(fresh ?? row, roles);
  }

  /** Owner (app_user) or reviewer; everyone else gets NOT_FOUND and a denial audit. */
  private async getVisibleRequest(requestId: unknown, roles: MembershipRole[], operation: string): Promise<RequestRow> {
    if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) throw invalid('A valid record id is required.');
    const row = await this.d.store.getRequest(requestId.toLowerCase());
    const ownerOk = row && row.creator_sub === this.d.caller.sub && hasPermission(roles, 'address.read.own');
    const reviewerOk = row && hasPermission(roles, 'address.read.all');
    if (!row || !(ownerOk || reviewerOk)) {
      await this.auditDenied(operation, 'address.read', requestId.toLowerCase());
      throw notFound();
    }
    return row;
  }

  private async detail(row: RequestRow, roles: MembershipRole[]): Promise<RecordDetail> {
    const [result, reviews] = await Promise.all([this.d.store.getLatestResult(row.id), this.d.store.listReviews(row.id)]);
    const isOwner = row.creator_sub === this.d.caller.sub;
    const stale = row.processing_status === 'PROCESSING' && this.now().getTime() - row.updated_at.getTime() > STALE_PROCESSING_MS;
    return {
      ...summary(row),
      originalAddress: row.original_address,
      currentFields: parseFields(row.current_fields_json),
      correlationId: row.correlation_id,
      errorCode: row.error_code,
      result: result ? resultView(result) : null,
      reviews: reviews.map(reviewView),
      canReview:
        hasPermission(roles, 'review.update') && (row.processing_status === 'COMPLETED' || row.processing_status === 'FAILED_VALIDATION'),
      canRetry: isOwner && hasPermission(roles, 'address.retry.own') && (RETRYABLE_STATUSES.includes(row.processing_status) || stale),
    };
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  async searchAudit(req: AuditSearchRequest): Promise<Page<AuditEventView>> {
    await this.require('audit.read', 'searchAudit');
    const { page, pageSize } = paging(req?.page, req?.pageSize, 100);
    const rows = await this.d.store.searchAudit(auditFilter(req), (page - 1) * pageSize, pageSize + 1);
    return { items: rows.slice(0, pageSize).map(auditView), page, pageSize, hasNextPage: rows.length > pageSize };
  }

  async exportAudit(req: AuditSearchRequest): Promise<AuditExportResponse> {
    await this.require('audit.export', 'exportAudit');
    const filter = auditFilter(req);
    const rows = await this.d.store.searchAudit(filter, 0, MAX_EXPORT_ROWS + 1);
    const truncated = rows.length > MAX_EXPORT_ROWS;
    const items = rows.slice(0, MAX_EXPORT_ROWS);
    const header = ['seq', 'occurred_at', 'app_id', 'environment', 'actor_email', 'action', 'object_type', 'object_id', 'outcome', 'correlation_id', 'release_version', 'details_json', 'event_hash'];
    const lines = [header.join(',')].concat(
      items.map((r) =>
        [r.seq, r.occurred_at.toISOString(), r.app_id, r.environment, r.actor_email, r.action, r.object_type, r.object_id, r.outcome, r.correlation_id, r.release_version, r.details_json, r.event_hash]
          .map(csvCell)
          .join(',')
      )
    );
    await this.d.store.appendAudit(
      this.draft({
        action: 'audit.exported',
        objectType: 'AuditEvent',
        objectId: null,
        outcome: 'SUCCESS',
        details: { rowCount: items.length, truncated, filter: { ...req, correlationId: undefined } },
      })
    );
    return {
      fileName: `audit-${this.d.config.appId}-${this.d.config.environment}-${this.now().toISOString().replace(/[:.]/g, '')}.csv`,
      contentType: 'text/csv',
      rowCount: items.length,
      truncated,
      content: lines.join('\r\n'),
    };
  }

  async verifyAuditChain(): Promise<AuditChainResponse> {
    await this.require('audit.verify', 'verifyAuditChain');
    let prev = GENESIS_HASH;
    let seq = 1;
    let checked = 0;
    for (let guard = 0; guard < 200; guard++) {
      const rows: AuditRow[] = await this.d.store.readAuditFrom(seq, 500);
      if (!rows.length) break;
      const r = verifyAuditChain(rows, prev, seq);
      checked += r.checked;
      if (!r.intact) return { intact: false, checked, firstBrokenSeq: r.firstBrokenSeq, reason: r.reason };
      prev = r.lastHash;
      seq = r.nextSeq;
    }
    return { intact: true, checked, firstBrokenSeq: null, reason: null };
  }

  // ---------------------------------------------------------------------------
  // Membership administration
  // ---------------------------------------------------------------------------

  async listMembers(): Promise<MembershipView[]> {
    await this.require('membership.manage', 'listMembers');
    return (await this.d.store.listMemberships()).map(membershipView);
  }

  async grantMembership(req: GrantMembershipRequest): Promise<MembershipView> {
    await this.require('membership.manage', 'grantMembership');
    const email = typeof req?.userEmail === 'string' ? req.userEmail.trim().toLowerCase() : '';
    const reason = typeof req?.reason === 'string' ? req.reason.trim() : '';
    const errors: Record<string, string> = {};
    if (!EMAIL_RE.test(email) || email.length > 320) errors.userEmail = 'Enter the user’s sign-in email address.';
    if (!ALL_ROLES.includes(req?.role)) errors.role = 'Choose a role.';
    if (!reason || reason.length > 500) errors.reason = 'Give a reason (up to 500 characters).';
    if (Object.keys(errors).length) throw invalid('Check the highlighted fields.', errors);
    if (email === this.d.caller.email) {
      await this.auditDenied('grantMembership:self', 'membership.manage', null);
      throw deny('You cannot change your own roles. Ask another app administrator.');
    }
    const all = await this.d.store.listMembershipsByEmail(email);
    if (all.some((m) => m.role === req.role && m.status === 'active')) {
      throw new AppError('CONFLICT', 'This user already has that role.');
    }
    const priorSub = all.find((m) => m.user_sub)?.user_sub ?? null;
    const now = this.now();
    const row: MembershipRow = {
      id: this.d.newId(),
      app_id: this.d.config.appId,
      user_email: email,
      user_sub: priorSub,
      role: req.role,
      status: 'active',
      reason,
      granted_by_email: this.d.caller.email,
      granted_by_sub: this.d.caller.sub,
      granted_at: now,
      revoked_by_email: null,
      revoked_at: null,
      updated_at: now,
    };
    await this.d.store
      .insertMembership(
        row,
        req.role === 'app_user' ? priorSub : null,
        this.draft({ action: 'membership.granted', objectType: 'AppMembership', objectId: row.id, outcome: 'SUCCESS', details: { userEmail: email, role: req.role, reason } })
      )
      .catch(rethrowWrite);
    return membershipView(row);
  }

  async revokeMembership(req: RevokeMembershipRequest): Promise<MembershipView> {
    await this.require('membership.manage', 'revokeMembership', req?.membershipId ?? null);
    const reason = typeof req?.reason === 'string' ? req.reason.trim() : '';
    if (typeof req?.membershipId !== 'string' || !UUID_RE.test(req.membershipId)) throw invalid('A valid membership id is required.');
    if (!reason || reason.length > 500) throw invalid('Give a reason (up to 500 characters).', { reason: 'Required.' });
    const m = await this.d.store.getMembership(req.membershipId.toLowerCase());
    if (!m) throw notFound('Membership not found.');
    if (m.user_email === this.d.caller.email) {
      await this.auditDenied('revokeMembership:self', 'membership.manage', m.id);
      throw deny('You cannot change your own roles. Ask another app administrator.');
    }
    if (m.status !== 'active') throw new AppError('CONFLICT', 'This membership is already revoked.');
    const others = (await this.d.store.listActiveMembershipsByEmail(m.user_email)).filter((x) => x.id !== m.id);
    const losesOwnRecords = m.role === 'app_user' && !others.some((x) => x.role === 'app_user');
    const now = this.now();
    await this.d.store
      .revokeMembership(
        m.id,
        this.d.caller.email,
        now,
        losesOwnRecords ? m.user_sub : null,
        this.draft({
          action: 'membership.revoked',
          objectType: 'AppMembership',
          objectId: m.id,
          outcome: 'SUCCESS',
          details: { userEmail: m.user_email, role: m.role, reason, ownerRecordsLocked: losesOwnRecords },
        })
      )
      .catch(rethrowWrite);
    return membershipView({ ...m, status: 'revoked', revoked_by_email: this.d.caller.email, revoked_at: now, updated_at: now });
  }

  /** One-time: first app_admin from deployment configuration (D-15). */
  async bootstrapAppAdmin(): Promise<MembershipView> {
    const c = this.d.config;
    if (!c.bootstrapAdminEmails.includes(this.d.caller.email) || (await this.d.store.countActiveAdmins()) > 0) {
      await this.auditDenied('bootstrapAppAdmin', 'bootstrap', null);
      throw deny('Bootstrap is not available for your account.');
    }
    const now = this.now();
    const row: MembershipRow = {
      id: this.d.newId(),
      app_id: c.appId,
      user_email: this.d.caller.email,
      user_sub: this.d.caller.sub,
      role: 'app_admin',
      status: 'active',
      reason: 'Bootstrap administrator from deployment configuration',
      granted_by_email: this.d.caller.email,
      granted_by_sub: this.d.caller.sub,
      granted_at: now,
      revoked_by_email: null,
      revoked_at: null,
      updated_at: now,
    };
    await this.d.store
      .insertMembership(row, null, this.draft({ action: 'membership.bootstrapped', objectType: 'AppMembership', objectId: row.id, outcome: 'SUCCESS', details: { role: 'app_admin' } }))
      .catch(rethrowWrite);
    this.roles = null;
    return membershipView(row);
  }

  /**
   * D-57: claim the combined super_user role (app_user + app_admin). Allowed only for emails listed in
   * the deployment configuration (superUserEmails, set by the project admin), never in prod, once per
   * person. Fully audited; the in-app membership screen still forbids self-assignment.
   */
  async claimSuperUser(): Promise<MembershipView> {
    const c = this.d.config;
    const listed = c.superUserEmails.includes(this.d.caller.email);
    const existing = (await this.d.store.listActiveMembershipsByEmail(this.d.caller.email)).some((m) => m.role === 'super_user');
    if (c.environment === 'prod' || !listed || existing) {
      await this.auditDenied('claimSuperUser', 'super_user.claim', null);
      throw deny(existing ? 'You already hold the super_user role.' : 'Super user is not available for your account in this environment.');
    }
    const now = this.now();
    const row: MembershipRow = {
      id: this.d.newId(),
      app_id: c.appId,
      user_email: this.d.caller.email,
      user_sub: this.d.caller.sub,
      role: 'super_user',
      status: 'active',
      reason: `Claimed from deployment configuration (superUserEmails, ${c.environment})`,
      granted_by_email: 'deployment-config',
      granted_by_sub: 'deployment-config',
      granted_at: now,
      revoked_by_email: null,
      revoked_at: null,
      updated_at: now,
    };
    await this.d.store
      .insertMembership(
        row,
        this.d.caller.sub,
        this.draft({ action: 'membership.super_user_claimed', objectType: 'AppMembership', objectId: row.id, outcome: 'SUCCESS', details: { role: 'super_user', environment: c.environment } })
      )
      .catch(rethrowWrite);
    this.roles = null;
    return membershipView(row);
  }

  // ---------------------------------------------------------------------------
  // Configuration, seed, diagnostics, Foundry readiness and evaluation
  // ---------------------------------------------------------------------------

  async seedSampleData(): Promise<SeedResponse> {
    await this.require('config.manage', 'seedSampleData');
    const c = this.d.config;
    const now = this.now();
    await this.d.store
      .upsertAppConfig(
        {
          id: deterministicUuid(`appconfig:${c.orgId}:${c.projectId}:${c.appId}:${c.environment}`),
          org_id: c.orgId,
          project_id: c.projectId,
          app_id: c.appId,
          environment: c.environment,
          allowed_ai_config_json: JSON.stringify({
            foundryProjectEndpoint: c.foundry.projectEndpoint,
            agentName: c.foundry.agentName,
            agentVersionLabel: c.foundry.agentVersionLabel,
            apiVersion: c.foundry.apiVersion,
            promptContractVersion: PROMPT_CONTRACT_VERSION,
          }),
          active_version: c.release,
          owner_email: c.ownerEmail,
          updated_at: now,
        },
        this.draft({ action: 'config.upserted', objectType: 'AppConfig', objectId: null, outcome: 'SUCCESS', details: { release: c.release } })
      )
      .catch(rethrowWrite);
    const n = await this.d.store
      .upsertSamples(
        SAMPLES.map((s, i) => ({
          id: s.id,
          app_id: c.appId,
          label: s.label,
          address: s.address,
          expected_json: JSON.stringify(s.expected),
          sort_order: i + 1,
        })),
        this.draft({ action: 'samples.seeded', objectType: 'SampleAddress', objectId: null, outcome: 'SUCCESS', details: { count: SAMPLES.length } })
      )
      .catch(rethrowWrite);
    return { appConfigUpserted: true, samplesUpserted: n };
  }

  async diagnostics(): Promise<DiagnosticsResponse> {
    await this.require('config.manage', 'diagnostics');
    const c = this.d.config;
    return {
      release: c.release,
      environment: c.environment,
      config: {
        orgId: c.orgId,
        projectId: c.projectId,
        appId: c.appId,
        foundryProjectEndpoint: c.foundry.projectEndpoint,
        agentName: c.foundry.agentName,
        agentVersionLabel: c.foundry.agentVersionLabel,
        apiVersion: c.foundry.apiVersion,
        sqlServer: c.sql.server,
        sqlDatabase: c.sql.database,
        sqlSchema: c.sql.schema,
        bootstrapConfigured: c.bootstrapAdminEmails.length > 0,
        faultInjection: activeFault(c),
      },
      schema: await this.d.store.schemaCheck(EXPECTED_COLUMNS),
    };
  }

  async probeFoundry(): Promise<FoundryProbeResponse> {
    await this.require('config.manage', 'probeFoundry');
    const sample = SAMPLES[0];
    const base = { agentName: this.d.config.foundry.agentName };
    try {
      const ai = await this.d.callAgent(buildAgentInput(sample.address));
      const parsed = parseAgentOutput(ai.outputText, sample.address);
      await this.d.store.appendAudit(
        this.draft({ action: 'foundry.probe', objectType: 'FoundryAgent', objectId: null, outcome: parsed.ok ? 'SUCCESS' : 'FAILURE', agentRef: this.agentRef, details: { contractValid: parsed.ok, aiLatencyMs: ai.latencyMs, attempts: ai.attempts } })
      );
      return { ...base, reachable: true, contractValid: parsed.ok, validationErrors: parsed.ok ? [] : parsed.errors, aiLatencyMs: ai.latencyMs, attempts: ai.attempts, responseId: ai.responseId, model: ai.model };
    } catch (err) {
      const kind = err instanceof FoundryError ? err.kind : 'unavailable';
      await this.d.store.appendAudit(
        this.draft({ action: 'foundry.probe', objectType: 'FoundryAgent', objectId: null, outcome: 'FAILURE', agentRef: this.agentRef, details: { kind, status: err instanceof FoundryError ? err.status : null } })
      );
      return { ...base, reachable: false, contractValid: false, validationErrors: [`Foundry call failed: ${kind}${err instanceof FoundryError && err.status ? ` (HTTP ${err.status})` : ''}`], aiLatencyMs: 0, attempts: err instanceof FoundryError ? err.attempts : 0, responseId: null, model: null };
    }
  }

  async runEvaluationSample(req: EvaluationSampleRequest): Promise<EvaluationSampleResponse> {
    await this.require('config.manage', 'runEvaluationSample');
    const sample = SAMPLES.find((s) => s.id === req?.sampleId || s.key === req?.sampleId);
    if (!sample) throw invalid('Unknown sample.');
    let ai: FoundryInvokeResult;
    try {
      ai = await this.d.callAgent(buildAgentInput(sample.address));
    } catch (err) {
      throw new AppError(err instanceof FoundryError && err.kind === 'timeout' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE', 'The address service call failed during evaluation.');
    }
    const parsed = parseAgentOutput(ai.outputText, sample.address);
    const actual = parsed.ok ? parsed.value.fields : parsed.partial?.fields ?? null;
    const fieldResults = FIELD_NAMES.map((field) => ({
      field,
      expected: sample.expected[field],
      actual: actual ? actual[field] ?? null : null,
      match: Boolean(actual) && (actual?.[field] ?? null) === sample.expected[field],
    }));
    const allMatch = parsed.ok && fieldResults.every((r) => r.match);
    await this.d.store.appendAudit(
      this.draft({ action: 'evaluation.sample_run', objectType: 'SampleAddress', objectId: sample.id, outcome: allMatch ? 'SUCCESS' : 'FAILURE', agentRef: this.agentRef, promptContractVersion: PROMPT_CONTRACT_VERSION, details: { sample: sample.key, allMatch, contractValid: parsed.ok } })
    );
    return { sampleId: sample.id, label: sample.label, contractValid: parsed.ok, validationErrors: parsed.ok ? [] : parsed.errors, fieldResults, allMatch, aiLatencyMs: ai.latencyMs };
  }
}

// -----------------------------------------------------------------------------
// Mapping helpers
// -----------------------------------------------------------------------------

function rethrowWrite(err: unknown): never {
  if (err instanceof AuditWriteError) throw new AppError('AUDIT_FAILURE', 'The change was not saved because the audit store is unavailable. Try again later.');
  throw new AppError('STORAGE_FAILURE', 'The change could not be saved. Try again later.');
}

function paging(page: unknown, pageSize: unknown, max: number): { page: number; pageSize: number } {
  const p = Number.isInteger(page) && (page as number) >= 1 && (page as number) <= 10_000 ? (page as number) : 1;
  const s = Number.isInteger(pageSize) && (pageSize as number) >= 1 ? Math.min(pageSize as number, max) : Math.min(25, max);
  return { page: p, pageSize: s };
}

function auditFilter(req: AuditSearchRequest | undefined) {
  const parseDate = (v: unknown, name: string): Date | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const d = typeof v === 'string' ? new Date(v) : null;
    if (!d || Number.isNaN(d.getTime())) throw invalid(`${name} must be an ISO-8601 date/time.`, { [name]: 'Invalid date.' });
    return d;
  };
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const outcome = req?.outcome && ['SUCCESS', 'DENIED', 'FAILURE'].includes(req.outcome) ? req.outcome : undefined;
  return {
    actorEmail: text(req?.actorEmail, 320)?.toLowerCase(),
    action: text(req?.action, 100),
    outcome,
    correlationId: text(req?.correlationIdFilter, 64),
    fromUtc: parseDate(req?.fromUtc, 'fromUtc'),
    toUtc: parseDate(req?.toUtc, 'toUtc'),
  };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function boundedJson(value: unknown, max: number): string {
  const s = JSON.stringify(value);
  if (s.length <= max) return s;
  if (Array.isArray(value)) {
    const items = [...value];
    while (items.length && JSON.stringify([...items, '[truncated]']).length > max) items.pop();
    return JSON.stringify([...items, '[truncated]']);
  }
  return JSON.stringify({ truncated: true, sha256: sha256Hex(s) });
}

function emptyFields(): AddressFields {
  return { building: null, street: null, town: null, region: null, postcode: null, country: null };
}

function parseFields(json: string | null): AddressFields | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const out = emptyFields();
    for (const f of FIELD_NAMES) out[f] = typeof v[f] === 'string' ? (v[f] as string) : null;
    return out;
  } catch {
    return null;
  }
}

function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function summary(r: RequestRow): RecordSummary {
  return {
    id: r.id,
    creatorEmail: r.creator_email,
    addressExcerpt: r.original_address.length > 80 ? `${r.original_address.slice(0, 77)}...` : r.original_address,
    processingStatus: r.processing_status,
    reviewStatus: r.review_status,
    decision: r.decision,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function resultView(r: ResultRow): AddressResultView {
  const fields = parseFields(r.fields_json);
  return {
    validationOutcome: r.validation_outcome,
    validationErrors: parseJson<string[]>(r.validation_errors_json, []),
    fields,
    evidence: parseFields(r.evidence_json),
    notes: parseJson<string[]>(r.notes_json, []),
    decision: r.decision,
    checks: r.validation_outcome === 'VALID' ? evaluateChecks(fields).checks : [],
    agentName: r.agent_name,
    agentVersionLabel: r.agent_version_label,
    promptContractVersion: r.prompt_contract_version,
    responseId: r.response_id,
    aiLatencyMs: r.ai_latency_ms,
    processingMs: r.processing_ms,
    createdAt: r.created_at.toISOString(),
  };
}

function reviewView(r: ReviewRow): ReviewView {
  return {
    id: r.id,
    reviewerEmail: r.reviewer_email,
    decision: r.decision,
    comments: r.comments,
    changedFields: parseJson(r.changed_fields_json, {}),
    recordVersion: r.record_version,
    createdAt: r.created_at.toISOString(),
  };
}

function auditView(r: AuditRow): AuditEventView {
  return {
    id: r.id,
    seq: r.seq,
    appId: r.app_id,
    environment: r.environment,
    actorEmail: r.actor_email,
    action: r.action,
    objectType: r.object_type,
    objectId: r.object_id,
    outcome: r.outcome,
    correlationId: r.correlation_id,
    releaseVersion: r.release_version,
    details: parseJson<Record<string, unknown> | null>(r.details_json, null),
    occurredAt: r.occurred_at.toISOString(),
  };
}

function membershipView(m: MembershipRow): MembershipView {
  return {
    id: m.id,
    userEmail: m.user_email,
    bound: Boolean(m.user_sub),
    role: m.role,
    status: m.status,
    reason: m.reason,
    grantedByEmail: m.granted_by_email,
    grantedAt: m.granted_at.toISOString(),
    revokedByEmail: m.revoked_by_email,
    revokedAt: m.revoked_at ? m.revoked_at.toISOString() : null,
  };
}

/** Stable UUID (v8 layout) from a name, for idempotent seed rows. */
export function deterministicUuid(name: string): string {
  const h = sha256Hex(name);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
