import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HOLDER DECIDES HER OWN CONFIRMED ORDER — UNTIL IT ENTERS A BATCH (the owner, 2/11).
 *
 * «بدي التعديل التأجيل أو الالغاء … أضيفهم كصلاحية انو يقدرو يعدلو ع الطلب لغاية مرحلة الشحنة. مجرد ما الشحنة اتوزعت ع شركة شحن
 * ودخلت باتش ما بقدرو يعدلو، بصير يقدمو طلب تعديل. حلها بدون تعارض او مشاكل.»
 *
 * THE TABLE IS ON THE REAL ENGINE. Nothing about permissions is mocked: each person is built the way a session is — keys turned
 * into `effectiveGrants` by `computeEffectiveGrants` and attached by `attachGrants` — and the REAL `mayDecide`, `holdsTheWindow`
 * and `mayApply` answer for them. The key lists are the live ones: the CONFIRMATION_AGENT role (22 keys, `GET /api/roles`, 1/11)
 * plus the one key the owner ticks for her on «الصلاحيات» (no migration and no fallback grants it).
 *
 * WHAT THIS FILE HOLDS, IN ORDER:
 *   Ⅰ the rule, row by row — each condition has the row that breaks it;
 *   Ⅱ the money rule, unchanged: a request that moves a figure also needs `orders.change_price`;
 *   Ⅲ it ADDS a decider and removes none — every other person's verdict is the one they always had, with no `via`;
 *   Ⅳ the self-decision and the apply step read ONE predicate: for every person on every order, they agree;
 *   Ⅴ a caller that does not say whether the order is in a batch denies.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { deciderFor, holdsTheWindow, mayDecide, type RoutingSource } from './change-request-routing';
import { mayApply } from './change-request-apply';

/** CONFIRMATION_AGENT, live, 1/11: all 22 keys, every one at the whole company. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** …and what she holds once the owner ticks the box for her role. */
const WITH_KEY = [...LIVE_AGENT, 'orders.edit_confirmed'];
const NO_PRICE = WITH_KEY.filter((k) => k !== 'orders.change_price');
const SUPERVISOR = ['orders.view', 'confirmation.work', 'orders.request_change', 'control.change_requests', 'control.change_requests_view', 'orders.change_price'];
const WAREHOUSE_HAND = ['orders.view', 'ops.decide_changes', 'ops.ship', 'orders.change_price'];

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const SALMA = 'salma';
const mine = (over: Partial<RoutingSource> = {}): RoutingSource => ({
  confirmationStatus: 'CONFIRMED',
  claimedById: SALMA,
  handedToCourier: false,
  inBatch: false,
  ...over,
});

/** Where the parcel is, in the six places that matter. */
const HERS = mine();
const NOT_HERS = mine({ claimedById: 'someone-else' });
const NOBODYS = mine({ claimedById: null });
const ON_A_TROLLEY = mine({ inBatch: true }); // READY, the courier has not taken it: the packing table's
const PRESSED = mine({ inBatch: true, handedToCourier: true }); // «سُلّمت للشركة»
const SHIPPED_BY_HAND = mine({ inBatch: false, handedToCourier: true }); // no trolley at all, and gone
const SILENT: RoutingSource = { confirmationStatus: 'CONFIRMED', claimedById: SALMA }; // a caller that was never taught the facts

const ORDERS: Array<[string, RoutingSource]> = [
  ['hers, in no batch', HERS],
  ['a colleague’s', NOT_HERS],
  ['nobody’s', NOBODYS],
  ['hers, on a trolley', ON_A_TROLLEY],
  ['hers, pressed (with the courier)', PRESSED],
  ['hers, shipped by hand (no trolley)', SHIPPED_BY_HAND],
  ['hers, caller silent', SILENT],
];

