import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCREEN AND THE DOOR MUST BUCKET THE SAME ENTRY THE SAME WAY.
 *
 * Commission stays ACCRUED at rest and is promoted to PAYABLE at the moment
 * of payment — «the payout door promotes». The condition is one exported
 * Prisma filter, `PROMOTABLE_BY_PAYOUT`, and `owedTo` reads both arms of it,
 * so the payout dialog, the payslip and the performance card all say an
 * entry on a SETTLED order is owed and ready to pay.
 *
 * The commission screen used to ask the LABEL instead:
 *
 *     if (entry.status === 'ACCRUED') row.accrued += amount;
 *     else if (entry.status === 'PAYABLE') row.payable += amount;
 *
 * So one 300 EGP entry on a settled order showed as «300 محتسبة / 0 مستحقة»
 * while the door was willing to pay it that second. And the table's «صرف»
 * button is drawn on `payable > 0`, so the zero did not merely mislabel the
 * money — it removed the only way to pay it.
 *
 * THESE TESTS DO NOT RE-STATE THE NEW `if`. They put the same rows to BOTH
 * answerers — the screen (`GET /api/finance/commission`) and the door
 * (`owedTo`) — and require the two to agree, entry by entry and in total.
 * A screen that drifts from the door by any amount fails here, whichever of
 * the two moved.
 * ─────────────────────────────────────────────────────────────────────────
 */

const { db, state } = vi.hoisted(() => {
  const state = {
    entries: [] as Record<string, unknown>[],
    orders: [] as Record<string, unknown>[],
  };

  /**
   * Prisma's filter semantics over plain objects — the subset these two
   * readers use: scalar equality, an explicit null, `in`, `is: null` on a
   * to-one relation, a nested relation filter (the related row must EXIST
   * and match, which is what excludes a null `orderId`), and `OR`.
   */
  function matches(row: unknown, where: unknown): boolean {
    if (row == null || typeof row !== 'object') return false;
    const r = row as Record<string, unknown>;
    for (const [key, cond] of Object.entries((where ?? {}) as Record<string, unknown>)) {
      if (key === 'OR') {
        if (!(cond as unknown[]).some((c) => matches(r, c))) return false;
        continue;
      }
      if (key === 'AND') {
        if (!(cond as unknown[]).every((c) => matches(r, c))) return false;
        continue;
      }
      const value = r[key];
      if (cond === null) {
        if (value != null) return false;
        continue;
      }
      if (typeof cond === 'object') {
        const c = cond as Record<string, unknown>;
        // A to-many relation: `none` — no related row may match (an order with no rows at all passes). The promotable filter
        // carries it since «أقفل القديمة بلا باركود»; no order in this file carries the close's mark.
        if ('none' in c) {
          const related = Array.isArray(value) ? (value as unknown[]) : [];
          if (related.some((x) => matches(x, c.none))) return false;
          continue;
        }
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(value)) return false;
          continue;
        }
        if ('not' in c) {
          if (c.not === null ? value == null : value === c.not) return false;
          continue;
        }
        if ('gte' in c || 'lt' in c || 'lte' in c) continue;
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
      findMany: vi.fn(async ({ where }: { where?: unknown }) =>
        state.entries.map(view).filter((r) => matches(r, where))
      ),
    },
    // The fairness block reads orders; it is not what is under test here.
    order: { findMany: vi.fn(async () => []) },
    user: {
      findMany: vi.fn(async ({ where }: { where?: { id?: { in?: string[] } } }) =>
        [
          { id: 'sara', name: 'سارة', role: 'MODERATOR' },
          { id: 'omar', name: 'عمر', role: 'CONFIRMATION_AGENT' },
        ].filter((u) => (where?.id?.in ?? [u.id]).includes(u.id))
      ),
    },
  };

  return { db, state };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'boss' },
    companyId: 'c1',
    storeId: 's1',
    country: { currencyCode: 'EGP', minorUnit: 2 },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));
vi.mock('@/lib/audit', () => ({ logAudit: async () => undefined }));

import { GET } from './route';
import { owedTo } from '@/lib/commission-payout';

const PERIOD = '2026-09';

/** An order the courier's statement delivered: DELIVERED and SETTLED. */
const order = (id: string, over: Record<string, unknown> = {}) => {
  state.orders.push({
    id,
    companyId: 'c1',
    orderNumber: id,
    merchantRef: null,
    deliveredAt: new Date('2026-09-10T00:00:00Z'),
    shippingStatus: 'DELIVERED',
    settlementStatus: 'SETTLED',
    ...over,
  });
  return id;
};

/** The entry the accrual job wrote that night — ACCRUED, and stuck. */
const entry = (id: string, over: Record<string, unknown> = {}) => {
  state.entries.push({
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
    periodMonth: PERIOD,
    createdAt: new Date('2026-09-10T00:00:00Z'),
    ...over,
  });
  return id;
};

interface Row {
  userId: string;
  name: string;
  accrued: number;
  payable: number;
  paid: number;
  reversed: number;
}

