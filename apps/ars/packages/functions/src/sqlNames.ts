/**
 * Physical SQL names for the Rayfin-generated tables (D-24).
 *
 * VERIFIED 26 Oct 2026 against the deployed dev database (R-09): Rayfin 1.36.2
 * creates one table per entity in schema `dbo`, named with the PLURAL of the
 * entity class (AddressRequest -> AddressRequests, ReviewHistory ->
 * ReviewHistories), and one column per decorated property using the property
 * name. The `diagnostics` function and scripts/51-Test-AppSchema.ps1 compare
 * this map with INFORMATION_SCHEMA. Change names here only.
 */
export const TABLES = {
  AppConfig: 'AppConfigs',
  AppMembership: 'AppMemberships',
  AddressRequest: 'AddressRequests',
  AddressResult: 'AddressResults',
  ReviewHistory: 'ReviewHistories',
  AuditEvent: 'AuditEvents',
  SampleAddress: 'SampleAddresses',
} as const;

export const EXPECTED_COLUMNS: Record<keyof typeof TABLES, readonly string[]> = {
  AppConfig: ['id', 'org_id', 'project_id', 'app_id', 'environment', 'allowed_ai_config_json', 'active_version', 'owner_email', 'server_lock', 'updated_at'],
  AppMembership: ['id', 'app_id', 'user_email', 'user_sub', 'role', 'status', 'reason', 'granted_by_email', 'granted_by_sub', 'granted_at', 'revoked_by_email', 'revoked_at', 'updated_at', 'server_lock'],
  AddressRequest: ['id', 'app_id', 'creator_sub', 'creator_email', 'client_request_id', 'request_key', 'original_address', 'input_sha256', 'processing_status', 'review_status', 'decision', 'current_fields_json', 'version', 'owner_status', 'correlation_id', 'error_code', 'created_at', 'updated_at'],
  AddressResult: ['id', 'request_id', 'app_id', 'creator_sub', 'owner_status', 'validation_outcome', 'validation_errors_json', 'fields_json', 'evidence_json', 'notes_json', 'decision', 'agent_name', 'agent_version_label', 'prompt_contract_version', 'response_id', 'model', 'raw_output_sha256', 'raw_output_excerpt', 'ai_latency_ms', 'processing_ms', 'usage_json', 'created_at'],
  ReviewHistory: ['id', 'request_id', 'app_id', 'reviewer_sub', 'reviewer_email', 'decision', 'comments', 'changed_fields_json', 'record_version', 'created_at', 'server_lock'],
  AuditEvent: ['id', 'seq', 'org_id', 'project_id', 'app_id', 'environment', 'actor_sub', 'actor_email', 'action', 'object_type', 'object_id', 'outcome', 'correlation_id', 'release_version', 'agent_ref', 'prompt_contract_version', 'details_json', 'prev_hash', 'event_hash', 'occurred_at', 'server_lock'],
  SampleAddress: ['id', 'app_id', 'label', 'address', 'expected_json', 'sort_order'],
};

/** Must match packages/data/src/policies.ts SERVER_ONLY_LOCK. */
export const SERVER_ONLY_LOCK = 'ionova:server-only';

export function qualified(schema: string, table: string): string {
  return `[${schema}].[${table}]`;
}
