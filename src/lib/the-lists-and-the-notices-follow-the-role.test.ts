import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «قوائم الطلبات حسب الدور» (the owner, 2/11)
 *
 *   «بنات التأكيد يظهرلها بخانة الطلبات الطلبات الي سحبتها فقط»
 *   «بنات المودريتور يظهرلها بخانة الطلبات الطلبات الي سجلتها فقط»
 *
 *   1. On «المسندة إليه» an agent's «الطلبات» drops the orders held for a colleague; the read envelope keeps the pool, so a
 *      pull still opens the order it gives her.
 *   2. On «طلباتي المنشأة» the write doors accept the order he TYPED (`createdById`), not only the one he is the moderator of —
 *      the list and the sheet already did, so an order in his list answered «غير موجود» to his edit.
 *   3. A create / confirm / reject / cancel notice goes only to the people the order opens for: no link that says «غير موجود».
 *   4. Nothing changes for anybody until the owner ticks the scopes on the roles screen: today's live agents are «كل الشركة».
 *
 * NOTHING ABOUT PERMISSIONS IS MOCKED HERE. Each person is built the way a session is — keys and scopes turned into
 * `effectiveGrants` by `computeEffectiveGrants` and attached by `attachGrants` — and the REAL `can`, `authorize`,
 * `orderListWhere`, `assertOrderAccess` and `createNotification` answer (measure-live-keys-before-trusting-a-permission-rule).
 * The key list is the live CONFIRMATION_AGENT role as `GET /api/roles` returned it on 1/11 — the same list
 * `the-live-agent-is-refused-by-the-real-engine.test.ts` holds — with `orders.view` set to the scope the owner is asked to tick.
 * Only the database is a fake: it answers a `where` by evaluating it against rows, with SQL's three values.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  rows: [] as Record<string, any>[],
  notices: [] as Record<string, any>[],
  findFirst: 0,
}));

vi.mock('./db', () => ({
  db: {
    order: {
      findFirst: async ({ where }: { where: Row }) => {
        h.findFirst++;
        return h.rows.find((r) => matches(r, where)) ?? null;
      },
      findUnique: async ({ where }: { where: Row }) => h.rows.find((r) => r.id === where.id) ?? null,
    },
    notification: {
      createMany: async ({ data }: { data: Row[] }) => {
        h.notices.push(...data);
        return { count: data.length };
      },
    },
  },
}));

type Tri = true | false | null;
const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
function tri(row: Row, where: Row): Tri {
  if (Object.keys(where).length === 0) return true;
  return and(
    Object.entries(where).map(([key, cond]): Tri => {
      if (key === 'AND') return and((cond as Row[]).map((w) => tri(row, w)));
      if (key === 'OR') return or((cond as Row[]).map((w) => tri(row, w)));
      const value = row[key] ?? null;
      if (cond === null) return value === null;
      if (typeof cond !== 'object') return value === null ? null : value === cond;
      return and(
        Object.entries(cond as Row).map(([op, arg]): Tri => {
          switch (op) {
            case 'not':
              if (arg === null) return value !== null;
              return value === null ? null : value !== arg;
            case 'gt': return value === null ? null : (value as Date).getTime() > (arg as Date).getTime();
            case 'lte': return value === null ? null : (value as Date).getTime() <= (arg as Date).getTime();
            case 'is':
              if (arg === null) return value === null;
              return value === null ? null : tri(value as Row, arg as Row);
            case 'none': return !(row[key] ?? []).some((c: Row) => tri(c, arg as Row) === true);
            default: throw new Error(`the evaluator does not know «${op}»`);
          }
        })
      );
    })
  );
}
function matches(row: Row, where: Row): boolean {
  return tri(row, where) === true;
}

import { attachGrants, authorize, can } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { applyQueueFilter, assertOrderAccess, orderListWhere, orderVisibilityWhere, whoMayOpenOrder } from './rbac';
import { ORDER_WORK_DOOR } from './order-work-door';
import { createNotification } from './notification';
import fs from 'node:fs';
import path from 'node:path';

