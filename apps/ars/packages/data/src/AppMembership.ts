import { date, entity, role, set, text, uuid } from '@microsoft/rayfin-core';

import { SERVER_ONLY_LOCK } from './policies.js';

/**
 * Business-role membership (PRD §5, ACC-02/03). One row per user and role.
 * Server-only so no client can grant itself a role through the data API.
 */
@entity()
@role('authenticated', 'read', {
  policy: (claims, item) => claims.sub.eq(item.server_lock),
})
export class AppMembership {
  @uuid() id!: string;
  @text({ min: 1, max: 100 }) app_id!: string;
  @text({ min: 3, max: 320 }) user_email!: string;
  @text({ optional: true, max: 200 }) user_sub?: string;
  @set('app_user', 'reviewer', 'auditor', 'audit_exporter', 'app_admin', 'super_user')
  role!: 'app_user' | 'reviewer' | 'auditor' | 'audit_exporter' | 'app_admin' | 'super_user';
  @set('active', 'revoked') status!: 'active' | 'revoked';
  @text({ min: 1, max: 500 }) reason!: string;
  @text({ max: 320 }) granted_by_email!: string;
  @text({ max: 200 }) granted_by_sub!: string;
  @date() granted_at!: Date;
  @text({ optional: true, max: 320 }) revoked_by_email?: string;
  @date({ optional: true }) revoked_at?: Date;
  @date() updated_at!: Date;
  @text({ max: 40, default: SERVER_ONLY_LOCK }) server_lock!: string;
}