describe('Ⅰ · the rule — the holder, with the key, on a confirmed order in no batch', () => {
  it('lets her decide it, says which rule, and names her as the decider', async () => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    const v = mayDecide(salma, HERS);
    expect(v.allowed).toBe(true);
    expect(v.via).toBe('EDIT_CONFIRMED');
    expect(v.decider).toEqual({ kind: 'HOLDING_AGENT', userId: SALMA });
    expect(holdsTheWindow(salma, HERS)).toBe(true);
  });

  it('NEGATIVE: the SAME order without the key ⇒ not hers to decide (the live role as it was on 1/11)', async () => {
    const before = await person(SALMA, 'CONFIRMATION_AGENT', LIVE_AGENT);
    const v = mayDecide(before, HERS);
    expect(v.allowed).toBe(false);
    expect(v.via).toBeUndefined();
    expect(holdsTheWindow(before, HERS)).toBe(false);
  });

  it.each([
    ['a colleague’s order', NOT_HERS],
    ['an order nobody holds', NOBODYS],
  ])('NEGATIVE: %s ⇒ she waits for a decision, exactly as before', async (_name, order) => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    const v = mayDecide(salma, order);
    expect(v.allowed).toBe(false);
    expect(v.via).toBeUndefined();
    expect(v.reason).toContain('المستودع');
  });

  it('NEGATIVE: on a trolley that is still being filled (READY, not handed) ⇒ the packing table’s, not hers', async () => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    const v = mayDecide(salma, ON_A_TROLLEY);
    expect(v.allowed).toBe(false);
    expect(v.decider).toEqual({ kind: 'WAREHOUSE' });
    expect(v.reason).toContain('المستودع');
  });

  it.each([
    ['pressed — «سُلّمت للشركة»', PRESSED],
    ['shipped by hand, in no batch', SHIPPED_BY_HAND],
  ])('NEGATIVE: with the courier (%s) ⇒ the supervisor alone', async (_name, order) => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    const v = mayDecide(salma, order);
    expect(v.allowed).toBe(false);
    expect(v.decider).toEqual({ kind: 'SUPERVISOR' });
    expect(v.reason).toContain('شركة الشحن');
  });

  it.each(['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'])(
    'BEFORE confirmation (%s) the holding agent decides as she always did — with no «via», the window is not what let her',
    async (confirmationStatus) => {
      const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
      const v = mayDecide(salma, { confirmationStatus, claimedById: SALMA });
      expect(v.allowed).toBe(true);
      expect(v.via).toBeUndefined();
    }
  );

  it.each(['REJECTED', 'CANCELLED'])('NEGATIVE: an order that has ended (%s) is nobody’s window', async (confirmationStatus) => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    expect(mayDecide(salma, mine({ confirmationStatus })).allowed).toBe(false);
    expect(holdsTheWindow(salma, mine({ confirmationStatus }))).toBe(false);
  });
});

describe('Ⅱ · the money rule, exactly as it was: a request that moves a figure also needs orders.change_price', () => {
  it('with the price key ⇒ she decides a price, a discount, a quantity or a product too', async () => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    expect(mayDecide(salma, HERS, { money: true })).toMatchObject({ allowed: true, via: 'EDIT_CONFIRMED' });
  });

  it('NEGATIVE: without it ⇒ refused for the price key, in its own words — the figure waits for somebody who holds it', async () => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', NO_PRICE);
    const v = mayDecide(salma, HERS, { money: true });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('PRICE_KEY_REQUIRED');
    expect(v.reason).toContain('صلاحية تغيير السعر');
    // …and the same person decides a request that moves no figure.
    expect(mayDecide(salma, HERS, { money: false })).toMatchObject({ allowed: true, via: 'EDIT_CONFIRMED' });
  });

  it('NEGATIVE: the price key without the window key decides nothing on its own', async () => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', LIVE_AGENT);
    expect(mayDecide(salma, HERS, { money: true }).allowed).toBe(false);
  });
});

describe('Ⅲ · it ADDS a decider and removes none — every other person’s verdict is the one they always had', () => {
  it('a supervisor decides every order, whatever the window says, with no «via» (also when she holds the key)', async () => {
    for (const keys of [SUPERVISOR, [...SUPERVISOR, 'orders.edit_confirmed']]) {
      const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', keys);
      for (const [name, order] of ORDERS) {
        const v = mayDecide(sup, order);
        expect(v.allowed, name).toBe(true);
        expect(v.via, name).toBeUndefined();
        expect(v.decider, name).toEqual(deciderFor(order));
      }
    }
  });

  it('the packing table decides a confirmed order the courier has not taken, with no «via»; not one that left', async () => {
    const hand = await person('hand', 'WAREHOUSE', WAREHOUSE_HAND);
    for (const [name, order] of [['hers', HERS], ['on a trolley', ON_A_TROLLEY], ['a colleague’s', NOT_HERS]] as const) {
      const v = mayDecide(hand, order);
      expect(v.allowed, name).toBe(true);
      expect(v.via, name).toBeUndefined();
      expect(v.decider, name).toEqual({ kind: 'WAREHOUSE' });
    }
    expect(mayDecide(hand, PRESSED).allowed).toBe(false);
    expect(mayDecide(hand, SHIPPED_BY_HAND).allowed).toBe(false);
    // NEGATIVE: the packing table is not a holder — a colleague’s window is not opened by the warehouse key.
    expect(holdsTheWindow(hand, HERS)).toBe(false);
  });

  it('a person who is BOTH a warehouse hand and the holder is decided by the earlier rule — and her window is open all the same', async () => {
    const both = await person(SALMA, 'WAREHOUSE', [...WAREHOUSE_HAND, 'orders.edit_confirmed']);
    const v = mayDecide(both, HERS);
    expect(v.allowed).toBe(true);
    expect(v.via).toBeUndefined();
    expect(holdsTheWindow(both, HERS)).toBe(true);
    // …which is what the two doors that carry out a cancel or a hold ask, so no door guesses which rule let her.
    expect(holdsTheWindow(both, ON_A_TROLLEY)).toBe(false);
  });

  it('the owner (SUPER_ADMIN, who holds every key) decides everything, as a supervisor; his window needs him to HOLD the order', async () => {
    const owner = await person('owner', 'SUPER_ADMIN', []);
    for (const [name, order] of ORDERS) {
      const v = mayDecide(owner, order);
      expect(v.allowed, name).toBe(true);
      expect(v.via, name).toBeUndefined();
    }
    expect(holdsTheWindow(owner, HERS)).toBe(false);
    expect(holdsTheWindow(owner, mine({ claimedById: 'owner' }))).toBe(true);
  });

  it('a person with neither role nor key is refused on every order, as she always was', async () => {
    const nobody = await person('nobody', 'MODERATOR', ['orders.view']);
    for (const [name, order] of ORDERS) expect(mayDecide(nobody, order).allowed, name).toBe(false);
  });

  it('the decider an order names for a notification is not touched by the window: a confirmed order still on our floor is the packing table’s', () => {
    expect(deciderFor(HERS)).toEqual({ kind: 'WAREHOUSE' });
    expect(deciderFor(ON_A_TROLLEY)).toEqual({ kind: 'WAREHOUSE' });
    expect(deciderFor(PRESSED)).toEqual({ kind: 'SUPERVISOR' });
    expect(deciderFor(SILENT)).toEqual({ kind: 'SUPERVISOR' });
  });
});

