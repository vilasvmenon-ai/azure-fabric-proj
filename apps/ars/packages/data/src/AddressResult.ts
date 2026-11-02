import { date, entity, int, role, set, text, uuid } from '@microsoft/rayfin-core';

/**
 * The agent's proposed extraction for one request (PRD §5 "Address result").
 * Immutable after insert. Invalid agent output is preserved and flagged
 * (`validation_outcome = 'INVALID'`) rather than discarded (AI-04).
 *
 * `creator_sub` and `owner_status` are denormalised from AddressRequest so the
 * same owner-only read policy can be expressed (Rayfin policies cannot join).
 */
@entity()
@role('authenticated', 'read', {
  policy: (claims, item) =>
    claims.sub.eq(item.creator_sub).and(item.owner_status.eq('active')),
})
export class AddressResult {
  @uuid() id!: string;
  @uuid() request_id!: string;
  @text({ min: 1, max: 100 }) app_id!: string;
  @text({ min: 1, max: 200 }) creator_sub!: string;
  @set('active', 'revoked') owner_status!: 'active' | 'revoked';
  @set('VALID', 'INVALID') validation_outcome!: 'VALID' | 'INVALID';
  @text({ optional: true, max: 2000 }) validation_errors_json?: string;
  @text({ optional: true, max: 2000 }) fields_json?: string;
  @text({ optional: true, max: 2000 }) evidence_json?: string;
  @text({ optional: true, max: 4000 }) notes_json?: string;
  @set('FIELDS_PRESENT', 'NEEDS_REVIEW', 'NONE')
  decision!: 'FIELDS_PRESENT' | 'NEEDS_REVIEW' | 'NONE';
  @text({ max: 200 }) agent_name!: string;
  @text({ optional: true, max: 50 }) agent_version_label?: string;
  @text({ max: 100 }) prompt_contract_version!: string;
  @text({ optional: true, max: 200 }) response_id?: string;
  @text({ optional: true, max: 200 }) model?: string;
  @text({ min: 64, max: 64 }) raw_output_sha256!: string;
  @text({ optional: true, max: 4000 }) raw_output_excerpt?: string;
  @int({ min: 0 }) ai_latency_ms!: number;
  @int({ min: 0 }) processing_ms!: number;
  @text({ optional: true, max: 500 }) usage_json?: string;
  @date() created_at!: Date;
}
