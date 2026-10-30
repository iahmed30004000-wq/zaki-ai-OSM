// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { GOODS_SHOWN, OrderGoods, OrderNotes, OrderPlace, goodsLines, governorateOf, streetOf } from './OrderGoods';

/**
 * WHAT THE DESK'S LISTS SAY ABOUT AN ORDER — the three pieces and the cut.
 *
 * Display only: no figure here is computed. The edge cases the owner named: one line, ten lines
 * (cut with the number left out), no lines at all, an add-on, a gift, no street, a very long name,
 * and text that runs right to left.
 */

afterEach(cleanup);

const line = (n: number, over: Record<string, unknown> = {}) => ({ id: `i${n}`, productName: `منتج ${n}`, quantity: 1, freeQuantity: 0, ...over });

describe('goodsLines — the lines and the cut', () => {
  it('one line: the product and its quantity, nothing cut', () => {
    const r = goodsLines([line(1, { quantity: 2 })], []);
    expect(r.shown.map((l) => l.text)).toEqual(['منتج 1 × 2']);
    expect(r.more).toBe(0);
  });

  it('a gift is written beside its line, not as a line of its own', () => {
    const r = goodsLines([line(1, { quantity: 3, freeQuantity: 1 })], []);
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0].text).toBe('منتج 1 × 3 (+1 مجاني)');
  });

  it('an add-on comes after the lines and is marked as one', () => {
    const r = goodsLines([line(1)], [{ id: 'a1', productName: 'شامبو', quantity: 1 }]);
    expect(r.shown.map((l) => [l.text, l.addOn])).toEqual([
      ['منتج 1 × 1', false],
      ['شامبو × 1', true],
    ]);
  });

  it('ten lines: three are shown and the rest is a number', () => {
    const r = goodsLines(Array.from({ length: 10 }, (_, i) => line(i + 1)), []);
    expect(GOODS_SHOWN).toBe(3);
    expect(r.shown).toHaveLength(3);
    expect(r.more).toBe(7);
  });

  it('the cut covers lines AND add-ons together — an add-on cannot hide behind the cut', () => {
    const r = goodsLines(Array.from({ length: 3 }, (_, i) => line(i + 1)), [{ id: 'a1', productName: 'شامبو', quantity: 1 }]);
    expect(r.shown.every((l) => !l.addOn)).toBe(true);
    expect(r.more).toBe(1);
  });

  it('no lines, or no field at all (an older server): an empty list, not a crash', () => {
    expect(goodsLines([], [])).toEqual({ shown: [], more: 0 });
    expect(goodsLines(undefined, undefined)).toEqual({ shown: [], more: 0 });
    expect(goodsLines(null, null)).toEqual({ shown: [], more: 0 });
  });

  it('a cap below one still shows one line', () => {
    expect(goodsLines([line(1), line(2)], [], 0).shown).toHaveLength(1);
  });
});

