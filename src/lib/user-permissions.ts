/**
 * Shared guards for the per-user permission override APIs (Phase 5).
 *
 * Used by /api/users/:id/permissions (GET, PUT) and
 * /api/users/:id/permissions/[permission] (DELETE) so the tenant boundary and
 * privilege-escalation rules stay identical across all three handlers:
 *
 * - Target must exist and belong to the admin's company (404 otherwise).
 *   Only a platform-level SUPER_ADMIN (companyId null) may act on
 *   platform-level accounts — UserPermission overrides on companyId:null
 *   accounts are a SUPER_ADMIN-exclusive operation.
 * - Only SUPER_ADMIN may manage SUPER_ADMIN accounts (403 otherwise).
 *
 * The "SUPER_ADMIN accounts accept no overrides" rule is enforced separately
 * by superAdminOverrideGuard() in the mutating handlers (PUT/DELETE) only —
 * viewing a SUPER_ADMIN's effective permissions is harmless and allowed.
 */
import { NextResponse } from 'next/server';
import { db } from './db';
import { ROLE_PERMISSIONS, SessionUser, UserRole } from '../types/auth';
import { getPermissionScope } from './authorization';
import { legacyEffectiveKeys, catalogExtensionKeys, computeEffectiveGrants, dbGrantSource, type GrantSource, type UserOverrideRow } from './permissions-core';
import { catalogItem, newOrphans, TIER_COVERAGE } from './permission-catalog';

/** Shape of the target user needed by the permission override routes. */
export interface PermissionTargetUser {
  id: string;
  companyId: string | null;
  role: string;
  name: string;
  email: string;
  roleId: string | null;
  permissionsVersion: number;
}

export const PERMISSION_TARGET_SELECT = {
  id: true,
  companyId: true,
  role: true,
  name: true,
  email: true,
  roleId: true,
  permissionsVersion: true,
} as const;

export type PermissionTargetResult =
  | { ok: true; user: PermissionTargetUser }
  | { ok: false; response: NextResponse };

/** Load the target user through the tenant boundary + privilege guards. */
export async function loadPermissionTarget(
  targetId: string,
  admin: SessionUser
): Promise<PermissionTargetResult> {
  const target = await db.user.findUnique({
    where: { id: targetId },
    select: PERMISSION_TARGET_SELECT,
  });
  if (!target) {
    return { ok: false, response: NextResponse.json({ error: 'المستخدم غير موجود' }, { status: 404 }) };
  }

  // ── Multi-tenant isolation (same rule as PATCH /api/users/:id): admins may
  // only act on users inside their own company. Platform-level accounts
  // (companyId null) are manageable ONLY by a platform SUPER_ADMIN — a
  // company admin must never create/edit/delete overrides on them. ──
  const isPlatformSuper = admin.role === 'SUPER_ADMIN' && !admin.companyId;
  if (!isPlatformSuper) {
    const sameCompany = !!admin.companyId && target.companyId === admin.companyId;
    if (!sameCompany) {
      return { ok: false, response: NextResponse.json({ error: 'المستخدم غير موجود' }, { status: 404 }) };
    }
  }

  // ── Privilege-escalation guard: only SUPER_ADMIN manages SUPER_ADMINs ──
  if (target.role === 'SUPER_ADMIN' && admin.role !== 'SUPER_ADMIN') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'فقط المدير الأعلى يمكنه إدارة حسابات المدراء الأعلى' },
        { status: 403 }
      ),
    };
  }

  return { ok: true, user: target };
}

export function superAdminOverrideGuard(target: { role: string }): NextResponse | null {
  if (target.role === 'SUPER_ADMIN') {
    return NextResponse.json(
      { error: 'حساب SUPER_ADMIN وصول كامل ولا يقبل الاستثناءات' },
      { status: 400 }
    );
  }
  return null;
}

/**
 * The keys of doing a shift's work, which grant no power over anyone — so
 * they are conferrable in a ROLE without being held (see firstGrantBeyond).
 * Not on a per-person exception: there the granter must hold the key.
 */
