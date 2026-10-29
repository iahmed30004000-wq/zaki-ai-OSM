import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Order numbering.
 *
 * The defect this covers: the number came from counting rows, so deleting or
 * voiding an order dropped the count back onto a number already in use. The
 * insert then hit the unique index, and on Postgres a failed statement
 * aborts the whole transaction — which meant the retry written to recover
 * from exactly this could not run either.
 *
 * AND THE SECOND ONE (ط41): the highest number was taken as TEXT, and as text
 * «9999» sorts after «10000». After the ten-thousandth order of a year every
 * new order asked for 10000 again and the door failed for the rest of the year.
 * The highest is now read as a NUMBER, in SQL; these tests hand the query a
 * stand-in database that answers it the way Postgres would, so what is pinned
 * is the question asked (company, stem, shape) and what is done with the answer.
 */

/** The text of a tagged-template SQL call, whitespace-flattened. */
const sqlOf = (call: unknown[]) => (call[0] as string[]).join(' ? ').replace(/\s+/g, ' ').trim();

const { db } = vi.hoisted(() => ({ db: { $queryRaw: vi.fn() } }));
vi.mock('./db', () => ({ db }));

import { ORDER_NUMBER_RE, nextOrderNumber, orderRefFields } from './order-ref';

const AT = new Date('2026-09-20T10:00:00Z');

/**
 * A database holding these order numbers, answering the highest-number query as Postgres does: only the company's
 * rows, only those starting with the stem, only a suffix that IS 1–8 digits, and the largest as a NUMBER.
 */
function holding(numbers: { companyId?: string; orderNumber: string }[]) {
  db.$queryRaw.mockImplementation(async (strings: string[], from: number, companyId: string, stem: string) => {
    expect(strings.join(' ? ')).toContain('MAX(CAST(');
    const suffixes = numbers
      .filter((n) => (n.companyId ?? 'c1') === companyId && n.orderNumber.startsWith(stem))
      .map((n) => n.orderNumber.slice(from - 1))
      .filter((s) => /^[0-9]{1,8}$/.test(s))
      .map(Number);
    return [{ highest: suffixes.length ? Math.max(...suffixes) : null }];
  });
}

beforeEach(() => vi.clearAllMocks());

describe('nextOrderNumber', () => {
  it('continues from the highest number issued, not the row count', async () => {
    holding([{ orderNumber: 'ORD-2026-0007' }, { orderNumber: 'ORD-2026-0003' }]);
    expect(await nextOrderNumber(db as never, 'c1', 'ORD', 0, AT)).toBe('ORD-2026-0008');
  });

  it('does not reuse a number after one is deleted', async () => {
    // Six orders remain but 0007 was the highest ever issued.
    holding([1, 2, 3, 4, 5, 7].map((n) => ({ orderNumber: `ORD-2026-000${n}` })));
    const next = await nextOrderNumber(db as never, 'c1', 'ORD', 0, AT);
    expect(next).toBe('ORD-2026-0008');
    expect(next).not.toBe('ORD-2026-0007');
  });

  it('starts at one for a company with no orders this year', async () => {
    holding([]);
    expect(await nextOrderNumber(db as never, 'c1', 'ORD', 0, AT)).toBe('ORD-2026-0001');
  });

  it('steps forward on each retry attempt', async () => {
    holding([{ orderNumber: 'ORD-2026-0007' }]);
    expect(await nextOrderNumber(db as never, 'c1', 'ORD', 1, AT)).toBe('ORD-2026-0009');
    expect(await nextOrderNumber(db as never, 'c1', 'ORD', 2, AT)).toBe('ORD-2026-0010');
  });

  it('looks only at this company, this prefix and this year', async () => {
    holding([
      { orderNumber: 'ORD-2026-0007' },
      { orderNumber: 'ORD-2025-0900' },
      { orderNumber: 'SY-2026-0500' },
      { companyId: 'other', orderNumber: 'ORD-2026-0400' },
    ]);
    expect(await nextOrderNumber(db as never, 'c1', 'ORD', 0, AT)).toBe('ORD-2026-0008');
    const call = db.$queryRaw.mock.calls[0];
    expect(call.slice(1)).toEqual(['ORD-2026-'.length + 1, 'c1', 'ORD-2026-', 'ORD-2026-'.length + 1]);
  });

  it('survives a malformed number already in the table', async () => {
    holding([{ orderNumber: 'ORD-2026-XXXX' }]);
    expect(await nextOrderNumber(db as never, 'c1', 'ORD', 0, AT)).toBe('ORD-2026-0001');
  });

  it('honours a country prefix other than ORD', async () => {
    holding([{ orderNumber: 'SY-2026-0044' }]);
    expect(await nextOrderNumber(db as never, 'c1', 'SY', 0, AT)).toBe('SY-2026-0045');
  });
});

describe('after the ten-thousandth order of a year (ط41)', () => {
  it('the number after 10000 is 10001 — as TEXT «9999» sorts after «10000» and the old reading asked for 10000 again', async () => {
    holding([{ orderNumber: 'XX-2026-9999' }, { orderNumber: 'XX-2026-10000' }]);
    expect(await nextOrderNumber(db as never, 'c1', 'XX', 0, AT)).toBe('XX-2026-10001');
  });

  it('and the number after 9999 is 10000, which the shape still accepts', async () => {
    holding([{ orderNumber: 'XX-2026-9999' }]);
    const n = await nextOrderNumber(db as never, 'c1', 'XX', 0, AT);
    expect(n).toBe('XX-2026-10000');
    expect(ORDER_NUMBER_RE.test(n)).toBe(true);
  });

  it('asks the database for a NUMBER, over a suffix that is digits only', async () => {
    holding([]);
    await nextOrderNumber(db as never, 'c1', 'XX', 0, AT);
    const sql = sqlOf(db.$queryRaw.mock.calls[0]);
    expect(sql).toContain('MAX(CAST(');
    expect(sql).toContain("~ '^[0-9]{1,8}$'");
    // Not a sort of the strings.
    expect(sql).not.toMatch(/ORDER BY/i);
  });

  it('NEGATIVE: with no orders yet it still starts at 0001', async () => {
    holding([]);
    expect(await nextOrderNumber(db as never, 'c1', 'XX', 0, AT)).toBe('XX-2026-0001');
  });
});

describe('orderRefFields', () => {
  it('makes the merchant reference the order number — one identifier, not two', async () => {
    holding([{ orderNumber: 'ORD-2026-0007' }]);
    const refs = await orderRefFields(db as never, 'c1', 'ORD', 0, AT);
    expect(refs).toEqual({ orderNumber: 'ORD-2026-0008', merchantRef: 'ORD-2026-0008' });
  });
});

describe('the shape of an order number', () => {
  it('accepts what the generator actually produces, for any store prefix', async () => {
    // The public upsell route used to carry its own pattern demanding a
    // literal "ORD-". Every Syrian and Jordanian order failed it, so the
    // upsell had never once succeeded.
    for (const prefix of ['SY', 'JO', 'ORD', 'EG1']) {
      holding([]);
      const n = await nextOrderNumber(db as never, 'c1', prefix, 0, AT);
      expect(ORDER_NUMBER_RE.test(n), n).toBe(true);
    }
  });

  it('still refuses something that is not an order number', () => {
    for (const bad of ['', 'SY-2026', 'SY-26-0001', '../../etc', 'SY-2026-0001; DROP', 'sy-2026-0001']) {
      expect(ORDER_NUMBER_RE.test(bad), bad).toBe(false);
    }
  });
});
