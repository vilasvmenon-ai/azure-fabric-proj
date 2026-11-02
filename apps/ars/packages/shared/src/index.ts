/**
 * Browser-safe contracts shared by the data registration package, the
 * functions package (type-only) and the frontend.
 *
 * Keep each record shape aligned with its decorated runtime entity in
 * `@rayfin-app/data`. This package must stay isomorphic, so do not import the
 * decorated classes here. The functions package imports only its types
 * (`import type`), so the deployed functions bundle never needs it at runtime.
 */

// ---------------------------------------------------------------------------
// Address contract (preserved from the existing Foundry agent's contract)
// ---------------------------------------------------------------------------

export const ADDRESS_FIELD_NAMES = [
  'building',
  'street',
  'town',
  'region',
  'postcode',
  'country',
] as const;

export type AddressFieldName = (typeof ADDRESS_FIELD_NAMES)[number];
export type AddressFields = Record<AddressFieldName, string | null>;

export type ProcessingStatus =
  | 'RECEIVED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED_AI'
  | 'FAILED_VALIDATION'
  | 'FAILED_STORAGE'
  | 'FAILED_AUDIT';

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'NEEDS_CHANGES';
export type ReviewDecision = 'APPROVED' | 'REJECTED' | 'NEEDS_CHANGES' | 'COMMENT';
export type ExtractionDecision = 'FIELDS_PRESENT' | 'NEEDS_REVIEW' | 'NONE';
export type OwnerStatus = 'active' | 'revoked';

// ---------------------------------------------------------------------------
// Entity records (generated data API surface)
// ---------------------------------------------------------------------------

export type AppConfigRecord = {
  id: string;
  org_id: string;
  project_id: string;
  app_id: string;
  environment: 'local' | 'dev' | 'uat' | 'prod';
  allowed_ai_config_json: string;
  active_version: string;
  owner_email: string;
  server_lock: string;
  updated_at: Date;
}

export type MembershipRole =
  | 'app_user'
  | 'reviewer'
  | 'auditor'
  | 'audit_exporter'
  | 'app_admin'
  /** app_user + app_admin combined; claimable from deployment config in non-prod only (D-57). */
  | 'super_user';

export type AppMembershipRecord = {
  id: string;
  app_id: string;
  user_email: string;
  user_sub?: string | null;
  role: MembershipRole;
  status: 'active' | 'revoked';
  reason: string;
  granted_by_email: string;
  granted_by_sub: string;
  granted_at: Date;
  revoked_by_email?: string | null;
  revoked_at?: Date | null;
  updated_at: Date;
  server_lock: string;
}

export type AddressRequestRecord = {
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
  current_fields_json?: string | null;
  version: number;
  owner_status: OwnerStatus;
  correlation_id: string;
  error_code?: string | null;
  created_at: Date;
  updated_at: Date;
}

export type AddressResultRecord = {
  id: string;
  request_id: string;
  app_id: string;
  creator_sub: string;
  owner_status: OwnerStatus;
  validation_outcome: 'VALID' | 'INVALID';
  validation_errors_json?: string | null;
  fields_json?: string | null;
  evidence_json?: string | null;
  notes_json?: string | null;
  decision: ExtractionDecision;
  agent_name: string;
  agent_version_label?: string | null;
  prompt_contract_version: string;
  response_id?: string | null;
  model?: string | null;
  raw_output_sha256: string;
  raw_output_excerpt?: string | null;
  ai_latency_ms: number;
  processing_ms: number;
  usage_json?: string | null;
  created_at: Date;
}

export type ReviewHistoryRecord = {
  id: string;
  request_id: string;
  app_id: string;
  reviewer_sub: string;
  reviewer_email: string;
  decision: ReviewDecision;
  comments?: string | null;
  changed_fields_json?: string | null;
  record_version: number;
  created_at: Date;
  server_lock: string;
}

export type AuditEventRecord = {
  id: string;
  seq: number;
  org_id: string;
  project_id: string;
  app_id: string;
  environment: string;
  actor_sub?: string | null;
  actor_email?: string | null;
  action: string;
  object_type: string;
  object_id?: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  correlation_id: string;
  release_version: string;
  agent_ref?: string | null;
  prompt_contract_version?: string | null;
  details_json?: string | null;
  prev_hash: string;
  event_hash: string;
  occurred_at: Date;
  server_lock: string;
}

export type SampleAddressRecord = {
  id: string;
  app_id: string;
  label: string;
  address: string;
  expected_json: string;
  sort_order: number;
}

export type UniversalAppSchema = {
  AppConfig: AppConfigRecord;
  AppMembership: AppMembershipRecord;
  AddressRequest: AddressRequestRecord;
  AddressResult: AddressResultRecord;
  ReviewHistory: ReviewHistoryRecord;
  AuditEvent: AuditEventRecord;
  SampleAddress: SampleAddressRecord;
};

// ---------------------------------------------------------------------------
// Function API contracts (all functions return ApiResult<T>)
// ---------------------------------------------------------------------------

export type Permission =
  | 'address.submit'
  | 'address.read.own'
  | 'address.read.all'
  | 'address.retry.own'
  | 'review.update'
  | 'audit.read'
  | 'audit.export'
  | 'audit.verify'
  | 'membership.manage'
  | 'config.manage';

