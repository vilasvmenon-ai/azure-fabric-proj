import { date, entity, role, set, text, uuid } from '@microsoft/rayfin-core';

import { SERVER_ONLY_LOCK } from './policies.js';

/** App configuration (PRD §5). Server-only; written by `seedSampleData`. */
@entity()
@role('authenticated', 'read', {
  policy: (claims, item) => claims.sub.eq(item.server_lock),
})
export class AppConfig {
  @uuid() id!: string;
  @text({ min: 1, max: 100 }) org_id!: string;
  @text({ min: 1, max: 100 }) project_id!: string;
  @text({ min: 1, max: 100 }) app_id!: string;
  @set('local', 'dev', 'uat', 'prod') environment!: 'local' | 'dev' | 'uat' | 'prod';
  @text({ max: 2000 }) allowed_ai_config_json!: string;
  @text({ max: 50 }) active_version!: string;
  @text({ max: 320 }) owner_email!: string;
  @text({ max: 40, default: SERVER_ONLY_LOCK }) server_lock!: string;
  @date() updated_at!: Date;
}
