/**
 * PERMISSION CORE — low-level effective-permission computation.
 *
 * Source of truth: RolePermission (via users.roleId) + UserPermission overrides,
 * with a legacy fallback to ROLE_PERMISSIONS[role] mapped through LEGACY_PERMISSION_MAP
 * for any user without a roleId (backward compatibility — never removes access).
 *
 * PRECEDENCE (documented contract):
 *   1. SUPER_ADMIN                       → full access (centralized here, nowhere else)
 *   2. UserPermission effect=DENY        → final DENY (beats role + ALLOW)
 *   3. UserPermission effect=ALLOW       → ALLOW (wins over role absence/scope)
 *   4. RolePermission                    → allowed with its scope
 *   5. otherwise                         → DENY
 *
 * TENANT BOUNDARY (non-negotiable): companyId comes from the authenticated
 * server-side session only. No scope ever crosses it. SUPER_ADMIN bypasses
 * resource ownership but is still tenant-scoped by requireCompanyTenant().
 *
 * CACHING POLICY: grants are computed per-request from indexed queries
 * (role_permissions + user_permissions by roleId/userId). No long-lived cache —
 * permission changes take effect on the next request.
 */
import { db } from './db';
import { ROLE_PERMISSIONS, UserRole } from '../types/auth';
import { AI_ASSIST_FROM, AI_ASSIST_KEY } from './ai-assistants';
import { ORDER_ACTION_KEYS_FROM } from './order-action-keys';
import { CONFIRMATION_SPLIT_KEYS_FROM, rolesThatPassedByName } from './confirmation-split-keys';
import { OPS_ACTION_KEYS_FROM } from './ops-action-keys';
import { FINANCE_SPLIT_KEYS_FROM } from './finance-split-keys';
import { CATEGORIES_CAMPAIGNS_KEYS_FROM } from './categories-campaigns-keys';

export type Scope = 'ALL_COMPANY' | 'OWN' | 'ASSIGNED' | 'CATEGORY' | 'SPECIFIC';

/**
 * THE BOXES SPLIT OFF THE SETTINGS KEYS (PR-4), AND THE KEY EACH DOOR ASKED BEFORE.
 *
 * `[newKey, sourceKey]`: whoever held the source yesterday holds the new box today. The migration
 * 20261029150000_settings_split_keys writes it into the database from the same list (a test reads the SQL
 * and this table side by side), and the in-code fallback below applies it to a person with no stored role.
 * The one door that asked for TWO keys (orders.migrate: orders.import AND settings.manage) is not a row here.
 */
export const SPLIT_FROM_SETTINGS: ReadonlyArray<readonly [newKey: string, source: string]> = [
  ['settings.jobs', 'settings.manage'],
  ['settings.messages', 'settings.manage'],
  ['penalties.rules', 'settings.manage'],
  ['team.settings', 'settings.manage'],
  ['offers.rules', 'settings.manage'],
  ['commission.view', 'settings.view'],
  ['commission.manage', 'settings.edit'],
  ['settings.delivery_fees', 'settings.edit'],
  ['settings.tracking', 'settings.edit'],
];

export interface Grant {
  scope: Scope;
  scopeIds?: unknown[] | null;
}

export interface EffectiveGrants {
  fullAccess: boolean;
  grants: Record<string, Grant>;
}

/** Legacy permission key → new catalog key(s) + default scope (parity mapping,
 *  identical to scripts/generate-permission-backfill.ts and the migration backfill). */