/** CONFIRMATION_AGENT, live, 1/11: all 22 keys, every one at the whole company — `orders.view` is the one the owner re-ticks. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** MODERATOR: the stock template's order keys. `orders.view` is OWN since migration 20261014140000 (only where untouched). */
const MODERATOR = ['orders.view', 'orders.create', 'orders.edit', 'orders.note', 'orders.confirm', 'orders.contact_log'];
/** FOLLOW_UP_AGENT, live 1/11: supervise without orders.view — the notice used to reach her too. */
const FOLLOW_UP = ['confirmation.supervise'];

async function person(id: string, keys: string[], scopes: Record<string, string> = {}, fullAccess = false): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role: fullAccess ? 'SUPER_ADMIN' : 'CUSTOM', roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  if (fullAccess) return attachGrants(base, { fullAccess: true, grants: {} } as never);
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: scopes[k] ?? 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}
const agent = (id: string, view = 'ASSIGNED') => person(id, LIVE_AGENT, { 'orders.view': view });
const moderator = (id: string) => person(id, MODERATOR, { 'orders.view': 'OWN', 'orders.edit': 'OWN' });

const hoursAgo = (hrs: number) => new Date(Date.now() - hrs * 3_600_000);
const order = (id: string, over: Row = {}): Row => ({
  id, companyId: 'c1', storeId: 's1',
  claimedById: null, createdById: null, currentOwnerId: null, moderatorId: null, assignedToId: null, assignedAt: null,
  confirmationStatus: 'NEW', signatureStatus: 'UNSIGNED', lockedById: null, lockExpiresAt: null, assignee: null, claimHistory: [],
  ...over,
});
const heldForSara = order('held-sara', { assignedToId: 'sara', assignedAt: hoursAgo(1), assignee: { status: 'ACTIVE' } });
const pulledByHuda = order('pulled-huda', { claimedById: 'huda', currentOwnerId: 'huda', signatureStatus: 'SIGNED', confirmationStatus: 'IN_PROGRESS' });
const confirmedBySara = order('confirmed-sara', { claimedById: 'sara', currentOwnerId: 'sara', signatureStatus: 'SIGNED', confirmationStatus: 'CONFIRMED' });
const pool = order('pool');

const listed = (u: SessionUser, row: Row) => matches(row, applyQueueFilter(u, {}, null));

beforeEach(() => {
  h.rows = [];
  h.notices = [];
  h.findFirst = 0;
});

describe('1 — «المسندة إليه»: an agent’s «الطلبات» is what she pulled, with the live keys and the real engine', () => {
  it('Huda sees the order she pulled, and not the one held for Sara, nor the pool, nor what Sara confirmed', async () => {
    const huda = await agent('huda');
    expect(listed(huda, pulledByHuda)).toBe(true);
    expect(listed(huda, heldForSara), 'طلب محجوز لسارة بقائمة هدى').toBe(false);
    expect(listed(huda, pool), 'الطابور بقائمتها').toBe(false);
    expect(listed(huda, confirmedBySara)).toBe(false);
  });

  it('…and the pull still opens: the READ envelope keeps the pool (narrowing it would 404 every pull)', async () => {
    const huda = await agent('huda');
    expect(matches(pool, orderVisibilityWhere(huda)), 'السحب بينكسر').toBe(true);
    expect(matches(heldForSara, orderVisibilityWhere(huda))).toBe(true);
  });

  it('TODAY nothing moves: the live agents are «كل الشركة», and their list is the whole store until the owner ticks the scope', async () => {
    const huda = await agent('huda', 'ALL_COMPANY');
    expect(orderListWhere(huda)).toEqual({});
    for (const row of [pulledByHuda, heldForSara, pool, confirmedBySara]) expect(listed(huda, row)).toBe(true);
  });
});

