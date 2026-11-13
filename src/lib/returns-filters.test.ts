import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  AGES,
  AGE_AR,
  AGE_FROM,
  DEFAULT_VIEW,
  NO_COURIER,
  PENDING_ORDER_BY,
  RECEIVED_ORDER_BY,
  RETURN_STATUSES,
  STATUS_AR,
  VIEWS,
  VIEW_AR,
  ageOf,
  ageWhere,
  courierWhere,
  daysWaitedOf,
  isBarcodeFilter,
  isCourierFilter,
  noBarcodeWhere,
  returnsFilters,
  returnsSearch,
  sinceOf,
  viewScope,
  type Age,
} from './returns-filters';
import { SHIPPING_STATUS_AR } from './shipping-workflow';
import { repoFile, stripComments } from './guard-source';

/**
 * THE RETURNS DESK'S WORDS, EACH READ TWICE — AND THE TWO READINGS AGREE.
 *
 * «المرتجعات — صفحات + فلاتر + بحث». «منذ 2–3 أيام (4)» beside a word is a promise that four rows will appear when
 * it is chosen; the number is asked of the database (`ageWhere`) and the label on each row is read in memory
 * (`sinceOf` → `daysWaitedOf` → `ageOf`). They are written side by side so they cannot drift, and what is held here
 * is that they never do — at every boundary, and in every column the moment can live in.
 */

const NOW = new Date('2026-10-21T12:00:00.000Z');
const DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

// ───────────────────────── a tiny Prisma `where` evaluator ─────────────────────────
//
// Only the operators the module writes: AND / OR, equality (null included), lte / gt. A condition it does not know
// THROWS, so the day the module starts writing one the evaluator cannot read, this fails loudly instead of agreeing
// with itself.

type Row = Record<string, unknown>;

function matches(where: Prisma.OrderWhereInput, row: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Prisma.OrderWhereInput[]).every((w) => matches(w, row));
    if (key === 'OR') return (cond as Prisma.OrderWhereInput[]).some((w) => matches(w, row));
    const value = row[key];
    if (cond === null) return value === null;
    if (typeof cond !== 'object' || cond instanceof Date) return value === cond;
    return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
      if (!(value instanceof Date)) return false; // a comparison on null is never true
      const a = value.getTime();
      const b = (arg as Date).getTime();
      if (op === 'lte') return a <= b;
      if (op === 'gt') return a > b;
      throw new Error(`the evaluator does not know «${op}»`);
    });
  });
}

/** A parcel with its four possible moments — `updatedAt` is never null. */
const parcel = (over: Partial<Record<'returnedAt' | 'failedAt' | 'deliveredAt' | 'updatedAt', Date | null>> = {}): Row => ({
  returnedAt: null,
  failedAt: null,
  deliveredAt: null,
  updatedAt: at(-DAY),
  ...over,
});

/** Every instant that sits on a line: each boundary in milliseconds, one either side, and the middle of each pile. */
const OFFSETS = [
  0, 1, 3_600_000, DAY - 1, DAY, DAY + 1, 2 * DAY - 1, 2 * DAY, 2 * DAY + 1, 3 * DAY, 4 * DAY - 1, 4 * DAY, 4 * DAY + 1,
  6 * DAY, 8 * DAY - 1, 8 * DAY, 8 * DAY + 1, 30 * DAY,
].map((ms) => -ms);

const pilesOf = (row: Row): Age[] => AGES.filter((a) => matches(ageWhere(a, NOW), row));

