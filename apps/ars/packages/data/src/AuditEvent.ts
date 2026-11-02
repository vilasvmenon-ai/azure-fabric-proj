import { date, entity, int, role, set, text, uuid } from '@microsoft/rayfin-core';

import { SERVER_ONLY_LOCK } from './policies.js';

/**
 * Business audit event (PRD §8 AUD-02). Server-only and append-only: no client
 * role may create, update or delete rows. `prev_hash`/`event_hash` form a
 * SHA-256 chain ordered by `seq` so edits, deletions and insertions are
 * detectable (`verifyAuditChain`). Address text is never stored here.
 */
@entity()
@role('authenticated', 'read', {
  policy: (claims, item) => claims.sub.eq(item.server_lock),
})
export class AuditEvent {
  @uuid() id!: string;
  @int({ min: 1, unique: true }) seq!: number;
  @text({ max: 100 }) org_id!: string;
  @text({ max: 100 }) project_id!: string;
  @text({ max: 100 }) app_id!: string;
  @text({ max: 20 }) environment!: string;
  @text({ optional: true, max: 200 }) actor_sub?: string;
  @text({ optional: true, max: 320 }) actor_email?: string;
  @text({ min: 1, max: 100 }) action!: string;
  @text({ min: 1, max: 50 }) object_type!: string;
  @text({ optional: true, max: 100 }) object_id?: string;
  @set('SUCCESS', 'DENIED', 'FAILURE') outcome!: 'SUCCESS' | 'DENIED' | 'FAILURE';
  @text({ max: 64 }) correlation_id!: string;
  @text({ max: 50 }) release_version!: string;
  @text({ optional: true, max: 300 }) agent_ref?: string;
  @text({ optional: true, max: 100 }) prompt_contract_version?: string;
  @text({ optional: true, max: 2000 }) details_json?: string;
  @text({ min: 64, max: 64 }) prev_hash!: string;
  @text({ min: 64, max: 64 }) event_hash!: string;
  @date() occurred_at!: Date;
  @text({ max: 40, default: SERVER_ONLY_LOCK }) server_lock!: string;
}
