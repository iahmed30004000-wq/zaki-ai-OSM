import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';
import { fingerprintOf, type LegacyRow } from './legacy-closeout';
import {
  measurePicked,
  readNamedBy,
  readPicked,
  stillClosablePickedWhere,
  type NamedBy,
  type PickedRead,
  type PickedRow,
} from './legacy-closeout-picked';
import { LEGACY_CLOSE_ACTION, PICKED_CLOSE_AUDIT, PICKED_CLOSE_NOTE, PICKED_MOST, PICKED_RECENT_DAYS } from './legacy-closeout-words';
import { describeAction } from './audit-view';

/**
 * «أقفل المحدّد بلا حركة مال» (13/11) — THE RULES OF THE PRESS ON TICKED ORDERS, WITHOUT A DATABASE.
 *
 *   «اقدر اعمل هالحركة هاي لاي طلب حتى لو عليه باركود، بس بدي الزر هاد متاح للمالك فقط» (the owner)
 *
 * What it closes (any barcode, any age), what it still leaves and the reason said in words, and the promise it keeps like the old
 * press: «بدون ما تأثر على المالية». The door's own cases (gates, refusals, what is written) are in `picked.test.ts` beside the route.
 */

const NOW = new Date('2026-11-13T00:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

let seq = 0;
const row = (over: Partial<PickedRow> = {}): PickedRow => {
  seq += 1;
  return {
    id: `o${seq}`,
    orderNumber: `ORD-${seq}`,
    merchantRef: `ORD-${seq}`,
    trackingNumber: null,
    deliveryProviderId: 'p1',
    settlementStatus: 'PENDING',
    shippingStatus: 'DELIVERED',
    at: daysAgo(40),
    currency: 'USD',
    value: 20,
    courier: 'الباشا',
    ...over,
  };
};
const read = (rows: PickedRow[], over: Partial<PickedRead> = {}): PickedRead => ({
  rows,
  asked: rows.length + (over.missing ?? 0),
  missing: 0,
  named: new Map<string, NamedBy>(),
  ...over,
});

describe('what the press closes — the ticked orders, with or without a barcode, of any age', () => {
  it('closes an order WITH a barcode (the owner: «حتى لو عليه باركود») and counts how many carry one', () => {
    const a = row({ trackingNumber: 'BP-1' });
    const b = row({ trackingNumber: null });
    const c = row({ trackingNumber: '' });
    const { measure, rows } = measurePicked(read([a, b, c]), NOW);
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    expect(measure.closeable.count).toBe(3);
    // A blank barcode is no barcode — the screen draws both as «—».
    expect(measure.closeable.withBarcode).toBe(1);
  });

  it('closes an order of YESTERDAY too — and says how many are recent, because their cash may still be in the courier’s hand', () => {
    const old = row({ at: daysAgo(40) });
    const lastWeek = row({ at: daysAgo(5) });
    const yesterday = row({ at: daysAgo(1) });
    const { measure, rows } = measurePicked(read([old, lastWeek, yesterday]), NOW);
    expect(rows).toHaveLength(3);
    expect(measure.closeable.recent).toBe(2);
    expect(measure.recentDays).toBe(PICKED_RECENT_DAYS);
    expect(PICKED_RECENT_DAYS).toBe(14);
  });

  it('«recent» is «not older than the cut», the old press’s own edge: exactly 14 days old is still recent, 15 is not', () => {
    const edge = row({ at: daysAgo(14) });
    const older = row({ at: new Date(daysAgo(14).getTime() - 1) });
    expect(measurePicked(read([edge]), NOW).measure.closeable.recent).toBe(1);
    expect(measurePicked(read([older]), NOW).measure.closeable.recent).toBe(0);
  });

  it('says whose they are (biggest first), the oldest and newest day, and their value per currency', () => {
    const rows = [
      row({ courier: 'الباشا', at: daysAgo(30), value: 25 }),
      row({ courier: 'الباشا', at: daysAgo(10), value: 15 }),
      row({ courier: 'الو دليفيري', at: daysAgo(2), value: 10, currency: 'JOD' }),
    ];
    const { measure } = measurePicked(read(rows), NOW);
    expect(measure.closeable.byCourier).toEqual([
      { name: 'الباشا', count: 2 },
      { name: 'الو دليفيري', count: 1 },
    ]);
    expect(measure.closeable.value).toEqual([
      { currency: 'JOD', amount: 10 },
      { currency: 'USD', amount: 40 },
    ]);
    expect(measure.closeable.oldestAt).toBe(daysAgo(30).toISOString());
    expect(measure.closeable.newestAt).toBe(daysAgo(2).toISOString());
  });

  it('nothing ticked that qualifies is an empty answer, not an error — with a zero fingerprint of nothing', () => {
    const { measure, rows } = measurePicked(read([row({ shippingStatus: 'SHIPPED' })]), NOW);
    expect(rows).toEqual([]);
    expect(measure.closeable).toMatchObject({ count: 0, oldestAt: null, newestAt: null, byCourier: [], value: [], withBarcode: 0, recent: 0 });
    expect(measure.closeable.fingerprint).toBe(fingerprintOf([]));
  });
});

describe('what it still leaves alone — each one said in words, by its number', () => {
  it('an order that is not delivered: nothing was handed over, so nothing is owed', () => {
    for (const s of ['NOT_READY', 'READY_FOR_SHIPPING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'RETURNED', 'CANCELLED']) {
      const r = row({ shippingStatus: s });
      const { measure, rows } = measurePicked(read([r]), NOW);
      expect(rows, s).toEqual([]);
      expect(measure.left, s).toEqual([{ orderNumber: r.orderNumber, why: 'NOT_DELIVERED', text: `${r.orderNumber} — مش مسلَّم بعد.` }]);
    }
  });

  it('a partly delivered order IS closed — it arrived, and «بانتظار التحصيل» counts it', () => {
    expect(measurePicked(read([row({ shippingStatus: 'PARTIALLY_DELIVERED' })]), NOW).rows).toHaveLength(1);
  });

  it('an order already settled', () => {
    const r = row({ settlementStatus: 'SETTLED' });
    expect(measurePicked(read([r]), NOW).measure.left).toEqual([{ orderNumber: r.orderNumber, why: 'ALREADY_SETTLED', text: `${r.orderNumber} — مسوّى من قبل.` }]);
  });

  it('a settlement state that carries money is never closed without it (the courier holds it, part-settled, refunded)', () => {
    for (const s of ['COLLECTED', 'PARTIALLY_SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED']) {
      const r = row({ settlementStatus: s });
      const { measure, rows } = measurePicked(read([r]), NOW);
      expect(rows, s).toEqual([]);
      expect(measure.left[0].why, s).toBe('MONEY_RECORDED');
      expect(measure.left[0].text).toContain(r.orderNumber);
    }
  });

  it('the four states it may close are exactly the ones with no money recorded', () => {
    for (const s of ['NOT_APPLICABLE', 'PENDING', 'PENDING_COLLECTION', 'UNSETTLED']) {
      expect(measurePicked(read([row({ settlementStatus: s })]), NOW).rows, s).toHaveLength(1);
    }
  });

  it('an order a statement speaks for is left to the statement — the collect door’s own sentence is what is said', () => {
    const r = row({ trackingNumber: 'BP-9' });
    const sentence = `الطلب ${r.orderNumber} بكشف ما انعتمد بعد — مصاريه بتنسجّل لما ينعتمد الكشف`;
    const named = new Map<string, NamedBy>([[r.id, { code: 'ON_UNAPPROVED_STATEMENT', error: sentence }]]);
    const { measure, rows } = measurePicked(read([r], { named }), NOW);
    expect(rows).toEqual([]);
    expect(measure.left).toEqual([{ orderNumber: r.orderNumber, why: 'ON_A_STATEMENT', text: sentence }]);
  });

  it('the FIRST refusal that applies is the one said (not delivered beats settled beats money beats a statement)', () => {
    const r = row({ shippingStatus: 'SHIPPED', settlementStatus: 'SETTLED' });
    const named = new Map<string, NamedBy>([[r.id, { code: 'x', error: 'كشف' }]]);
    expect(measurePicked(read([r], { named }), NOW).measure.left[0].why).toBe('NOT_DELIVERED');
    const s = row({ settlementStatus: 'SETTLED' });
    expect(measurePicked(read([s], { named: new Map([[s.id, { code: 'x', error: 'كشف' }]]) }), NOW).measure.left[0].why).toBe('ALREADY_SETTLED');
    const m = row({ settlementStatus: 'COLLECTED' });
    expect(measurePicked(read([m], { named: new Map([[m.id, { code: 'x', error: 'كشف' }]]) }), NOW).measure.left[0].why).toBe('MONEY_RECORDED');
  });

  it('a ticked id that is no order of this store is said FIRST and counted — «حدّث الصفحة»', () => {
    const r = row({ shippingStatus: 'SHIPPED' });
    const { measure } = measurePicked(read([r], { missing: 2, asked: 3 }), NOW);
    expect(measure.asked).toBe(3);
    expect(measure.leftTotal).toBe(3);
    expect(measure.left[0]).toEqual({ orderNumber: null, why: 'NOT_FOUND', text: '2 طلب محدَّد ما انلقى بهالمتجر — حدّث الصفحة.' });
    expect(measure.left[1].why).toBe('NOT_DELIVERED');
  });

  it('the list of refusals is the first 30; the true count is `leftTotal`, and the closeable ones are never cut', () => {
    const refused = Array.from({ length: 45 }, () => row({ shippingStatus: 'SHIPPED' }));
    const fine = row();
    const { measure, rows } = measurePicked(read([...refused, fine]), NOW);
    expect(measure.left).toHaveLength(30);
    expect(measure.leftTotal).toBe(45);
    expect(rows.map((r) => r.id)).toEqual([fine.id]);
    // They follow the order the screen read them (the order they were ticked).
    expect(measure.left.map((l) => l.orderNumber)).toEqual(refused.slice(0, 30).map((r) => r.orderNumber));
  });
});

describe('the fingerprint is what the screen saw', () => {
  it('the same orders give the same one, in any order — and another set gives another', () => {
    const [a, b, c] = [row(), row(), row()];
    const one = measurePicked(read([a, b]), NOW).measure.closeable.fingerprint;
    expect(measurePicked(read([b, a]), NOW).measure.closeable.fingerprint).toBe(one);
    expect(measurePicked(read([a, b, c]), NOW).measure.closeable.fingerprint).not.toBe(one);
    expect(one).toMatch(/^[0-9a-f]{24}$/);
  });

  it('an order that stops qualifying (it was collected a moment ago) changes what the press would close', () => {
    const [a, b] = [row(), row()];
    const before = measurePicked(read([a, b]), NOW).measure.closeable;
    const after = measurePicked(read([a, { ...b, settlementStatus: 'SETTLED' }]), NOW).measure.closeable;
    expect(after.count).toBe(before.count - 1);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

describe('the questions it asks the database', () => {
  const scope = { companyId: 'c1', storeId: 's1' };

  it('the claim names the delivered statuses and the states with no money — and NOT the barcode — in this store, for these ids only', () => {
    expect(stillClosablePickedWhere(scope, ['a', 'b'])).toEqual({
      companyId: 'c1',
      storeId: 's1',
      id: { in: ['a', 'b'] },
      shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] },
      settlementStatus: { in: ['NOT_APPLICABLE', 'PENDING', 'PENDING_COLLECTION', 'UNSETTLED'] },
    });
  });

  const statement = (approved = false, deliveryProviderId = 'p1') => ({ reference: 'ST-1', status: approved ? 'APPROVED' : 'DRAFT', approvedAt: approved ? new Date() : null, deliveryProviderId });
  const tx = (lines: unknown[], links: unknown[], orders: unknown[] = []) => ({
    order: { findMany: vi.fn(async (_a: { where: unknown }) => orders) },
    statementLine: { findMany: vi.fn(async (_a: { where: unknown }) => lines) },
    settlementMatch: { findMany: vi.fn(async (_a: { where: unknown }) => links) },
  });

  it('reads the ticked ids of THIS store only, each once', async () => {
    const t = tx([], []);
    const got = await readPicked(t as never, scope, ['a', 'b', 'a']);
    expect(t.order.findMany).toHaveBeenCalledTimes(1);
    expect(t.order.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1', storeId: 's1', id: { in: ['a', 'b'] } });
    expect(got.asked).toBe(2);
    expect(got.missing).toBe(2);
  });

  it('more ticked orders than one press may carry is refused before a single order is read', async () => {
    const t = tx([], []);
    const many = Array.from({ length: PICKED_MOST + 1 }, (_, i) => `id${i}`);
    await expect(readPicked(t as never, scope, many)).rejects.toMatchObject({ status: 400, body: { code: 'TOO_MANY' } });
    expect(t.order.findMany).not.toHaveBeenCalled();
  });

  it('a line carrying the order’s reference names it — and the sentence is the gate’s own', async () => {
    const a = row({ merchantRef: 'SY-100', orderNumber: 'SY-100' });
    const b = row({ merchantRef: 'SY-200' });
    const t = tx([{ merchantRef: 'SY-100', barcode: null, statement: statement(), matches: [] }], []);
    const named = await readNamedBy(t as never, scope, [a, b] as LegacyRow[]);
    expect([...named.keys()]).toEqual([a.id]);
    expect(named.get(a.id)?.code).toBe('ON_UNAPPROVED_STATEMENT');
    expect(named.get(a.id)?.error).toContain('SY-100');
  });

  it('a line carrying the courier’s BARCODE names the order too — but only inside that courier (a barcode is unique per company)', async () => {
    const mine = row({ merchantRef: null, trackingNumber: 'BP-77', deliveryProviderId: 'p1' });
    const same = tx([{ merchantRef: null, barcode: 'BP-77', statement: statement(false, 'p1'), matches: [] }], []);
    expect([...(await readNamedBy(same as never, scope, [mine] as LegacyRow[])).keys()]).toEqual([mine.id]);
    // The same digits on ANOTHER courier's statement are another parcel.
    const other = tx([{ merchantRef: null, barcode: 'BP-77', statement: statement(false, 'p2'), matches: [] }], []);
    expect([...(await readNamedBy(other as never, scope, [mine] as LegacyRow[])).keys()]).toEqual([]);
  });

  it('the statement line is read WITH what the rule needs: its statement’s reference, status, approval and COURIER, and whether the matching excluded it — a fake that answers whole rows would hide the loss of any of them', async () => {
    const t = tx([], []);
    await readNamedBy(t as never, scope, [row({ merchantRef: 'SY-1', trackingNumber: 'BP-1' })] as LegacyRow[]);
    const statementPart = { select: { reference: true, status: true, approvedAt: true, deliveryProviderId: true } };
    expect(t.statementLine.findMany.mock.calls[0][0]).toMatchObject({
      select: { merchantRef: true, barcode: true, statement: statementPart, matches: { select: { result: true } } },
    });
    expect(t.settlementMatch.findMany.mock.calls[0][0]).toMatchObject({
      select: { orderId: true, result: true, statement: statementPart },
    });
  });

  it('an APPROVED statement is said differently from a draft one — its money is in', async () => {
    const a = row({ merchantRef: 'SY-100', orderNumber: 'SY-100' });
    const t = tx([{ merchantRef: 'SY-100', barcode: null, statement: statement(true), matches: [] }], []);
    expect((await readNamedBy(t as never, scope, [a] as LegacyRow[])).get(a.id)?.code).toBe('IN_APPROVED_STATEMENT');
  });

  it('a line the matching EXCLUDED carries no money for the order, so it does not name it', async () => {
    const a = row({ merchantRef: 'SY-100' });
    const t = tx([{ merchantRef: 'SY-100', barcode: null, statement: statement(), matches: [{ result: 'EXCLUDED' }] }], []);
    expect((await readNamedBy(t as never, scope, [a] as LegacyRow[])).size).toBe(0);
  });

  it('a line a person tied to the order by hand names it, whatever reference it carries', async () => {
    const a = row({ merchantRef: null });
    const t = tx([], [{ orderId: a.id, result: 'MATCHED', statement: statement() }]);
    expect([...(await readNamedBy(t as never, scope, [a] as LegacyRow[])).keys()]).toEqual([a.id]);
  });

  it('asks for this store’s statements only, in ONE question for references and barcodes together — as the collect door does', async () => {
    const t = tx([], []);
    await readNamedBy(t as never, scope, [row({ merchantRef: 'SY-1', trackingNumber: 'BP-1' }), row({ merchantRef: null, trackingNumber: null })] as LegacyRow[]);
    expect(t.statementLine.findMany).toHaveBeenCalledTimes(1);
    expect(t.statementLine.findMany.mock.calls[0][0].where).toEqual({
      statement: { companyId: 'c1', storeId: 's1' },
      OR: [{ merchantRef: { in: ['SY-1'] } }, { barcode: { in: ['BP-1'] } }],
    });
    expect(t.settlementMatch.findMany.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', statementLineId: { not: null } });
  });

  it('no orders, no questions — and an order that carries neither reference nor barcode asks only for the hand links', async () => {
    const t = tx([], []);
    expect((await readNamedBy(t as never, scope, [])).size).toBe(0);
    expect(t.statementLine.findMany).not.toHaveBeenCalled();
    expect(t.settlementMatch.findMany).not.toHaveBeenCalled();
    await readNamedBy(t as never, scope, [row({ merchantRef: null, trackingNumber: null })] as LegacyRow[]);
    expect(t.statementLine.findMany).not.toHaveBeenCalled();
    expect(t.settlementMatch.findMany).toHaveBeenCalledTimes(1);
  });

  it('statements are asked about only for the orders that could be closed — a settled or undelivered one is not a question', async () => {
    const ok = { ...row(), settlementStatus: 'PENDING', shippingStatus: 'DELIVERED' };
    const settled = { ...row(), settlementStatus: 'SETTLED', shippingStatus: 'DELIVERED' };
    const shipped = { ...row(), settlementStatus: 'PENDING', shippingStatus: 'SHIPPED' };
    const asRow = (r: PickedRow) => ({
      id: r.id, orderNumber: r.orderNumber, merchantRef: r.merchantRef, trackingNumber: r.trackingNumber, deliveryProviderId: r.deliveryProviderId,
      settlementStatus: r.settlementStatus, shippingStatus: r.shippingStatus, deliveredAt: r.at, shippedAt: null, createdAt: r.at, currency: 'USD', totalAmount: 20, deliveryProvider: { name: 'الباشا' },
    });
    const t = tx([], [], [asRow(ok), asRow(settled), asRow(shipped)]);
    await readPicked(t as never, scope, [ok.id, settled.id, shipped.id]);
    const where = t.settlementMatch.findMany.mock.calls[0][0].where as { orderId: { in: string[] } };
    expect(where.orderId.in).toEqual([ok.id]);
  });
});

describe('«بدون ما تأثر على المالية» — the press on ticked orders has no way to reach the money either', () => {
  const root = process.cwd();
  const read2 = (f: string) => stripComments(readFileSync(join(root, f), 'utf8'));
  const sources = {
    'src/lib/legacy-closeout-picked.ts': read2('src/lib/legacy-closeout-picked.ts'),
    'src/app/api/ops/tracking/close-legacy/picked/route.ts': read2('src/app/api/ops/tracking/close-legacy/picked/route.ts'),
    'src/components/screens/tracking/ClosePickedDialog.tsx': read2('src/components/screens/tracking/ClosePickedDialog.tsx'),
  };

  // Everything that moves money, makes commission payable, writes the courier's figure, moves stock or tells another system.
  const FORBIDDEN = [
    'walletMovement',
    'recordMovement',
    'reverseMovement',
    'markPayableForOrders',
    'promoteSettledToPayable',
    'commissionEntry',
    'accrueForOrder',
    'collectedAmount',
    'financialTransaction',
    'consumeOrderStock',
    'restoreOrderStock',
    'emitAppEvent',
    '$executeRaw',
    '$queryRaw',
  ];
  for (const [file, src] of Object.entries(sources)) {
    it(`${file} names none of them`, () => {
      expect(FORBIDDEN.filter((w) => src.includes(w)), 'بابٌ يلمس المال').toEqual([]);
    });
  }

  it('the only order column it writes is the settlement status, and only to SETTLED — once', () => {
    const src = sources['src/lib/legacy-closeout-picked.ts'];
    const writes = [...src.matchAll(/tx\.order\.(update|updateMany|create|createMany|delete|deleteMany|upsert)\(/g)].map((m) => m[1]);
    expect(writes).toEqual(['updateMany']);
    expect(src).toMatch(/data: \{ settlementStatus: 'SETTLED' \}/);
  });

  it('it never writes the log or the mark itself: both go through the ONE `markClosed` the old press uses', () => {
    const src = sources['src/lib/legacy-closeout-picked.ts'];
    expect(src).not.toContain('orderStatusLog');
    expect(src).not.toContain('orderActivity');
    expect(src).toContain('await markClosed(tx,');
    // ...and that function writes THE MARK the commission rule reads.
    expect(read2('src/lib/legacy-closeout.ts')).toContain('action: LEGACY_CLOSE_ACTION');
    expect(LEGACY_CLOSE_ACTION).toBe('LEGACY_CLOSED_NO_MONEY');
  });

  it('claim FIRST, then the second look at the statements, then the log and the mark — in that order in the source', () => {
    const src = sources['src/lib/legacy-closeout-picked.ts'];
    const claim = src.indexOf('tx.order.updateMany(');
    const late = src.indexOf('const late = await readNamedBy(');
    const mark = src.indexOf('await markClosed(tx,');
    expect(claim).toBeGreaterThan(-1);
    expect(late, 'the re-read is gone').toBeGreaterThan(claim);
    expect(mark, 'the mark is written before the re-read').toBeGreaterThan(late);
  });

  it('the press refuses before it claims: the read, the nothing-to-close and the changed checks all sit above the claim', () => {
    const src = sources['src/lib/legacy-closeout-picked.ts'];
    const claim = src.indexOf('tx.order.updateMany(');
    for (const needle of ['await readPicked(tx,', "code: 'NOTHING_TO_CLOSE'", "code: 'CHANGED'"]) {
      const at = src.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      expect(at, `${needle} must come before the claim`).toBeLessThan(claim);
    }
  });
});

describe('every word the owner can see for the press is Arabic', () => {
  const root = process.cwd();
  const arabicOnly = (s: string) => /[؀-ۿ]/.test(s) && !/[A-Za-z]/.test(s);

  it('the audit screen names this press in Arabic, not by its code', () => {
    const said = describeAction(PICKED_CLOSE_AUDIT, 'Store');
    expect(said).not.toBe(PICKED_CLOSE_AUDIT);
    expect(arabicOnly(said), said).toBe(true);
  });

  it('the sentence on every settlement-log line of an order he ticked is Arabic — and says it was his decision', () => {
    expect(arabicOnly(PICKED_CLOSE_NOTE)).toBe(true);
    expect(PICKED_CLOSE_NOTE).toContain('بقرار المالك');
  });

  it('the order timeline word for the mark is true for BOTH presses (it no longer says «طلب قديم قبل التسوية»)', () => {
    const src = readFileSync(join(root, 'src/lib/order-timeline.ts'), 'utf8');
    const word = /LEGACY_CLOSED_NO_MONEY: '([^']+)'/.exec(src)?.[1] ?? '';
    expect(arabicOnly(word), word).toBe(true);
    expect(word).not.toContain('قديم');
  });
});
