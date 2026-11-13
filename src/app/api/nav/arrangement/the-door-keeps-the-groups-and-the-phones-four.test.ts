import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ARRANGEMENT'S DOOR KEEPS THE GROUPS AND THE PHONE'S FOUR (13/11).
 *
 *   «زر رتّب القائمة لترتيب القوائم والخانات الرئيسية» (the owner)
 *
 * Two newer opinions ride the layout: the order of the drawer's groups (`groups`, keys) and the
 * four screens of the phone's bottom bar (`slots`, paths). This is the REAL door and the REAL
 * store over a recording fake of the one table, which evaluates `where` the way the database
 * does — `AND`, `OR` and the role relation included — because the case that mattered most here
 * is exactly a `where` that does not say what it looks like it says.
 *
 * What is held:
 *   • what is stored, and what is dropped (a group the caller's menu does not hold, a screen they
 *     may not open, a repeat, a fifth slot) — dropped, never an error that blocks the rest;
 *   • an OLDER TAB, which posts three lists and has never heard of the other two, does not erase
 *     them — and a current client that posts them EMPTY clears them, which is how it says «no opinion»;
 *   • the role's base reaches a person with no layout of their own, their own wins over it
 *     field by field, and two people of one role are two answers;
 *   • a role that also has VIEWS published to it does not hand its menu base the views row;
 *   • no new key: whoever could save an arrangement before can save these, and only `roles.edit`
 *     sets a role's base — nobody gets a screen they could not open.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = { id: string; companyId: string; roleId: string | null; userId: string | null; surface: string | null; layout: string };

const { db, rows, roles, session, audit, TABLE } = vi.hoisted(() => {
  const rows: Row[] = [];
  const roles = [
    { id: 'role-mod', name: 'MODERATOR', companyId: 'c1' },
    { id: 'role-agent', name: 'AGENT', companyId: 'c1' },
    { id: 'role-template', name: 'TEMPLATE', companyId: null as string | null },
    { id: 'role-foreign', name: 'MODERATOR', companyId: 'c2' },
  ];
  let seq = 0;

  /** Prisma's `where`, as far as the store and the door use it: equality, `AND`, `OR`, and the role relation. */
  function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, want]) => {
      if (key === 'AND') return (want as Record<string, unknown>[]).every((w) => matches(row, w));
      if (key === 'OR') return (want as Record<string, unknown>[]).some((w) => matches(row, w));
      if (key === 'role') {
        const role = roles.find((r) => r.id === row.roleId);
        return !!role && matches(role as Record<string, unknown>, want as Record<string, unknown>);
      }
      return row[key] === want;
    });
  }

  const TABLE = {
    findMany: async ({ where }: { where?: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    findFirst: async ({ where }: { where?: Record<string, unknown> }) => {
      const hit = rows.find((r) => matches(r, where));
      return hit ? { ...hit } : null;
    },
    create: async ({ data }: { data: Partial<Row> & { companyId: string; layout: string } }) => {
      const row: Row = { id: `row-${++seq}`, roleId: null, userId: null, surface: null, ...data };
      // The partial unique indexes: one row per owner per surface. A double create is a bug, so it throws.
      const clash = rows.find(
        (r) =>
          r.companyId === row.companyId &&
          (r.surface ?? 'nav') === (row.surface ?? 'nav') &&
          ((row.userId && r.userId === row.userId) || (row.roleId && r.roleId === row.roleId))
      );
      if (clash) throw new Error('unique constraint');
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const hit = rows.find((r) => r.id === where.id)!;
      Object.assign(hit, data);
      return { ...hit };
    },
    deleteMany: async ({ where }: { where?: Record<string, unknown> }) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) {
          rows.splice(i, 1);
          count++;
        }
      }
      return { count };
    },
  };

  const db = {
    navArrangement: TABLE,
    role: {
      findFirst: async ({ where }: { where?: Record<string, unknown> }) => {
        const hit = roles.find((r) => matches(r, where));
        return hit ? { id: hit.id, name: hit.name } : null;
      },
    },
  };
  return { db, rows, roles, session: { user: null as unknown }, audit: vi.fn(), TABLE };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => session.user),
  requireCompanyTenant: vi.fn(async () => ({ user: session.user, companyId: 'c1' })),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => audit(...a) }));

