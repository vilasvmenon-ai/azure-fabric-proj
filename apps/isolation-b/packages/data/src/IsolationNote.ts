import { date, entity, role, text, uuid } from '@microsoft/rayfin-core';

/**
 * App B (isolation test app). Its only purpose is to prove that code, records
 * and access stay separate from App A (PRD "Minimum demonstration", PRJ-03).
 * Owner-only access is enforced by the data policy, not the UI.
 */
@entity()
@role('authenticated', ['create', 'read', 'update', 'delete'], {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class IsolationNote {
  @uuid() id!: string;
  @text({ min: 1, max: 200 }) title!: string;
  @text({ max: 50 }) app_id!: string;
  @date() created_at!: Date;
  @text({ max: 200 }) owner_id!: string;
}