export const OPERATIONAL_KEYS: ReadonlySet<string> = new Set([
  'confirmation.pull',   // take the next order from the pool
  'confirmation.work',   // work the orders you are holding
  'confirmation.issues', // flag a problem on one of them
]);

/**
 * Visibility-tier coverage: holding a broader view tier covers its narrower
 * tier (customers.view ⊇ customers.view_basic) — conferring a role that
 * carries the narrower tier to someone when you hold the broader one is a
 * downgrade, not an escalation. Every granting door reads it the same way.
 */
const COVERAGE = TIER_COVERAGE;

/** How this person holds a key — directly, or through the broader tier that covers it. */
export function heldOrCovered(actor: SessionUser, key: string) {
  return getPermissionScope(actor, key) ?? (COVERAGE[key] ? getPermissionScope(actor, COVERAGE[key]) : null);
}

/**
 * The first grant this person could not hand out, and why — or null.
 *
 * Granter-must-hold for ROLE-MATRIX writes (POST /roles, PATCH /roles/:id)
 * and for conferring a role: the actor may only place a permission they hold
 * themselves, at a scope they hold at equal strength or ALL_COMPANY
 * (ALL_COMPANY holders can grant any narrower scope; OWN/ASSIGNED/CATEGORY/
 * SPECIFIC holders only their exact scope, and below full scope only ids
 * among their own). SUPER_ADMIN holds everything by engine precedence.
 *
 * ── Hiring somebody is not the same as doing their job ──
 *
 * The rule is sound for AUTHORITY: you must not hand out a power you do not
 * hold. It was wrong for the shift-work keys (OPERATIONAL_KEYS), which grant
 * no power over anyone — they are the act of doing a shift's work. A company
 * admin does not work the confirmation queue on purpose (the contract keeps
 * that desk separate), and the result was an outcome nobody would defend:
 * the person who runs the company could create ANOTHER COMPANY ADMIN — a
 * strictly more powerful account — but could not hire a confirmation agent.
 * So those keys are conferrable without holding them, in a ROLE. Everything
 * else obeys the rule: no key that reaches money, settings, other people's
 * accounts, or a decision over somebody else's work is there.
 */
export function firstGrantBeyond(
  actor: SessionUser,
  grants: Array<{ permission: string; scope?: string; scopeIds?: unknown }>
): { key: string; why: 'KEY' | 'IDS' } | null {
  for (const g of grants) {
    if (OPERATIONAL_KEYS.has(g.permission)) continue;
    const requested = g.scope ?? 'ALL_COMPANY';
    const held = heldOrCovered(actor, g.permission);
    const ok =
      !!held &&
      (held.scope === 'ALL_COMPANY' ||
        (requested !== 'ALL_COMPANY' && held.scope === requested));
    if (!ok) return { key: g.permission, why: 'KEY' };
    /*
     * AND NOT WIDER THAN THE IDS YOU HOLD.
     *
     * A CATEGORY or SPECIFIC grant passed when the scope's NAME matched, so
     * somebody who may edit the products of one category could place «every
     * category» — any ids at all — into a role. Below full scope, the ids
     * asked for must be among the ids held.
     */
    if (held.scope !== 'ALL_COMPANY' && (requested === 'CATEGORY' || requested === 'SPECIFIC')) {
      const mine = new Set(idsOf(held.scopeIds));
      if (!idsOf(g.scopeIds).every((id) => mine.has(id))) return { key: g.permission, why: 'IDS' };
    }
  }
  return null;
}

/** A key's Arabic name for a refusal, or the key itself if the catalog has none. */
export function keyLabel(key: string): string {
  return catalogItem(key)?.ar ?? key;
}

/**
 * Granter-must-hold, as the Arabic 403 sentence — naming the key, so the
 * person knows which box stopped them — or null when every grant is allowed.
 */
export function granterHoldsAll(
  actor: SessionUser,
  grants: Array<{ permission: string; scope?: string; scopeIds?: unknown }>
): string | null {
  const beyond = firstGrantBeyond(actor, grants);
  if (!beyond) return null;
  return beyond.why === 'IDS'
    ? `لا يمكنك منح نطاق أوسع من نطاقك في «${keyLabel(beyond.key)}» — بعض الأصناف أو المنتجات ليست ضمن صلاحيتك`
    : `لا يمكنك منح «${keyLabel(beyond.key)}» — لا تملكها بنطاق كامل`;
}

