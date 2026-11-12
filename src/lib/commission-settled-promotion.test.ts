import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE MOMENT AND THE STATE — the commission nobody could ever be paid.
 *
 * `markPayableForOrders` is the only writer of PAYABLE in the codebase, and
 * it is a MOMENT: it runs inside the statement-approval transaction, over
 * the orders that statement matched. The condition it stands for — the money
 * for this order is in — is a STATE.
 *
 * On the normal path the entry is born AFTER that moment. The statement
 * delivers and settles the order in one transaction; the accrual job writes
 * the entry that night. The entry is then ACCRUED with its money sitting in
 * the wallet and the only writer of PAYABLE already finished, so the payout
 * door refused it for ever — and told the owner it «becomes payable when the
 * collection statement is approved», naming an approval already past. Two
 * orders on the golden-path walk ended exactly there.
 *
 * These tests are not where-clause spelling checks. They run the real
 * filters against rows in memory under Prisma's own semantics, so breaking
 * any one condition breaks a test about money and not a test about a string.
 * ─────────────────────────────────────────────────────────────────────────
 */

const { db, state } = vi.hoisted(() => {
  const state = {
    entries: [] as Record<string, unknown>[],
    orders: [] as Record<string, unknown>[],
    payouts: [] as Record<string, unknown>[],
    movements: [] as Record<string, unknown>[],
    afterRead: null as null | (() => void),
  };

  /**
   * Prisma's filter semantics over plain objects — the subset the promotion
   * uses: scalar equality, an explicit null, `in`, `is: null` on a to-one
   * relation, a nested relation filter (the related row must EXIST and
   * match, which is what excludes a null `orderId`), and `OR`.
   */
  function matches(row: unknown, where: unknown): boolean {
    if (row == null || typeof row !== 'object') return false;
    const r = row as Record<string, unknown>;
    for (const [key, cond] of Object.entries((where ?? {}) as Record<string, unknown>)) {
      if (key === 'OR') {
        if (!(cond as unknown[]).some((c) => matches(r, c))) return false;
        continue;
      }
      const value = r[key];
      if (cond === null) {
        if (value != null) return false;
        continue;
      }
      if (typeof cond === 'object') {
        const c = cond as Record<string, unknown>;
        // A to-many relation: `none` — no related row may match (an order with no rows at all passes).
        if ('none' in c) {
          const related = Array.isArray(value) ? (value as unknown[]) : [];
          if (related.some((x) => matches(x, c.none))) return false;
          continue;
        }
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(value)) return false;
          continue;
        }
        if ('is' in c) {
          if (c.is === null) {
            if (value != null) return false;
            continue;
          }
          if (!matches(value, c.is)) return false;
          continue;
        }
        if (!matches(value, c)) return false;
        continue;
      }
      if (value !== cond) return false;
    }
    return true;
  }

  /** The row as the database would join it: its order, and its reversal. */
  const view = (e: Record<string, unknown>) => ({
    ...e,
    order: state.orders.find((o) => o.id === e.orderId) ?? null,
    reversedBy: state.entries.find((x) => x.reversalOfId === e.id) ?? null,
  });

  const db = {
    commissionEntry: {
      findMany: vi.fn(async ({ where }: { where?: unknown }) => {
        const rows = state.entries.map(view).filter((r) => matches(r, where));
        state.afterRead?.();
        state.afterRead = null;
        return rows;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where?: unknown; data: Record<string, unknown> }) => {
          let count = 0;
          for (const e of state.entries) {
            if (matches(view(e), where)) {
              Object.assign(e, data);
              count++;
            }
          }
          return { count };
        }
      ),
    },
    commissionPayout: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `p${state.payouts.length + 1}`, ...data };
        state.payouts.push(row);
        return row;
      }),
    },
    walletMovement: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.movements.push(data);
        return data;
      }),
    },
    wallet: {
      findFirst: vi.fn(async () => ({
        id: 'w-usd',
        name: 'الصندوق الرئيسي',
        currencyCode: 'USD',
        country: { minorUnit: 2 },
      })),
    },
    user: { findFirst: vi.fn(async () => ({ name: 'سارة' })) },
  };

  return { db, state };
});
vi.mock('./db', () => ({ db }));

import { PROMOTABLE_BY_PAYOUT, promoteSettledToPayable } from './commission';
import { PayoutRefused, owedTo, payCommission } from './commission-payout';

/** An order the courier's statement delivered: DELIVERED and SETTLED. */
const order = (id: string, over: Record<string, unknown> = {}) => {
  const row = {
    id,
    companyId: 'c1',
    shippingStatus: 'DELIVERED',
    settlementStatus: 'SETTLED',
    ...over,
  };
  state.orders.push(row);
  return row;
};