describe('2 — «طلباتي المنشأة»: the write doors accept the order he typed', () => {
  // He holds «إسناد الطلبات» elsewhere, so he named nobody: `moderatorId` null, `createdById` him (responsible-moderator.ts).
  const typedByMona = order('typed-mona', { createdById: 'mona', moderatorId: null, confirmationStatus: 'IN_PROGRESS' });
  const legacyMona = order('legacy-mona', { createdById: null, moderatorId: 'mona' });
  const typedByOther = order('typed-other', { createdById: 'other', moderatorId: null });

  it('`authorize` (the key’s own scope) lets her edit what she typed, what she is the moderator of, and nothing else', async () => {
    const mona = await moderator('mona');
    expect(authorize(mona, 'orders.edit', typedByMona).allowed, 'كتبته وما بتقدر تعدّله').toBe(true);
    expect(authorize(mona, 'orders.edit', legacyMona).allowed).toBe(true);
    expect(authorize(mona, 'orders.edit', typedByOther).allowed).toBe(false);
  });

  it('the work door (every write on the order sheet) opens what she typed — it answered «غير موجود» before', async () => {
    const mona = await moderator('mona');
    h.rows = [typedByMona, legacyMona, typedByOther];
    const at = { companyId: 'c1', storeId: 's1' };
    expect((await assertOrderAccess('typed-mona', mona, at, ORDER_WORK_DOOR)).allowed).toBe(true);
    expect((await assertOrderAccess('legacy-mona', mona, at, ORDER_WORK_DOOR)).allowed).toBe(true);
    expect((await assertOrderAccess('typed-other', mona, at, ORDER_WORK_DOOR)).allowed).toBe(false);
  });

  it('…and the older door (shipping, delivery attempts, transfer, finance) the same', async () => {
    const mona = await moderator('mona');
    h.rows = [typedByMona, typedByOther];
    const at = { companyId: 'c1', storeId: 's1' };
    expect((await assertOrderAccess('typed-mona', mona, at, 'orders.view')).allowed).toBe(true);
    expect((await assertOrderAccess('typed-other', mona, at, 'orders.view')).allowed).toBe(false);
  });

  it('…and the list and the read agree with the doors: the same three rows, the same answers', async () => {
    const mona = await moderator('mona');
    expect([typedByMona, legacyMona, typedByOther].map((r) => listed(mona, r))).toEqual([true, true, false]);
    expect([typedByMona, legacyMona, typedByOther].map((r) => matches(r, orderVisibilityWhere(mona)))).toEqual([true, true, false]);
  });

  it('an empty record is nobody’s: an order nobody typed (a storefront one) is not hers because her id is not null', async () => {
    const mona = await moderator('mona');
    expect(authorize(mona, 'orders.edit', order('storefront')).allowed).toBe(false);
  });
});

