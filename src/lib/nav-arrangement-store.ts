import { db } from './db';
import { EMPTY_LAYOUT, parseLayout, resolveLayout, type NavLayout } from './nav-arrangement';

/**
 * READING AND WRITING THE ARRANGEMENT — SERVER SIDE, FOR THE FIRST FRAME.
 *
 * The brief asks for the stored arrangement to be on screen in the FIRST
 * frame, not after a fetch: a menu that reorders itself a moment after the
 * page appears is a menu that moved under somebody's thumb. The shell
 * layout is a server component and already resolves the session, so the
 * read happens there and the sidebar is simply handed the result.
 *
 * ── AND ONE SURFACE PER OPINION ──
 *
 * The same three lists answer every «you arrange it» in this product: the
 * menu, the dashboard cards, the orders columns, a saved view published to
 * a role. They are told apart by `surface`, and NULL reads as `nav` —
 * which is what every row written before the column existed is.
 *
 * ── THE ROLE A PERSON IS IN IS A NAME, NOT AN ID ──
 *
 * `user.role` is a name (`'MANAGER'`), and a role's base is keyed on the
 * ROW. So the base is found by joining on the name within the company,
 * plus the system-wide templates (`companyId IS NULL`) that older roles
 * still resolve against — the same way `role_permissions` is read.
 */

/**
 * `surface = 'nav'` has to match the rows that predate the column, and
 * those hold NULL. Written once so no caller forgets which of the two it
 * is looking for.
 */
function surfaceWhere(surface: string) {
  return surface === 'nav' ? { OR: [{ surface: 'nav' }, { surface: null }] } : { surface };
}

/** One query: the role's base and this person's own, in one round trip. */
export async function readArrangement(
  companyId: string,
  userId: string,
  roleName: string,
  surface = 'nav'
): Promise<{ base: NavLayout | null; own: NavLayout | null; resolved: NavLayout }> {
  const rows = await db.navArrangement.findMany({
    where: {
      companyId,
      /*
       * TWO CONDITIONS, SO TWO ENTRIES OF `AND`.
       *
       * Both are an `OR`, and an object holds one key of that name: the
       * surface's `OR` (for `nav`, «`nav` or the rows written before the
       * column») was spread in and then replaced by the owner's `OR` below
       * it, so a read of the MENU also read every other surface of the same
       * person or role. A role that had views published to it (`view:orders`)
       * could then hand its menu base the views row instead of the menu's.
       */
      AND: [surfaceWhere(surface), { OR: [{ userId }, { role: { name: roleName } }] }],
    },
    select: { userId: true, roleId: true, layout: true },
  });

  const ownRow = rows.find((r) => r.userId === userId);
  const baseRow = rows.find((r) => r.roleId !== null);
  const base = baseRow ? parseLayout(baseRow.layout) : null;
  const own = ownRow ? parseLayout(ownRow.layout) : null;

  return { base, own, resolved: resolveLayout(base, own) };
}

/**
 * This person's own row alone, as it is stored — `null` when they never saved one.
 *
 * Not the resolved layout: a save that did not mention the groups or the phone's bar must leave
 * THEIR stored choice as it was (see `carryUnsaid`), and the role's base showing through would be
 * copied into their row as if it had been theirs.
 */
export async function readOwnArrangement(
  companyId: string,
  userId: string,
  surface = 'nav'
): Promise<NavLayout | null> {
  const row = await db.navArrangement.findFirst({
    where: { companyId, userId, ...surfaceWhere(surface) },
    select: { layout: true },
  });
  return row ? parseLayout(row.layout) : null;
}

/** This person's own arrangement, replacing whatever was there. */
export async function saveOwnArrangement(
  companyId: string,
  userId: string,
  layout: NavLayout,
  surface = 'nav'
): Promise<void> {
  const existing = await db.navArrangement.findFirst({
    where: { companyId, userId, ...surfaceWhere(surface) },
    select: { id: true },
  });
  if (existing) {
    await db.navArrangement.update({ where: { id: existing.id }, data: { layout: JSON.stringify(layout) } });
    return;
  }
  await db.navArrangement.create({
    data: { companyId, userId, surface, layout: JSON.stringify(layout) },
  });
}

/**
 * «رجّع الأساس» — the person's own row goes, and the role's base answers
 * again. Deleting beats storing an empty layout: an empty one would be
 * indistinguishable from «I deliberately hid nothing», which is a
 * different thing from «I have no opinion».
 */
export async function clearOwnArrangement(
  companyId: string,
  userId: string,
  surface = 'nav'
): Promise<void> {
  await db.navArrangement.deleteMany({ where: { companyId, userId, ...surfaceWhere(surface) } });
}

/** The base for a role, set by the owner. */
export async function saveRoleArrangement(
  companyId: string,
  roleId: string,
  layout: NavLayout,
  surface = 'nav'
): Promise<void> {
  const existing = await db.navArrangement.findFirst({
    where: { companyId, roleId, ...surfaceWhere(surface) },
    select: { id: true },
  });
  if (existing) {
    await db.navArrangement.update({ where: { id: existing.id }, data: { layout: JSON.stringify(layout) } });
    return;
  }
  await db.navArrangement.create({
    data: { companyId, roleId, surface, layout: JSON.stringify(layout) },
  });
}

/** The base a role carries today, for the owner's own «الترتيب لـ» screen. */
export async function readRoleArrangement(
  companyId: string,
  roleId: string,
  surface = 'nav'
): Promise<NavLayout> {
  const row = await db.navArrangement.findFirst({
    where: { companyId, roleId, ...surfaceWhere(surface) },
    select: { layout: true },
  });
  return row ? parseLayout(row.layout) : EMPTY_LAYOUT;
}