/** The entry the accrual job wrote that night — ACCRUED, and stuck. */
const entry = (id: string, over: Record<string, unknown> = {}) => {
  const row = {
    id,
    companyId: 'c1',
    orderId: null as string | null,
    userId: 'sara',
    role: 'MODERATOR',
    status: 'ACCRUED',
    amount: 0,
    currencyCode: 'EGP',
    payoutId: null as string | null,
    reversalOfId: null as string | null,
    ...over,
  };
  state.entries.push(row);
  return row;
};

const statusOf = (id: string) => state.entries.find((e) => e.id === id)?.status;
const payoutOf = (id: string) => state.entries.find((e) => e.id === id)?.payoutId;

const pay = (entryIds: string[], over: Record<string, unknown> = {}) =>
  payCommission(db as never, {
    companyId: 'c1',
    userId: 'sara',
    walletId: 'w-usd',
    entryIds,
    exchangeRate: 1 / 48.5,
    createdById: 'owner',
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.entries = [];
  state.orders = [];
  state.payouts = [];
  state.movements = [];
  state.afterRead = null;
});

/**
 * THE CASE AS IT WAS MEASURED. Two orders the statement delivered: both
 * SETTLED, both with commission still ACCRUED, both permanently unpayable.
 */
describe('the two orders the statement delivered', () => {
  beforeEach(() => {
    order('o1');
    order('o2');
    entry('e1', { orderId: 'o1', amount: 300 });
    entry('e2', { orderId: 'o2', amount: 200 });
  });

  it('were owed and invisible — the balance now shows the 500 EGP', async () => {
    const owed = await owedTo(db as never, { companyId: 'c1', userId: 'sara' });
    expect(owed).toEqual([{ currencyCode: 'EGP', amount: 500, entries: ['e1', 'e2'] }]);
  });

  it('are paid: 500 EGP out of the dollar wallet as 10.31 USD', async () => {
    const r = await pay(['e1', 'e2']);
    expect(r.amount).toBe(500);
    expect(r.currencyCode).toBe('EGP');
    expect(r.paidAmount).toBe(10.31); // 500 ÷ 48.5, to the wallet's two decimals
    expect(r.paidCurrency).toBe('USD');
    expect(r.entries).toBe(2);
  });

  it('end as PAID and pointing at the payment that paid them', async () => {
    await pay(['e1', 'e2']);
    expect([
      [statusOf('e1'), payoutOf('e1')],
      [statusOf('e2'), payoutOf('e2')],
    ]).toEqual([
      ['PAID', 'p1'],
      ['PAID', 'p1'],
    ]);
  });

  it('and the money actually leaves the wallet, in the wallet currency', async () => {
    await pay(['e1', 'e2']);
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0]).toMatchObject({
      walletId: 'w-usd',
      direction: 'OUT',
      amount: 10.31,
      currencyCode: 'USD',
      category: 'COMMISSION',
    });
  });

  it('are nothing to the door once paid — a second attempt pays no one twice', async () => {
    await pay(['e1', 'e2']);
    await expect(pay(['e1', 'e2'])).rejects.toMatchObject({ reason: 'NOT_PAYABLE' });
    expect(state.movements).toHaveLength(1);
  });

  it('and the promotion itself is idempotent — a second call promotes nothing', async () => {
    const first = await promoteSettledToPayable(db as never, {
      companyId: 'c1',
      userId: 'sara',
      entryIds: ['e1', 'e2'],
    });
    const second = await promoteSettledToPayable(db as never, {
      companyId: 'c1',
      userId: 'sara',
      entryIds: ['e1', 'e2'],
    });
    expect([first, second]).toEqual([2, 0]);
  });
});

/**
 * EVERY GUARD, BROKEN ON PURPOSE. A promotion that is not at least as strict
 * as `markPayableForOrders` has not fixed the defect, it has widened it.
 */
