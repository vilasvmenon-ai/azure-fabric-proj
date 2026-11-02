import { entity, int, role, text, uuid } from '@microsoft/rayfin-core';

/**
 * Approved synthetic sample inputs (DATA-05, AI-06). Seeded by
 * `seedSampleData`; readable by any signed-in user of this app; never written
 * by clients. Contains no real personal data.
 */
@entity()
@role('authenticated', 'read')
export class SampleAddress {
  @uuid() id!: string;
  @text({ min: 1, max: 100 }) app_id!: string;
  @text({ min: 1, max: 200 }) label!: string;
  @text({ min: 1, max: 2000 }) address!: string;
  @text({ max: 1000 }) expected_json!: string;
  @int({ min: 0 }) sort_order!: number;
}
