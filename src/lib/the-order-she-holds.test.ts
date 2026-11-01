import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SessionUser } from '@/types/auth';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER SHE HOLDS — THE RULE ITSELF, ASKED OF THE REAL ENGINE.
 *
 * «كموظف تأكيد ماتقدر تسحب او تعدل على طلب الا اذا كانت ظاهرة عندك كل
 * الطلبات اللي بالموقع..»
 *
 * Twenty-five route tests mock `@/lib/rbac` by name, and a mock cannot tell
 * whether a rule is right — it hands back whatever the test says. So these
 * call the REAL `rbac.ts` and the REAL `authorization.ts`, with the grants a
 * session carries (`effectiveGrants`) and only the database mocked:
 *
 *   · what the work door lets through, for every way a role can be set up;
 *   · that the three list envelopes are exactly what they were, for all of
 *     them — the rule must not widen or narrow any list;
 *   · that only the reviewed call sites use the door.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { findFirst, findUnique } = vi.hoisted(() => ({ findFirst: vi.fn(), findUnique: vi.fn() }));
vi.mock('./db', () => ({
  db: {
    order: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
  },
}));
// `authorization.ts` imports the session module for `requirePermission`; nothing here signs in.
vi.mock('./auth', () => ({ requireAuth: vi.fn() }));

const rbac = await import('./rbac');
const { ORDER_WORK_DOOR, mayEnterOrderWorkDoor } = await import('./order-work-door');
const { heldOrderWhere, orderWorkWhere, orderVisibilityWhere, orderListWhere, applyQueueFilter, assertOrderAccess, assertOrderReadable } =
  rbac;

type Scope = 'ALL_COMPANY' | 'ASSIGNED' | 'OWN' | 'CATEGORY';

/**
 * A session as `getCurrentUser` builds it: the keys, and the scope of each.
 * The role name is the same for everybody here on purpose — nothing below
 * reads it; the door is decided by keys alone.
 */
function person(grants: Record<string, Scope>, id = 'u1'): SessionUser {
  return {
    id,
    email: `${id}@x.test`,
    name: id,
    role: 'CONFIRMATION_AGENT',
    status: 'ACTIVE',
    companyId: 'c1',
    permissions: Object.keys(grants),
    effectiveGrants: {
      fullAccess: false,
      grants: Object.fromEntries(Object.entries(grants).map(([k, scope]) => [k, { scope, scopeIds: null }])),
    },
  };
}

/** The shipped «موظف التأكيد», «عرض الطلبات» unticked — the owner's case. */
const HOLDER_ONLY = person({
  'orders.edit': 'ASSIGNED',
  'orders.confirm': 'ALL_COMPANY',
  'orders.release': 'ALL_COMPANY',
  'orders.contact_log': 'ALL_COMPANY',
  'confirmation.pull': 'ALL_COMPANY',
  'confirmation.work': 'ALL_COMPANY',
});
/** «عرض الطلبات» at a scope, with «العمل على طلباتي» unless told otherwise. */
function withView(scope: Scope, work = true): SessionUser {
  const grants: Record<string, Scope> = { 'orders.view': scope, 'orders.edit': 'ASSIGNED' };
  if (work) grants['confirmation.work'] = 'ALL_COMPANY';
  return person(grants);
}
/** The moderator: his own entries, «إشكالات الإدخال» — and no pull, no work, no supervise. */
const MODERATOR = person({ 'orders.view': 'OWN', 'orders.create': 'ALL_COMPANY', 'confirmation.issues': 'ALL_COMPANY' }, 'm1');
const NOBODY = person({ 'customers.view_basic': 'ALL_COMPANY' });

const STAND = { companyId: 'c1', storeId: 's1' };

/** The claimable branch carries `lockExpiresAt: { lte: new Date() }` — the same rule a millisecond apart. */
const shape = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? '<when>' : x));

const row = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  companyId: 'c1',
  storeId: 's1',
  claimedById: null,
  assignedToId: null,
  currentOwnerId: null,
  moderatorId: null,
  createdById: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
  findUnique.mockResolvedValue(null);
});

