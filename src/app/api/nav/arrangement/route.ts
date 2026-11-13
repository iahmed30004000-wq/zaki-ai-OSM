import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { can } from '@/lib/authorization';
import { isMenuLine, visibleNav } from '@/lib/route-registry';
import { carryUnsaid, cleanLayout, parseLayout, type NavLayout } from '@/lib/nav-arrangement';
import {
  clearOwnArrangement,
  readArrangement,
  readOwnArrangement,
  readRoleArrangement,
  saveOwnArrangement,
  saveRoleArrangement,
} from '@/lib/nav-arrangement-store';
import { logAudit } from '@/lib/audit';
import type { SessionUser } from '@/types/auth';

/**
 * THE MENU'S ARRANGEMENT — the owner's base per role, a person's own.
 *
 * ── ARRANGING OPENS NOTHING ──
 *
 * Every layout written here is filtered down to the paths the WRITER may
 * already reach (`visibleNav`), so a hand-posted path for a screen
 * somebody may not open is dropped rather than stored. And it could not
 * grant anything even if it were stored: the menu this arranges is built
 * from `visibleNav` per viewer, and every door checks its own permission
 * when it is opened. Hiding is cosmetic; unhiding is cosmetic.
 *
 * ── THE GROUPS AND THE PHONE'S FOUR RIDE THE SAME DOOR ──
 *
 * The order of the drawer's main entries (`groups`, keys) and the four
 * screens of the phone's bottom bar (`slots`, paths) are stored in the same
 * layout, by the same permission — whoever may save an arrangement may save
 * these, and nobody needs a new key. They are checked the same way: a group
 * key that is not one of the groups of THIS caller's menu, and a slot that is
 * not a screen they may open, are DROPPED from what is stored, and the rest of
 * the save goes through. And a save that does not mention them leaves them as
 * they were (see `carryUnsaid`).
 *
 * ── WHO MAY SET A ROLE'S BASE ──
 *
 * `roles.edit` — the permission that already means «decide what a role
 * is». Inventing a key for it would be a grant somebody has to remember
 * before the feature works at all, which is how a feature arrives already
 * broken for everyone except whoever thought to tick it.
 */

const layoutSchema = z.object({
  order: z.array(z.string()).max(200).default([]),
  hidden: z.array(z.string()).max(200).default([]),
  pinned: z.array(z.string()).max(200).default([]),
  /*
   * NO `.default([])` ON THE TWO NEWER LISTS — ABSENT IS NOT EMPTY.
   *
   * A tab opened before they existed posts the three lists and nothing else,
   * and that must not read as «clear them». A current client always posts both,
   * an empty list meaning «no opinion of mine».
   */
  groups: z.array(z.string()).max(200).optional(),
  slots: z.array(z.string()).max(200).optional(),
});

/**
 * What this caller may arrange: the screens they may open, the keys of the groups that hold them, and which of
 * those screens the drawer draws as a LINE (`menuPaths` — the only ones the phone's bar can ever hold). Never more.
 */
function reachOf(user: SessionUser) {
  const visible = visibleNav(user, can);
  const paths = visible.flatMap((g) => g.routes.map((r) => r.path));
  const openable = new Set(paths);
  return {
    paths,
    groupKeys: visible.map((g) => g.key),
    menuPaths: visible.flatMap((g) => g.routes.filter((r) => isMenuLine(r, openable)).map((r) => r.path)),
  };
}
type Reach = ReturnType<typeof reachOf>;

/**
 * A layout on its way OUT — only what this caller's own menu holds, so the screen never meets a path
 * or a key that is not theirs, whatever a row happens to carry.
 */
const readable = (layout: NavLayout, reach: Reach): NavLayout =>
  cleanLayout(layout, reach.paths, reach.groupKeys, reach.menuPaths);