describe('what the promotion refuses to promote', () => {
  const refuses = async (ids: string[]) => {
    await expect(pay(ids)).rejects.toThrow(PayoutRefused);
    expect(state.movements).toEqual([]);
  };

  it('an entry whose order is NOT settled — the money is not in yet', async () => {
    order('o3', { settlementStatus: 'PENDING' });
    entry('e3', { orderId: 'o3', amount: 300 });
    await refuses(['e3']);
    expect(statusOf('e3')).toBe('ACCRUED');
    // And NOT_PAYABLE now says something true: the statement really has not
    // been approved. That sentence was a lie for every settled order.
    await expect(pay(['e3'])).rejects.toMatchObject({ reason: 'NOT_PAYABLE' });
  });

  it('an entry whose order is only PARTIALLY_SETTLED — part of the money is still out there', async () => {
    order('o4', { settlementStatus: 'PARTIALLY_SETTLED' });
    entry('e4', { orderId: 'o4', amount: 300 });
    await refuses(['e4']);
    expect(statusOf('e4')).toBe('ACCRUED');
  });

  it('A REVERSED ENTRY — delivered, settled, and then it came back', async () => {
    // The reversal does not touch the original: it is a second, negative
    // entry pointing back at it. The original is still ACCRUED and its order
    // is still SETTLED, because nothing un-settles an order that came back.
    // Promote it and the business pays commission on goods sitting back on
    // its own shelf.
    order('o5');
    entry('e5', { orderId: 'o5', amount: 300 });
    entry('e5r', { orderId: 'o5', amount: -300, status: 'REVERSED', reversalOfId: 'e5' });
    await refuses(['e5']);
    expect(statusOf('e5')).toBe('ACCRUED');
  });

  it('and the negative entry itself is never promoted or paid', async () => {
    order('o5');
    entry('e5', { orderId: 'o5', amount: 300 });
    entry('e5r', { orderId: 'o5', amount: -300, status: 'REVERSED', reversalOfId: 'e5' });
    await refuses(['e5r']);
    expect(statusOf('e5r')).toBe('REVERSED');
  });

  it('an entry already PAID — the money already left', async () => {
    order('o6');
    entry('e6', { orderId: 'o6', amount: 300, status: 'PAID', payoutId: 'older' });
    await refuses(['e6']);
    expect(statusOf('e6')).toBe('PAID');
    expect(payoutOf('e6')).toBe('older');
  });

  it('an ACCRUED entry that somehow still carries a payoutId', async () => {
    // Status and payout are two facts. An entry dragged backwards by hand
    // with a payment still hanging off it must not be paid again.
    order('o7');
    entry('e7', { orderId: 'o7', amount: 300, payoutId: 'older' });
    await refuses(['e7']);
    expect(statusOf('e7')).toBe('ACCRUED');
  });

  it('a PERIOD entry, which has no order and so has no settlement', async () => {
    entry('e8', { orderId: null, amount: 300 });
    await refuses(['e8']);
    expect(statusOf('e8')).toBe('ACCRUED');
  });

  it('somebody ELSE commission, even when it is settled and sitting right there', async () => {
    order('o9');
    order('o10');
    entry('e9', { orderId: 'o9', amount: 300 });
    entry('e10', { orderId: 'o10', amount: 70, userId: 'omar' });
    await pay(['e9']);
    // Omar's figure must not move because Sara was paid: the number he was
    // shown a second earlier would be a different number in the database.
    expect(statusOf('e10')).toBe('ACCRUED');
    expect(statusOf('e9')).toBe('PAID');
  });

  /**
   * THE BLAST RADIUS, asserted on the promotion itself and not through a
   * payout that happens to succeed.
   *
   * `payCommission` names the entries, so a payout refuses a stranger's
   * entry a moment later and its transaction rolls everything back. Neither
   * fact is a reason to leave the promotion wide: it is exported, it writes
   * PAYABLE — the one status the whole system reads as "this is owed" — and
   * a guard that only holds because a later guard also holds is a guard that
   * disappears the day somebody calls this from anywhere else.
   */
  it('and the promotion promotes NOBODY but the person being paid', async () => {
    order('o15');
    order('o16');
    entry('e15', { orderId: 'o15', amount: 300 });
    entry('e16', { orderId: 'o16', amount: 70, userId: 'omar' });
    const promoted = await promoteSettledToPayable(db as never, {
      companyId: 'c1',
      userId: 'sara',
      entryIds: ['e15', 'e16'],
    });
    expect(promoted).toBe(1);
    expect(statusOf('e15')).toBe('PAYABLE');
    expect(statusOf('e16')).toBe('ACCRUED');
  });

  it('and NOTHING but the entries it was handed, even of the same person', async () => {
    // Everything else Sara is owed stays exactly as the screen showed it a
    // moment ago. Promoting her whole balance because she was paid part of
    // it would move a figure nobody asked to move, and `owedTo` groups by
    // currency — so a sweep here could make a second currency payable in a
    // payout that was never about it.
    order('o17');
    order('o18');
    entry('e17', { orderId: 'o17', amount: 300 });
    entry('e18', { orderId: 'o18', amount: 200 });
    const promoted = await promoteSettledToPayable(db as never, {
      companyId: 'c1',
      userId: 'sara',
      entryIds: ['e17'],
    });
    expect(promoted).toBe(1);
    expect(statusOf('e17')).toBe('PAYABLE');
    expect(statusOf('e18')).toBe('ACCRUED');
  });

  it('another COMPANY entry, whatever id was sent', async () => {
    order('o11', { companyId: 'c2' });
    entry('e11', { orderId: 'o11', amount: 300, companyId: 'c2' });
    await refuses(['e11']);
    expect(statusOf('e11')).toBe('ACCRUED');
  });

  it('and nothing at all when no entries were named', async () => {
    expect(
      await promoteSettledToPayable(db as never, { companyId: 'c1', userId: 'sara', entryIds: [] })
    ).toBe(0);
    expect(db.commissionEntry.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * THE CLAIM. Promoting cannot be what lets an entry be paid twice, so the
 * write that marks it PAID carries its condition in the WHERE and not only
 * in a read: a read is a photograph, and two payouts can photograph the
 * same PAYABLE row.
 */
describe('two payouts at once cannot pay one entry twice', () => {
  it('the second finds nothing to claim and takes no money out', async () => {
    order('o12');
    entry('e12', { orderId: 'o12', amount: 300 });
    // Between this payout's read and its claim, another transaction commits
    // the same entry as PAID. The claim must match nothing.
    state.afterRead = () => {
      const e = state.entries.find((x) => x.id === 'e12');
      if (e) Object.assign(e, { status: 'PAID', payoutId: 'other' });
    };
    await expect(pay(['e12'])).rejects.toMatchObject({ reason: 'NOT_PAYABLE' });
    // No money left the wallet; the caller's transaction takes the payout
    // row with it when this throws.
    expect(state.movements).toEqual([]);
    expect(statusOf('e12')).toBe('PAID');
    expect(payoutOf('e12')).toBe('other');
  });

  /**
   * AND THE CLAIM IS NEVER LOOSER THAN THE READ.
   *
   * The read above refuses an entry that is not PAYABLE *or* that already
   * carries a payoutId — two conditions, because both are ways of being
   * already paid. The claim asserts the same two. If it asserted fewer, the
   * window between the read and the write would be a hole exactly the shape
   * of the condition it dropped: a state the function refuses when it looks
   * would be a state it accepts when it writes.
   */
  it('refuses an entry that turned PAID with no payout on it — the status alone says so', async () => {
    // A real way to reach PAID with a null payoutId: `payout` is declared
    // `onDelete: SetNull`, so removing a payout row leaves its entries PAID
    // and pointing at nothing. If the claim trusted the payoutId alone it
    // would quietly re-pay money that has already left the wallet once.
    order('o15');
    entry('e15', { orderId: 'o15', amount: 300 });
    state.afterRead = () => {
      const e = state.entries.find((x) => x.id === 'e15');
      if (e) Object.assign(e, { status: 'PAID', payoutId: null });
    };
    await expect(pay(['e15'])).rejects.toMatchObject({ reason: 'NOT_PAYABLE' });
    expect(state.movements).toEqual([]);
    expect(payoutOf('e15')).toBeNull();
  });

  it('refuses an entry that acquired a payout while still labelled PAYABLE', async () => {
    // The mirror: the read already refuses this state, so the claim must
    // too. A status left behind by a half-applied write is not permission
    // to pay a person a second time.
    order('o16');
    entry('e16', { orderId: 'o16', amount: 300 });
    state.afterRead = () => {
      const e = state.entries.find((x) => x.id === 'e16');
      if (e) Object.assign(e, { status: 'PAYABLE', payoutId: 'other' });
    };
    await expect(pay(['e16'])).rejects.toMatchObject({ reason: 'NOT_PAYABLE' });
    expect(state.movements).toEqual([]);
    expect(payoutOf('e16')).toBe('other');
  });

  it('and a partial claim is refused whole, never half-paid', async () => {
    order('o13');
    order('o14');
    entry('e13', { orderId: 'o13', amount: 300 });
    entry('e14', { orderId: 'o14', amount: 200 });
    state.afterRead = () => {
      const e = state.entries.find((x) => x.id === 'e14');
      if (e) Object.assign(e, { status: 'PAID', payoutId: 'other' });
    };
    await expect(pay(['e13', 'e14'])).rejects.toMatchObject({ reason: 'NOT_PAYABLE' });
    expect(state.movements).toEqual([]);
  });
});

/**
 * THE BALANCE AND THE DOOR READ THE SAME LIST. A figure the door would not
 * accept, or an entry the door would pay that the balance never shows, is a
 * balance nobody can collect — which is the defect in its other shape.
 */
describe('what a person is owed is what the door will pay', () => {
  it('counts a settled ACCRUED entry, and excludes everything the door refuses', async () => {
    order('ok1');
    order('ok2');
    order('unsettled', { settlementStatus: 'PENDING' });
    order('returned');
    entry('owed-accrued', { orderId: 'ok1', amount: 300 });
    entry('owed-payable', { orderId: 'ok2', amount: 200, status: 'PAYABLE' });
    entry('not-settled', { orderId: 'unsettled', amount: 999 });
    entry('reversed-original', { orderId: 'returned', amount: 999 });
    entry('the-reversal', {
      orderId: 'returned',
      amount: -999,
      status: 'REVERSED',
      reversalOfId: 'reversed-original',
    });
    entry('already-paid', { orderId: 'ok1', amount: 999, status: 'PAID', payoutId: 'older' });
    entry('period-entry', { orderId: null, amount: 999 });

    const owed = await owedTo(db as never, { companyId: 'c1', userId: 'sara' });
    expect(owed).toEqual([
      { currencyCode: 'EGP', amount: 500, entries: ['owed-accrued', 'owed-payable'] },
    ]);
  });

  it('keeps two currencies apart, as it always did', async () => {
    order('ok1');
    order('ok2');
    entry('egp', { orderId: 'ok1', amount: 300 });
    entry('syp', { orderId: 'ok2', amount: 50, currencyCode: 'SYP' });
    expect(await owedTo(db as never, { companyId: 'c1', userId: 'sara' })).toEqual([
      { currencyCode: 'EGP', amount: 300, entries: ['egp'] },
      { currencyCode: 'SYP', amount: 50, entries: ['syp'] },
    ]);
  });
});

/** The filter is one object, read by both the balance and the promotion. */
describe('the condition is written once', () => {
  it('names the state, not the moment — and leaves out an order closed as collected before the system', () => {
    expect(PROMOTABLE_BY_PAYOUT).toEqual({
      status: 'ACCRUED',
      payoutId: null,
      reversedBy: { is: null },
      order: { settlementStatus: 'SETTLED', activities: { none: { action: 'LEGACY_CLOSED_NO_MONEY' } } },
    });
  });
});

/**
 * «أقفل القديمة بلا باركود» (12/11): the owner closes old delivered orders as collected WITHOUT a wallet movement and said
 * «بدون ما تأثر على المالية». SETTLED would make their commission payable at the next payout — so an order carrying the close's
 * mark is not promotable, however settled it looks. The control in every test: an ordinary settled order next to it still is.
 */
describe('an order the owner closed as collected before the system', () => {
  const MARK = [{ action: 'LEGACY_CLOSED_NO_MONEY' }];

  beforeEach(() => {
    order('closed', { activities: MARK });
    order('ordinary', { activities: [{ action: 'ORDER_UPDATED' }] });
    entry('e-closed', { orderId: 'closed', amount: 300 });
    entry('e-ordinary', { orderId: 'ordinary', amount: 200 });
  });

  it('is not on the balance — only the ordinary settled order is owed', async () => {
    const owed = await owedTo(db as never, { companyId: 'c1', userId: 'sara' });
    expect(owed).toEqual([{ currencyCode: 'EGP', amount: 200, entries: ['e-ordinary'] }]);
  });

  it('is not promoted by the payout, and the payout is refused as not payable', async () => {
    await expect(pay(['e-closed'])).rejects.toMatchObject({ reason: 'NOT_PAYABLE' });
    expect(statusOf('e-closed')).toBe('ACCRUED');
    expect(state.movements).toEqual([]);
  });

  it('is not promoted by the promotion itself; the ordinary one next to it is', async () => {
    const n = await promoteSettledToPayable(db as never, {
      companyId: 'c1',
      userId: 'sara',
      entryIds: ['e-closed', 'e-ordinary'],
    });
    expect(n).toBe(1);
    expect([statusOf('e-closed'), statusOf('e-ordinary')]).toEqual(['ACCRUED', 'PAYABLE']);
  });

  it('stays out even when its entry was written AFTER the close (the nightly job runs later)', async () => {
    entry('e-late', { orderId: 'closed', amount: 50 });
    const owed = await owedTo(db as never, { companyId: 'c1', userId: 'sara' });
    expect(owed[0].entries).toEqual(['e-ordinary']);
    await expect(pay(['e-late'])).rejects.toMatchObject({ reason: 'NOT_PAYABLE' });
  });
});