/** The ids of a CATEGORY/SPECIFIC scope, as strings; anything else is none. */
function idsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * A ROLE'S SCOPE IDS, CHECKED AS THE EXCEPTION DOOR CHECKS THEM.
 *
 * The roles doors stored `scopeIds` as they came: not checked against the
 * company's own categories and products, and a scope a key does not even
 * offer (CATEGORY on a key that knows only ALL and OWN) was written as
 * readily as one it does.
 *
 * Only what is NEW in this save is judged (`previous` = the role's rows as
 * they stand): a row already on the role is not refused for being there —
 * the owner could otherwise never save a role whose category was deleted
 * since. And an id that exists NOWHERE is a deleted category or product, not
 * another company's: it is let through (it reaches nothing). What is refused
 * is an id that belongs to ANOTHER company. Returns the Arabic refusal, or null.
 */
export async function roleScopeRefusal(
  companyId: string | null,
  grants: Array<{ permission: string; scope?: string; scopeIds?: unknown }>,
  previous: Array<{ permission: string; scope?: string | null; scopeIds?: unknown }> = []
): Promise<string | null> {
  const before = new Map(previous.map((p) => [p.permission, p]));
  for (const g of grants) {
    const scope = g.scope ?? 'ALL_COMPANY';
    const was = before.get(g.permission);
    const sameScope = !!was && (was.scope ?? 'ALL_COMPANY') === scope;
    const offered = catalogItem(g.permission)?.scopes;
    if (!sameScope && offered && scope !== 'ALL_COMPANY' && !(offered as readonly string[]).includes(scope)) {
      return `النطاق غير متاح لهذه الصلاحية: ${keyLabel(g.permission)}`;
    }
    if (scope !== 'CATEGORY' && scope !== 'SPECIFIC') continue;
    const had = new Set(sameScope ? idsOf(was?.scopeIds) : []);
    const fresh = [...new Set(idsOf(g.scopeIds))].filter((id) => !had.has(id));
    if (fresh.length === 0 || !companyId) continue;
    const foreign =
      scope === 'CATEGORY'
        ? await db.category.count({ where: { id: { in: fresh }, NOT: { companyId } } })
        : await db.product.count({ where: { id: { in: fresh }, NOT: { companyId } } });
    if (foreign > 0) return `نطاق «${keyLabel(g.permission)}» يحتوي أصنافاً أو منتجات من شركة أخرى`;
  }
  return null;
}

/**
 * AN ACTION WITHOUT THE KEY THAT OPENS ITS SCREEN — judged only where the save ADDS it.
 *
 * «تعديل الطلبات» ticked with «عرض الطلبات» not: the box is on and the person
 * can never reach the button. The catalog says which key each action needs
 * (`requires`); this refuses a save that leaves a pair NEW, with the 400 the
 * screens show (`ORPHAN_ACTION`).
 *
 * `before` = what is stored. A pair already there is NOT refused: five of the
 * shipped templates hold «عرض العملاء» without «عرض بيانات العميل الأساسية»,
 * nine people stand on them, and the owner could never save any of those
 * roles again if the old pair were judged too. Presence only — a scope is not
 * compared. No exemption for anyone: it is the shape of the matrix, not
 * authority. Returns the Arabic refusal, or null.
 */
/**
 * A SAVE FROM A SCREEN THAT IS OUT OF DATE.
 *
 * The role editor and the exceptions editor replace the whole list. Opened
 * before somebody else's change — a colleague's, or a data migration's like the
 * one that split the sensitive settings off — and saved after it, they
 * quietly wrote the old list over the new one. Both screens now send the
 * version they read (a role's `updatedAt`, a person's `permissionsVersion`),
 * the door refuses a save that does not carry the CURRENT one, and the refusal
 * is a 409 the screen turns into «حدّث الصفحة».
 */
export const STALE_PERMISSIONS_MESSAGE = 'تغيّرت الصلاحيات من وقت ما فتحت الشاشة — حدّث الصفحة وأعد تعديلك';