describe('the holder rule', () => {
  it('is the order she holds — granted by «العمل على طلباتي والمؤجلة», and by nothing else', () => {
    expect(heldOrderWhere(HOLDER_ONLY)).toEqual({ claimedById: 'u1' });
    expect(heldOrderWhere(MODERATOR), 'المودريتور صار يفتح ما بين يديه').toBeNull();
    expect(heldOrderWhere(NOBODY)).toBeNull();
  });

  it('and either key lets her through the door; neither does not', () => {
    expect(mayEnterOrderWorkDoor(HOLDER_ONLY)).toBe(true);
    expect(mayEnterOrderWorkDoor(MODERATOR)).toBe(true);
    expect(mayEnterOrderWorkDoor(NOBODY)).toBe(false);
  });
});

describe('what opens through the work door, by how the role is set up', () => {
  it('«عرض الطلبات» unticked: the order she holds, and that is all', () => {
    expect(orderWorkWhere(HOLDER_ONLY)).toEqual({ claimedById: 'u1' });
  });

  it('«طلباتي المنشأة» (OWN) + work: what she entered, OR what she holds', () => {
    expect(orderWorkWhere(withView('OWN'))).toEqual({
      OR: [{ OR: [{ createdById: 'u1' }, { moderatorId: 'u1' }] }, { claimedById: 'u1' }],
    });
  });

  it('«المسندة إليه» (ASSIGNED) + work: today’s envelope unchanged — pool and all — OR what she holds', () => {
    const user = withView('ASSIGNED');
    const got = orderWorkWhere(user) as { OR: unknown[] };
    expect(got.OR).toHaveLength(2);
    expect(shape(got.OR[0])).toBe(shape(orderVisibilityWhere(user)));
    expect(got.OR[1]).toEqual({ claimedById: 'u1' });
  });

  it('«كل الشركة»: nothing but the tenant and the store, as today', () => {
    expect(orderWorkWhere(withView('ALL_COMPANY'))).toEqual({});
    expect(orderWorkWhere(withView('ALL_COMPANY', false))).toEqual({});
  });

  it('NEGATIVE: neither key — nothing', () => {
    expect(orderWorkWhere(NOBODY)).toEqual({ id: '__no_access__' });
  });

  it('NEGATIVE: the moderator is exactly where he was — his own entries, no holder branch', () => {
    expect(orderWorkWhere(MODERATOR)).toEqual(orderVisibilityWhere(MODERATOR));
    expect(orderWorkWhere(MODERATOR)).toEqual({ OR: [{ createdById: 'm1' }, { moderatorId: 'm1' }] });
  });

  it('NEGATIVE: a scope orders do not have opens nothing — only the held order, when she has the key', () => {
    expect(orderWorkWhere(withView('CATEGORY', false))).toEqual({ id: '__no_access__' });
    expect(orderWorkWhere(withView('CATEGORY'))).toEqual({ claimedById: 'u1' });
  });
});

