// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * THE PLACEMENT SHEET (warehouse plan W1b) — the banner on the balances screen and the sheet it opens.
 *
 * What these hold: the banner is there only for a store that has warehouses and is not placed; every figure on the sheet
 * is the preview's, verbatim (the server is made to answer figures no subtraction could give, and the screen prints them);
 * the press waits for an exact check about the boxes as they are now; a refusal is said in the door's own sentence; a
 * three-hundred-product store is a search and a page of cards.
 */

const { api, user } = vi.hoisted(() => ({
  api: vi.fn(),
  user: {
    current: {
      id: 'u1',
      name: 'سارة',
      role: 'COMPANY_ADMIN',
      permissions: ['inventory.view', 'inventory.adjust'],
      status: 'ACTIVE',
    } as Record<string, unknown>,
  },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar', currentUser: user.current }),
}));

import { PlacementBanner } from './PlacementSheet';

const W = [
  { id: 'wA', name: 'مخزن الشمال' },
  { id: 'wB', name: 'مخزن الجنوب' },
];

const prow = (id: string, over: Record<string, unknown> = {}) => ({
  productId: id,
  name: `منتج ${id}`,
  sku: `SKU-${id}`,
  onHand: 12,
  withCourier: 2,
  toPlace: 10,
  counted: 0,
  difference: -10,
  perWarehouse: {},
  hasVariants: false,
  ...over,
});

const VARIANTS = 'المنتج بيتوزّع ككل. عدّ الخيارات بيضل على مستوى المتجر لهلق.';

type Handler = (url: string, init?: RequestInit) => unknown;
let onPreview: Handler;
let onPlace: Handler;
let gate: unknown;

const previewCalls = () => api.mock.calls.filter(([u]) => u === '/api/inventory/placement/preview');
const lastPreviewBody = () => JSON.parse((previewCalls().at(-1)![1] as RequestInit).body as string);

