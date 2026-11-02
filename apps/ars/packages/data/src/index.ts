import type { UniversalAppSchema } from '@rayfin-app/shared';

import { AddressRequest } from './AddressRequest.js';
import { AddressResult } from './AddressResult.js';
import { AppConfig } from './AppConfig.js';
import { AppMembership } from './AppMembership.js';
import { AuditEvent } from './AuditEvent.js';
import { ReviewHistory } from './ReviewHistory.js';
import { SampleAddress } from './SampleAddress.js';

/**
 * The app's Rayfin data schema.
 *
 * `UniversalAppSchema` in `@rayfin-app/shared` is what makes
 * `(await getRayfinClient()).data.<Entity>` typed, so keep it in step with
 * `schema` below. Access rules live on each entity; see ./policies.ts and
 * docs/DECISIONS.md (D-21, D-22).
 */
export type { UniversalAppSchema };
export {
  AddressRequest,
  AddressResult,
  AppConfig,
  AppMembership,
  AuditEvent,
  ReviewHistory,
  SampleAddress,
};

export const schema = [
  AppConfig,
  AppMembership,
  AddressRequest,
  AddressResult,
  ReviewHistory,
  AuditEvent,
  SampleAddress,
];