export class StalePermissionsError extends Error {
  constructor() {
    super(STALE_PERMISSIONS_MESSAGE);
    this.name = 'StalePermissionsError';
  }
}

export function staleResponse(): NextResponse {
  return NextResponse.json({ error: STALE_PERMISSIONS_MESSAGE, code: 'STALE_VERSION' }, { status: 409 });
}

/** Is the version the screen sent the role's current one? A missing or unreadable version is stale. */
export function roleVersionIsCurrent(sent: unknown, current: Date): boolean {
  if (typeof sent !== 'string') return false;
  const at = Date.parse(sent);
  return Number.isFinite(at) && at === current.getTime();
}

/** Is the version the screen sent the person's current `permissionsVersion`? A missing one is stale. */
export function userVersionIsCurrent(sent: unknown, current: number): boolean {
  return typeof sent === 'number' && Number.isInteger(sent) && sent === current;
}

/** The 400 every door answers an orphan with: the sentence, and a code the screens can tell it by. */
export function orphanResponse(message: string): NextResponse {
  return NextResponse.json({ error: message, code: 'ORPHAN_ACTION' }, { status: 400 });
}

export function newOrphanRefusal(after: Iterable<string>, before: Iterable<string> = []): string | null {
  const fresh = newOrphans(before, after)[0];
  return fresh ? `لازم «${keyLabel(fresh.view)}» مع «${keyLabel(fresh.action)}»` : null;
}

/**
 * The same rule for a PERSON'S exceptions, read from what they would END UP
 * holding: the role's rows with the exceptions on top, by the engine itself.
 * So a «منع» on a view whose actions still come from the role is an orphan
 * too, and the exceptions list must deny those actions with it.
 */
export async function overrideOrphanRefusal(
  target: { id: string; role: string; roleId: string | null },
  beforeRows: UserOverrideRow[],
  afterRows: UserOverrideRow[]
): Promise<string | null> {
  const roleRows = await dbGrantSource.roleRows(target);
  const source = (rows: UserOverrideRow[]): GrantSource => ({ roleRows: async () => roleRows, overrideRows: async () => rows });
  const [was, will] = await Promise.all([
    computeEffectiveGrants(target, source(beforeRows)),
    computeEffectiveGrants(target, source(afterRows)),
  ]);
  if (will.fullAccess) return null;
  return newOrphanRefusal(Object.keys(will.grants), Object.keys(was.grants));
}

/**
 * Canonical (permission, scope) grants a role would CONFER onto a user.
 * DB roles resolve from their RolePermission rows; legacy roles (no rows)
 * resolve through the parity mapping (legacyEffectiveKeys + catalogExtensionKeys)
 * at ALL_COMPANY scope. Returns null when the role name is unknown (fail closed).
 */
export async function roleConferralGrants(
  role: { id?: string | null; name: string }
): Promise<Array<{ permission: string; scope: string; scopeIds?: unknown }> | null> {
  if (role.id) {
    const rows = await db.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permission: true, scope: true, scopeIds: true },
    });
    // The ids travel with the scope, so conferring a role cannot hand out
    // categories or products the person conferring it does not hold.
    return rows.map((r) => ({ permission: r.permission, scope: (r.scope as string) ?? 'ALL_COMPANY', scopeIds: r.scopeIds }));
  }
  const legacy = (ROLE_PERMISSIONS as Record<string, string[]>)[role.name];
  if (!legacy) return null;
  if (legacy.length === 0) return []; // PENDING_USER — confers nothing
  const keys = catalogExtensionKeys(new Set(legacyEffectiveKeys(role.name as UserRole)));
  return [...keys]
    .filter((k) => k !== 'dashboard.view')
    .map((permission) => ({ permission, scope: 'ALL_COMPANY' }));
}

/**
 * Conferral policy — the SINGLE gate for granting a role to a user in ANY
 * path (POST /users, PATCH /users/:id roleId + legacy string, role deletion
 * replacement, role duplication). SUPER_ADMIN bypasses (existing precedence).
 * Everything else resolves the role to its canonical effective grants and
 * enforces granter-must-hold — role NAME is never a security authority.
 */