import { DELETE, GET, POST, PUT } from './route';
import { can } from '@/lib/authorization';
import { visibleNav } from '@/lib/route-registry';

const A = { scope: 'ALL_COMPANY' };
const person = (grants: string[], over: Record<string, unknown> = {}) => ({
  id: 'u-salwa',
  name: 'سلوى',
  role: 'MODERATOR',
  status: 'ACTIVE',
  companyId: 'c1',
  effectiveGrants: { fullAccess: false, grants: Object.fromEntries(grants.map((k) => [k, A])) },
  ...over,
});
/** Salwa: a desk, the preparation, the tracking, her orders — and her profile, which everybody has. */
const SALWA_KEYS = ['orders.view', 'confirmation.work', 'confirmation.pull', 'ops.prepare', 'ops.track'];
const SALWA_PATHS = ['/orders', '/confirmation/mine', '/ops/preparation', '/ops/tracking', '/admin/profile'];
const SALWA_GROUPS = ['main', 'confirmation', 'ops', 'admin'];
const owner = () => ({
  id: 'u-owner',
  name: 'أحمد',
  role: 'SUPER_ADMIN',
  status: 'ACTIVE',
  companyId: 'c1',
  effectiveGrants: { fullAccess: true, grants: {} },
});

const json = (body: unknown) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (body: unknown, roleId?: string) =>
  PUT(new Request(`http://x/api/nav/arrangement${roleId ? `?roleId=${roleId}` : ''}`, json(body)));
const get = async () => (await (await GET()).json()) as Record<string, any>;
const del = async () => (await (await DELETE()).json()) as Record<string, any>;
const post = (roleId: string) => POST(new Request(`http://x/api/nav/arrangement?roleId=${roleId}`, { method: 'POST' }));

/** What a row holds, as the column holds it. */
const stored = (where: Partial<Row>) => {
  const row = rows.find((r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v));
  return row ? (JSON.parse(row.layout) as Record<string, unknown>) : null;
};
const addRow = (row: Partial<Row> & { layout: Record<string, unknown> }) =>
  rows.push({ id: `seed-${rows.length}`, companyId: 'c1', roleId: null, userId: null, surface: 'nav', ...row, layout: JSON.stringify(row.layout) });

beforeEach(() => {
  rows.length = 0;
  audit.mockClear();
  session.user = person(SALWA_KEYS);
});

describe('the fixtures say what they claim — or every claim below could pass by looking at nothing', () => {
  it('Salwa opens exactly five screens in four groups, and the owner opens more', () => {
    const mine = visibleNav(session.user as never, can);
    expect(mine.flatMap((g) => g.routes.map((r) => r.path))).toEqual(SALWA_PATHS);
    expect(mine.map((g) => g.key)).toEqual(SALWA_GROUPS);
    expect(visibleNav(owner() as never, can).flatMap((g) => g.routes).length).toBeGreaterThan(40);
  });

  it('and the fake table answers a `where` the way the database does', async () => {
    addRow({ userId: 'u1', layout: { order: [] } });
    addRow({ userId: 'u2', surface: 'view:orders', layout: { order: [] } });
    addRow({ userId: 'u3', surface: null, layout: { order: [] } });
    const both = await TABLE.findMany({ where: { AND: [{ OR: [{ surface: 'nav' }, { surface: null }] }, { OR: [{ userId: 'u1' }, { userId: 'u2' }] }] } });
    expect(both.map((r) => r.userId)).toEqual(['u1']);
    // …and a literal with two `OR` keys keeps ONE of them, which is the whole reason the store uses `AND`.
    const collided = Object.assign({ OR: [{ surface: 'nav' }] }, { OR: [{ userId: 'u2' }] });
    expect((await TABLE.findMany({ where: collided })).map((r) => r.userId)).toEqual(['u2']);
  });
});