beforeEach(() => {
  api.mockReset();
  user.current = { ...user.current, permissions: ['inventory.view', 'inventory.adjust'] };
  gate = { placed: false, warehouses: W, rows: [prow('A'), prow('B', { hasVariants: true })], variantsNote: VARIANTS };
  onPreview = () => ({
    exact: false,
    rows: [prow('A'), prow('B', { hasVariants: true })],
    differing: [prow('A'), prow('B')],
    totals: { wA: 0, wB: 0 },
    messageAr: 'العدّ مش مطابق للدفتر: «منتج A» (لازم 10، انعدّ 0). اجرد هالمنتجات من «جرد المتاح» أول، وبعدين وزّع.',
  });
  onPlace = () => ({ placement: {}, rows: [], totals: {} });
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/inventory/placement' && !init) return gate;
    if (url === '/api/inventory/placement/preview') return onPreview(url, init);
    if (url === '/api/inventory/placement') return onPlace(url, init);
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => {
  cleanup();
});

const mountBanner = async () => {
  const onPlaced = vi.fn();
  render(<PlacementBanner onPlaced={onPlaced} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/inventory/placement'));
  return onPlaced;
};
const openSheet = async () => {
  const onPlaced = await mountBanner();
  fireEvent.click(await screen.findByRole('button', { name: 'وزّع الرصيد على المخازن' }));
  await screen.findByText('توزيع الرصيد على المخازن');
  return onPlaced;
};
const box = (product: string, warehouse: string) => screen.getByLabelText(`عدد «منتج ${product}» بـ${warehouse}`) as HTMLInputElement;
const press = () => screen.getByRole('button', { name: 'وزّع' }) as HTMLButtonElement;

describe('the banner', () => {
  it('shows for a store with warehouses that is not placed, with the press', async () => {
    await mountBanner();
    expect(await screen.findByText(/بضاعة هالمتجر لسا مش موزّعة على المخازن/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'وزّع الرصيد على المخازن' })).toBeTruthy();
  });

  it('NEGATIVE: a placed store draws nothing', async () => {
    // Warehouses and rows too: only `placed` may be what hides it.
    gate = { placed: true, warehouses: W, rows: [prow('A')], placement: { countedByName: 'أمين', countedAt: '2026-11-19T10:00:00.000Z' } };
    const { container } = render(<PlacementBanner onPlaced={vi.fn()} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('NEGATIVE: a store with no warehouse it can be placed in draws nothing (today’s screen)', async () => {
    gate = { placed: false, warehouses: [], rows: [prow('A')] };
    const { container } = render(<PlacementBanner onPlaced={vi.fn()} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('NEGATIVE: a refused read (no key, no store) draws nothing', async () => {
    api.mockImplementation(async () => {
      throw new Error('ما معك صلاحية');
    });
    const { container } = render(<PlacementBanner onPlaced={vi.fn()} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('NEGATIVE: without inventory.adjust the banner says who places, and offers no press', async () => {
    user.current = { ...user.current, permissions: ['inventory.view'] };
    await mountBanner();
    expect(await screen.findByText(/التوزيع بيعمله اللي معه صلاحية تعديل المخزون/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'وزّع الرصيد على المخازن' })).toBeNull();
  });
});

describe('the sheet — totals differ', () => {
  it('asks the preview on open with every warehouse in order and no line for a blank box', async () => {
    await openSheet();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    expect(lastPreviewBody()).toEqual({ counts: [{ warehouseId: 'wA', lines: [] }, { warehouseId: 'wB', lines: [] }] });
  });

  it('a typed box becomes a line of its warehouse; the server’s sentence is shown and the press stays shut', async () => {
    await openSheet();
    fireEvent.change(box('A', 'مخزن الجنوب'), { target: { value: '7' } });
    await waitFor(() =>
      expect(lastPreviewBody()).toEqual({
        counts: [
          { warehouseId: 'wA', lines: [] },
          { warehouseId: 'wB', lines: [{ productId: 'A', quantity: 7 }] },
        ],
      })
    );
    expect(await screen.findByText(/العدّ مش مطابق للدفتر/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('مين عدّ *'), { target: { value: 'أمين المخزن' } });
    expect(press().disabled).toBe(true);
  });

  it('«فيها فرق» keeps only the rows the server says differ', async () => {
    onPreview = () => ({
      exact: false,
      rows: [prow('A', { counted: 10, difference: 0 }), prow('B')],
      differing: [prow('B')],
      totals: { wA: 10, wB: 0 },
      messageAr: 'العدّ مش مطابق للدفتر: «منتج B».',
    });
    await openSheet();
    await screen.findByText(/العدّ مش مطابق للدفتر: «منتج B»/);
    expect(screen.getByText('منتج A')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /فيها فرق/ }));
    expect(screen.queryByText('منتج A')).toBeNull();
    expect(screen.getByText('منتج B')).toBeTruthy();
  });

  it('a box that is not a whole number is said under it, and nothing is asked about it', async () => {
    await openSheet();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    const before = previewCalls().length;
    fireEvent.change(box('A', 'مخزن الشمال'), { target: { value: '2.5' } });
    expect(await screen.findByText(/في خانة مش رقم صحيح/)).toBeTruthy();
    expect(screen.getByText('رقم صحيح من صفر وطالع')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500));
    expect(previewCalls().length).toBe(before);
    expect(press().disabled).toBe(true);
    fireEvent.change(box('A', 'مخزن الشمال'), { target: { value: '-1' } });
    await new Promise((r) => setTimeout(r, 500));
    expect(previewCalls().length).toBe(before);
  });
});

describe('the sheet — totals agree', () => {
  beforeEach(() => {
    onPreview = () => ({
      exact: true,
      rows: [prow('A', { counted: 10, difference: 0, perWarehouse: { wA: 6, wB: 4 } }), prow('B', { counted: 10, difference: 0 })],
      differing: [],
      totals: { wA: 16, wB: 4 },
    });
  });

  it('says it agrees, prints the server’s units per warehouse, and opens the press only with a name', async () => {
    await openSheet();
    expect(await screen.findByText('العدّ مطابق للدفتر. جاهز للتوزيع.')).toBeTruthy();
    const list = screen.getByText('العدّ مطابق للدفتر. جاهز للتوزيع.').parentElement as HTMLElement;
    expect(within(list).getByText('16')).toBeTruthy();
    expect(within(list).getByText('4')).toBeTruthy();
    expect(press().disabled).toBe(true); // no counter named yet
    fireEvent.change(screen.getByLabelText('مين عدّ *'), { target: { value: 'أمين المخزن' } });
    expect(press().disabled).toBe(false);
  });

  it('the press posts the counter, the time and the very counts the check was about — then the banner goes', async () => {
    const onPlaced = await openSheet();
    fireEvent.change(box('A', 'مخزن الشمال'), { target: { value: '6' } });
    fireEvent.change(box('A', 'مخزن الجنوب'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('مين عدّ *'), { target: { value: 'أمين المخزن' } });
    fireEvent.change(screen.getByLabelText('ملاحظة'), { target: { value: 'عدّ أول الشهر' } });
    await waitFor(() => expect(press().disabled).toBe(false));
    gate = { placed: true, placement: {} };
    fireEvent.click(press());
    await waitFor(() => expect(onPlaced).toHaveBeenCalled());
    const post = api.mock.calls.find(([u, i]) => u === '/api/inventory/placement' && i)!;
    const init = post[1] as RequestInit & { timeoutMs?: number };
    expect(init.method).toBe('POST');
    expect(init.timeoutMs).toBe(60_000);
    const body = JSON.parse(init.body as string);
    expect(body.countedByName).toBe('أمين المخزن');
    expect(body.note).toBe('عدّ أول الشهر');
    expect(Number.isNaN(Date.parse(body.countedAt))).toBe(false);
    expect(body.counts).toEqual([
      { warehouseId: 'wA', lines: [{ productId: 'A', quantity: 6 }] },
      { warehouseId: 'wB', lines: [{ productId: 'A', quantity: 4 }] },
    ]);
    expect(body.counts).toEqual(lastPreviewBody().counts);
    await waitFor(() => expect(screen.queryByText(/بضاعة هالمتجر لسا مش موزّعة/)).toBeNull());
    expect(screen.queryByText('توزيع الرصيد على المخازن')).toBeNull();
  });

  it('a box changed after the check shuts the press until the new answer lands', async () => {
    let release: (v: unknown) => void = () => {};
    await openSheet();
    fireEvent.change(screen.getByLabelText('مين عدّ *'), { target: { value: 'أمين المخزن' } });
    await waitFor(() => expect(press().disabled).toBe(false));
    const exact = onPreview;
    onPreview = (...a) => new Promise((r) => (release = () => r(exact(...a))));
    fireEvent.change(box('B', 'مخزن الشمال'), { target: { value: '3' } });
    expect(press().disabled).toBe(true);
    await waitFor(() => expect(lastPreviewBody().counts[0].lines).toEqual([{ productId: 'B', quantity: 3 }]));
    expect(press().disabled).toBe(true);
    release(undefined);
    await waitFor(() => expect(press().disabled).toBe(false));
  });
});

describe('the sheet — refused', () => {
  it('the press’s refusal is the door’s own sentence, and the check is asked again', async () => {
    onPreview = () => ({ exact: true, rows: [prow('A', { counted: 10, difference: 0 })], differing: [], totals: { wA: 10, wB: 0 } });
    onPlace = () => {
      throw Object.assign(new Error('العدّ مش مطابق للدفتر: «منتج A» (لازم 11، انعدّ 10). اجرد هالمنتجات من «جرد المتاح» أول، وبعدين وزّع.'), {
        status: 409,
      });
    };
    const onPlaced = await openSheet();
    fireEvent.change(screen.getByLabelText('مين عدّ *'), { target: { value: 'أمين المخزن' } });
    await waitFor(() => expect(press().disabled).toBe(false));
    const before = previewCalls().length;
    fireEvent.click(press());
    expect(await screen.findByText(/لازم 11، انعدّ 10/)).toBeTruthy();
    expect(onPlaced).not.toHaveBeenCalled();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(before));
    expect(screen.getByText('توزيع الرصيد على المخازن')).toBeTruthy();
  });

  it('a refused preview (a warehouse she does not reach) is said, and the press stays shut', async () => {
    onPreview = () => {
      throw new Error('في مخزن ما إلك وصول عليه. وزّع على المخازن اللي إلك بس.');
    };
    await openSheet();
    fireEvent.change(screen.getByLabelText('مين عدّ *'), { target: { value: 'أمين المخزن' } });
    expect(await screen.findByText(/ما إلك وصول عليه/)).toBeTruthy();
    expect(press().disabled).toBe(true);
  });
});

describe('no arithmetic in the screen', () => {
  it('prints the server’s figures verbatim, even ones no subtraction could give', async () => {
    onPreview = () => ({
      exact: false,
      rows: [prow('A', { onHand: 50, withCourier: 7, toPlace: 21, counted: 3, difference: 99 })],
      differing: [prow('A')],
      totals: { wA: 0, wB: 0 },
      messageAr: 'العدّ مش مطابق.',
    });
    await openSheet();
    await screen.findByText('العدّ مش مطابق.');
    expect(screen.getByText('+99')).toBeTruthy(); // 3 − 21 would be −18: the screen did not compute it
    expect(screen.getByText('21')).toBeTruthy();
    expect(screen.getByText(/على الرف 50 · مع الشحن 7/)).toBeTruthy();
  });

  it('the source sums nothing and subtracts no figure', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/components/inventory/PlacementSheet.tsx'), 'utf8'));
    expect(src).not.toMatch(/\.reduce\(/);
    expect(src).not.toMatch(/\b(onHand|withCourier|toPlace|counted|difference|totals\[[^\]]+\])\s*[-+*/]\s*[\w(]/);
    expect(src).not.toMatch(/[-+*/]\s*(r|row|check)\.(onHand|withCourier|toPlace|counted|difference)\b/);
  });
});

describe('a store of three hundred products on a phone', () => {
  const many = Array.from({ length: 300 }, (_, i) => prow(`P${String(i).padStart(3, '0')}`));

  beforeEach(() => {
    gate = { placed: false, warehouses: W, rows: many, variantsNote: VARIANTS };
    onPreview = () => ({ exact: false, rows: many, differing: many, totals: { wA: 0, wB: 0 }, messageAr: 'العدّ مش مطابق.' });
  });

  it('draws a page of cards, finds any product by search, and draws more on asking', async () => {
    await openSheet();
    await screen.findByText('العدّ مش مطابق.');
    expect(screen.getAllByText(/^منتج P\d{3}$/)).toHaveLength(30);
    expect(screen.queryByText('منتج P250')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'اعرض المزيد' }));
    expect(screen.getAllByText(/^منتج P\d{3}$/)).toHaveLength(60);
    fireEvent.change(screen.getByLabelText('ابحث باسم المنتج أو رمزه'), { target: { value: 'P250' } });
    expect(screen.getAllByText(/^منتج P\d{3}$/)).toHaveLength(1);
    expect(screen.getByText('منتج P250')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'اعرض المزيد' })).toBeNull();
  });

  it('nothing is wider than a phone: no fixed pixel widths, no nowrap rows', async () => {
    await openSheet();
    await screen.findByText('العدّ مش مطابق.');
    const tokens = [...document.body.querySelectorAll('[class]')].flatMap((e) => (e.getAttribute('class') ?? '').split(/\s+/));
    const wide = tokens.filter((t) => /^(min-w|w)-\[(\d+)px\]$/.test(t) && Number(/\d+/.exec(t)![0]) > 375);
    expect(wide).toEqual([]);
    expect(tokens).not.toContain('whitespace-nowrap');
  });
});

describe('a product with options', () => {
  /*
   * 20/11 (W8c): was «is placed as a product, and the sheet says so on it and once on top» (the sentence twice). W8b let
   * the placement carry combinations, so the card of such a product now carries its grid instead of the sentence, and the
   * door's sentence (VARIANTS_IN_PLACEMENT_AR) is said once, on top.
   */
  it('the door’s sentence about combinations is said once, on top', async () => {
    await openSheet();
    await waitFor(() => expect(screen.getAllByText(VARIANTS)).toHaveLength(1));
  });
});

describe('20/11 (W8c): the combination grid', () => {
  const COMBOS = {
    B: [
      { variantId: 'v1', label: 'أسود · L', onHand: 11 },
      { variantId: 'v2', label: 'كحلي · M', onHand: 4 },
    ],
  };
  const vbox = (label: string, warehouse: string) => screen.getByLabelText(`عدد «منتج B» «${label}» بـ${warehouse}`) as HTMLInputElement;

  beforeEach(() => {
    gate = { ...(gate as Record<string, unknown>), combinations: COMBOS };
  });

  it('draws a grid per warehouse for a product with combinations — none for one without — with the server’s store-level figure', async () => {
    await openSheet();
    await screen.findByText(/العدّ مش مطابق للدفتر/);
    const grids = document.querySelectorAll('[data-combinations]');
    expect(grids).toHaveLength(2); // B × two warehouses; A has none
    expect(grids[0].textContent).toContain('مخزن الشمال: كم قطعة من كل خيار؟');
    expect(grids[1].textContent).toContain('مخزن الجنوب: كم قطعة من كل خيار؟');
    expect(grids[0].textContent).toContain('بالمتجر كله 11');
    expect(grids[0].textContent).toContain('بالمتجر كله 4');
    expect(vbox('أسود · L', 'مخزن الشمال')).toBeTruthy();
    expect(screen.queryByLabelText(/عدد «منتج A» «/)).toBeNull();
    // Wraps on a phone: two boxes a row.
    expect(grids[0].querySelector('.grid')!.className).toMatch(/\bgrid-cols-2\b/);
  });

  it('the boxes ride on their warehouse’s line as typed — a zero is a count, a blank is not sent', async () => {
    await openSheet();
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    fireEvent.change(box('B', 'مخزن الشمال'), { target: { value: '6' } });
    fireEvent.change(vbox('أسود · L', 'مخزن الشمال'), { target: { value: '6' } });
    fireEvent.change(vbox('كحلي · M', 'مخزن الشمال'), { target: { value: '0' } });
    fireEvent.change(box('A', 'مخزن الجنوب'), { target: { value: '3' } });
    await waitFor(() =>
      expect(lastPreviewBody().counts).toEqual([
        { warehouseId: 'wA', lines: [{ productId: 'B', quantity: 6, variants: [{ variantId: 'v1', quantity: 6 }, { variantId: 'v2', quantity: 0 }] }] },
        // NEGATIVE: a product without combinations carries no «variants» — its line is today's.
        { warehouseId: 'wB', lines: [{ productId: 'A', quantity: 3 }] },
      ])
    );
  });

  it('NEGATIVE: combinations typed under a blank product box ask nothing and say so; the press stays shut', async () => {
    await openSheet();
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    fireEvent.change(vbox('أسود · L', 'مخزن الجنوب'), { target: { value: '2' } });
    expect(await screen.findByText(/كتبت عدد خياراته بمخزن وما كتبت عدده هو/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 450));
    expect(previewCalls()).toHaveLength(1);
    expect(press().disabled).toBe(true);
    fireEvent.change(box('B', 'مخزن الجنوب'), { target: { value: '2' } });
    await waitFor(() => expect(previewCalls()).toHaveLength(2));
    expect(lastPreviewBody().counts[1].lines).toEqual([{ productId: 'B', quantity: 2, variants: [{ variantId: 'v1', quantity: 2 }] }]);
  });

  it('NEGATIVE: a combination box that is not a whole number is said under it — not under the product’s — and nothing is asked', async () => {
    await openSheet();
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    fireEvent.change(box('B', 'مخزن الشمال'), { target: { value: '2' } });
    fireEvent.change(vbox('كحلي · M', 'مخزن الشمال'), { target: { value: '1.5' } });
    expect(await screen.findByText(/في خانة مش رقم صحيح/)).toBeTruthy();
    expect(screen.getAllByText('رقم صحيح من صفر وطالع')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 450));
    expect(previewCalls()).toHaveLength(1);
    expect(press().disabled).toBe(true);
  });

  it('the sum and the store-level ceiling are the door’s: its refusal is printed as it came, and the press stays shut', async () => {
    const sentence = 'مجموع الخيارات (5) مش قد كمية المنتج بسطره (6). خلّيهم متساويين.';
    onPreview = () => {
      throw new Error(sentence);
    };
    await openSheet();
    fireEvent.change(box('B', 'مخزن الشمال'), { target: { value: '6' } });
    fireEvent.change(vbox('أسود · L', 'مخزن الشمال'), { target: { value: '5' } });
    expect(await screen.findByText(sentence)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('مين عدّ *'), { target: { value: 'أمين المخزن' } });
    expect(press().disabled).toBe(true);
  });

  it('the press posts the very counts — combinations included — that the exact check was about', async () => {
    onPreview = () => ({ exact: true, rows: [prow('A', { difference: 0 }), prow('B', { hasVariants: true, difference: 0 })], differing: [], totals: { wA: 6, wB: 0 } });
    const onPlaced = await openSheet();
    fireEvent.change(box('B', 'مخزن الشمال'), { target: { value: '6' } });
    fireEvent.change(vbox('أسود · L', 'مخزن الشمال'), { target: { value: '4' } });
    fireEvent.change(vbox('كحلي · M', 'مخزن الشمال'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('مين عدّ *'), { target: { value: 'أمين المخزن' } });
    await waitFor(() => expect(press().disabled).toBe(false));
    fireEvent.click(press());
    await waitFor(() => expect(onPlaced).toHaveBeenCalled());
    const placed = api.mock.calls.find(([u, init]) => u === '/api/inventory/placement' && (init as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse((placed[1] as RequestInit).body as string);
    expect(body.counts[0].lines).toEqual([{ productId: 'B', quantity: 6, variants: [{ variantId: 'v1', quantity: 4 }, { variantId: 'v2', quantity: 2 }] }]);
    expect(body.counts).toEqual(lastPreviewBody().counts);
  });

  it('NEGATIVE: a store whose door sends no combinations draws no grid (today’s sheet)', async () => {
    gate = { placed: false, warehouses: W, rows: [prow('A'), prow('B', { hasVariants: true })], variantsNote: VARIANTS };
    await openSheet();
    await screen.findByText(/العدّ مش مطابق للدفتر/);
    expect(document.querySelectorAll('[data-combinations]')).toHaveLength(0);
  });

  it('three hundred products with combinations: still a page of thirty cards, and nothing wider than a phone', async () => {
    const many = Array.from({ length: 300 }, (_, i) => prow(`P${String(i).padStart(3, '0')}`, { hasVariants: true }));
    const combos = Object.fromEntries(many.map((r) => [r.productId, Array.from({ length: 6 }, (_, k) => ({ variantId: `${r.productId}-v${k}`, label: `خيار ${k}`, onHand: k }))]));
    gate = { placed: false, warehouses: W, rows: many, variantsNote: VARIANTS, combinations: combos };
    onPreview = () => ({ exact: false, rows: many, differing: many, totals: { wA: 0, wB: 0 }, messageAr: 'العدّ مش مطابق.' });
    await openSheet();
    await screen.findByText('العدّ مش مطابق.');
    expect(screen.getAllByText(/^منتج P\d{3}$/)).toHaveLength(30);
    expect(document.querySelectorAll('[data-combinations]')).toHaveLength(60);
    const tokens = [...document.body.querySelectorAll('[class]')].flatMap((e) => (e.getAttribute('class') ?? '').split(/\s+/));
    expect(tokens.filter((t) => /^(min-w|w)-\[(\d+)px\]$/.test(t))).toEqual([]);
    expect(tokens).not.toContain('whitespace-nowrap');
  });
});