export async function canConferRole(
  actor: SessionUser,
  role: { id?: string | null; name: string }
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (actor.role === 'SUPER_ADMIN') return { ok: true };
  const grants = await roleConferralGrants(role);
  if (grants === null) {
    return { ok: false, error: 'الدور غير معروف', status: 400 };
  }
  const err = granterHoldsAll(actor, grants);
  return err ? { ok: false, error: err, status: 403 } : { ok: true };
}

/**
 * The role a user's grants actually come from — the same lookup the engine
 * makes (permissions-core: `roleRows`): their role row when they have one,
 * otherwise the SYSTEM template of that name, otherwise the in-code matrix.
 */
export async function roleRefOf(user: { roleId?: string | null; role: string }): Promise<{ id: string | null; name: string }> {
  if (user.roleId) return { id: user.roleId, name: user.role };
  const system = await db.role.findFirst({
    where: { companyId: null, name: user.role },
    select: { id: true, _count: { select: { permissions: true } } },
  });
  // An EMPTY system template is not what the engine grants: with no rows it
  // falls back to the in-code matrix (permissions-core), and so does this.
  if (!system || system._count.permissions === 0) return { id: null, name: user.role };
  return { id: system.id, name: user.role };
}

/**
 * MAY THIS PERSON ACT ON THAT ACCOUNT AT ALL.
 *
 * `users.edit` let its holder suspend, disable, re-activate, sign out,
 * delete, re-role or re-permission ANY account in the company; the only one
 * protected was a SUPER_ADMIN. So a manager could suspend the company admin,
 * or DENY them «المالية», and nothing asked whether the manager held the
 * powers they were taking away.
 *
 * The rule: you may act on an account only if you hold everything it holds
 * — its EFFECTIVE grants, the role AND the owner's exceptions on top, read by
 * the engine itself (computeEffectiveGrants). Reading the role alone let a
 * manager strip an employee of a key the owner had given them personally.
 * The shift-work keys aside, as for conferring a role. Acting on yourself is
 * governed by each action's own self-guard, not by this.
 */
export async function canActOnUser(
  actor: SessionUser,
  target: { id: string; roleId?: string | null; role: string }
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (actor.role === 'SUPER_ADMIN') return { ok: true };
  if (target.id === actor.id) return { ok: true };
  const effective = await computeEffectiveGrants({ id: target.id, role: target.role, roleId: target.roleId ?? null });
  if (effective.fullAccess) {
    return { ok: false, status: 403, error: 'هذا الحساب وصول كامل — يديره المالك وحده.' };
  }
  const beyond = firstGrantBeyond(
    actor,
    Object.entries(effective.grants)
      .filter(([permission]) => permission !== 'dashboard.view')
      .map(([permission, g]) => ({ permission, scope: g.scope, scopeIds: g.scopeIds })),
  );
  if (!beyond) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: `لا يمكنك إدارة هذا الحساب — معه «${keyLabel(beyond.key)}» وأنت لا تملكها بنطاق كامل. يديره المالك أو من يملك كل صلاحياته.`,
  };
}

/**
 * REMOVING A «منع» IS GRANTING.
 *
 * A DENY takes a key away from what the role gives; deleting the DENY gives
 * it back. The exception door checked only the ALLOW rows it was writing, so
 * a full replacement that simply left a DENY out — or the single-row delete,
 * which checked nothing — handed the key back without asking whether the
 * person doing it held it. The same granter-must-hold rule as an ALLOW.
 * Returns the Arabic refusal, or null.
 */
export function denyRemovalRefusal(actor: SessionUser, removedDenyKeys: readonly string[]): string | null {
  for (const key of removedDenyKeys) {
    // No shift-work exemption here: a person's exception is not a role, and
    // «إشكالات التأكيد» on one person opens the customers of every issue.
    const held = heldOrCovered(actor, key);
    if (!held || held.scope !== 'ALL_COMPANY') {
      return `إزالة «منع» عن «${keyLabel(key)}» تعني منحها من جديد — لا يمكنك منح صلاحية لا تملكها بنطاق كامل`;
    }
  }
  return null;
}