describe('one word, two readings — over every boundary', () => {
  it.each(OFFSETS)('— a parcel %i ms old by returnedAt lands in exactly the pile the label says', (offset) => {
    const row = parcel({ returnedAt: at(offset) });
    const expected = ageOf(daysWaitedOf(sinceOf(row), NOW));
    expect(pilesOf(row), `@ ${offset}`).toEqual([expected]);
  });

  it.each(['failedAt', 'deliveredAt'] as const)('— and the same instants read from %s, when the columns before it are empty, land the same', (column) => {
    for (const offset of OFFSETS) {
      const row = parcel({ [column]: at(offset) });
      expect(pilesOf(row), `${column} @ ${offset}`).toEqual([ageOf(daysWaitedOf(sinceOf(row), NOW))]);
    }
  });

  it('— and a return that was only requested, which has no moment of its own, is as old as its last write', () => {
    for (const offset of OFFSETS) {
      const row = parcel({ updatedAt: at(offset) });
      expect(pilesOf(row), `updatedAt @ ${offset}`).toEqual([ageOf(daysWaitedOf(sinceOf(row), NOW))]);
    }
  });

  it('and the piles PARTITION the parcels — one each, never two, never none', () => {
    for (const offset of OFFSETS) {
      for (const column of ['returnedAt', 'failedAt', 'deliveredAt', 'updatedAt'] as const) {
        const row = parcel({ [column]: at(offset) });
        expect(pilesOf(row).length, `${column} @ ${offset}`).toBe(1);
      }
    }
  });

  it('and the lines are where «whole days» puts them: 47 hours is one day old, 48 hours is two', () => {
    expect(daysWaitedOf(at(-(2 * DAY - 3_600_000)), NOW)).toBe(1);
    expect(daysWaitedOf(at(-2 * DAY), NOW)).toBe(2);
    expect(ageOf(1)).toBe('fresh');
    expect(ageOf(2)).toBe('few');
    expect(ageOf(3)).toBe('few');
    expect(ageOf(4)).toBe('week');
    expect(ageOf(7)).toBe('week');
    expect(ageOf(8)).toBe('old');
    expect(ageOf(400)).toBe('old');
    // The same lines through the database: an equal instant falls on the OLDER side of each.
    expect(pilesOf(parcel({ returnedAt: at(-2 * DAY) }))).toEqual(['few']);
    expect(pilesOf(parcel({ returnedAt: at(-2 * DAY + 1) }))).toEqual(['fresh']);
    expect(pilesOf(parcel({ returnedAt: at(-8 * DAY) }))).toEqual(['old']);
    expect(pilesOf(parcel({ returnedAt: at(-8 * DAY + 1) }))).toEqual(['week']);
  });
});

describe('which column the moment is read from', () => {
  it('— the return date first, then the failed delivery, then the part-delivery, then the last write', () => {
    const early = at(-9 * DAY);
    const late = at(-DAY);
    expect(sinceOf({ returnedAt: late, failedAt: early, deliveredAt: early, updatedAt: early })).toEqual(late);
    expect(sinceOf({ returnedAt: null, failedAt: late, deliveredAt: early, updatedAt: early })).toEqual(late);
    expect(sinceOf({ returnedAt: null, failedAt: null, deliveredAt: late, updatedAt: early })).toEqual(late);
    expect(sinceOf({ returnedAt: null, failedAt: null, deliveredAt: null, updatedAt: late })).toEqual(late);
  });

  it('and the database reads the same column — an older date in a later column does not move a parcel out of its pile', () => {
    // Returned yesterday; failed nine days ago. It is a day old, not nine.
    const row = parcel({ returnedAt: at(-DAY), failedAt: at(-9 * DAY), deliveredAt: at(-9 * DAY), updatedAt: at(-9 * DAY) });
    expect(pilesOf(row)).toEqual(['fresh']);
    expect(daysWaitedOf(sinceOf(row), NOW)).toBe(1);
    // And the other way round: returned nine days ago, touched yesterday. It is nine days old.
    const old = parcel({ returnedAt: at(-9 * DAY), updatedAt: at(-DAY) });
    expect(pilesOf(old)).toEqual(['old']);
  });

  it('and a string date reads the same as a Date — the route hands over whatever Prisma returned', () => {
    expect(sinceOf({ returnedAt: at(-3 * DAY).toISOString() })?.getTime()).toBe(at(-3 * DAY).getTime());
    expect(daysWaitedOf(sinceOf({ failedAt: at(-3 * DAY).toISOString() }), NOW)).toBe(3);
  });

  it('and a parcel with no moment at all has no age', () => {
    expect(sinceOf({})).toBeNull();
    expect(sinceOf({ returnedAt: 'not a date' })).toBeNull();
    expect(daysWaitedOf(null, NOW)).toBeNull();
    expect(ageOf(null)).toBeNull();
  });
});

