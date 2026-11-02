import { date, entity, int, role, set, text, uuid } from '@microsoft/rayfin-core';

import { SERVER_ONLY_LOCK } from './policies.js';

/** Append-only review history (PRD §5 "Review history"). Server-only. */
@entity()
@role('authenticated', 'read', {
  policy: (claims, item) => claims.sub.eq(item.server_lock),
})
export class ReviewHistory {
  @uuid() id!: string;
  @uuid() request_id!: string;
  @text({ min: 1, max: 100 }) app_id!: string;
  @text({ min: 1, max: 200 }) reviewer_sub!: string;
  @text({ max: 320 }) reviewer_email!: string;
  @set('APPROVED', 'REJECTED', 'NEEDS_CHANGES', 'COMMENT')
  decision!: 'APPROVED' | 'REJECTED' | 'NEEDS_CHANGES' | 'COMMENT';
  @text({ optional: true, max: 2000 }) comments?: string;
  @text({ optional: true, max: 2000 }) changed_fields_json?: string;
  @int({ min: 1 }) record_version!: number;
  @date() created_at!: Date;
  @text({ max: 40, default: SERVER_ONLY_LOCK }) server_lock!: string;
}