/** What the SCREEN says — the four money columns, per person. */
async function screenRows(): Promise<Map<string, Row>> {
  const res = await GET(new Request(`http://localhost/api/finance/commission?period=${PERIOD}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { totals: Row[] };
  return new Map(body.totals.map((t) => [t.userId, t]));
}

/** What the DOOR says — the EGP balance it would pay this person. */
async function doorOwes(userId: string): Promise<{ amount: number; entries: string[] }> {
  const owed = await owedTo(db as never, { companyId: 'c1', userId });
  const egp = owed.find((o) => o.currencyCode === 'EGP');
  return { amount: egp?.amount ?? 0, entries: (egp?.entries ?? []).slice().sort() };
}

beforeEach(() => {
  state.entries = [];
  state.orders = [];
});

describe('the 300 EGP the screen refused to call payable', () => {
  beforeEach(() => {
    order('o1');
    entry('e1', { orderId: 'o1', amount: 300, status: 'ACCRUED' });
  });

  it('the door would pay it — 300, right now', async () => {
    expect(await doorOwes('sara')).toEqual({ amount: 300, entries: ['e1'] });
  });

  it('and the screen says the same 300 is مستحقة, not محتسبة', async () => {
    const sara = (await screenRows()).get('sara');
    // Before the fix this read { accrued: 300, payable: 0 } — the accountant
    // was told the money was not yet owed, and got no «صرف» button at all.
    expect(sara).toMatchObject({ accrued: 0, payable: 300, paid: 0, reversed: 0 });
  });

  it('so the «صرف» button the table draws on `payable > 0` is there', async () => {
    expect((await screenRows()).get('sara')!.payable).toBeGreaterThan(0);
  });
});

/**
 * Every shape the door distinguishes, in one population — so the comparison
 * below is not two readers agreeing about one easy row.
 */
function thePopulation() {
  order('settled-1');
  order('settled-2');
  order('settled-3');
  order('settled-4');
  order('settled-paid');
  order('collected', { settlementStatus: 'COLLECTED' });
  order('partial', { settlementStatus: 'PARTIALLY_SETTLED' });
  order('settled-returned');

  // Owed: accrued on a settled order (the defect), and already labelled.
  entry('owed-accrued', { orderId: 'settled-1', amount: 300 });
  entry('owed-payable', { orderId: 'settled-2', amount: 200, status: 'PAYABLE' });
  // Not owed: the statement really has not been approved.
  entry('not-collected', { orderId: 'collected', amount: 70 });
  entry('not-partial', { orderId: 'partial', amount: 80 });
  // Not owed: a period entry has no order for a statement to cover.
  entry('not-period', { orderId: null, amount: 90 });
  // Not owed: the goods came back. The original stays ACCRUED on a SETTLED
  // order and is still pointed at by its negative reversal.
  entry('not-reversed-original', { orderId: 'settled-returned', amount: 150 });
  entry('the-reversal', {
    orderId: 'settled-returned', amount: -150, status: 'REVERSED', reversalOfId: 'not-reversed-original',
  });
  // Not owed: the money already left.
  entry('not-paid', { orderId: 'settled-paid', amount: 500, status: 'PAID', payoutId: 'p1' });
  // Not owed: ACCRUED but a payout is already attached to it.
  entry('not-claimed', { orderId: 'settled-3', amount: 400, payoutId: 'p2' });
  // Another person entirely — a payout for Sara must not move Omar's money,
  // and neither must the screen's arithmetic.
  entry('omar-owed', { orderId: 'settled-4', amount: 123, userId: 'omar' });
}

describe('the screen and the door, asked about the same rows', () => {
  beforeEach(thePopulation);

  /**
   * THE GUARD. For each entry on its own: which column does the screen put
   * it in, and would the door pay it? The two answers must be the same
   * answer. Nothing here reads the route's own flag or re-states its `if` —
   * the screen is asked through its HTTP response and the door through
   * `owedTo`, and the two sets are compared.
   */
  it('agree entry by entry: owed on the screen ⇔ paid by the door', async () => {
    const all = state.entries.map((e) => ({ ...e }));
    const orders = state.orders.map((o) => ({ ...o }));

    const disagreements: string[] = [];
    for (const one of all) {
      // One entry at a time, with its reversal if it has one, so each row's
      // column is unambiguous rather than a share of a sum.
      state.orders = orders;
      state.entries = all.filter((e) => e.id === one.id || e.reversalOfId === one.id);

      const row = (await screenRows()).get(one.userId as string);
      const screenCallsItPayable = (row?.payable ?? 0) === Number(one.amount) && Number(one.amount) !== 0;
      const doorWouldPayIt = (await doorOwes(one.userId as string)).entries.includes(one.id as string);

      if (screenCallsItPayable !== doorWouldPayIt) {
        disagreements.push(
          `${one.id}: الشاشة ${screenCallsItPayable ? 'مستحقة' : 'غير مستحقة'} / ` +
            `باب الصرف ${doorWouldPayIt ? 'يدفعها' : 'يرفضها'} (${one.amount} ${one.currencyCode})`
        );
      }
    }

    expect(disagreements, disagreements.join('\n')).toEqual([]);
  });

  /** And in total, over the whole population at once, per person. */
  it('agree in total: the مستحقة column is the balance the door would pay', async () => {
    const rows = await screenRows();
    for (const userId of ['sara', 'omar']) {
      const door = await doorOwes(userId);
      expect(rows.get(userId)!.payable, userId).toBe(door.amount);
    }
    // Not a tautology about zero: both numbers are real money.
    expect(rows.get('sara')!.payable).toBe(500); // 300 accrued-and-settled + 200 payable
    expect(rows.get('omar')!.payable).toBe(123);
  });

  /** The other three columns still hold what the door refuses, and nothing is lost. */
  it('and nothing falls out of the table on the way', async () => {
    const sara = (await screenRows()).get('sara')!;
    // Refused by the door, so still only محتسبة: 70 + 80 + 90 + 150 + 400.
    expect(sara.accrued).toBe(790);
    expect(sara.paid).toBe(500);
    expect(sara.reversed).toBe(-150);
    const total = sara.accrued + sara.payable + sara.paid + sara.reversed;
    const ledger = state.entries
      .filter((e) => e.userId === 'sara')
      .reduce((sum, e) => sum + Number(e.amount), 0);
    expect(total).toBe(ledger);
  });
});
