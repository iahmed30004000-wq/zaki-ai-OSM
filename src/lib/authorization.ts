/**
 * AUTHORIZATION ENGINE — single source of truth for all permission checks.
 *
 * Every API route must authorize through this module. Frontend checks are UX only.
 *
 * PRECEDENCE (see permissions-core.ts for the full contract):
 *   1. SUPER_ADMIN → full access
 *   2. UserPermission DENY → final deny
 *   3. UserPermission ALLOW → allow (overrides role absence/scope)
 *   4. RolePermission → allowed with its scope
 *   5. otherwise → DENY
 *
 * SUPER_ADMIN handling is centralized HERE — no route may add its own
 * `if role === SUPER_ADMIN` bypass.
 *
 * SESSION INTEGRATION: getCurrentUser() computes EffectiveGrants fresh from the
 * DB on every request (permissions-core) and attaches them to the SessionUser —
 * permission changes take effect on the next request, no stale caches.
 * For SessionUser objects built outside getCurrentUser, can()/getPermissionScope
 * fall back to async loading via loadUserGrants().
 */
import type { SessionUser } from '@/types/auth';
import { db } from './db';
import { requireAuth } from './auth';
import { computeEffectiveGrants, EffectiveGrants, Scope } from './permissions-core';
import { LEGACY_ALIAS } from './permission-aliases';
import { isHeldRow } from './order-reservation';

// ─────────────────────────────────────────────────────
// Grants access — sync when the session carries them (normal path),
// async fallback (WeakMap) for externally-built SessionUser objects.
// ─────────────────────────────────────────────────────
const grantsCache = new WeakMap<object, EffectiveGrants>();

export function attachGrants<T extends SessionUser>(user: T, grants: EffectiveGrants): T {
  grantsCache.set(user, grants);
  return user;
}

function grantsOf(user: SessionUser): EffectiveGrants | null {
  if ((user as any).effectiveGrants) return (user as any).effectiveGrants as EffectiveGrants;
  return grantsCache.get(user) ?? null;
}

async function resolveGrants(user: SessionUser): Promise<EffectiveGrants> {
  const g = grantsOf(user);
  if (g) return g;
  const computed = await computeEffectiveGrants({ id: user.id, role: user.role, roleId: (user as any).roleId ?? null });
  attachGrants(user, computed);
  return computed;
}

/** Pre-compute and attach grants for a session user (used by getCurrentUser). */
/*
 * `hydrateGrants` stood here: attach a session's grants if they are
 * missing. Nothing called it — `getCurrentUser` attaches them, and the
 * one place that copes with their absence is the fallback inside `can()`
 * below, which is where that case is actually handled. A second, unused
 * net is a net somebody trusts without hanging it.
 */

// ─────────────────────────────────────────────────────
// can() — the ONLY permission check (sync; grants are session-attached)
// ─────────────────────────────────────────────────────

export function can(user: SessionUser, permission: string): boolean {
  if (user.status !== 'ACTIVE') return false;
  const g = grantsOf(user);
  if (!g) {
    // Session without attached grants (should not happen for getCurrentUser
    // sessions) — legacy role fallback so nothing silently loses access.
    if (user.role === 'SUPER_ADMIN') return true;
    // `?? []` because this whole branch is the one that "should not happen":
    // a session shaped oddly enough to reach it is a session that may also
    // be missing the array, and a thrown TypeError here 500s the request
    // instead of answering «no».
    return (user.permissions ?? []).includes(permission);
  }
  if (g.fullAccess) return true;
  return g.grants[permission] !== undefined || g.grants[LEGACY_ALIAS[permission] ?? permission] !== undefined;
}

// `LEGACY_ALIAS` lives in permission-aliases.ts, shared with the browser's `userCan`.

// ─────────────────────────────────────────────────────
// Scope resolution
// ─────────────────────────────────────────────────────

export interface PermissionScope {
  scope: Scope;
  scopeIds?: unknown[] | null;
}