describe('Ⅳ · the self-decision and the apply step read ONE predicate — for every person on every confirmed order they agree', () => {
  const asOrder = (o: RoutingSource) => ({ id: 'o1', confirmationStatus: o.confirmationStatus, claimedById: o.claimedById, handedToCourier: o.handedToCourier, inBatch: o.inBatch });

  it('mayApply allows exactly when mayDecide allows — 5 people × 7 places', async () => {
    const people = [
      await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY),
      await person(SALMA, 'CONFIRMATION_AGENT', LIVE_AGENT),
      await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR),
      await person('hand', 'WAREHOUSE', WAREHOUSE_HAND),
      await person('owner', 'SUPER_ADMIN', []),
    ];
    let allowed = 0;
    for (const user of people) {
      for (const [name, order] of ORDERS) {
        const decides = mayDecide(user, order).allowed;
        const applies = mayApply(user, { orderId: 'o1' }, asOrder(order));
        expect(applies.ok, `${user.role}/${name}`).toBe(decides);
        if (!applies.ok) expect(applies.code, `${user.role}/${name}`).toBe('NOT_THE_DECIDER');
        if (decides) allowed++;
      }
    }
    // The table is not vacuous: some rows allow and some refuse.
    expect(allowed).toBeGreaterThan(12);
    expect(allowed).toBeLessThan(people.length * ORDERS.length);
  });

  it('a request she decided herself is NOT refused at apply time — on the same facts', async () => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    expect(mayDecide(salma, HERS).allowed).toBe(true);
    expect(mayApply(salma, { orderId: 'o1' }, asOrder(HERS))).toEqual({ ok: true });
  });

  it('…and one decided BEFORE the order entered a batch is refused at apply time, once it has', async () => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    expect(mayApply(salma, { orderId: 'o1' }, asOrder(ON_A_TROLLEY))).toMatchObject({ ok: false, status: 403, code: 'NOT_THE_DECIDER' });
    expect(mayApply(salma, { orderId: 'o1' }, asOrder(PRESSED))).toMatchObject({ ok: false, code: 'NOT_THE_DECIDER' });
  });

  it('the apply step still refuses a request for another order, and an order not confirmed yet — before it asks who decides', async () => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    expect(mayApply(salma, { orderId: 'other' }, asOrder(HERS))).toMatchObject({ ok: false, code: 'WRONG_ORDER' });
    expect(mayApply(salma, { orderId: 'o1' }, asOrder(mine({ confirmationStatus: 'IN_PROGRESS' })))).toMatchObject({ ok: false, code: 'NOT_CONFIRMED' });
  });
});

describe('Ⅴ · a caller that does not say whether the order is in a batch denies — the same safe way round as the handover', () => {
  it('mayDecide, holdsTheWindow and mayApply all read «silent» as «in a batch»', async () => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    expect(mayDecide(salma, SILENT).allowed).toBe(false);
    expect(holdsTheWindow(salma, SILENT)).toBe(false);
    expect(mayApply(salma, { orderId: 'o1' }, { id: 'o1', confirmationStatus: 'CONFIRMED', claimedById: SALMA, handedToCourier: false })).toMatchObject({
      ok: false,
      code: 'NOT_THE_DECIDER',
    });
    // …and one that says the batch but not the handover denies too.
    expect(mayDecide(salma, { confirmationStatus: 'CONFIRMED', claimedById: SALMA, inBatch: false }).allowed).toBe(false);
  });

  it('the rows that DO say it, open it — so the refusals above are the defaults and not a closed door', async () => {
    const salma = await person(SALMA, 'CONFIRMATION_AGENT', WITH_KEY);
    expect(mayDecide(salma, { confirmationStatus: 'CONFIRMED', claimedById: SALMA, inBatch: false, handedToCourier: false }).allowed).toBe(true);
  });
});
