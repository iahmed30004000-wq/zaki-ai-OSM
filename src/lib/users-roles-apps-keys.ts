/**
 * THE USERS, ROLES AND APP-KEYS DOORS THAT GOT A BOX EACH (perm-plan PR-13), AND WHO PASSED THEM BEFORE.
 *
 * Five keys:
 *
 *   users.delete       ← users.edit              (deleting an account rode on editing one)
 *   users.shift        ← users.edit              (an employee's start time, hand-over time and rest days)
 *   users.security     ← the NAME COMPANY_ADMIN  (setting a password, resetting the second factor)
 *   roles.edit_system  ← the NAME COMPANY_ADMIN  (rewriting a system role template — it moves everybody who carries it)
 *   apps.tokens        ← apps.manage             (issuing and stopping the keys other systems call /api/v1 with)
 *
 * `from` is OR: whoever held ANY of them yesterday passed the door, so whoever held any of them holds the new key today.
 *
 * `byRole` is the part of the old door that was a NAME and not a key: the 2FA reset and the password door read the two
 * owner names (`two-factor-reset.ts`), and the system-template door read `admin.role` — SUPER_ADMIN being the one name that
 * needs no row (see below). The migration gives the key to every
 * person whose `users.role` is one of those names and to every role carrying the name — the day after the deploy the same
 * people pass, and from then on the owner can untick them (D6: the owner AND the company admin keep users.security).
 *
 * Nothing here carries a scope: none of these doors ever evaluated one. And SUPER_ADMIN holds EVERY box centrally —
 * `computeEffectiveGrants` returns full access before any row is read — which is the way back in if the boxes are ever
 * unticked from everybody else: no tick, no «منع» and no mistake in this file can take a door away from the owner.
 *
 * The migration 20261030190000_users_roles_apps_keys writes it into the database from the same list (a test reads the SQL
 * and this table side by side), and the in-code fallback in permissions-core applies it to a person with no stored role.
 */
export interface UsersRolesAppsKey {
  readonly key: string;
  readonly from: readonly string[];
  /** A door that was a role NAME: `users.role` equal to one of these passed yesterday. */
  readonly byRole?: readonly string[];
}

/**
 * The role the password door and the second-factor door read, besides the owner, until this change (D6 keeps it).
 *
 * SUPER_ADMIN is the other name those doors read, and it is NOT listed: it holds every key centrally, and a stored row on
 * its template would be one the engine never reads and the screen shows as read-only. No tick can take a door from it.
 */
export const USERS_SECURITY_ROLE_NAMES = ['COMPANY_ADMIN'] as const;

/** The role the system-template door read until this change (SUPER_ADMIN passes it centrally, like the one above). */
export const SYSTEM_TEMPLATE_EDITOR_ROLE_NAMES = ['COMPANY_ADMIN'] as const;

export const USERS_ROLES_APPS_KEYS_FROM: readonly UsersRolesAppsKey[] = [
  { key: 'users.delete', from: ['users.edit'] },
  { key: 'users.shift', from: ['users.edit'] },
  { key: 'users.security', from: [], byRole: USERS_SECURITY_ROLE_NAMES },
  { key: 'roles.edit_system', from: [], byRole: SYSTEM_TEMPLATE_EDITOR_ROLE_NAMES },
  { key: 'apps.tokens', from: ['apps.manage'] },
];