/** Resolve the effective scope of a permission for this user (null = denied). */
export function getPermissionScope(user: SessionUser, permission: string): PermissionScope | null {
  if (user.status !== 'ACTIVE') return null;
  const g = grantsOf(user);
  if (!g) return user.role === 'SUPER_ADMIN' ? { scope: 'ALL_COMPANY' } : null;
  if (g.fullAccess) return { scope: 'ALL_COMPANY' };
  const grant = g.grants[permission] ?? g.grants[LEGACY_ALIAS[permission] ?? permission];
  if (!grant) return null;
  return { scope: grant.scope, scopeIds: grant.scopeIds ?? null };
}

// ─────────────────────────────────────────────────────
// Resource authorization
// ─────────────────────────────────────────────────────

export interface AuthorizeResult {
  allowed: boolean;
  /** Safe reason for server logs/debugging — never contains PII or internals. */
  reason?: 'NO_PERMISSION' | 'NO_TENANT' | 'OUT_OF_SCOPE' | 'NO_COMPANY_CONTEXT';
}

function orderMatchesScope(order: Record<string, any>, userId: string, scope: Scope, scopeIds?: unknown[] | null): boolean {
  switch (scope) {
    case 'ALL_COMPANY':
      return true; // tenant boundary already enforced by caller
    case 'ASSIGNED':
      return (
        // An order named for her that nobody holds is hers to TAKE, not to work (order-reservation.ts `isHeldRow`).
        (order.assignedToId === userId && !isHeldRow(order)) ||
        order.claimedById === userId ||
        order.currentOwnerId === userId ||
        order.moderatorId === userId
      );
    case 'OWN':
      return order.moderatorId === userId;
    default:
      // CATEGORY / SPECIFIC are not meaningful for orders — company-wide only
      return false;
  }
}

function productMatchesScope(product: Record<string, any>, _userId: string, scope: Scope, scopeIds?: unknown[] | null): boolean {
  switch (scope) {
    case 'ALL_COMPANY':
      return true;
    case 'CATEGORY':
      return Array.isArray(scopeIds) && product.categoryId != null && scopeIds.includes(product.categoryId);
    case 'SPECIFIC':
      return Array.isArray(scopeIds) && scopeIds.includes(product.id);
    case 'OWN':
      // Products have no per-user ownership column — OWN is not supported for
      // products (documented); treated as company-wide.
      return true;
    default:
      return false;
  }
}

function genericMatchesScope(_resource: Record<string, any>, _userId: string, scope: Scope, _scopeIds?: unknown[] | null): boolean {
  // Unknown resource types: only ALL_COMPANY scopes are evaluable.
  return scope === 'ALL_COMPANY';
}

/**
 * Authorize a permission against a specific resource (sync).
 * - tenant: resource.companyId must equal the session companyId (never client input)
 * - scope: evaluated per resource type by the engine
 */
export function authorize(
  user: SessionUser,
  permission: string,
  resource?: Record<string, any>
): AuthorizeResult {
  if (user.status !== 'ACTIVE') return { allowed: false, reason: 'NO_PERMISSION' };
  const scope = getPermissionScope(user, permission);
  if (!scope) return { allowed: false, reason: 'NO_PERMISSION' };

  if (resource) {
    const g = grantsOf(user);
    if (!g?.fullAccess) {
      if (!user.companyId) return { allowed: false, reason: 'NO_COMPANY_CONTEXT' };
      if (resource.companyId !== user.companyId) return { allowed: false, reason: 'NO_TENANT' };
    }
    const ok =
      permission.startsWith('orders.')
        ? orderMatchesScope(resource, user.id, scope.scope, scope.scopeIds)
        : permission.startsWith('products.')
          ? productMatchesScope(resource, user.id, scope.scope, scope.scopeIds)
          : genericMatchesScope(resource, user.id, scope.scope, scope.scopeIds);
    if (!ok) return { allowed: false, reason: 'OUT_OF_SCOPE' };
  }
  return { allowed: true };
}

// ─────────────────────────────────────────────────────
// requirePermission — throws like the legacy guard (message contract kept)
// ─────────────────────────────────────────────────────

export async function requirePermission(permission: string): Promise<SessionUser> {
  const user = await requireAuth();
  if (!can(user, permission)) {
    throw new Error(`Forbidden: missing required permission ${permission}`);
  }
  return user;
}

export type { Scope };