export function mapLegacyPermission(legacy: string): Grant[] {
  const A: Grant = { scope: 'ALL_COMPANY' };
  const AS: Grant = { scope: 'ASSIGNED' };
  const O: Grant = { scope: 'OWN' };
  const M: Record<string, Grant[]> = {
    'orders.view': [A], 'orders.view_assigned': [AS], 'orders.view_own': [O],
    'orders.create': [A],
    'orders.update': [A], 'orders.update_own': [AS],
    'orders.assign': [A], 'orders.reassign': [A],
    'orders.claim': [A], 'orders.release': [A], 'orders.unlock': [A], 'orders.delete': [A],
    'orders.confirmation_status': [A], 'orders.shipping_status': [A],
    'customers.view': [A], 'customers.view_basic': [A], 'customers.create': [A],
    'customers.update': [A], 'customers.freeze': [A], 'customers.unfreeze': [A],
    'products.view': [A], 'products.create': [A], 'products.update': [A], 'products.delete': [A],
    'products.manage': [{ ...A }, { ...A }, { ...A }, { ...A }],
    'offers.manage': [A],
    'finance.view': [A], 'finance.create': [A], 'finance.update': [A], 'finance.cashbox': [A],
    'settlement.view': [A], 'settlement.upload': [A], 'settlement.review': [A],
    'production.manage': [A],
    'inventory.manage': [A],
    'reports.view': [A], 'analytics.view': [A], 'ai.use': [A],
    'users.view': [A], 'users.create': [A], 'users.update': [A], 'users.delete': [A],
    'users.manage': [A], 'users.manage_roles': [A], 'moderators.manage': [A],
    'settings.view': [A], 'settings.manage': [A], 'audit.view': [A],
    'crm.view': [A], 'crm.manage': [A],
  };
  const out = M[legacy];
  if (out) return out;
  // unknown legacy key → keep as-is (defensive; never silently drops access)
  return [A];
}

/** Legacy permission key → expanded NEW-catalog keys (parity: identical to the
 *  migration backfill mapping — single source of truth for renames/expansions). */
function expandLegacyKey(legacy: string): string[] {
  const E: Record<string, string[]> = {
    // ORDERS
    'orders.update': ['orders.edit'],
    'orders.update_own': ['orders.edit'],
    'orders.confirmation_status': ['orders.confirm'],
    'orders.shipping_status': ['orders.change_status'],
    'orders.reassign': ['orders.assign'],
    'orders.view_assigned': ['orders.view'],
    'orders.view_own': ['orders.view'],
    // CUSTOMERS
    'customers.update': ['customers.edit'],
    'customers.freeze': ['customers.edit'],
    'customers.unfreeze': ['customers.edit'],
    // PRODUCTS
    'products.update': ['products.edit'],
    'products.manage': ['products.edit', 'products.delete', 'products.change_price', 'products.upload_images'],
    // OPERATIONS
    'production.manage': ['production.view', 'production.manage'],
    'inventory.manage': ['inventory.view', 'inventory.adjust'],
    // REPORTS
    'analytics.view': ['reports.view'],
    'reports.view': ['reports.view', 'reports.export'],
    // USERS
    'users.update': ['users.edit'],
    'users.manage': ['users.view', 'users.create', 'users.edit', 'users.delete'],
    'users.manage_roles': ['roles.view', 'roles.edit'],
    'moderators.manage': ['users.view', 'users.edit'],
    // SETTINGS — the legacy key meant both: the general settings AND the
    // sensitive ones, which are their own box since the alias went (RV149).
    'settings.manage': [
      'settings.edit', 'settings.manage',
      ...SPLIT_FROM_SETTINGS.filter(([, src]) => src === 'settings.manage' || src === 'settings.edit').map(([k]) => k),
    ],
    // The commission page and the team's running progress used to open on settings.view.
    'settings.view': ['settings.view', 'commission.view'],
    // CRM
    'crm.view': ['crm.view', 'crm.contacts.view', 'crm.companies.view', 'crm.leads.view', 'crm.deals.view', 'crm.tasks.view', 'crm.invoices.view'],
    'crm.manage': [
      'crm.view',
      'crm.contacts.view', 'crm.contacts.create', 'crm.contacts.edit', 'crm.contacts.delete',
      'crm.companies.view', 'crm.companies.create', 'crm.companies.edit', 'crm.companies.delete',
      'crm.leads.view', 'crm.leads.create', 'crm.leads.edit', 'crm.leads.delete',
      'crm.deals.view', 'crm.deals.create', 'crm.deals.edit', 'crm.deals.delete',
      'crm.tasks.view', 'crm.tasks.create', 'crm.tasks.edit', 'crm.tasks.delete',
      'crm.invoices.view', 'crm.invoices.create', 'crm.invoices.edit', 'crm.invoices.delete',
    ],
  };
  return E[legacy] ?? [legacy];
}