describe('what a save stores', () => {
  it('— the groups and the four, as posted, when they are the caller’s own', async () => {
    const res = await put({
      order: ['/orders'],
      hidden: [],
      pinned: [],
      groups: ['ops', 'main', 'confirmation', 'admin'],
      slots: ['/ops/tracking', '/orders', '/confirmation/mine', '/ops/preparation'],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saved).toBe('own');
    expect(body.layout.groups).toEqual(['ops', 'main', 'confirmation', 'admin']);
    expect(body.layout.slots).toEqual(['/ops/tracking', '/orders', '/confirmation/mine', '/ops/preparation']);
    // …and the column holds the same, as JSON, under her own id
    expect(stored({ userId: 'u-salwa' })).toEqual({
      order: ['/orders'],
      hidden: [],
      pinned: [],
      groups: ['ops', 'main', 'confirmation', 'admin'],
      slots: ['/ops/tracking', '/orders', '/confirmation/mine', '/ops/preparation'],
    });
    expect(rows).toHaveLength(1);
  });

  it('and a group key that is not one of HER groups is dropped — the rest of the save goes through', async () => {
    const res = await put({
      order: ['/orders', '/finance/wallets'],
      hidden: ['/control/audit'],
      pinned: [],
      groups: ['finance', 'ops', 'control', 'main', 'nope'],
    });
    expect(res.status).toBe(200);
    expect(stored({ userId: 'u-salwa' })).toEqual({ order: ['/orders'], hidden: [], pinned: [], groups: ['ops', 'main'] });
  });

  it('and a slot she may not open is dropped, a repeat is kept once, and a fifth is cut — AFTER the dropped ones', async () => {
    const res = await put({
      order: [],
      hidden: [],
      pinned: [],
      slots: ['/finance/wallets', '/orders', '/orders', '/ops/tracking', '/ops/preparation', '/confirmation/mine', '/admin/profile', '/forged'],
    });
    expect(res.status).toBe(200);
    expect(stored({ userId: 'u-salwa' })!.slots).toEqual(['/orders', '/ops/tracking', '/ops/preparation', '/confirmation/mine']);
  });

  it('and what is left empty is not stored as an empty list', async () => {
    await put({ order: [], hidden: [], pinned: [], groups: ['nope'], slots: ['/nope'] });
    const row = stored({ userId: 'u-salwa' })!;
    expect(Object.keys(row).sort()).toEqual(['hidden', 'order', 'pinned']);
  });

  it('and a second save replaces her row — one row, not two', async () => {
    await put({ order: [], hidden: [], pinned: [], groups: ['ops', 'main'] });
    await put({ order: [], hidden: [], pinned: [], groups: ['main', 'ops'] });
    expect(rows).toHaveLength(1);
    expect(stored({ userId: 'u-salwa' })!.groups).toEqual(['main', 'ops']);
  });

  it('and a post that is not the shape is refused whole — a number in a list, more than the cap, a body that is not JSON', async () => {
    expect((await put({ order: [], hidden: [], pinned: [], groups: [7] })).status).toBe(400);
    expect((await put({ order: [], hidden: [], pinned: [], slots: ['/orders', null] })).status).toBe(400);
    expect((await put({ order: [], hidden: [], pinned: [], groups: 'ops' })).status).toBe(400);
    expect((await put({ order: [], hidden: [], pinned: [], slots: Array.from({ length: 201 }, (_, i) => `/p${i}`) })).status).toBe(400);
    const notJson = await PUT(new Request('http://x/api/nav/arrangement', { method: 'PUT', body: '{nope' }));
    expect(notJson.status).toBe(400);
    expect(rows, 'شي انحفظ من طلب مرفوض').toHaveLength(0);
  });

  it('and one person’s save never touches another person’s row, or the role’s base', async () => {
    addRow({ userId: 'u-hana', layout: { order: ['/orders'], hidden: [], pinned: [], groups: ['ops'] } });
    addRow({ roleId: 'role-mod', layout: { order: [], hidden: [], pinned: [], groups: ['admin'] } });
    await put({ order: [], hidden: [], pinned: [], groups: ['main', 'ops'] });
    expect(stored({ userId: 'u-hana' })!.groups).toEqual(['ops']);
    expect(stored({ roleId: 'role-mod' })!.groups).toEqual(['admin']);
    expect(stored({ userId: 'u-salwa' })!.groups).toEqual(['main', 'ops']);
  });
});

describe('an older tab — it posts three lists, and must not erase the two it has never heard of', () => {
  const OLD = { order: ['/ops/tracking'], hidden: ['/orders'], pinned: [] };
  const HERS = { order: ['/orders'], hidden: [], pinned: [], groups: ['ops', 'main'], slots: ['/ops/tracking', '/orders'] };

  it('— her saved groups and four survive; the three lists it did post are the post’s', async () => {
    addRow({ userId: 'u-salwa', layout: HERS });
    const res = await put(OLD);
    expect(res.status).toBe(200);
    expect(stored({ userId: 'u-salwa' })).toEqual({ ...OLD, groups: ['ops', 'main'], slots: ['/ops/tracking', '/orders'] });
  });

  it('and with nothing stored, the row it creates holds exactly the three lists', async () => {
    await put(OLD);
    expect(stored({ userId: 'u-salwa' })).toEqual(OLD);
  });

  it('and what is kept is checked again — a screen she can no longer open does not stay in her row', async () => {
    addRow({ userId: 'u-salwa', layout: { ...HERS, groups: ['finance', 'ops'], slots: ['/finance/wallets', '/orders'] } });
    await put(OLD);
    expect(stored({ userId: 'u-salwa' })).toEqual({ ...OLD, groups: ['ops'], slots: ['/orders'] });
  });

  it('and only the key it left out is kept: posting the groups alone keeps the four, and the other way round', async () => {
    addRow({ userId: 'u-salwa', layout: HERS });
    await put({ ...OLD, groups: ['main'] });
    expect(stored({ userId: 'u-salwa' })).toEqual({ ...OLD, groups: ['main'], slots: ['/ops/tracking', '/orders'] });
    await put({ ...OLD, slots: ['/orders'] });
    expect(stored({ userId: 'u-salwa' })).toEqual({ ...OLD, groups: ['main'], slots: ['/orders'] });
  });

  it('and a CURRENT client posting both EMPTY clears them — that is how it says «no opinion of mine»', async () => {
    addRow({ userId: 'u-salwa', layout: HERS });
    await put({ ...OLD, groups: [], slots: [] });
    const row = stored({ userId: 'u-salwa' })!;
    expect(row).toEqual(OLD);
    expect('groups' in row || 'slots' in row).toBe(false);
  });

  it('and the ROLE’S base, written by an older tab of the owner, keeps its groups and four the same way', async () => {
    session.user = owner();
    addRow({ roleId: 'role-mod', layout: { order: [], hidden: [], pinned: [], groups: ['ops', 'main'], slots: ['/ops/tracking', '/orders'] } });
    const res = await put({ order: ['/orders'], hidden: [], pinned: [] }, 'role-mod');
    expect(res.status).toBe(200);
    expect(stored({ roleId: 'role-mod' })).toEqual({
      order: ['/orders'],
      hidden: [],
      pinned: [],
      groups: ['ops', 'main'],
      slots: ['/ops/tracking', '/orders'],
    });
  });
});

describe('a role’s base — only roles.edit sets it, and it reaches the people in the role', () => {
  const BASE = { order: [], hidden: [], pinned: [], groups: ['ops', 'confirmation', 'main', 'admin'], slots: ['/confirmation/mine', '/ops/preparation'] };

  it('— a person without roles.edit is refused, in Arabic, and nothing is stored', async () => {
    const res = await put(BASE, 'role-mod');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('ROLE_BASE_FORBIDDEN');
    expect(body.errorAr).toContain('صلاحيّة تعديل الأدوار');
    expect(rows).toHaveLength(0);
  });

  it('and the owner stores it, and the audit says how many groups and slots it holds', async () => {
    session.user = owner();
    const res = await put({ ...BASE, groups: ['ops', 'admin', 'nope'], slots: ['/confirmation/mine', '/orders', '/nope'] }, 'role-mod');
    expect(res.status).toBe(200);
    expect((await res.json()).saved).toBe('role');
    expect(stored({ roleId: 'role-mod' })).toEqual({
      order: [],
      hidden: [],
      pinned: [],
      groups: ['ops', 'admin'],
      slots: ['/confirmation/mine', '/orders'],
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({ action: 'NAV_BASE_SET', entityId: 'role-mod', newData: { groups: 2, slots: 2 } });
  });

  it('and it is bounded by the WRITER’S own menu, as the three lists always were — a narrow manager cannot name what he cannot see', async () => {
    session.user = person(['roles.edit', 'orders.view'], { id: 'u-manager' });
    await put({ ...BASE, groups: ['ops', 'main'], slots: ['/confirmation/mine', '/orders'] }, 'role-mod');
    expect(stored({ roleId: 'role-mod' })).toEqual({ order: [], hidden: [], pinned: [], groups: ['main'], slots: ['/orders'] });
  });

  it('and a role of another company, or one that does not exist, is not written', async () => {
    session.user = owner();
    expect((await put(BASE, 'role-foreign')).status).toBe(404);
    expect((await put(BASE, 'role-nobody')).status).toBe(404);
    expect(rows).toHaveLength(0);
    // a system template (no company) is allowed, as it is for the three lists
    expect((await put(BASE, 'role-template')).status).toBe(200);
    expect(stored({ roleId: 'role-template' })).toBeTruthy();
  });

  it('and the base reaches a person who never arranged anything — it is what they see', async () => {
    session.user = owner();
    await put(BASE, 'role-mod');
    session.user = person(SALWA_KEYS);
    const body = await get();
    expect(body.own).toBeNull();
    expect(body.resolved.groups).toEqual(['ops', 'confirmation', 'main', 'admin']);
    expect(body.resolved.slots).toEqual(['/confirmation/mine', '/ops/preparation']);
    expect(body.base.groups).toEqual(['ops', 'confirmation', 'main', 'admin']);
  });

  it('and a person’s own wins over it, field by field — and two people of one role are two answers', async () => {
    addRow({ roleId: 'role-mod', layout: BASE });
    addRow({ userId: 'u-salwa', layout: { order: [], hidden: [], pinned: [], groups: ['admin', 'main'] } });
    const salwa = await get();
    expect(salwa.resolved.groups, 'ترتيبها ضاع تحت الأساس').toEqual(['admin', 'main']);
    expect(salwa.resolved.slots, 'الأساس ضاع لأنها رتّبت المجموعات بس').toEqual(['/confirmation/mine', '/ops/preparation']);
    expect(salwa.own.groups).toEqual(['admin', 'main']);

    session.user = person(SALWA_KEYS, { id: 'u-hana', name: 'هناء' });
    const hana = await get();
    expect(hana.resolved.groups).toEqual(['ops', 'confirmation', 'main', 'admin']);
    expect(hana.own).toBeNull();
  });

  it('and the base is the NAV base even when the same role has views published to it — the views row never stands in for it', async () => {
    // The views row is written FIRST: a read that lost its surface filter would take the first role row it finds.
    addRow({ roleId: 'role-mod', surface: 'view:orders', layout: { order: [], hidden: [], pinned: [], views: [{ name: 'المتأخرة', query: 'late=1' }] } });
    addRow({ roleId: 'role-mod', surface: 'nav', layout: BASE });
    const body = await get();
    expect(body.base, 'الأساس صار صف العروض').not.toBeNull();
    expect(body.base.groups).toEqual(['ops', 'confirmation', 'main', 'admin']);
    expect(body.resolved.slots).toEqual(['/confirmation/mine', '/ops/preparation']);
    expect(body.resolved.views, 'عروض الطلبات دخلت القائمة').toBeUndefined();
  });

  it('and a row written before the surface column existed (NULL) is the menu’s too', async () => {
    addRow({ roleId: 'role-mod', surface: null, layout: BASE });
    expect((await get()).resolved.groups).toEqual(['ops', 'confirmation', 'main', 'admin']);
  });
});

describe('what a read hands back', () => {
  it('— nothing arranged: no groups, no four, no own row, and the paths she may arrange', async () => {
    const body = await get();
    expect(body.resolved).toEqual({ order: [], hidden: [], pinned: [] });
    expect(body.own).toBeNull();
    expect(body.base).toBeNull();
    expect(body.paths).toEqual(SALWA_PATHS);
    expect(body.maySetRoleBase).toBe(false);
  });

  it('and a row that holds a group or a screen she cannot have is read WITHOUT it — the screen never meets a key that is not hers', async () => {
    addRow({
      userId: 'u-salwa',
      layout: {
        order: ['/orders', '/finance/wallets'],
        hidden: [],
        pinned: [],
        groups: ['finance', 'ops', 'nope'],
        slots: ['/finance/wallets', '/orders', '/ops/tracking'],
      },
    });
    const body = await get();
    for (const layout of [body.resolved, body.own]) {
      expect(layout.groups).toEqual(['ops']);
      expect(layout.slots).toEqual(['/orders', '/ops/tracking']);
      expect(layout.order).toEqual(['/orders']);
    }
  });

  it('and another person’s row, and another company’s, are never read', async () => {
    addRow({ userId: 'u-hana', layout: { order: [], hidden: [], pinned: [], groups: ['ops'], slots: ['/orders'] } });
    addRow({ companyId: 'c2', userId: 'u-salwa', layout: { order: [], hidden: [], pinned: [], groups: ['admin'] } });
    const body = await get();
    expect(body.own).toBeNull();
    expect(body.resolved.groups).toBeUndefined();
  });

  it('and the owner reading a role’s base gets its groups and its four, and nobody else may ask', async () => {
    addRow({ roleId: 'role-mod', layout: { order: [], hidden: [], pinned: [], groups: ['ops', 'main'], slots: ['/orders', '/ops/tracking'] } });
    expect((await post('role-mod')).status).toBe(403);
    session.user = owner();
    const res = await post('role-mod');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe('MODERATOR');
    expect(body.layout.groups).toEqual(['ops', 'main']);
    expect(body.layout.slots).toEqual(['/orders', '/ops/tracking']);
    expect((await post('role-foreign')).status).toBe(404);
  });
});

describe('«رجّع الأساس»', () => {
  it('— deletes HER row, groups and four with it, and answers with the base — which stays', async () => {
    addRow({ roleId: 'role-mod', layout: { order: [], hidden: [], pinned: [], groups: ['admin', 'main'], slots: ['/orders'] } });
    addRow({ userId: 'u-salwa', layout: { order: ['/orders'], hidden: [], pinned: [], groups: ['ops', 'main'], slots: ['/ops/tracking'] } });
    addRow({ userId: 'u-hana', layout: { order: [], hidden: [], pinned: [], groups: ['ops'] } });
    const body = await del();
    expect(body.reset).toBe(true);
    expect(body.resolved.groups).toEqual(['admin', 'main']);
    expect(body.resolved.slots).toEqual(['/orders']);
    expect(body.base.groups).toEqual(['admin', 'main']);
    expect(stored({ userId: 'u-salwa' })).toBeNull();
    expect(stored({ roleId: 'role-mod' })).toBeTruthy();
    expect(stored({ userId: 'u-hana' })).toBeTruthy();
  });

  it('and with no base and no row it is simply the system’s answer — nothing arranged', async () => {
    const body = await del();
    expect(body.reset).toBe(true);
    expect(body.resolved).toEqual({ order: [], hidden: [], pinned: [] });
    expect(body.base).toBeNull();
  });

  it('and it leaves the role’s base and the published views alone, whoever presses it', async () => {
    session.user = owner();
    addRow({ roleId: 'role-mod', layout: { order: [], hidden: [], pinned: [], groups: ['ops'] } });
    addRow({ roleId: 'role-mod', surface: 'view:orders', layout: { order: [], hidden: [], pinned: [], views: [{ name: 'x', query: 'y' }] } });
    addRow({ userId: 'u-owner', layout: { order: [], hidden: [], pinned: [], groups: ['main'] } });
    await del();
    expect(rows.map((r) => r.userId ?? r.roleId)).toEqual(['role-mod', 'role-mod']);
  });
});

describe('and it asks for nothing new', () => {
  const source = stripComments(readFileSync(join(process.cwd(), 'src/app/api/nav/arrangement/route.ts'), 'utf8'));

  it('— the only permission the door names is roles.edit, as before; the two newer lists have no key of their own', () => {
    const named = [...source.matchAll(/\bcan\(\s*user\s*,\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect([...new Set(named)]).toEqual(['roles.edit']);
  });

  it('and what a caller may arrange is still what THEY may open — `visibleNav` — never a list the post carries', () => {
    expect(source).toContain('visibleNav(user, can)');
    expect(source).not.toContain('menuNav');
    // every layout that goes out or in passes through the one cleaner
    expect(source.match(/cleanLayout\(/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('and a save that left a key out reads the stored row only then — a current client costs no extra query', async () => {
    const spy = vi.spyOn(TABLE, 'findFirst');
    await put({ order: [], hidden: [], pinned: [], groups: [], slots: [] });
    const readsBefore = spy.mock.calls.length;
    // the store's own existence check on save is the only read for a client that said both…
    expect(readsBefore).toBe(1);
    spy.mockClear();
    await put({ order: [], hidden: [], pinned: [] });
    // …and an older tab adds the one read of the row it has to keep.
    expect(spy.mock.calls.length).toBe(2);
    spy.mockRestore();
  });
});