/** GET — what this person's menu is arranged by, and what the base is. */
export async function GET() {
  try {
    const { user, companyId } = await requireCompanyTenant();
    const { base, own, resolved } = await readArrangement(companyId, user.id, user.role);
    const reach = reachOf(user);
    return NextResponse.json({
      resolved: readable(resolved, reach),
      base: base && readable(base, reach),
      /** Null means «رجّع الأساس» would change nothing — there is nothing of mine. */
      own: own && readable(own, reach),
      /** The paths this person may arrange: their own menu, nothing more. */
      paths: reach.paths,
      maySetRoleBase: can(user, 'roles.edit'),
    });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}

/** PUT — mine, or a role's base with `?roleId=`. */
export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    const parsed = layoutSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ errorAr: 'شكل الترتيب غير مفهوم.' }, { status: 400 });
    }

    const roleId = new URL(req.url).searchParams.get('roleId');
    const { paths, groupKeys, menuPaths } = reachOf(user);
    const posted = parseLayout(parsed.data);
    // What the post CARRIED, by key — `parseLayout` cannot tell «absent» from «empty», this can.
    const said = { groups: parsed.data.groups !== undefined, slots: parsed.data.slots !== undefined };
    // Only a post that left something out can need the stored row: a current client says both.
    const mayKeep = !said.groups || !said.slots;

    if (!roleId) {
      const stored = mayKeep ? await readOwnArrangement(companyId, user.id) : null;
      const mine = cleanLayout(carryUnsaid(stored, posted, said), paths, groupKeys, menuPaths);
      await saveOwnArrangement(companyId, user.id, mine);
      return NextResponse.json({ saved: 'own', layout: mine });
    }

    if (!can(user, 'roles.edit')) {
      return NextResponse.json(
        { errorAr: 'ترتيب القائمة لدورٍ كامل بيحتاج صلاحيّة تعديل الأدوار.', code: 'ROLE_BASE_FORBIDDEN' },
        { status: 403 }
      );
    }
    /*
     * The role has to be this company's. Without this check a role id from
     * another company could be written against this company's row — and
     * the partial unique index is on `(companyId, roleId)`, so it would
     * store cleanly and belong to nobody.
     */
    const role = await db.role.findFirst({
      where: { id: roleId, OR: [{ companyId }, { companyId: null }] },
      select: { id: true, name: true },
    });
    if (!role) return NextResponse.json({ errorAr: 'لا دور بهذا المعرّف.' }, { status: 404 });

    const stored = mayKeep ? await readRoleArrangement(companyId, role.id) : null;
    const base = cleanLayout(carryUnsaid(stored, posted, said), paths, groupKeys, menuPaths);
    await saveRoleArrangement(companyId, role.id, base);
    await logAudit({
      companyId,
      userId: user.id,
      action: 'NAV_BASE_SET',
      entity: 'Role',
      entityId: role.id,
      newData: {
        role: role.name,
        hidden: base.hidden.length,
        pinned: base.pinned.length,
        groups: base.groups?.length ?? 0,
        slots: base.slots?.length ?? 0,
      },
    });
    return NextResponse.json({ saved: 'role', role: role.name, layout: base });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}

/**
 * DELETE — «رجّع الأساس».
 *
 * Only ever the caller's own row. A role's base is changed by writing a
 * new one, never by a delete: an owner pressing «رجّع الأساس» on his own
 * menu must not silently take the base away from everybody in his role.
 */
export async function DELETE() {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await clearOwnArrangement(companyId, user.id);
    const { resolved, base } = await readArrangement(companyId, user.id, user.role);
    const reach = reachOf(user);
    return NextResponse.json({ reset: true, resolved: readable(resolved, reach), base: base && readable(base, reach) });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}

/** The owner's «الترتيب لـ: <دور>» screen reads a role's base with this. */
export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    if (!can(user, 'roles.edit')) {
      return NextResponse.json({ errorAr: 'لا تملك صلاحية تعديل الأدوار.' }, { status: 403 });
    }
    const roleId = new URL(req.url).searchParams.get('roleId');
    if (!roleId) return NextResponse.json({ errorAr: 'المعرّف مطلوب.' }, { status: 400 });
    const role = await db.role.findFirst({
      where: { id: roleId, OR: [{ companyId }, { companyId: null }] },
      select: { id: true, name: true },
    });
    if (!role) return NextResponse.json({ errorAr: 'لا دور بهذا المعرّف.' }, { status: 404 });
    return NextResponse.json({
      role: role.name,
      layout: readable(await readRoleArrangement(companyId, role.id), reachOf(user)),
    });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}