describe('OrderGoods', () => {
  it('draws each line, the «إضافة» mark on an add-on, and «+N أخرى» for the rest', () => {
    render(<OrderGoods items={[line(1), line(2, { freeQuantity: 1 }), line(3), line(4), line(5)]} addOns={[{ id: 'a1', productName: 'شامبو', quantity: 2 }]} />);
    expect(screen.getByText('منتج 2 × 1 (+1 مجاني)')).toBeTruthy();
    expect(screen.getByText('+3 أخرى')).toBeTruthy();
    expect(screen.queryByText('منتج 4 × 1')).toBeNull();
  });

  it('shows the add-on with its mark when it fits', () => {
    render(<OrderGoods items={[line(1)]} addOns={[{ id: 'a1', productName: 'شامبو', quantity: 2 }]} />);
    expect(screen.getByText('إضافة:')).toBeTruthy();
    expect(screen.getByText('شامبو × 2')).toBeTruthy();
    expect(screen.queryByText(/أخرى/)).toBeNull();
  });

  it('every line follows its own direction — an English product name in an Arabic list reads right', () => {
    const { container } = render(<OrderGoods items={[line(1, { productName: 'Vitamin C 500mg' }), line(2), line(3), line(4)]} />);
    const lis = container.querySelectorAll('li');
    expect(lis).toHaveLength(4);
    for (const li of lis) expect(li.getAttribute('dir')).toBe('auto');
  });

  it('an order with no lines draws a dash', () => {
    render(<OrderGoods items={[]} addOns={undefined} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('a very long name is allowed to break and is held to two lines', () => {
    const long = 'اسم منتج طويل جداً '.repeat(20);
    render(<OrderGoods items={[line(1, { productName: long })]} />);
    const li = screen.getByText(new RegExp('اسم منتج طويل جداً')).closest('li')!;
    expect(li.className).toContain('line-clamp-2');
    expect(li.parentElement!.className).toContain('break-words');
  });
});

describe('OrderPlace', () => {
  it('governorate, city and street', () => {
    render(<OrderPlace region="دمشق" city="المزة" address="شارع الجلاء بناء 4" />);
    expect(screen.getByText('دمشق · المزة')).toBeTruthy();
    expect(screen.getByText('شارع الجلاء بناء 4')).toBeTruthy();
  });

  it('the governorate is left out when it only repeats the city', () => {
    render(<OrderPlace region="عمّان" city="عمّان" address="" />);
    expect(screen.getByText('عمّان')).toBeTruthy();
    expect(screen.queryByText('عمّان · عمّان')).toBeNull();
  });

  it('no street: the place alone, with no empty line under it', () => {
    const { container } = render(<OrderPlace region={null} city="إربد" address={null} />);
    expect(container.querySelectorAll('p')).toHaveLength(1);
  });

  it('nothing known: a dash', () => {
    render(<OrderPlace region={undefined} city="" address="   " />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('every line follows its own direction, so a mixed street reads right', () => {
    const { container } = render(<OrderPlace region="دمشق" city="المزة" address="Mazzeh Street 4 - شارع" />);
    for (const p of container.querySelectorAll('p')) expect(p.getAttribute('dir')).toBe('auto');
  });
});

describe('OrderNotes', () => {
  it('the customer’s own note, in one line that follows its own direction', () => {
    render(<OrderNotes customer="اتصلوا بعد العصر" />);
    const p = screen.getByText('ملاحظة الزبون: اتصلوا بعد العصر');
    expect(p.getAttribute('dir')).toBe('auto');
  });

  it('no note, or a blank one, draws nothing at all', () => {
    expect(render(<OrderNotes customer={null} />).container.innerHTML).toBe('');
    cleanup();
    expect(render(<OrderNotes customer="   " />).container.innerHTML).toBe('');
  });

  it('the team’s note has no prop to be passed in: the piece cannot print it', () => {
    // @ts-expect-error — `internal` is not a prop; a caller that tries is a type error, not a leak
    render(<OrderNotes customer="x" internal="Telegram: chat 5 topic 9" />);
    expect(screen.queryByText(/Telegram/)).toBeNull();
  });
});

describe('the small rules', () => {
  it('streetOf: the order’s own street, else the customer’s, and a blank string is absent', () => {
    expect(streetOf(' شارع أ ', 'شارع ب')).toBe('شارع أ');
    expect(streetOf('', 'شارع ب')).toBe('شارع ب');
    expect(streetOf('   ', ' شارع ب ')).toBe('شارع ب');
    expect(streetOf(null, undefined)).toBe('');
  });

  it('governorateOf: trimmed, and nothing when it only repeats the city (spaces do not make it different)', () => {
    expect(governorateOf(' دمشق ', 'المزة')).toBe('دمشق');
    expect(governorateOf('دمشق', ' دمشق ')).toBeNull();
    expect(governorateOf('   ', 'دمشق')).toBeNull();
    expect(governorateOf(undefined, 'دمشق')).toBeNull();
  });
});