describe('the words', () => {
  it('— two views, the work first, and each has its words', () => {
    expect(VIEWS).toEqual(['pending', 'received']);
    expect(DEFAULT_VIEW).toBe('pending');
    expect(VIEW_AR).toEqual({ pending: 'بانتظار الاستلام', received: 'تم استلامها' });
  });

  it('and the four states are the four the desk has always listed, said in the words the rest of the product says them', () => {
    expect([...RETURN_STATUSES]).toEqual(['RETURN_REQUESTED', 'RETURNED', 'FAILED_DELIVERY', 'PARTIALLY_DELIVERED']);
    for (const s of RETURN_STATUSES) expect(STATUS_AR[s]).toBe(SHIPPING_STATUS_AR[s]);
  });

  it('and the age piles grow, and every pile has words', () => {
    const lines = AGES.map((a) => AGE_FROM[a]);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(new Set(lines).size).toBe(AGES.length);
    expect(AGE_FROM.fresh).toBe(0);
    for (const a of AGES) expect(AGE_AR[a].length).toBeGreaterThan(3);
    expect(new Set(AGES.map((a) => AGE_AR[a])).size).toBe(AGES.length);
  });
});

describe('the scope of each view', () => {
  const scope = { companyId: 'c1', storeId: 's1' };

  it('— pending is this company, this store, the four states, and no receipt', () => {
    expect(viewScope('pending', scope)).toEqual({
      companyId: 'c1',
      storeId: 's1',
      shippingStatus: { in: ['RETURN_REQUESTED', 'RETURNED', 'FAILED_DELIVERY', 'PARTIALLY_DELIVERED'] },
      returnReceipt: null,
    });
  });

  it('and received is this company, this store, and a receipt that exists — whatever state the order is in since', () => {
    expect(viewScope('received', scope)).toEqual({ companyId: 'c1', storeId: 's1', returnReceipt: { isNot: null } });
  });

  it('and a courier is an id, or «nobody» — which is a parcel with no company on it', () => {
    expect(courierWhere('11111111-1111-4111-8111-111111111111')).toEqual({ deliveryProviderId: '11111111-1111-4111-8111-111111111111' });
    expect(courierWhere(NO_COURIER)).toEqual({ deliveryProviderId: null });
    expect(isCourierFilter(NO_COURIER)).toBe(true);
    expect(isCourierFilter('11111111-1111-4111-8111-111111111111')).toBe(true);
    for (const bad of ['', 'abc', '1', 'all', undefined, 7, null]) expect(isCourierFilter(bad), String(bad)).toBe(false);
  });
});

