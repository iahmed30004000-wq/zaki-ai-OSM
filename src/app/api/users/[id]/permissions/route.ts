import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { ALL_CATALOG_KEYS, catalogItem, isRetiredKey, withoutRetired } from '@/lib/permission-catalog';
import { logAudit } from '@/lib/audit';
import {
  PERMISSION_TARGET_SELECT,
  canActOnUser,
  denyRemovalRefusal,
  heldOrCovered,
  keyLabel,
  loadPermissionTarget,
  overrideOrphanRefusal,
  orphanResponse,
  StalePermissionsError,
  staleResponse,
  superAdminOverrideGuard,
  userVersionIsCurrent,
  PermissionTargetUser,
} from '@/lib/user-permissions';

/**
 * GET /api/users/:id/permissions — permission inspector payload (users.view).
 * PUT /api/users/:id/permissions — FULL REPLACEMENT of the user's overrides
 * (users.edit) in a single transaction (deleteMany + createMany) so a partial
 * update can never leave the account in a half-edited state.
 *
 * Precedence itself is NOT changed here — computeEffectiveGrants()
 * (permissions-core) remains the single source of truth for effective grants.
 */

type OverrideEffect = 'ALLOW' | 'DENY';

interface ParsedOverride {
  permission: string;
  effect: OverrideEffect;
  /** null = not stored (DENY rows ignore scope in the engine). */
  scope: string | null;
  scopeIds: string[] | null;
}

/** Build the full permissions payload for a target user (shared by GET / PUT). */
async function buildPermissionsPayload(target: PermissionTargetUser) {
  const [roleRow, rolePerms, overrides, effective] = await Promise.all([
    target.roleId
      ? db.role.findUnique({ where: { id: target.roleId }, select: { id: true, name: true } })
      : Promise.resolve(null),
    target.roleId
      ? db.rolePermission.findMany({
          where: { roleId: target.roleId },
          select: { permission: true, scope: true, scopeIds: true },
        })
      : Promise.resolve([]),
    db.userPermission.findMany({
      where: { userId: target.id },
      select: { permission: true, effect: true, scope: true, scopeIds: true },
      orderBy: { permission: 'asc' },
    }),
    computeEffectiveGrants({ id: target.id, role: target.role, roleId: target.roleId }),
  ]);

  const roleGrants: Record<string, { scope: string; scopeIds: unknown[] | null }> = {};
  for (const r of rolePerms) {
    roleGrants[r.permission] = { scope: r.scope, scopeIds: (r.scopeIds as unknown[] | null) ?? null };
  }

  return {
    user: { id: target.id, name: target.name, email: target.email },
    role: { id: roleRow?.id ?? null, name: roleRow?.name ?? target.role },
    permissionsVersion: target.permissionsVersion,
    roleGrants,
    overrides: overrides.map((o) => ({
      permission: o.permission,
      effect: o.effect,
      scope: o.scope,
      scopeIds: (o.scopeIds as unknown[] | null) ?? null,
    })),
    effective: { fullAccess: effective.fullAccess, grants: effective.grants },
    // Permissions explicitly denied by a user-level override (DENY wins over role)
    denied: overrides.filter((o) => o.effect === 'DENY').map((o) => o.permission),
  };
}

function invalidOverride(error: string) {
  return { ok: false as const, response: NextResponse.json({ error }, { status: 400 }) };
}

/** Validate + normalize the PUT body against the permission catalog. */
function validateOverrideInputs(raw: unknown): { ok: true; parsed: ParsedOverride[] } | { ok: false; response: NextResponse } {
  if (!Array.isArray(raw)) {
    return invalidOverride('قائمة الاستثناءات غير صالحة');
  }

  const seen = new Set<string>();
  const parsed: ParsedOverride[] = [];

  for (const entry of raw) {
    const rec = (entry ?? {}) as Record<string, unknown>;

    const permission = rec.permission;
    if (typeof permission !== 'string' || !ALL_CATALOG_KEYS.has(permission)) {
      return invalidOverride(`صلاحية غير معروفة: ${String(permission ?? '')}`);
    }
    if (seen.has(permission)) {
      return invalidOverride(`صلاحية مكررة: ${permission}`);
    }
    seen.add(permission);

    const effectRaw = rec.effect;
    if (effectRaw !== 'ALLOW' && effectRaw !== 'DENY') {
      return invalidOverride(`نوع الاستثناء غير صالح للصلاحية: ${permission}`);
    }
    const effect = effectRaw as OverrideEffect;

    // Scope must be one of the key's declared scopes in the catalog
    // (orders.view/edit → ALL_COMPANY|OWN|ASSIGNED, products.view/edit →
    // ALL_COMPANY|CATEGORY|SPECIFIC, other keys → ALL_COMPANY only).
    const item = catalogItem(permission);
    const declaredScopes: readonly string[] = item?.scopes ?? ['ALL_COMPANY'];
    const scopeRaw = rec.scope ?? 'ALL_COMPANY';
    if (typeof scopeRaw !== 'string' || !declaredScopes.includes(scopeRaw)) {
      return invalidOverride(`نطاق غير صالح للصلاحية: ${permission}`);
    }
    const scope: string = scopeRaw;

    let scopeIds: string[] | null = null;
    if (scope === 'CATEGORY' || scope === 'SPECIFIC') {
      const rawIds = rec.scopeIds;
      if (rawIds !== undefined && rawIds !== null && !Array.isArray(rawIds)) {
        return invalidOverride(`قائمة الموارد غير صالحة للصلاحية: ${permission}`);
      }
      // Dedupe + keep strings only; tenant membership is validated per-row below.
      scopeIds = Array.isArray(rawIds)
        ? [...new Set(rawIds.filter((x): x is string => typeof x === 'string'))]
        : [];
    }

    parsed.push({
      permission,
      effect,
      // DENY rows ignore scope in the engine — store null unless explicitly sent
      scope: effect === 'ALLOW' ? scope : ((rec.scope as string | undefined) ?? null),
      scopeIds,
    });
  }

  return { ok: true, parsed };
}