export type ApiErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'ACCESS_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE_IN_PROGRESS'
  | 'AI_TIMEOUT'
  | 'AI_UNAVAILABLE'
  | 'AI_INVALID_OUTPUT'
  | 'STORAGE_FAILURE'
  | 'AUDIT_FAILURE'
  | 'CONFIG'
  | 'INTERNAL';

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  /** Present when a request record exists, so the user can recover. */
  requestId?: string;
  /** Present on CONFLICT so the UI can reload the newer version. */
  currentVersion?: number;
  fieldErrors?: Record<string, string>;
}

export type ApiResult<T> =
  | { ok: true; data: T; correlationId: string }
  | { ok: false; error: ApiError; correlationId: string };

/** Every request carries an optional browser-generated correlation id. */
export type BaseRequest = {
  correlationId?: string;
}

export type WhoAmIResponse = {
  user: { sub: string; email: string };
  app: {
    orgId: string;
    projectId: string;
    appId: string;
    appName: string;
    environment: string;
    release: string;
  };
  roles: MembershipRole[];
  permissions: Permission[];
  bootstrapAvailable: boolean;
  /** True when the caller is listed in superUserEmails (non-prod) and has not claimed super_user yet. */
  superUserAvailable: boolean;
  faultInjection: string | null;
}

export type SubmitAddressRequest = BaseRequest & {
  clientRequestId: string;
  address: string;
}

export type CheckResult = {
  name: string;
  passed: boolean;
}

export type AddressResultView = {
  validationOutcome: 'VALID' | 'INVALID';
  validationErrors: string[];
  fields: AddressFields | null;
  evidence: AddressFields | null;
  notes: string[];
  decision: ExtractionDecision;
  checks: CheckResult[];
  agentName: string;
  agentVersionLabel: string | null;
  promptContractVersion: string;
  responseId: string | null;
  aiLatencyMs: number;
  processingMs: number;
  createdAt: string;
}

export type RecordSummary = {
  id: string;
  creatorEmail: string;
  addressExcerpt: string;
  processingStatus: ProcessingStatus;
  reviewStatus: ReviewStatus;
  decision: ExtractionDecision;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ReviewView = {
  id: string;
  reviewerEmail: string;
  decision: ReviewDecision;
  comments: string | null;
  changedFields: Record<string, { from: string | null; to: string | null }>;
  recordVersion: number;
  createdAt: string;
}

export type RecordDetail = RecordSummary & {
  originalAddress: string;
  currentFields: AddressFields | null;
  correlationId: string;
  errorCode: string | null;
  result: AddressResultView | null;
  reviews: ReviewView[];
  canReview: boolean;
  canRetry: boolean;
}

export type SubmitAddressResponse = {
  duplicate: boolean;
  record: RecordDetail;
}

export type RequestIdRequest = BaseRequest & {
  requestId: string;
}

export type ListRecordsRequest = BaseRequest & {
  scope: 'mine' | 'all';
  processingStatus?: ProcessingStatus;
  reviewStatus?: ReviewStatus;
  page?: number;
  pageSize?: number;
}

export type Page<T> = {
  items: T[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

export type SubmitReviewRequest = BaseRequest & {
  requestId: string;
  expectedVersion: number;
  decision: ReviewDecision;
  comments?: string;
  fieldEdits?: Partial<AddressFields>;
}

export type AuditSearchRequest = BaseRequest & {
  actorEmail?: string;
  action?: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  correlationIdFilter?: string;
  fromUtc?: string;
  toUtc?: string;
  page?: number;
  pageSize?: number;
}

export type AuditEventView = {
  id: string;
  seq: number;
  appId: string;
  environment: string;
  actorEmail: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  correlationId: string;
  releaseVersion: string;
  details: Record<string, unknown> | null;
  occurredAt: string;
}

export type AuditExportResponse = {
  fileName: string;
  contentType: 'text/csv';
  rowCount: number;
  truncated: boolean;
  content: string;
}

export type AuditChainResponse = {
  intact: boolean;
  checked: number;
  firstBrokenSeq: number | null;
  reason: string | null;
}

export type MembershipView = {
  id: string;
  userEmail: string;
  bound: boolean;
  role: MembershipRole;
  status: 'active' | 'revoked';
  reason: string;
  grantedByEmail: string;
  grantedAt: string;
  revokedByEmail: string | null;
  revokedAt: string | null;
}

export type GrantMembershipRequest = BaseRequest & {
  userEmail: string;
  role: MembershipRole;
  reason: string;
}

export type RevokeMembershipRequest = BaseRequest & {
  membershipId: string;
  reason: string;
}

export type DiagnosticsResponse = {
  release: string;
  environment: string;
  config: Record<string, string | boolean | null>;
  schema: { table: string; present: boolean; missingColumns: string[] }[];
}

export type FoundryProbeResponse = {
  reachable: boolean;
  contractValid: boolean;
  validationErrors: string[];
  aiLatencyMs: number;
  attempts: number;
  agentName: string;
  responseId: string | null;
  model: string | null;
}

export type EvaluationSampleRequest = BaseRequest & {
  sampleId: string;
}

export type EvaluationSampleResponse = {
  sampleId: string;
  label: string;
  contractValid: boolean;
  validationErrors: string[];
  fieldResults: { field: AddressFieldName; expected: string | null; actual: string | null; match: boolean }[];
  allMatch: boolean;
  aiLatencyMs: number;
}

export type SampleAddressView = {
  id: string;
  label: string;
  address: string;
}

export type SeedResponse = {
  appConfigUpserted: boolean;
  samplesUpserted: number;
}