describe('3 — a notice about an order goes only to the people it opens for', () => {
  it('a confirmation by Sara: the owner and the moderator are told; Huda (live keys, «المسندة إليه») and the follow-up are not', async () => {
    const owner = await person('owner', [], {}, true);
    const huda = await agent('huda');
    const mona = await moderator('mona');
    const follow = await person('follow', FOLLOW_UP);
    // The live agents all hold `confirmation.supervise`, so the old audience named all of them.
    expect(can(huda, 'confirmation.supervise')).toBe(true);
    h.rows = [{ ...confirmedBySara, moderatorId: 'mona' }];

    const count = await createNotification({
      companyId: 'c1',
      storeId: 's1',
      audience: { permission: 'confirmation.supervise' },
      recipients: [owner, huda, mona, follow],
      title: 'تأكيد طلب',
      message: '…',
      link: '/orders?highlight=confirmed-sara',
      orderId: 'confirmed-sara',
    });
    expect(h.notices.map((n) => n.userId).sort()).toEqual(['mona', 'owner']);
    expect(count).toBe(2);
  });

  it('the agent who holds it is told; and with «كل الشركة» (today) everybody still is — no query asked for them', async () => {
    const sara = await agent('sara');
    const hudaToday = await agent('huda', 'ALL_COMPANY');
    h.rows = [confirmedBySara];
    expect((await whoMayOpenOrder([sara, hudaToday], { id: 'confirmed-sara', companyId: 'c1', storeId: 's1' })).map((u) => u.id)).toEqual(['sara', 'huda']);
    expect(h.findFirst, 'سؤال قاعدة بيانات لصاحبة «كل الشركة»').toBe(1);
  });

  it('a new order in the pool opens for every agent — the creation notice reaches them; an entry its writer kept does not', async () => {
    const huda = await agent('huda');
    const sara = await agent('sara');
    h.rows = [pool, order('kept', { claimedById: 'sara', currentOwnerId: 'sara', createdById: 'sara', signatureStatus: 'SIGNED' })];
    expect((await whoMayOpenOrder([huda, sara], { id: 'pool', companyId: 'c1', storeId: 's1' })).map((u) => u.id)).toEqual(['huda', 'sara']);
    expect((await whoMayOpenOrder([huda, sara], { id: 'kept', companyId: 'c1', storeId: 's1' })).map((u) => u.id)).toEqual(['sara']);
  });

  it('another store’s order with the same id opens for nobody below «كل الشركة»', async () => {
    const sara = await agent('sara');
    h.rows = [{ ...confirmedBySara, storeId: 's2' }];
    expect(await whoMayOpenOrder([sara], { id: 'confirmed-sara', companyId: 'c1', storeId: 's1' })).toEqual([]);
  });

  it('without an order named, nothing is filtered — every other notice is as it was', async () => {
    const huda = await agent('huda');
    await createNotification({ companyId: 'c1', storeId: 's1', audience: {}, recipients: [huda], title: 't', message: 'm' });
    expect(h.notices.map((n) => n.userId)).toEqual(['huda']);
    expect(h.findFirst).toBe(0);
  });
});

describe('4 — every door that announces a new order or a decision names the order, so the filter above is asked', () => {
  /*
   * A wire test, by design: the filter is proven above, and what is left to prove is that each door hands it the order. One
   * door forgotten is a dead link in some agent's bell. Read across the whole of src, so a door added later is held too.
   */
  const root = path.join(process.cwd(), 'src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(root);

  /** Every `notify({ … })` / `createNotification({ … })` call, as text, by matching its braces. */
  function calls(src: string): string[] {
    const out: string[] = [];
    const re = /\b(?:notify|createNotification)\(\{/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      let depth = 0;
      for (let i = m.index + m[0].length - 1; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) {
          out.push(src.slice(m.index, i + 1));
          break;
        }
      }
    }
    return out;
  }
  const aboutAnOrder = (call: string) => /type: 'ORDER_NEW'|'تأكيد طلب'|'رفض طلب'|'إلغاء طلب'/.test(call);

  const found = files.flatMap((f) =>
    calls(fs.readFileSync(f, 'utf8'))
      .filter(aboutAnOrder)
      .map((call) => ({ file: path.relative(root, f).split(path.sep).join('/'), call }))
  );

  it('finds the ten it is about — five creation doors and five decision doors', () => {
    expect(found.map((c) => c.file).sort()).toEqual(
      [
        'app/api/orders/[id]/confirmation/route.ts',
        // The landing confirmation chat's confirm and cancel (contract oms-lp.v1 §8): the agent's two notices.
        'lib/v1/landing-chat.ts',
        'lib/v1/landing-chat.ts',
        'app/api/orders/[id]/route.ts',
        'app/api/orders/[id]/route.ts',
        'app/api/orders/ai-intake/route.ts',
        'app/api/orders/route.ts',
        'lib/public-order.ts',
        'lib/telegram/order-creation.ts',
        'lib/v1/order-intake.ts',
      ].sort()
    );
  });

  it('and every one of them passes `orderId`', () => {
    const blind = found.filter((c) => !/\borderId: /.test(c.call)).map((c) => c.file);
    expect(blind, 'إشعار عن طلب ما بيسمّي الطلب — بيوصل لمين ما بيقدر يفتحه').toEqual([]);
  });
});