/** GET — inspector payload for the target user's effective permissions. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const admin = await requirePermission('users.view');

    const loaded = await loadPermissionTarget(id, admin);
    if (!loaded.ok) return loaded.response;

    return NextResponse.json(await buildPermissionsPayload(loaded.user));
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}

/** PUT — full replacement of the target user's permission overrides. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const admin = await requirePermission('users.edit');

    const loaded = await loadPermissionTarget(id, admin);
    if (!loaded.ok) return loaded.response;
    const target = loaded.user;

    // Self-modification guard: no user may edit their own permission overrides —
    // a holder of users.edit could otherwise silently grant themselves keys.
    if (target.id === admin.id) {
      return NextResponse.json({ error: 'لا يمكنك تعديل صلاحيات حسابك الشخصي' }, { status: 400 });
    }

    // SUPER_ADMIN is full-access by engine precedence — no overrides, ever.
    const superBlock = superAdminOverrideGuard(target);
    if (superBlock) return superBlock;

    // Not on an account whose role carries powers this admin lacks.
    const acting = await canActOnUser(admin, target);
    if (!acting.ok) return NextResponse.json({ error: acting.error }, { status: acting.status });

    const body = await req.json().catch(() => null);
    // A key the catalog has stopped offering is dropped before the list is judged (none is retired yet).
    const validated = validateOverrideInputs(Array.isArray(body?.overrides) ? withoutRetired(body.overrides as unknown[]) : body?.overrides);
    if (!validated.ok) return validated.response;
    const parsed = validated.parsed;

    // ── Grant-level guard: the actor may only ALLOW keys they themselves hold
    // at ALL_COMPANY scope (or be SUPER_ADMIN). DENY rows grant nothing. ──
    for (const o of parsed) {
      if (o.effect !== 'ALLOW') continue;
      // The broader view tier covers the narrower one, as in every granting door.
      const granterScope = heldOrCovered(admin, o.permission);
      if (!granterScope || granterScope.scope !== 'ALL_COMPANY') {
        return NextResponse.json(
          { error: `لا يمكنك منح «${keyLabel(o.permission)}» — لا تملكها بنطاق كامل` },
          { status: 403 }
        );
      }
    }

    // ── scopeIds tenant validation: every id must belong to the TARGET
    // user's company (never the actor's) — no cross-tenant resource scopes. ──
    for (const o of parsed) {
      if (!o.scopeIds || o.scopeIds.length === 0) continue;
      // A platform-level (companyId null) target owns no tenant resources —
      // no scopeIds can ever belong to its (nonexistent) company.
      if (!target.companyId) {
        return NextResponse.json({ error: 'نطاق يحتوي موارد من شركة أخرى' }, { status: 400 });
      }
      if (o.scope === 'CATEGORY') {
        const found = await db.category.findMany({
          where: { id: { in: o.scopeIds }, companyId: target.companyId },
          select: { id: true },
        });
        if (found.length !== o.scopeIds.length) {
          return NextResponse.json({ error: 'نطاق يحتوي موارد من شركة أخرى' }, { status: 400 });
        }
      } else if (o.scope === 'SPECIFIC') {
        const found = await db.product.findMany({
          where: { id: { in: o.scopeIds }, companyId: target.companyId },
          select: { id: true },
        });
        if (found.length !== o.scopeIds.length) {
          return NextResponse.json({ error: 'نطاق يحتوي موارد من شركة أخرى' }, { status: 400 });
        }
      }
    }

    // ── Full replacement in ONE transaction (deleteMany + createMany) ──
    const beforeRows = await db.userPermission.findMany({ where: { userId: target.id } });
    const before = new Map(beforeRows.map((r) => [r.permission, r]));
    const after = new Map(parsed.map((o) => [o.permission, o]));

    // A DENY that this replacement drops gives the key back — a grant, held
    // to the same rule as an ALLOW (denyRemovalRefusal).
    // (A retired key is nothing to lift: nothing asks it, so dropping its «منع» hands back no door.)
    const droppedDenies = beforeRows
      .filter((r) => r.effect === 'DENY' && !isRetiredKey(r.permission) && after.get(r.permission)?.effect !== 'DENY')
      .map((r) => r.permission);
    const denyRefusal = denyRemovalRefusal(admin, droppedDenies);
    if (denyRefusal) return NextResponse.json({ error: denyRefusal }, { status: 403 });

    // The list REPLACES the stored one: it is saved only over the version it was read from.
    if (!userVersionIsCurrent(body?.version, target.permissionsVersion)) return staleResponse();

    // What the person would END UP holding must not gain an action without its screen key.
    // Only a NEW orphan is refused — the ones already there (the shipped templates') keep working.
    const orphan = await overrideOrphanRefusal(
      target,
      beforeRows,
      parsed.map((o) => ({ permission: o.permission, effect: o.effect, scope: o.scope, scopeIds: o.scopeIds })),
    );
    if (orphan) return orphanResponse(orphan);

    await db.$transaction(async (tx) => {
      // First, and in the same transaction: two saves of one version cannot both win.
      const claimed = await tx.user.updateMany({
        where: { id: target.id, permissionsVersion: target.permissionsVersion },
        data: { permissionsVersion: { increment: 1 } },
      });
      if (claimed.count !== 1) throw new StalePermissionsError();
      await tx.userPermission.deleteMany({ where: { userId: target.id } });
      if (parsed.length) {
        await tx.userPermission.createMany({
          data: parsed.map((o) => ({
            userId: target.id,
            permission: o.permission,
            effect: o.effect,
            scope: o.scope,
            scopeIds: (o.scopeIds as unknown) ?? undefined,
            grantedById: admin.id,
          })),
        });
      }
      // (permissionsVersion was bumped by the claim above — the target recomputes on their next request.)
    });

    // ── Audit per changed permission (old vs new effect/scope comparison) ──
    const auditCompanyId = target.companyId || admin.companyId || 'platform';
    const changedKeys = new Set<string>([...before.keys(), ...after.keys()]);
    for (const permission of changedKeys) {
      const oldO = before.get(permission);
      const newO = after.get(permission);

      // Override dropped by the replacement → same action as the DELETE route
      if (!newO) {
        await logAudit({
          companyId: auditCompanyId,
          userId: admin.id,
          action: 'USER_PERMISSION_OVERRIDE_REMOVED',
          entity: 'User',
          entityId: target.id,
          previousData: {
            targetUserId: target.id,
            permission,
            effect: oldO?.effect ?? null,
            scope: oldO?.scope ?? null,
            scopeIds: oldO?.scopeIds ?? null,
          },
          newData: { removedBy: admin.name },
        });
        continue;
      }

      const effectChanged = !oldO || oldO.effect !== newO.effect;
      // Scope only changes behavior for ALLOW rows (DENY deletes the grant)
      const scopeChanged =
        !!oldO &&
        newO.effect === 'ALLOW' &&
        (oldO.scope !== newO.scope ||
          JSON.stringify(oldO.scopeIds ?? null) !== JSON.stringify(newO.scopeIds ?? null));
      if (!effectChanged && !scopeChanged) continue;

      const action = effectChanged
        ? newO.effect === 'DENY'
          ? 'USER_PERMISSION_DENIED'
          : 'USER_PERMISSION_GRANTED'
        : 'USER_PERMISSION_SCOPE_CHANGED';

      await logAudit({
        companyId: auditCompanyId,
        userId: admin.id,
        action,
        entity: 'User',
        entityId: target.id,
        previousData: {
          targetUserId: target.id,
          permission,
          effect: oldO?.effect ?? null,
          scope: oldO?.scope ?? null,
          scopeIds: oldO?.scopeIds ?? null,
        },
        newData: {
          targetUserId: target.id,
          permission,
          effect: newO.effect,
          scope: newO.scope,
          scopeIds: newO.scopeIds,
          grantedBy: admin.name,
        },
      });
    }

    // Return the updated GET payload (fresh permissionsVersion)
    const fresh = await db.user.findUnique({
      where: { id: target.id },
      select: PERMISSION_TARGET_SELECT,
    });
    return NextResponse.json(await buildPermissionsPayload(fresh as PermissionTargetUser));
  } catch (error: unknown) {
    if (error instanceof StalePermissionsError) return staleResponse();
    return apiErrorResponse(error);
  }
}
