import { describe, expect, it } from 'vitest';
import { hasLeftWarehouse } from './order-state';
import { SHIPPING_STATUSES } from './shipping-workflow';
import { SEALED_BATCH_STATUSES, handedToCourier, notHandedToCourierWhere } from './order-seal';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE LINE THE CONFIRM GUARD ASKS — «STILL OURS» IS THE SAME RULE AS `handedToCourier`, ASKED OF THE DATABASE.
 *
 * `handedToCourier` answers about a row in hand. The guard must FIND the confirmed twins the courier has not taken, so the same
 * three facts are rendered as a `where` (`notHandedToCourierWhere`). Two renderings of one rule is the defect this repository keeps
 * finding; it is acceptable only when they are held to each other — so this evaluates the `where` against EVERY combination of the
 * three inputs (generated, not sampled) and requires it to be exactly the negation of the function.
 *
 * The evaluator below is strict on purpose: a key or an operator it does not know throws, so a `where` that grew a clause nobody
 * taught the test is a red test and not a silent pass.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = { shippedAt: Date | null; shippingStatus: string; shippingBatchId: string | null; shippingBatch: { status: string } | null };

function holds(value: unknown, filter: unknown): boolean {
  if (filter === null) return value === null || value === undefined;
  if (typeof filter !== 'object') return value === filter;
  return Object.entries(filter as Record<string, unknown>).every(([op, arg]) => {
    if (op === 'notIn') return !(arg as unknown[]).includes(value);
    throw new Error(`the evaluator does not know the operator «${op}» — teach it before trusting it`);
  });
}

function evaluate(row: Row, where: unknown): boolean {
  return Object.entries(where as Record<string, unknown>).every(([key, value]) => {
    if (key === 'AND') return (value as unknown[]).every((w) => evaluate(row, w));
    if (key === 'OR') return (value as unknown[]).some((w) => evaluate(row, w));
    if (key === 'shippingBatch') {
      const rel = value as { is?: unknown };
      if (!('is' in rel)) throw new Error('the evaluator only knows `shippingBatch.is`');
      return row.shippingBatch !== null && evaluate(row.shippingBatch as unknown as Row, rel.is);
    }
    if (key === 'shippedAt' || key === 'shippingStatus' || key === 'shippingBatchId' || key === 'status') {
      return holds((row as unknown as Record<string, unknown>)[key], value);
    }
    throw new Error(`the evaluator does not know the key «${key}» — teach it before trusting it`);
  });
}

const BATCHES: (string | null)[] = [null, 'READY', ...SEALED_BATCH_STATUSES, 'SOMETHING_ELSE'];
const SHIPPED_AT: (Date | null)[] = [null, new Date('2026-11-01T10:00:00.000Z')];

function everyRow(): Row[] {
  const rows: Row[] = [];
  for (const shippedAt of SHIPPED_AT) {
    for (const shippingStatus of SHIPPING_STATUSES) {
      for (const batch of BATCHES) {
        rows.push({
          shippedAt,
          shippingStatus,
          shippingBatchId: batch ? 'b1' : null,
          shippingBatch: batch ? { status: batch } : null,
        });
      }
    }
  }
  return rows;
}

describe('notHandedToCourierWhere is exactly «not handedToCourier»', () => {
  const rows = everyRow();

  it('covers every shipping status, with and without a stamp, on no trolley and on each kind of trolley', () => {
    expect(rows).toHaveLength(SHIPPED_AT.length * SHIPPING_STATUSES.length * BATCHES.length);
    expect(rows.length).toBeGreaterThan(100);
  });

  it('agrees with the function on every one of them', () => {
    const disagree = rows.filter(
      (r) =>
        evaluate(r, notHandedToCourierWhere()) !==
        !handedToCourier({ shippingStatus: r.shippingStatus, shippedAt: r.shippedAt, batchStatus: r.shippingBatch?.status ?? null })
    );
    expect(
      disagree.map((r) => `${r.shippingStatus} · shippedAt=${r.shippedAt ? 'set' : 'null'} · trolley=${r.shippingBatch?.status ?? 'none'}`),
      'الصيغتان اختلفتا'
    ).toEqual([]);
  });

  it('and the test can see a disagreement: both answers occur, so an always-true or always-false where would fail it', () => {
    const answers = new Set(rows.map((r) => evaluate(r, notHandedToCourierWhere())));
    expect(answers).toEqual(new Set([true, false]));
  });
});

describe('what the line is, in the cases a person will ask about', () => {
  const ours = (r: Partial<Row> & { batch?: string | null }) =>
    evaluate(
      {
        shippedAt: r.shippedAt ?? null,
        shippingStatus: r.shippingStatus ?? 'NOT_READY',
        shippingBatchId: r.batch ? 'b1' : null,
        shippingBatch: r.batch ? { status: r.batch } : null,
      },
      notHandedToCourierWhere()
    );

  it('an order never batched is still ours — the commonest one, and the one a negated relation filter would silently drop', () => {
    expect(ours({})).toBe(true);
  });

  it('a parcel packed, labelled and waiting on an OPEN trolley is still ours: the box can be opened until «إغلاق الشحنة»', () => {
    expect(ours({ shippingStatus: 'READY_FOR_PICKUP', batch: 'READY' })).toBe(true);
  });

  it('the same parcel on a trolley the press has closed is the company’s, whatever its own status still says', () => {
    expect(ours({ shippingStatus: 'READY_FOR_PICKUP', batch: 'SHIPPED' })).toBe(false);
    expect(ours({ shippingStatus: 'READY_FOR_PICKUP', batch: 'CLOSED' })).toBe(false);
  });

  it('a stamped shippedAt is enough on its own', () => {
    expect(ours({ shippedAt: new Date('2026-11-01T10:00:00.000Z') })).toBe(false);
  });

  it('it is NOT the 28/09 waybill line: a labelled parcel on the pickup shelf has «left the warehouse» for stock and is still ours here', () => {
    const packed = { shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: new Date('2026-11-01T09:00:00.000Z'), confirmationStatus: 'CONFIRMED' };
    expect(hasLeftWarehouse(packed)).toBe(true);
    expect(ours({ shippingStatus: 'READY_FOR_PICKUP', batch: 'READY' })).toBe(true);
  });
});
