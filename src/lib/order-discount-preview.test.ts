import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewOrderDiscount } from './order-discount-preview';
import { allocateDiscount, computeCod } from './money';
import { stripComments } from './guard-source';

/**
 * «بعد الخصم» — the figure the card shows while the discount box is being
 * typed in. Every number below is worked by hand in the comment beside it.
 *
 * The round trip against the REAL `PATCH /api/orders/[id]` (the preview and
 * the save writing the same total and the same shares) is in
 * `src/app/api/orders/[id]/the-discount-answers.test.ts`.
 */

const lines = (...pairs: [number, string | undefined][]) => pairs.map(([quantity, price]) => ({ quantity, price }));

describe('Ⅰ · the discount box answers at once, by the server’s own maths', () => {
  it('the order in the photo: 5 pieces for 125, 10 off, in dollars — 115 after it', () => {
    const p = previewOrderDiscount({ lines: lines([5, '125']), discount: '10', minorUnit: 2 });
    expect(p).toEqual({ kind: 'ok', goods: 125, discount: 10, after: 115, shares: [10], linesAfter: [115] });
  });

  it('two lines, JOD: 36 and 10 with 4.600 off — 3.600 and 1.000 off them, 41.400 after', () => {
    // 4.6 × 36/46 = 3.6 and 4.6 × 10/46 = 1.0; the shares add up to the box exactly
    const p = previewOrderDiscount({ lines: lines([3, '36'], [2, '10']), discount: '4.6', minorUnit: 3 });
    expect(p).toEqual({ kind: 'ok', goods: 46, discount: 4.6, after: 41.4, shares: [3.6, 1], linesAfter: [32.4, 9] });
  });

  it('SYP, no decimals: 1001 and 2002 with 100 off — 33 and 67 (the remainder lands on the larger line)', () => {
    // 100 × 1/3 = 33.33 → 33 and 100 × 2/3 = 66.67 → 67; together exactly the 100 typed
    const p = previewOrderDiscount({ lines: lines([1, '1001'], [2, '2002']), discount: '100', minorUnit: 0 });
    expect(p.kind).toBe('ok');
    if (p.kind !== 'ok') return;
    expect(p.shares).toEqual([33, 67]);
    expect(p.discount).toBe(100);
    expect(p.after).toBe(2903);
  });

  it('the shares always add up to the discount taken, to the last decimal', () => {
    const p = previewOrderDiscount({ lines: lines([1, '33.333'], [1, '33.333'], [1, '33.334']), discount: '10', minorUnit: 3 });
    expect(p.kind).toBe('ok');
    if (p.kind !== 'ok') return;
    expect(Math.round(p.shares.reduce((a, b) => a + b, 0) * 1000)).toBe(10000);
  });

  it('an emptied discount box is no discount — as the card sends it — and the goods stand', () => {
    const p = previewOrderDiscount({ lines: lines([2, '40']), discount: '', minorUnit: 2 });
    expect(p).toEqual({ kind: 'ok', goods: 40, discount: 0, after: 40, shares: [0], linesAfter: [40] });
  });

  it('a discount finer than the currency is rounded the way the door rounds it', () => {
    // 0.0005 at three places is 0.001 (half away from zero) — the figure the order will carry
    const p = previewOrderDiscount({ lines: lines([1, '10']), discount: '0.0005', minorUnit: 3 });
    expect(p).toMatchObject({ kind: 'ok', discount: 0.001, after: 9.999 });
  });
});

describe('Ⅱ · the refusals come before the press, with the same reasons the door has', () => {
  it('all of it off is allowed — the door takes a discount EQUAL to the goods', () => {
    expect(previewOrderDiscount({ lines: lines([5, '125']), discount: '125', minorUnit: 2 })).toMatchObject({ kind: 'ok', after: 0 });
  });

  it('a cent more than the goods is too big, and says how much the goods are', () => {
    expect(previewOrderDiscount({ lines: lines([5, '125']), discount: '125.01', minorUnit: 2 })).toEqual({ kind: 'tooBig', goods: 125 });
  });

  it('too big is asked on the TYPED figure: 125.004 in dollars is over 125.00 even though it rounds to it', () => {
    // the door compares what was sent with the subtotal, not what it rounds to
    expect(previewOrderDiscount({ lines: lines([5, '125']), discount: '125.004', minorUnit: 2 }).kind).toBe('tooBig');
  });

  it('below zero, or past the largest the door takes, is invalid — not a figure', () => {
    expect(previewOrderDiscount({ lines: lines([1, '10']), discount: '-1', minorUnit: 2 }).kind).toBe('invalid');
    expect(previewOrderDiscount({ lines: lines([1, '10']), discount: '100001', minorUnit: 2 }).kind).toBe('invalid');
  });

  it('with a price box empty (or the currency not loaded yet) there is nothing true to show', () => {
    expect(previewOrderDiscount({ lines: lines([1, undefined]), discount: '5', minorUnit: 2 }).kind).toBe('unknown');
    expect(previewOrderDiscount({ lines: lines([1, '10'], [1, undefined]), discount: '5', minorUnit: 2 }).kind).toBe('unknown');
    expect(previewOrderDiscount({ lines: lines([1, '10']), discount: '5', minorUnit: undefined }).kind).toBe('unknown');
    expect(previewOrderDiscount({ lines: [], discount: '5', minorUnit: 2 }).kind).toBe('unknown');
  });

  it('a price below zero is not a price the door accepts', () => {
    expect(previewOrderDiscount({ lines: lines([1, '-10']), discount: '0', minorUnit: 2 }).kind).toBe('unknown');
  });
});

describe('Ⅲ · it is the server’s function, not a copy of it', () => {
  it('returns what computeCod returns for the same lines — every figure', () => {
    const boxes = lines([3, '36'], [2, '10'], [4, '7.77']);
    const p = previewOrderDiscount({ lines: boxes, discount: '5.55', minorUnit: 3 });
    const cod = computeCod({
      lines: boxes.map((l) => ({ quantity: l.quantity, unitPrice: Number(l.price) / l.quantity })),
      discount: 5.55,
      minorUnit: 3,
    });
    expect(p).toMatchObject({ kind: 'ok', goods: cod.subtotal, discount: cod.discount, shares: cod.discountShares, linesAfter: cod.lineTotals });
    expect(cod.discountShares).toEqual(
      allocateDiscount(boxes.map((l) => ({ quantity: l.quantity, unitPrice: Number(l.price) / l.quantity })), 5.55, 3)
    );
  });

  it('and the file imports the calculator — it carries no allocation of its own', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/lib/order-discount-preview.ts'), 'utf8'));
    expect(src).toMatch(/import \{[^}]*computeCod[^}]*\} from '\.\/money'/);
    expect(src).toMatch(/computeCod\(\{/);
    // no share is worked out here: nothing divides a line by the subtotal
    expect(src).not.toMatch(/\/\s*subtotal|subtotal\s*\*/);
  });

  it('and the card calls it — it draws «بعد الخصم» from this file, not from sums of its own', () => {
    const card = stripComments(readFileSync(join(process.cwd(), 'src/components/orders/OrderLinesCard.tsx'), 'utf8'));
    expect(card).toMatch(/from '@\/lib\/order-discount-preview'/);
    expect(card).toMatch(/previewOrderDiscount\(\{/);
  });
});