/** Legacy view_assigned/update_own → scoped keys (orders.view/edit keep the
 *  scope in the Grant, so the key itself is unscoped). */
function scopeAwareKey(legacy: string): string {
  switch (legacy) {
    case 'orders.view_assigned':
    case 'orders.view_own':
      return 'orders.view';
    default:
      return legacy;
  }
}

/** Roles that own countries/stores (parity with migration stage1_geo_context). */
export const GEO_MANAGER_ROLES: readonly string[] = ['COMPANY_ADMIN', 'MANAGER'];

/** geo.* companions for the legacy path: managers get geo.manage + geo.view,
 *  anyone who can view settings gets geo.view (same rule as the migration). */
function addGeoCompanions(role: string, keys: { has(k: string): boolean }, add: (k: string) => void): void {
  if (GEO_MANAGER_ROLES.includes(role)) {
    add('geo.manage');
    add('geo.view');
  } else if (keys.has('settings.view')) {
    add('geo.view');
  }
}

/** DB-shaped user (subset needed). */
export interface DbUserLike {
  id: string;
  role: string;
  roleId?: string | null;
}

/** The two tables the computation reads, as the rows it needs. */
export interface RoleGrantRow {
  permission: string;
  scope: string;
  scopeIds: unknown;
}
export interface UserOverrideRow {
  permission: string;
  effect: string;
  scope: string | null;
  scopeIds: unknown;
}

/**
 * Where computeEffectiveGrants reads its rows.
 *
 * The default is the database, one user at a time — what a request needs.
 * Deciding WHO should hear about something means evaluating every employee
 * of a company at once, and 2 queries per employee is a notification that
 * costs more than the order it announces. A caller that has already loaded
 * the rows for many users passes them in here; the RULES below stay the
 * one copy, whichever way the rows arrive.
 */
export interface GrantSource {
  /** Role rows: by roleId, or the system template named like the legacy role. */
  roleRows(user: DbUserLike): Promise<RoleGrantRow[]>;
  /** This user's ALLOW / DENY overrides. */
  overrideRows(userId: string): Promise<UserOverrideRow[]>;
}

export const dbGrantSource: GrantSource = {
  roleRows: (user) =>
    db.rolePermission.findMany({
      where: user.roleId ? { roleId: user.roleId } : { role: { companyId: null, name: user.role } },
      select: { permission: true, scope: true, scopeIds: true },
    }),
  overrideRows: (userId) =>
    db.userPermission.findMany({
      where: { userId },
      select: { permission: true, effect: true, scope: true, scopeIds: true },
    }),
};

