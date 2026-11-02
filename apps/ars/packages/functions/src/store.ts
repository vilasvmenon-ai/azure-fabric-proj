import type {
  ExtractionDecision,
  MembershipRole,
  OwnerStatus,
  ProcessingStatus,
  ReviewDecision,
  ReviewStatus,
} from '@rayfin-app/shared';

import type { AuditDraft, AuditRow } from './audit.js';

/**
 * Persistence boundary for trusted server operations.
 *
 * The production implementation is SqlStore (Rayfin `ctx.Tokens.Sql` + mssql,
 * D-21). Unit tests use an in-memory fake that lives only under test/ and is
 * never deployed (DEL-06).
 *
 * Every method that takes an AuditDraft writes the business change and the
 * audit event in ONE transaction: if the audit insert fails, the business
 * change is rolled back and AuditWriteError is thrown (AUD-04).
 */

export interface MembershipRow {
  id: string;
  app_id: string;
  user_email: string;
  user_sub: string | null;
  role: MembershipRole;
  status: 'active' | 'revoked';
  reason: string;
  granted_by_email: string;
  granted_by_sub: string;
  granted_at: Date;
  revoked_by_email: string | null;
  revoked_at: Date | null;
  updated_at: Date;
}

export interface RequestRow {
  id: string;
  app_id: string;
  creator_sub: string;
  creator_email: string;
  client_request_id: string;
  request_key: string;
  original_address: string;
  input_sha256: string;
  processing_status: ProcessingStatus;
  review_status: ReviewStatus;
  decision: ExtractionDecision;
  current_fields_json: string | null;
  version: number;
  owner_status: OwnerStatus;
  correlation_id: string;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ResultRow {
  id: string;
  request_id: string;
  app_id: string;
  creator_sub: string;
  owner_status: OwnerStatus;
  validation_outcome: 'VALID' | 'INVALID';
  validation_errors_json: string | null;
  fields_json: string | null;
  evidence_json: string | null;
  notes_json: string | null;
  decision: ExtractionDecision;
  agent_name: string;
  agent_version_label: string | null;
  prompt_contract_version: string;
  response_id: string | null;
  model: string | null;
  raw_output_sha256: string;
  raw_output_excerpt: string | null;
  ai_latency_ms: number;
  processing_ms: number;
  usage_json: string | null;
  created_at: Date;
}

export interface ReviewRow {
  id: string;
  request_id: string;
  app_id: string;
  reviewer_sub: string;
  reviewer_email: string;
  decision: ReviewDecision;
  comments: string | null;
  changed_fields_json: string | null;
  record_version: number;
  created_at: Date;
}

export interface SampleRow {
  id: string;
  app_id: string;
  label: string;
  address: string;
  expected_json: string;
  sort_order: number;
}

export interface AppConfigRow {
  id: string;
  org_id: string;
  project_id: string;
  app_id: string;
  environment: 'local' | 'dev' | 'uat' | 'prod';
  allowed_ai_config_json: string;
  active_version: string;
  owner_email: string;
  updated_at: Date;
}

export interface RequestFilter {
  creatorSub?: string;
  processingStatus?: ProcessingStatus;
  reviewStatus?: ReviewStatus;
}

export interface AuditFilter {
  actorEmail?: string;
  action?: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  correlationId?: string;
  fromUtc?: Date;
  toUtc?: Date;
}

export interface SchemaCheckRow {
  table: string;
  present: boolean;
  missingColumns: string[];
}

/** Thrown when the audit insert of a transactional operation fails. */
export class AuditWriteError extends Error {
  constructor(message = 'Audit write failed') {
    super(message);
    this.name = 'AuditWriteError';
  }
}

/** Thrown when a unique request key already exists. */
export class DuplicateKeyError extends Error {
  constructor() {
    super('Duplicate request key');
    this.name = 'DuplicateKeyError';
  }
}

export interface CompleteProcessingArgs {
  requestId: string;
  result: ResultRow;
  processingStatus: 'COMPLETED' | 'FAILED_VALIDATION';
  decision: ExtractionDecision;
  currentFieldsJson: string | null;
  now: Date;
  audit: AuditDraft;
}

export interface ApplyReviewArgs {
  requestId: string;
  expectedVersion: number;
  currentFieldsJson: string | null;
  reviewStatus: ReviewStatus;
  review: ReviewRow;
  now: Date;
  audit: AuditDraft;
}

export type ApplyReviewOutcome = { ok: true; newVersion: number } | { ok: false; currentVersion: number | null };

export interface Store {
  // Membership
  listActiveMembershipsByEmail(email: string): Promise<MembershipRow[]>;
  listMembershipsByEmail(email: string): Promise<MembershipRow[]>;
  bindMembershipSub(ids: string[], sub: string, now: Date, audit: AuditDraft): Promise<void>;
  countActiveAdmins(): Promise<number>;
  listMemberships(): Promise<MembershipRow[]>;
  getMembership(id: string): Promise<MembershipRow | null>;
  insertMembership(row: MembershipRow, reactivateOwnerSub: string | null, audit: AuditDraft): Promise<void>;
  revokeMembership(
    id: string,
    revokedByEmail: string,
    now: Date,
    revokeOwnerSub: string | null,
    audit: AuditDraft
  ): Promise<void>;

  // Address requests
  findRequestByKey(requestKey: string): Promise<RequestRow | null>;
  getRequest(id: string): Promise<RequestRow | null>;
  /** Throws DuplicateKeyError if request_key already exists. */
  insertRequest(row: RequestRow, audit: AuditDraft): Promise<void>;
  /** Atomically moves a request to PROCESSING if it is in one of `from` (or stale PROCESSING). */
  claimForProcessing(id: string, from: ProcessingStatus[], staleBefore: Date, now: Date): Promise<boolean>;
  completeProcessing(args: CompleteProcessingArgs): Promise<void>;
  failProcessing(id: string, status: ProcessingStatus, errorCode: string, now: Date, audit: AuditDraft | null): Promise<void>;
  getLatestResult(requestId: string): Promise<ResultRow | null>;
  listReviews(requestId: string): Promise<ReviewRow[]>;
  listRequests(filter: RequestFilter, offset: number, limit: number): Promise<RequestRow[]>;
  applyReview(args: ApplyReviewArgs): Promise<ApplyReviewOutcome>;

  // Audit
  appendAudit(audit: AuditDraft): Promise<void>;
  searchAudit(filter: AuditFilter, offset: number, limit: number): Promise<AuditRow[]>;
  readAuditFrom(fromSeq: number, limit: number): Promise<AuditRow[]>;

  // Configuration and seed data
  upsertAppConfig(row: AppConfigRow, audit: AuditDraft): Promise<void>;
  upsertSamples(rows: SampleRow[], audit: AuditDraft): Promise<number>;
  listSamples(): Promise<SampleRow[]>;
  getSample(id: string): Promise<SampleRow | null>;

  // Diagnostics
  schemaCheck(expected: Record<string, readonly string[]>): Promise<SchemaCheckRow[]>;

  close(): Promise<void>;
}