describe('the address', () => {
  const ask = (query = '', maySeeContact = true) => returnsFilters(new URLSearchParams(query), { now: NOW, maySeeContact });
  const COURIER = '22222222-2222-4222-8222-222222222222';

  it('— nothing chosen is the work, with no filter at all, and «all» is nothing chosen', () => {
    const r = ask();
    expect(r).toMatchObject({ ok: true, view: 'pending', clauses: [] });
    if (r.ok) expect(r.applied).toEqual({ view: 'pending', status: null, courier: null, age: null, q: null });
    for (const q of ['status=all', 'courier=all', 'age=all', 'view=all', 'status=', 'courier=%20']) {
      const g = ask(q);
      expect(g, q).toMatchObject({ ok: true, clauses: [] });
    }
  });

  it('and each chosen word becomes one clause, in the order they are read', () => {
    const r = ask(`status=FAILED_DELIVERY&courier=${COURIER}&age=old&q=${encodeURIComponent('سارة')}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clauses).toHaveLength(4);
    expect(r.clauses[0]).toEqual({ shippingStatus: 'FAILED_DELIVERY' });
    expect(r.clauses[1]).toEqual({ deliveryProviderId: COURIER });
    expect(r.clauses[2]).toEqual(ageWhere('old', NOW));
    expect((r.clauses[3] as { OR: unknown[] }).OR.length).toBeGreaterThan(3);
    expect(r.applied).toEqual({ view: 'pending', status: 'FAILED_DELIVERY', courier: COURIER, age: 'old', q: 'سارة' });
  });

  it('and the order of the parameters is no part of the question', () => {
    expect(JSON.stringify(ask(`age=old&status=RETURNED&courier=none`))).toBe(JSON.stringify(ask(`courier=none&status=RETURNED&age=old`)));
    expect(JSON.stringify(ask(`barcode=none&age=old&courier=none`))).toBe(JSON.stringify(ask(`courier=none&barcode=none&age=old`)));
  });

  it('and «بلا باركود» is one clause — a barcode that is null or blank — in either view, and only when it was asked for', () => {
    for (const view of ['pending', 'received']) {
      const r = ask(`view=${view}&barcode=none`);
      expect(r, view).toMatchObject({ ok: true, view });
      if (!r.ok) return;
      expect(r.clauses, view).toEqual([noBarcodeWhere]);
      expect(r.applied.barcode, view).toBe('none');
    }
    // «all», blank and absent are no filter — and leave no word behind in what was applied.
    for (const q of ['barcode=all', 'barcode=', 'barcode=%20', '']) {
      const r = ask(q);
      expect(r, q).toMatchObject({ ok: true, clauses: [] });
      if (r.ok) expect(r.applied, q).not.toHaveProperty('barcode');
    }
  });

  it('and the clause finds exactly the parcels that have none: null and blank, never one that has a barcode', () => {
    const rows: Row[] = [{ trackingNumber: null }, { trackingNumber: '' }, { trackingNumber: '100550615867' }, { trackingNumber: 'x' }];
    expect(rows.filter((r) => matches(noBarcodeWhere, r)).map((r) => r.trackingNumber)).toEqual([null, '']);
  });

  it('and it joins the other words — the company and the barcode are two clauses, both asked', () => {
    const r = ask(`courier=${COURIER}&barcode=none`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clauses).toEqual([{ deliveryProviderId: COURIER }, noBarcodeWhere]);
    expect(r.applied).toEqual({ view: 'pending', status: null, courier: COURIER, age: null, q: null, barcode: 'none' });
  });

  it('and the word is known to the screen by one name — «none» — and nothing else is', () => {
    expect(isBarcodeFilter('none')).toBe(true);
    for (const bad of ['', 'all', 'with', 'NONE', 'null', undefined, null, 0]) expect(isBarcodeFilter(bad), String(bad)).toBe(false);
  });

  it.each([
    ['view=everything', 'العرض غير معروف: everything'],
    ['status=SHIPPED', 'الحالة غير معروف: SHIPPED'],
    ['status=returned', 'الحالة غير معروف: returned'],
    ['courier=dhl', 'شركة الشحن غير معروف: dhl'],
    ['age=yesterday', 'العمر غير معروف: yesterday'],
    ['barcode=with', 'فلتر الباركود غير معروف: with'],
    ['barcode=NONE', 'فلتر الباركود غير معروف: NONE'],
  ])('and a value it does not know is refused in Arabic, never ignored — %s', (query, arabic) => {
    const r = ask(query);
    expect(r).toMatchObject({ ok: false, errorAr: arabic });
    if (!r.ok) expect(r.error).toMatch(/^Unknown /);
  });

  it('and in the record of what was received, the state and the age — which describe a parcel not yet counted — are checked and not applied', () => {
    const r = ask('view=received&status=RETURNED&age=old&courier=none');
    expect(r).toMatchObject({ ok: true, view: 'received' });
    if (!r.ok) return;
    expect(r.clauses).toEqual([{ deliveryProviderId: null }]);
    expect(r.applied).toEqual({ view: 'received', status: null, courier: 'none', age: null, q: null });
    // …but a word that is not a word is refused in either view.
    expect(ask('view=received&status=NONSENSE').ok).toBe(false);
    expect(ask('view=received&age=NONSENSE').ok).toBe(false);
  });

  it('and the search is trimmed, capped, and asks every way a parcel is known — the same builder the orders list uses', () => {
    const r = ask(`q=${encodeURIComponent('  ' + 'س'.repeat(300) + '  ')}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Trimmed, THEN capped: the cap alone would give the same length with two spaces inside it.
    expect(r.applied.q).toBe('س'.repeat(100));
    const keys = (r.clauses[0] as { OR: Record<string, unknown>[] }).OR.map((c) => Object.keys(c)[0]);
    expect(keys).toEqual(['orderNumber', 'merchantRef', 'trackingNumber', 'customer', 'customer', 'customer']);
    expect(ask('q=%20%20').ok && (ask('q=%20%20') as { clauses: unknown[] }).clauses).toEqual([]);
  });
});

describe('the search, and whose phone it may confirm', () => {
  const customerKeys = (maySeeContact: boolean) =>
    (returnsSearch('0791234567', maySeeContact) as { OR: { customer?: Record<string, unknown> }[] }).OR
      .filter((c) => c.customer)
      .flatMap((c) => Object.keys(c.customer!));

  it('— a person who may read phones searches the name and both phone columns', () => {
    expect(customerKeys(true).sort()).toEqual(['fullName', 'phone', 'rawPhone']);
  });

  it('and one who may NOT is not given a number-to-parcel oracle: the name stays, the phones go', () => {
    expect(customerKeys(false)).toEqual(['fullName']);
    const fields = (returnsSearch('0791234567', false) as { OR: Record<string, unknown>[] }).OR.map((c) => Object.keys(c)[0]);
    expect(fields).toEqual(['orderNumber', 'merchantRef', 'trackingNumber', 'customer']);
  });

  it('and the order number, the reference and the waybill are searched by everyone', () => {
    for (const may of [true, false]) {
      const fields = (returnsSearch('TRK', may) as { OR: Record<string, unknown>[] }).OR.map((c) => Object.keys(c)[0]);
      for (const f of ['orderNumber', 'merchantRef', 'trackingNumber']) expect(fields, `${may} ${f}`).toContain(f);
    }
  });
});

describe('the page is a place', () => {
  it('— every order ends in its id, so two parcels with the same moment are still two rows and a page never repeats one', () => {
    expect(PENDING_ORDER_BY.at(-1)).toEqual({ id: 'asc' });
    expect(RECEIVED_ORDER_BY.at(-1)).toEqual({ id: 'asc' });
  });

  it('and the waiting ones are oldest first — the return date, then the three states that have none, each by its own date', () => {
    expect(PENDING_ORDER_BY.map((o) => Object.keys(o)[0])).toEqual(['returnedAt', 'failedAt', 'deliveredAt', 'updatedAt', 'id']);
    for (const o of PENDING_ORDER_BY.slice(0, 3)) expect(Object.values(o)[0]).toEqual({ sort: 'asc', nulls: 'last' });
    expect(PENDING_ORDER_BY[3]).toEqual({ updatedAt: 'asc' });
  });

  it('and the record is the latest count first', () => {
    expect(RECEIVED_ORDER_BY[0]).toEqual({ returnReceipt: { inspectedAt: 'desc' } });
  });
});

describe('the module is safe for the screen to import', () => {
  it('— it reaches no server module: no database, no session, no queue', () => {
    const src = stripComments(repoFile('src/lib/returns-filters.ts'));
    for (const forbidden of ["'./db'", "'@/lib/db'", 'next/server', 'next/headers', 'geo-context', 'authorization']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