/** Compute effective grants for a user. 2 indexed queries max. */
export async function computeEffectiveGrants(
  user: DbUserLike,
  source: GrantSource = dbGrantSource
): Promise<EffectiveGrants> {
  // 1. SUPER_ADMIN → full access (centralized bypass)
  if (user.role === 'SUPER_ADMIN') return { fullAccess: true, grants: {} };

  const grants: Record<string, Grant> = {};
  let usedFallback = false;

  // 2. Role grants (DB). A user without roleId inherits the system role
  //    template named like their legacy role string, so role edits in the
  //    permissions screen reach every user. The in-code legacy map is used
  //    only when no such template exists.
  const rows = await source.roleRows(user);
  if (user.roleId || rows.length > 0) {
    for (const r of rows) {
      grants[r.permission] = { scope: r.scope as Scope, scopeIds: (r.scopeIds as unknown[]) ?? null };
    }
  } else {
    usedFallback = true;
    // Legacy fallback: ROLE_PERMISSIONS[role] mapped to new catalog keys.
    for (const legacy of ROLE_PERMISSIONS[user.role as UserRole] ?? []) {
      const key = scopeAwareKey(legacy);
      const mapped = mapLegacyPermission(legacy)[0] ?? { scope: 'ALL_COMPANY' as Scope };
      // keep the broadest scope if multiple legacy keys map to the same new key
      const existing = grants[key];
      if (!existing || (existing.scope !== 'ALL_COMPANY' && mapped.scope === 'ALL_COMPANY')) {
        grants[key] = mapped;
      }
    }
    addGeoCompanions(
      user.role,
      { has: (k) => grants[k] !== undefined },
      (k) => { grants[k] ??= { scope: 'ALL_COMPANY' }; }
    );
    // The in-screen assistants' box (PR-5) did not exist when this matrix was written: whoever reached one of the helpers
    // through a key below keeps it. A «منع» on the box, or on the key, still wins in step 3.
    if (AI_ASSIST_FROM.some((k) => grants[k] !== undefined)) grants[AI_ASSIST_KEY] ??= { scope: 'ALL_COMPANY' };
  }

  // 3. User overrides — DENY wins, ALLOW wins over role absence/scope
  const overrides = await source.overrideRows(user.id);
  for (const o of overrides) {
    if (o.effect === 'DENY') {
      delete grants[o.permission];
    } else {
      grants[o.permission] = { scope: (o.scope as Scope) ?? 'ALL_COMPANY', scopeIds: (o.scopeIds as unknown[]) ?? null };
    }
  }

  // 4. The in-code fallback holds the OLD keys only. A person who passed a split door through one of them keeps
  //    the new box — decided AFTER the overrides, so a «منع» on the source (or on the box) still counts.
  if (usedFallback) {
    const denied = new Set(overrides.filter((o) => o.effect === 'DENY').map((o) => o.permission));
    for (const [newKey, src] of SPLIT_FROM_SETTINGS) {
      if (grants[src] && !grants[newKey] && !denied.has(newKey)) grants[newKey] = { scope: 'ALL_COMPANY' };
    }
    // The order actions' boxes (PR-6): whoever passed the door through ANY of its old keys keeps it, with the SAME scope
    // where the old door evaluated one (a price edit is as wide as the order edit was).
    for (const { key, from, copyScope } of ORDER_ACTION_KEYS_FROM) {
      if (grants[key] || denied.has(key)) continue;
      const src = from.find((k) => grants[k]);
      if (!src) continue;
      grants[key] = copyScope ? { scope: grants[src].scope, scopeIds: grants[src].scopeIds ?? null } : { scope: 'ALL_COMPANY' };
    }
    // The confirmation and change-request boxes (PR-7): the same, and a door that used to be a role NAME (the desk's four
    // names, the packing table's WAREHOUSE) is kept for that role — and, deliberately, «إدخال إشكال» for the agent (D14).
    for (const rule of CONFIRMATION_SPLIT_KEYS_FROM) {
      if (rule.inFallback === false) continue;
      if (grants[rule.key] || denied.has(rule.key)) continue;
      if (rule.unless && grants[rule.unless]) continue;
      const src = rule.from.find((k) => grants[k]);
      if (src) {
        grants[rule.key] = rule.copyScope ? { scope: grants[src].scope, scopeIds: grants[src].scopeIds ?? null } : { scope: 'ALL_COMPANY' };
      } else if (rolesThatPassedByName(rule).includes(user.role)) {
        grants[rule.key] = { scope: 'ALL_COMPANY' };
      }
    }
    // The cash box's and the statement approval's boxes (PR-9): whoever passed the door through the old key keeps it.
    for (const { key, from } of FINANCE_SPLIT_KEYS_FROM) {
      if (grants[key] || denied.has(key)) continue;
      if (from.some((k) => grants[k])) grants[key] = { scope: 'ALL_COMPANY' };
    }
    // The operations boxes (PR-8): the same — whoever passed the door through ANY of its old keys keeps it.
    for (const { key, from } of OPS_ACTION_KEYS_FROM) {
      if (grants[key] || denied.has(key)) continue;
      if (from.some((k) => grants[k])) grants[key] = { scope: 'ALL_COMPANY' };
    }
    // The categories' and the campaigns' boxes (PR-11). D1m: the categories' box needs the source «كل الشركة».
    for (const { key, from, allCompanyOnly } of CATEGORIES_CAMPAIGNS_KEYS_FROM) {
      if (grants[key] || denied.has(key)) continue;
      if (from.some((k) => grants[k] && (!allCompanyOnly || grants[k].scope === 'ALL_COMPANY'))) grants[key] = { scope: 'ALL_COMPANY' };
    }
  }

  return { fullAccess: false, grants };
}

