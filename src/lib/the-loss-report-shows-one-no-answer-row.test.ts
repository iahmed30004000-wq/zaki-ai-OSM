import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE LOSS REPORT SHOWS ONE «أُغلق بلا رد» ROW, AND THE DATA STAYS TWO (the planner 15/11, answer 8)
 *
 *  1. The close of «لا يرد» is stored under two codes (`NO_ANSWER_3_ATTEMPTS`, `NO_ANSWER_5_ATTEMPTS`). What the screen DRAWS for reasons is one merged row — the sum of the two,
 *     the same fault (`OUR_REACH`) and the same share arithmetic — with the two codes' own lines under it as its `detail`, with their own labels and counts.
 *  2. The data is never merged: `summariseLoss` and `GET /api/analytics/loss` still return one line per code and no merged line; the merge is `lossDisplayLines`, derived from them.
 *  3. A company where only ONE of the two codes holds orders — every company with the plan off, where the new code never occurs — gets its lines back untouched, object for object:
 *     today's single row, today's label, no detail.
 *  4. The merged row ranks where its SUM puts it; the displayed counts still add up to the half's total; nothing is mutated; other reasons and the after-shipping half are untouched.
 *
 * Blockers: any change to the payload or to a stored code; a merged row for a one-code company; a detail row that is not a code's own line; a wrong sum.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn(), count: vi.fn() }, deliveryFee: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: () => true, requirePermission: (...a: unknown[]) => requirePermission(...a) }));

import { GET } from '@/app/api/analytics/loss/route';
import { NO_ANSWER_MERGED_AR, NO_ANSWER_MERGED_KEY, lossDisplayLines, summariseLoss, type LossRow } from './loss-analysis';
import { REJECTION_REASON_AR } from './confirmation-workflow';

const THREE = 'NO_ANSWER_3_ATTEMPTS';
const FIVE = 'NO_ANSWER_5_ATTEMPTS';
const rej = (reason: string, count: number): LossRow => ({ field: 'rejectionReason', reason, count, money: 0 });
const before = (rows: LossRow[]) => summariseLoss(rows).before;

