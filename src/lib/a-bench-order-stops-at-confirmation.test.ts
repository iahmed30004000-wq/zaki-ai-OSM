import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';
import {
  BENCH_CONFIRMED_AR,
  BENCH_LIST_EMPTY_AR,
  BENCH_STOPS_AR,
  BENCH_STOPS_CODE,
  benchStopsHere,
} from './test-store';
import { isBenchStore } from './bench-store';
import { dispatchReasonAr } from './dispatch-reason';
import { SHIPPING_GONE } from './order-state';

vi.mock('./db', () => ({ db: {} }));

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BENCH ORDER STOPS AT CONFIRMATION (B2, 18/11).
 *
 * «منصة تجريب»: confirmed by the team like a real order, then never packed,
 * never on a trolley, never sent to a courier, and no stock held for it. The
 * door tests live beside each door; this file holds the rule itself and the
 * source tripwires that name the line a removal would break.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const src = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), 'utf8')).replace(/\s+/g, ' ');

describe('the words are the owner’s', () => {
  it('the refusal, the empty list and the label', () => {
    expect(BENCH_STOPS_AR).toBe('هاي طلبية منصّة تجريب — ما بتنشحن');
    expect(BENCH_LIST_EMPTY_AR).toBe('هاي منصّة تجريب — طلباتها بتوقف عند التأكيد');
    expect(BENCH_CONFIRMED_AR).toBe('مؤكَّد — تيست، ما بينشحن');
    expect(BENCH_STOPS_CODE).toBe('TEST_STORE_STOPS_AT_CONFIRMATION');
  });

  it('and no English word reaches a screen', () => {
    for (const s of [BENCH_STOPS_AR, BENCH_LIST_EMPTY_AR, BENCH_CONFIRMED_AR]) expect(s).not.toMatch(/[A-Za-z]/);
  });

  it('and the courier send names it in the same sentence', () => {
    expect(dispatchReasonAr({ skipped: 'TEST_STORE' })).toBe(BENCH_STOPS_AR);
  });
});

describe('benchStopsHere — a NEW step stops, history keeps its road', () => {
  const base = { shippingBatchId: null, shippingStatus: 'NOT_READY', shippedAt: null };

  it('a confirmed order not yet packed stops', () => {
    expect(benchStopsHere(base)).toBe(true);
  });

  it('so does one being packed, or packed and handed back without a trolley', () => {
    expect(benchStopsHere({ ...base, shippingStatus: 'PACKING' })).toBe(true);
    expect(benchStopsHere({ ...base, shippingStatus: 'READY_FOR_SHIPPING' })).toBe(true);
    expect(benchStopsHere({ ...base, shippingStatus: 'READY_FOR_PICKUP' })).toBe(true);
  });

  it('one already on a trolley before its store became a bench keeps it', () => {
    expect(benchStopsHere({ ...base, shippingBatchId: 'b1', shippingStatus: 'READY_FOR_PICKUP' })).toBe(false);
  });

  it('one already gone keeps its road, by status or by the stamp', () => {
    for (const s of SHIPPING_GONE) expect(benchStopsHere({ ...base, shippingStatus: s }), s).toBe(false);
    expect(benchStopsHere({ ...base, shippedAt: new Date() })).toBe(false);
  });
});

describe('isBenchStore — asked as «is it marked», never as «is it real»', () => {
  const txWith = (row: { id: string } | null) => {
    const findFirst = vi.fn(async () => row);
    return { tx: { store: { findFirst } } as never, findFirst };
  };

  it('a marked store is a bench, and the question names the company and the mark', async () => {
    const { tx, findFirst } = txWith({ id: 's9' });
    expect(await isBenchStore(tx, { companyId: 'c1', storeId: 's9' })).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 's9', companyId: 'c1', isTest: true }, select: { id: true } });
  });

  it('a store the question does not find is NOT a bench — a missing row changes nothing', async () => {
    const { tx } = txWith(null);
    expect(await isBenchStore(tx, { companyId: 'c1', storeId: 's1' })).toBe(false);
  });

  it('no store asks nothing', async () => {
    const { tx, findFirst } = txWith({ id: 'x' });
    expect(await isBenchStore(tx, { companyId: 'c1', storeId: null })).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('the tripwires — each names the line a removal would break', () => {
  it('the packing list and the picking assistant read only real stores’ orders', () => {
    const ops = src('src/lib/operations.ts');
    const from = ops.indexOf('export async function preparationGroups');
    expect(ops.slice(from, from + 600), 'التجهيز عاد يعرض طلبات منصّة التجريب').toMatch(
      /shippingStatus: \{ in: \['NOT_READY', 'PACKING'\] \}, \.\.\.realStoresOnly\(\),/
    );
  });

  it('the shelf is never held for a bench order — both reads of reserveOrderLines carry the filter', () => {
    const r = src('src/lib/reservation.ts');
    const from = r.indexOf('export async function reserveOrderLines');
    const body = r.slice(from, r.indexOf('export async function releaseOrderLines'));
    expect(body.match(/where: \{ orderId, order: \{ \.\.\.realStoresOnly\(\) \} \}/g), 'الحجز عاد يحجز لطلب منصّة').toHaveLength(2);
  });

  it('period commission does not run for a bench store', () => {
    expect(src('src/lib/jobs/definitions/accrue-period-commission.ts')).toContain(
      '(await activeStores()).filter((s) => !s.isTest)'
    );
    expect(src('src/lib/jobs/definitions/shared.ts')).toMatch(/isTest: true/);
  });

  it('the list, the detail and the desk carry the mark, derived from the store', () => {
    expect(src('src/app/api/orders/route.ts')).toContain('testStore: store?.isTest === true');
    expect(src('src/app/api/orders/[id]/route.ts')).toContain('const testStore = _store?.isTest === true');
    expect(src('src/app/api/confirmation/mine/route.ts').match(/testStore: o\.store\?\.isTest === true/g)).toHaveLength(2);
    for (const f of [
      'src/components/screens/OrdersScreen.tsx',
      'src/components/orders/OrderDetailModal.tsx',
      'src/components/screens/ConfirmationMineScreen.tsx',
    ]) {
      expect(src(f), f).toContain('<OrderStateBadge state={order.state} testStore={order.testStore} />');
    }
  });

  it('and no new core state was added for it', () => {
    expect(src('src/lib/order-state.ts')).not.toMatch(/TEST|BENCH/);
  });
});