/** Legacy parity check helper: keys a legacy role would have (mapped).
 *  Includes the approved business-decision grants:
 *  - products.view = ALL_COMPANY for ACCOUNTANT / SETTLEMENT_OFFICER (migration
 *    accountant_settlement_products_view — shared product visibility, view only).
 */
export function legacyEffectiveKeys(role: UserRole): string[] {
  const keys = new Set<string>(['dashboard.view']);
  for (const legacy of ROLE_PERMISSIONS[role] ?? []) {
    const scoped = scopeAwareKey(legacy); // view_assigned/view_own → 'orders.view' (scoped)
    const expanded = expandLegacyKey(legacy);
    // When the legacy key expands to different key(s), the raw key is REPLACED
    // (orders.update → orders.edit), not kept alongside it.
    if (expanded.length === 1 && expanded[0] === scoped) {
      keys.add(scoped);
    } else {
      for (const k of expanded) keys.add(k);
    }
  }
  if (role === 'ACCOUNTANT' || role === 'SETTLEMENT_OFFICER') keys.add('products.view');
  addGeoCompanions(role, keys, (k) => keys.add(k));
  // The assistants' box goes to whoever reached an in-screen helper through the old keys (the reset-to-default baseline too).
  if (AI_ASSIST_FROM.some((k) => keys.has(k))) keys.add(AI_ASSIST_KEY);
  // And the order actions' boxes (PR-6): the baseline of a legacy role carries them for the roles that held the old keys.
  for (const { key, from } of ORDER_ACTION_KEYS_FROM) if (from.some((k) => keys.has(k))) keys.add(key);
  // And the confirmation and change-request boxes (PR-7), with the role NAMES that used to open a door by themselves.
  for (const rule of CONFIRMATION_SPLIT_KEYS_FROM) {
    if (rule.inFallback === false) continue;
    if (rule.unless && keys.has(rule.unless)) continue;
    if (rule.from.some((k) => keys.has(k)) || rolesThatPassedByName(rule).includes(role)) keys.add(rule.key);
  }
  // And the operations boxes (PR-8).
  for (const { key, from } of OPS_ACTION_KEYS_FROM) if (from.some((k) => keys.has(k))) keys.add(key);
  // And the cash box's and the statement approval's (PR-9).
  for (const { key, from } of FINANCE_SPLIT_KEYS_FROM) if (from.some((k) => keys.has(k))) keys.add(key);
  // And the categories' and the campaigns' (PR-11). A legacy role holds products.edit «كل الشركة» always (mapLegacyPermission).
  for (const { key, from } of CATEGORIES_CAMPAIGNS_KEYS_FROM) if (from.some((k) => keys.has(k))) keys.add(key);
  return [...keys];
}

/** Companion keys implied by the catalog extensions (parity with migration
 *  permission_catalog_extensions): CRM notes/activities granular keys and
 *  offers.view as the read companion of offers.manage. */
export function catalogExtensionKeys(keys: Set<string>): Set<string> {
  const out = new Set(keys);
  if (out.has('crm.manage')) {
    for (const k of ['crm.notes.view', 'crm.notes.create', 'crm.notes.edit', 'crm.notes.delete', 'crm.activities.view', 'crm.activities.create', 'crm.activities.delete']) out.add(k);
  }
  if (out.has('crm.view')) {
    out.add('crm.notes.view');
    out.add('crm.activities.view');
  }
  if (out.has('offers.manage')) out.add('offers.view');
  if (out.has('roles.edit')) { out.add('roles.create'); out.add('roles.delete'); }
  return out;
}