describe('the read through the door — one query, the id AND the door’s envelope', () => {
  it('asks for this id in this company and this store, AND the work envelope', async () => {
    findFirst.mockResolvedValue(row({ claimedById: 'u1' }));
    const got = await assertOrderReadable('o1', HOLDER_ONLY, STAND, ORDER_WORK_DOOR);
    expect(got.allowed).toBe(true);
    const where = findFirst.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ id: 'o1', companyId: 'c1', storeId: 's1' });
    expect(where.AND[1]).toEqual({ claimedById: 'u1' });
  });

  it('and «not found» — not «forbidden» — when the query brings nothing back', async () => {
    const got = await assertOrderReadable('o9', HOLDER_ONLY, STAND, ORDER_WORK_DOOR);
    expect(got).toEqual({ allowed: false, reason: 'NOT_FOUND' });
  });

  it('NEGATIVE: neither key is refused before the database is asked', async () => {
    await expect(assertOrderReadable('o1', NOBODY, STAND, ORDER_WORK_DOOR)).rejects.toThrow(
      'Forbidden: missing required permission orders.view'
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('and the old door is the old door: «orders.view» still means «orders.view»', async () => {
    await expect(assertOrderReadable('o1', HOLDER_ONLY, STAND, 'orders.view')).rejects.toThrow(
      'Forbidden: missing required permission orders.view'
    );
    findFirst.mockResolvedValue(row());
    await assertOrderReadable('o1', withView('ASSIGNED'), STAND, 'orders.view');
    expect(shape(findFirst.mock.calls[0][0].where.AND[1])).toBe(shape(orderVisibilityWhere(withView('ASSIGNED'))));
  });
});

describe('the write through the door', () => {
  const verdict = async (user: SessionUser, over: Record<string, unknown>) => {
    findUnique.mockResolvedValue(row(over));
    return assertOrderAccess('o1', user, STAND, ORDER_WORK_DOOR);
  };

  it('opens the order she holds, in the store she stands in', async () => {
    expect((await verdict(HOLDER_ONLY, { claimedById: 'u1' })).allowed).toBe(true);
  });

  it('NEGATIVE: a colleague’s order is not hers to write', async () => {
    expect(await verdict(HOLDER_ONLY, { claimedById: 'u2' })).toEqual({ allowed: false, reason: 'NOT_ASSIGNED' });
  });

  it('NEGATIVE: and neither is one transferred away from her — the stale assignment is not a holder', async () => {
    // A transfer wrote `assignedToId: u1` once; a release and a colleague's pull left it there.
    expect(await verdict(HOLDER_ONLY, { claimedById: 'u2', assignedToId: 'u1' })).toEqual({
      allowed: false,
      reason: 'NOT_ASSIGNED',
    });
  });

  it('NEGATIVE: nor an order of the pool she has not pulled', async () => {
    expect(await verdict(HOLDER_ONLY, { claimedById: null })).toEqual({ allowed: false, reason: 'NOT_ASSIGNED' });
  });

  it('NEGATIVE: an order she holds in ANOTHER store is not found while she stands in this one', async () => {
    expect(await verdict(HOLDER_ONLY, { claimedById: 'u1', storeId: 's2' })).toEqual({
      allowed: false,
      reason: 'NOT_FOUND',
    });
    expect(await verdict(HOLDER_ONLY, { claimedById: 'u1', companyId: 'c2' })).toEqual({
      allowed: false,
      reason: 'WRONG_COMPANY',
    });
  });

  it('OWN + work: what she holds, and the moderator rule for the rest — exactly as before', async () => {
    const own = withView('OWN');
    expect((await verdict(own, { claimedById: 'u1' })).allowed).toBe(true);
    expect((await verdict(own, { moderatorId: 'u1', claimedById: 'u2' })).allowed).toBe(true);
    expect((await verdict(own, { createdById: 'u1', claimedById: 'u2' })).allowed).toBe(false);
  });

  it('ASSIGNED + work: today’s four fields, unchanged', async () => {
    const assigned = withView('ASSIGNED');
    for (const field of ['assignedToId', 'claimedById', 'currentOwnerId', 'moderatorId']) {
      expect((await verdict(assigned, { [field]: 'u1' })).allowed, field).toBe(true);
    }
    expect((await verdict(assigned, { claimedById: 'u2' })).allowed).toBe(false);
  });

  it('ALL_COMPANY: any order of the store', async () => {
    expect((await verdict(withView('ALL_COMPANY', false), { claimedById: 'u2' })).allowed).toBe(true);
  });

  it('NEGATIVE: the moderator does not gain the order he holds — he has no `confirmation.work`', async () => {
    expect(await verdict(MODERATOR, { claimedById: 'm1' })).toEqual({ allowed: false, reason: 'NOT_ASSIGNED' });
    expect((await verdict(MODERATOR, { moderatorId: 'm1' })).allowed).toBe(true);
  });

  it('NEGATIVE: a scope orders do not have is refused here — this door does not fall through to «allowed»', async () => {
    expect(await verdict(withView('CATEGORY', false), { claimedById: 'u2' })).toEqual({
      allowed: false,
      reason: 'NOT_ASSIGNED',
    });
  });

  it('NEGATIVE: neither key — refused before the order is read', async () => {
    await expect(assertOrderAccess('o1', NOBODY, STAND, ORDER_WORK_DOOR)).rejects.toThrow(
      'Forbidden: missing required permission orders.view'
    );
    expect(findUnique).not.toHaveBeenCalled();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AND NOT ONE LIST MOVED.
 *
 * The three envelopes, written out as they are today, for every way a role
 * can be set up — including the one this change exists for. The holder rule
 * lives beside them and none of them asks it: «طلباتي» lists her orders by
 * its own query, and nothing else may list them for her.
 * ═══════════════════════════════════════════════════════════════════════
 */
const ASSIGNED_READ = {
  OR: [
    { assignedToId: 'u1' },
    { claimedById: 'u1' },
    { currentOwnerId: 'u1' },
    { createdById: 'u1' },
    { moderatorId: 'u1' },
    {
      claimedById: null,
      signatureStatus: 'UNSIGNED',
      confirmationStatus: 'NEW',
      OR: [{ lockedById: null }, { lockExpiresAt: null }, { lockExpiresAt: { lte: expect.any(Date) } }],
    },
  ],
};
/**
 * THE ONE CLAUSE THAT WAS ADDED (31/10): an order held for a colleague who worked the customer last — seen, never taken
 * (order-reservation.ts). It names an agent and a time, so it is not the pool; the pool is still not in the list.
 */
const HELD_FOR_A_COLLEAGUE = {
  claimedById: null,
  confirmationStatus: 'NEW',
  assignedToId: { not: null },
  assignedAt: { gt: expect.any(Date) },
  assignee: { is: { status: 'ACTIVE' } },
  claimHistory: { none: {} },
};
const ASSIGNED_LIST = {
  OR: [
    { assignedToId: 'u1' }, { claimedById: 'u1' }, { currentOwnerId: 'u1' }, { createdById: 'u1' }, { moderatorId: 'u1' },
    HELD_FOR_A_COLLEAGUE,
  ],
};
const OWN = { OR: [{ createdById: 'u1' }, { moderatorId: 'u1' }] };
const NONE = { id: '__no_access__' };
const CLAIMABLE = { claimedById: null, signatureStatus: 'UNSIGNED' };

describe.each([
  ['«كل الشركة»', withView('ALL_COMPANY'), {}, {}],
  ['«المسندة إليه»', withView('ASSIGNED'), ASSIGNED_READ, ASSIGNED_LIST],
  ['«طلباتي المنشأة»', withView('OWN'), OWN, OWN],
  ['no «عرض الطلبات» and no work', NOBODY, NONE, NONE],
  ['«عرض الطلبات» unticked, «العمل على طلباتي» ticked — this change’s own case', HOLDER_ONLY, NONE, NONE],
])('the lists are what they were — %s', (_name, user, read, list) => {
  const base = { companyId: 'c1', storeId: 's1' };

  it('the read envelope', () => {
    expect(orderVisibilityWhere(user)).toEqual(read);
  });

  it('the list envelope', () => {
    expect(orderListWhere(user)).toEqual(list);
  });

  it('the default queue — what «الطلبات» lists', () => {
    const got = applyQueueFilter(user, { ...base }, null);
    expect(got).toEqual(Object.keys(list).length === 0 ? base : { AND: [base, list] });
  });

  it('`?queue=available` — the pool, for exactly whom it was before', () => {
    const got = applyQueueFilter(user, { ...base }, 'available');
    const scope = (user.effectiveGrants?.grants['orders.view']?.scope ?? null) as Scope | null;
    if (scope === 'ALL_COMPANY') expect(got).toEqual({ ...base, AND: [CLAIMABLE] });
    else if (scope === 'ASSIGNED') expect(got).toEqual({ ...base, AND: [CLAIMABLE, { confirmationStatus: 'NEW' }] });
    else expect(got).toEqual({ ...base, id: '__no_access__' });
  });

  it('`?queue=all_company` — company-wide only', () => {
    const got = applyQueueFilter(user, { ...base }, 'all_company');
    const scope = user.effectiveGrants?.grants['orders.view']?.scope;
    expect(got).toEqual(scope === 'ALL_COMPANY' ? base : { ...base, id: '__no_access__' });
  });

  it('and the three narrowing queues are the bare fields they always were', () => {
    expect(applyQueueFilter(user, { ...base }, 'assigned_to_me')).toEqual({ ...base, assignedToId: 'u1' });
    expect(applyQueueFilter(user, { ...base }, 'my_orders')).toEqual({ ...base, claimedById: 'u1' });
    expect(applyQueueFilter(user, { ...base }, 'processing')).toEqual({ ...base, currentOwnerId: 'u1' });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHO MAY USE THE DOOR — A CLOSED LIST.
 *
 * Every handler that passes `ORDER_WORK_DOOR`, asks `orderWorkWhere` or
 * `mayEnterOrderWorkDoor`, by file and by method. These are the calls the
 * confirmation screens make for an order she holds: the order window, its
 * history, notes, calls, lock and edit, the decision, giving it back, a
 * change request from «أكّدتها», an entry issue, the return-risk card, the
 * assistant and the customer's history.
 *
 * A new door on this list is a review, not a line: it widens who may write
 * that door to everyone holding `confirmation.work`, on the orders they hold.
 * Shipping, delivery attempts, finance, transfer and every list stay off it.
 * ═══════════════════════════════════════════════════════════════════════
 */
const ALLOWED: Record<string, string[]> = {
  'src/app/api/orders/[id]/route.ts': ['GET', 'PATCH'],
  'src/app/api/orders/[id]/timeline/route.ts': ['GET'],
  'src/app/api/orders/[id]/notes/route.ts': ['GET', 'POST'],
  'src/app/api/orders/[id]/contact-attempts/route.ts': ['GET', 'POST'],
  'src/app/api/orders/[id]/lock/route.ts': ['POST'],
  'src/app/api/orders/[id]/confirmation/route.ts': ['POST'],
  'src/app/api/orders/[id]/claim/route.ts': ['DELETE'],
  'src/app/api/orders/[id]/change-requests/route.ts': ['POST'],
  // The preview of a multi-field edit: a pure read over the SAME door as the raise route above (same key, same 404).
  'src/app/api/orders/[id]/change-requests/preview/route.ts': ['POST'],
  'src/app/api/orders/[id]/shape-risk/route.ts': ['GET'],
  // The repeat-order notice in the same window, over the same envelope as shape-risk: requireContext + assertOrderReadable,
  // then one read of this company's history for this order. It answers with order NUMBERS only (no ids, names or phones).
  'src/app/api/orders/[id]/duplicate-suspect/route.ts': ['GET'],
  'src/app/api/confirmation/issues/route.ts': ['POST'],
  'src/app/api/customers/[id]/history/route.ts': ['GET'],
  'src/app/api/ai/confirmation/route.ts': ['POST'],
};

/** Where the door is defined — not callers of it. */
const HOME = ['src/lib/rbac.ts', 'src/lib/order-work-door.ts'];
// The literal too: a door written by its string instead of the constant is still a door.
const USES = /\bORDER_WORK_DOOR\b|\borderWorkWhere\s*\(|\bmayEnterOrderWorkDoor\s*\(|\bheldOrderWhere\s*\(|door:the-order-she-holds/;

const root = process.cwd();
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(join(root, 'src'));
  return out;
}

/** file → the handlers in it that use the door (a non-route file answers its own name). */
function doorUsers(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of sourceFiles()) {
    if (HOME.includes(file)) continue;
    const src = stripComments(readFileSync(join(root, file), 'utf8'));
    if (!USES.test(src)) continue;
    const marks = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
    const methods = marks
      .filter((m, i) => USES.test(src.slice(m.index!, marks[i + 1]?.index ?? src.length)))
      .map((m) => m[1]);
    found[file] = methods.length > 0 ? methods.sort() : ['(outside a handler)'];
  }
  return found;
}

describe('the door has a closed list of callers', () => {
  const found = doorUsers();

  it('and nothing uses it that was not reviewed — nor misses a door that was', () => {
    const want = Object.fromEntries(Object.entries(ALLOWED).map(([f, m]) => [f, [...m].sort()]));
    expect(found, 'بابُ الطلب الذي بين يديها صار يُستعمل في مكانٍ لم يُراجَع، أو غاب عن بابٍ رُوجع').toEqual(want);
  });

  it('and the lists, shipping, delivery, money and transfer are not on it', () => {
    for (const f of [
      'src/app/api/orders/route.ts',
      'src/app/api/reports/export/route.ts',
      'src/app/api/orders/[id]/shipping/route.ts',
      'src/app/api/orders/[id]/delivery-attempts/route.ts',
      'src/app/api/orders/[id]/finance/route.ts',
      'src/app/api/orders/[id]/transfer/route.ts',
      'src/app/api/orders/[id]/call-logs/route.ts',
      'src/app/api/confirmation/pull/route.ts',
    ]) {
      expect(found[f], f).toBeUndefined();
    }
  });

  it('and the order’s own file uses it at its two access calls and nowhere else', () => {
    const src = stripComments(readFileSync(join(root, 'src/app/api/orders/[id]/route.ts'), 'utf8'));
    expect(src.match(/\bORDER_WORK_DOOR\b/g)?.length, 'الاستيراد + القراءة + التعديل').toBe(3);
    expect(src).toMatch(/assertOrderAccess\(id, user, \{ companyId, storeId \}, ORDER_WORK_DOOR\)/);
  });
});
