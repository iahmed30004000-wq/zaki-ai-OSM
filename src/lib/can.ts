// Client-safe permission check for UI gating (UX only — the server remains
// the source of truth). SessionUser.permissions carries the effective keys.
import type { SessionUser } from '@/types/auth';
import { LEGACY_ALIAS } from './permission-aliases';

/**
 * The same answer the server's `can()` gives: SUPER_ADMIN holds everything, and a key is held when it — or the
 * canonical key it is an alias of — is among the user's effective keys. No other role is all-powerful here,
 * because none is on the server: a screen that let COMPANY_ADMIN through by name showed buttons that then failed.
 */
export function userCan(user: SessionUser | undefined | null, permission: string): boolean {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  const held = user.permissions ?? [];
  return held.includes(permission) || held.includes(LEGACY_ALIAS[permission] ?? permission);
}

/**
 * FULL ACCESS — THE OWNER, NOT A KEY. The engine gives `fullAccess` to SUPER_ADMIN and to nobody else (permissions-core
 * `computeEffectiveGrants`; role-names.ts reserves the name so no other role can carry it), and `userCan` above lets the same
 * role through for the same reason. Client-safe, so a rule that is the owner's alone — his window on a confirmed order before the
 * batch (edit-confirmed-window.ts) — is asked with ONE helper by the screen and by the server (change-request-routing.ts), where
 * the account's status is asked beside it by `can`.
 */
export function userHasFullAccess(user: SessionUser | undefined | null): boolean {
  return !!user && user.role === 'SUPER_ADMIN';
}
