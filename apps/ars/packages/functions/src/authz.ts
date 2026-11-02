import type { MembershipRole, Permission } from '@rayfin-app/shared';

/**
 * Business-role permissions (PRD §7). Server-side source of truth; the
 * frontend only displays what `whoAmI` returns from here.
 *
 * App admins manage membership and configuration but receive no record or
 * audit access unless separately granted those roles (PRD §7 last paragraph).
 */
export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  app_user: ['address.submit', 'address.read.own', 'address.retry.own'],
  reviewer: ['address.read.all', 'review.update'],
  auditor: ['audit.read', 'audit.verify'],
  audit_exporter: ['audit.read', 'audit.export'],
  app_admin: ['membership.manage', 'config.manage'],
  // D-57: owner-requested combined role for independent end-to-end checking by one person.
  // Exactly app_user + app_admin; no reviewer or audit access.
  super_user: ['address.submit', 'address.read.own', 'address.retry.own', 'membership.manage', 'config.manage'],
};

export const ALL_ROLES = Object.keys(ROLE_PERMISSIONS) as MembershipRole[];

export function permissionsFor(roles: readonly MembershipRole[]): Permission[] {
  const set = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) set.add(p);
  return [...set].sort();
}

export function hasPermission(roles: readonly MembershipRole[], permission: Permission): boolean {
  return roles.some((r) => (ROLE_PERMISSIONS[r] ?? []).includes(permission));
}
