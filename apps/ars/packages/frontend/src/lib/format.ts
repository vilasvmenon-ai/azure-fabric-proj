import type { AddressFields } from '@rayfin-app/shared';

export const FIELD_LABELS: Record<keyof AddressFields, string> = {
  building: 'Building',
  street: 'Street',
  town: 'Town / city',
  region: 'Region',
  postcode: 'Postcode',
  country: 'Country (ISO)',
};

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