describe('the merge, as a pure display', () => {
  it('both codes: ONE row «أُغلق بلا رد» — the sum, our reach, the share of the half — with the two codes’ own lines under it', () => {
    const half = before([rej(THREE, 6), rej(FIVE, 4), rej('PRICE_TOO_HIGH', 10)]);
    const shown = lossDisplayLines(half);

    // 10 and 10: a tie keeps the place of the merged row's first line.
    expect(shown.map((l) => l.reason)).toEqual(['PRICE_TOO_HIGH', NO_ANSWER_MERGED_KEY]);
    const merged = shown.find((l) => l.reason === NO_ANSWER_MERGED_KEY)!;
    expect(merged).toMatchObject({ field: 'rejectionReason', label: NO_ANSWER_MERGED_AR, fault: 'OUR_REACH', known: true, count: 10, money: 0, share: 50 });
    expect(NO_ANSWER_MERGED_AR).toBe('أُغلق بلا رد');
    // The detail IS the two lines the payload holds — their own labels, counts and shares, the older code first.
    expect(merged.detail!.map((d) => [d.reason, d.label, d.count, d.share])).toEqual([
      [THREE, REJECTION_REASON_AR[THREE], 6, 30],
      [FIVE, REJECTION_REASON_AR[FIVE], 4, 20],
    ]);
    // …and neither code is also drawn on its own at the top level.
    expect(shown.filter((l) => l.reason === THREE || l.reason === FIVE)).toEqual([]);
  });

  it('the data stays separate: the reading still has one line per code and no merged line, before and after the display is asked', () => {
    const half = before([rej(THREE, 6), rej(FIVE, 4), rej('PRICE_TOO_HIGH', 10)]);
    const snapshot = JSON.parse(JSON.stringify(half));
    lossDisplayLines(half);
    expect(JSON.parse(JSON.stringify(half))).toEqual(snapshot);
    expect(half.lines.map((l) => l.reason).sort()).toEqual([FIVE, 'PRICE_TOO_HIGH', THREE].sort());
    expect(half.lines.some((l) => l.reason === NO_ANSWER_MERGED_KEY)).toBe(false);
    expect(half.lines.every((l) => !('detail' in l))).toBe(true);
  });

  it('ONE code only (the older one — every company with the plan off): the lines come back untouched, today’s single row, no detail', () => {
    const half = before([rej(THREE, 7), rej('PRICE_TOO_HIGH', 3)]);
    const shown = lossDisplayLines(half);
    expect(shown).toBe(half.lines);
    const row = shown.find((l) => l.reason === THREE)!;
    expect(row.label).toBe('أُغلق بعد ثلاث محاولات بلا ردّ');
    expect('detail' in row).toBe(false);
    expect(shown.some((l) => l.reason === NO_ANSWER_MERGED_KEY)).toBe(false);
  });

  it('the NEW code alone: also untouched — nothing to merge with, so no merged label and no detail', () => {
    const half = before([rej(FIVE, 5)]);
    expect(lossDisplayLines(half)).toBe(half.lines);
    expect(half.lines[0].label).toBe('أُغلق بعد خمس محاولات بلا ردّ');
  });

  it('neither code, and an empty half: nothing to do', () => {
    expect(lossDisplayLines(before([rej('PRICE_TOO_HIGH', 2)]))).toEqual(before([rej('PRICE_TOO_HIGH', 2)]).lines);
    expect(lossDisplayLines(before([]))).toEqual([]);
  });

  it('a code with no orders is no data: a zero line next to a real one does not make a merged row', () => {
    const real = before([rej(THREE, 4)]);
    const withZero = { count: real.count, lines: [...real.lines, { ...real.lines[0], reason: FIVE, count: 0, share: 0 }] };
    expect(lossDisplayLines(withZero)).toBe(withZero.lines);
  });

  it('ranks by the SUM: two rows that are each smaller than another are together bigger, and the merged row goes first', () => {
    const half = before([rej('PRICE_TOO_HIGH', 5), rej(THREE, 3), rej(FIVE, 4), rej('CUSTOMER_CHANGED_MIND', 2)]);
    expect(half.lines[0].reason).toBe('PRICE_TOO_HIGH'); // each code alone is below it …
    expect(lossDisplayLines(half).map((l) => l.reason)).toEqual([NO_ANSWER_MERGED_KEY, 'PRICE_TOO_HIGH', 'CUSTOMER_CHANGED_MIND']); // … 3 + 4 is not
  });

  it('what is drawn adds up to the half’s total, and the shares to its share', () => {
    const half = before([rej(THREE, 6), rej(FIVE, 4), rej('PRICE_TOO_HIGH', 10), rej('OTHER', 3)]);
    const shown = lossDisplayLines(half);
    expect(shown.reduce((s, l) => s + l.count, 0)).toBe(half.count);
    const merged = shown.find((l) => l.reason === NO_ANSWER_MERGED_KEY)!;
    expect(merged.count).toBe(merged.detail!.reduce((s, d) => s + d.count, 0));
    expect(merged.share).toBe(Math.round((10 / 23) * 10_000) / 100);
  });

  it('only the rejection field merges: the same strings under the after-shipping fields are other lines', () => {
    const half = summariseLoss([rej(THREE, 2), rej(FIVE, 3), { field: 'returnReason', reason: THREE, count: 1, money: 4 }]).after;
    expect(lossDisplayLines(half)).toBe(half.lines);
  });

  it('the merged row is the plain row’s own shape (the screen draws both with one component) with `detail` the only addition', () => {
    const half = before([rej(THREE, 1), rej(FIVE, 1)]);
    const merged = lossDisplayLines(half)[0];
    const plain = half.lines[0];
    expect(Object.keys(merged).sort()).toEqual([...Object.keys(plain), 'detail'].sort());
  });
});

describe('the payload keeps two codes — GET /api/analytics/loss', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireContext.mockResolvedValue({ companyId: 'c1', storeId: 's1' });
    requirePermission.mockResolvedValue({});
    db.deliveryFee.findMany.mockResolvedValue([]);
  });
  const order = (rejectionReason: string) => ({
    rejectionReason, deliveryFailureReason: null, returnReason: null, deliveryFee: 0, productCost: null, estimatedCostOfGoods: null, quantity: 1, regionId: null, deliveryProviderId: null,
  });

  it('a company that closed under both codes: two lines with their own counts, no merged line, no `detail` key anywhere', async () => {
    db.order.findMany.mockResolvedValue([order(THREE), order(THREE), order(FIVE), order('PRICE_TOO_HIGH')]);
    db.order.count.mockResolvedValue(4);
    const body = await (await GET(new Request('http://localhost/api/analytics/loss?period=all'))).json();
    const lines = body.before.lines as { reason: string; count: number; label: string }[];
    expect(lines.find((l) => l.reason === THREE)).toMatchObject({ count: 2, label: 'أُغلق بعد ثلاث محاولات بلا ردّ' });
    expect(lines.find((l) => l.reason === FIVE)).toMatchObject({ count: 1, label: 'أُغلق بعد خمس محاولات بلا ردّ' });
    expect(JSON.stringify(body)).not.toContain(NO_ANSWER_MERGED_KEY);
    expect(JSON.stringify(body)).not.toContain('detail');
    expect(Object.keys(body).sort()).toEqual(['after', 'before', 'period', 'preventable', 'scanned', 'total', 'truncated']);
    // The faults tally already adds them: both are our reach, so the fault row is one number either way.
    expect(body.before.byFault.find((f: { fault: string }) => f.fault === 'OUR_REACH').count).toBe(3);
  });
});
