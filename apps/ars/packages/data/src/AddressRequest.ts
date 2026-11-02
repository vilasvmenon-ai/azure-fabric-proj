import { date, entity, int, role, set, text, uuid } from '@microsoft/rayfin-core';

/**
 * A submitted address (PRD §5 "Address request"). `original_address` is never
 * changed after creation; human corrections go to `current_fields_json` and
 * ReviewHistory.
 *
 * Generated data API: read-only, own rows only, and only while the owner's
 * membership is active (`owner_status`, flipped by revocation). All writes are
 * made by trusted functions.
 */
@entity()
@role('authenticated', 'read', {
  policy: (claims, item) =>
    claims.sub.eq(item.creator_sub).and(item.owner_status.eq('active')),
})
export class AddressRequest {
  @uuid() id!: string;
  @text({ min: 1, max: 100 }) app_id!: string;
  @text({ min: 1, max: 200 }) creator_sub!: string;
  @text({ max: 320 }) creator_email!: string;
  @text({ min: 36, max: 36 }) client_request_id!: string;
  @text({ max: 240, unique: true }) request_key!: string;
  @text({ min: 1, max: 2000 }) original_address!: string;
  @text({ min: 64, max: 64 }) input_sha256!: string;
  @set(
    'RECEIVED',
    'PROCESSING',
    'COMPLETED',
    'FAILED_AI',
    'FAILED_VALIDATION',
    'FAILED_STORAGE',
    'FAILED_AUDIT'
  )
  processing_status!:
    | 'RECEIVED'
    | 'PROCESSING'
    | 'COMPLETED'
    | 'FAILED_AI'
    | 'FAILED_VALIDATION'
    | 'FAILED_STORAGE'
    | 'FAILED_AUDIT';
  @set('PENDING', 'APPROVED', 'REJECTED', 'NEEDS_CHANGES')
  review_status!: 'PENDING' | 'APPROVED' | 'REJECTED' | 'NEEDS_CHANGES';
  @set('FIELDS_PRESENT', 'NEEDS_REVIEW', 'NONE')
  decision!: 'FIELDS_PRESENT' | 'NEEDS_REVIEW' | 'NONE';
  @text({ optional: true, max: 2000 }) current_fields_json?: string;
  @int({ min: 0 }) version!: number;
  @set('active', 'revoked') owner_status!: 'active' | 'revoked';
  @text({ max: 64 }) correlation_id!: string;
  @text({ optional: true, max: 40 }) error_code?: string;
  @date() created_at!: Date;
  @date() updated_at!: Date;
}
