// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * COMBINATIONS IN THE TRANSFER AND THE EXIT SCREENS (warehouse plan W8c; the rules are W8b's, `lib/variant-lines.ts`).
 *
 * DEFINITION OF DONE it pins:
 *  1. A product WITHOUT combinations: nothing is asked about it, no grid is drawn, and its line goes out exactly as today.
 *  2. A product with combinations: its active combinations are asked from the products door once, a box per combination
 *     is drawn under the line (wrapping on a phone), beside each the server's shelf figure in the source warehouse — and a
 *     row on the road (`warehouseId: null, inTransit`) is never shown as a place. The boxes go out as typed; a blank or a
 *     zero is not sent; a box that is not a whole number shuts the press.
 *  3. The receipt stays BLIND per combination: the dialog names which combinations came, never how many; every one must be
 *     counted (a zero is a count); the door's answer after the press shows sent · counted · difference per combination.
 *  4. Every check of the sum and of the free pieces is the door's: its sentence is printed as it came.
 *  5. The list and the decision dialogs say each combination under its line, with the server's figure.
 */

const { api, user } = vi.hoisted(() => ({
  api: vi.fn(),
  user: { current: { id: 'u-me', name: 'سارة', role: 'CUSTOM', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar', currentUser: user.current }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/inventory/transfers', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenGuide', () => ({ GuideButton: () => null }));
vi.mock('@/hooks/useLiveRefresh', async () => {
  const R = await import('react');
  return { useLiveRefresh: (load: () => unknown) => R.useEffect(() => void load(), []) };
});
vi.mock('@/hooks/useProducts', () => ({
  useProducts: () => ({
    loading: false,
    products: [
      { id: 'p1', name: 'كريم اليدين', sku: 'K-1', variantOptions: null },
      { id: 'p3', name: 'قميص', sku: 'Q-3', variantOptions: '[{"id":"o1","name":"المقاس","values":[{"id":"l","label":"L"}]}]' },
      // Options saved and then emptied: «[]» — nothing to ask.
      { id: 'p4', name: 'كاسة', sku: 'G-4', variantOptions: '[]' },
    ],
  }),
}));

import { StockTransfersScreen } from './StockTransfersScreen';
import { StockExitsScreen } from './StockExitsScreen';
import { EXIT_REASON_AR, EXIT_REASONS } from '@/lib/stock-exit-reasons';

type T = Record<string, unknown>;
const W = [
  { id: 'wA', name: 'مخزن الشمال', countryId: 'k1' },
  { id: 'wB', name: 'مخزن الجنوب', countryId: 'k1' },
];

/** The products door's answer for p3: two active combinations and an archived one; v1 has a road row. */
const VARIANTS_OF_P3 = {
  options: [],
  placed: true,
  combinations: [
    { id: 'v1', label: 'أسود · L', status: 'ACTIVE', onHand: 20, places: [{ warehouseId: null, onHand: 4, inTransit: true }, { warehouseId: 'wA', onHand: 13 }] },
    // v2: only a road row and the other warehouse — from wA it shows no figure, never the road's 5.
    { id: 'v2', label: 'كحلي · M', status: 'ACTIVE', onHand: 7, places: [{ warehouseId: null, onHand: 5, inTransit: true }, { warehouseId: 'wB', onHand: 2 }] },
    { id: 'v9', label: 'قديم', status: 'ARCHIVED', onHand: 0, places: [] },
  ],
};

const transfer = (over: T = {}): T => ({
  id: 't1',
  kind: 'INTERNAL',
  kindAr: 'نقل داخل المتجر',
  status: 'SENT',
  statusAr: 'بالطريق',
  blind: true,
  note: null,
  fromName: 'مخزن الشمال',
  toName: 'مخزن الجنوب',
  sentById: 'u-other',
  sentByName: 'رنا',
  sentAt: '2026-11-20T08:00:00.000Z',
  receivedById: null,
  receivedByName: null,
  receivedAt: null,
  cancelledByName: null,
  cancelReason: null,
  differenceType: null,
  differenceReason: null,
  differenceApprovedAt: null,
  differenceApprovedByName: null,
  lines: [
    {
      productId: 'p3', productName: 'قميص', quantitySent: null, quantityReceived: null, difference: null,
      variants: [
        { variantId: 'v1', label: 'أسود · L', quantitySent: null, quantityReceived: null, difference: null },
        { variantId: 'v2', label: 'كحلي · M', quantitySent: null, quantityReceived: null, difference: null },
      ],
    },
  ],
  ...over,
});

let transfers: { warehouses: T[]; transfers: T[] };
let exits: { warehouses: T[]; reasons: T[]; exits: T[] };
let variantsAnswer: () => unknown;
let onPost: (url: string, body: T) => unknown;
const posts = () =>
  api.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST').map(([u, init]) => [u, JSON.parse((init as RequestInit).body as string)] as [string, T]);
const variantReads = () => api.mock.calls.filter(([u]) => String(u).startsWith('/api/products/'));

const as = (...keys: string[]) => {
  user.current = { ...user.current, permissions: ['inventory.view', ...keys] };
};

beforeEach(() => {
  api.mockReset();
  as();
  transfers = { warehouses: W, transfers: [] };
  exits = { warehouses: [W[0]], reasons: EXIT_REASONS.map((r) => ({ reason: r, ar: EXIT_REASON_AR[r] })), exits: [] };
  variantsAnswer = () => VARIANTS_OF_P3;
  onPost = () => ({ transfer: {}, exit: {}, replay: false });
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return onPost(url, JSON.parse(init.body as string));
    if (url === '/api/inventory/transfers') return transfers;
    if (url === '/api/inventory/exits') return exits;
    if (url === '/api/products/p3/variants') return variantsAnswer();
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => cleanup());

const radio = (dialog: HTMLElement, group: string, name: string) =>
  fireEvent.click(within(within(dialog).getByRole('radiogroup', { name: group })).getByRole('radio', { name }));
const pickProduct = async (dialog: HTMLElement, name: string) => {
  await userEvent.click(within(dialog).getAllByPlaceholderText(/ابحث/).at(-1)!);
  await userEvent.click(within(dialog).getByText(name));
};
const refuse = (sentence: string) => () => {
  throw new Error(sentence);
};

async function openSend() {
  as('inventory.transfer');
  render(<StockTransfersScreen />);
  fireEvent.click(await screen.findByRole('button', { name: 'نقل جديد' }));
  const dialog = await screen.findByRole('dialog');
  radio(dialog, 'من مخزن', 'مخزن الشمال');
  radio(dialog, 'إلى مخزن', 'مخزن الجنوب');
  return dialog;
}

describe('the transfer form: a product WITHOUT combinations is today', () => {
  it('NEGATIVE: nothing is asked about it, no grid is drawn, and its line carries no «variants»', async () => {
    const dialog = await openSend();
    await pickProduct(dialog, 'كريم اليدين');
    fireEvent.change(within(dialog).getByLabelText('كمية السطر 1'), { target: { value: '6' } });
    expect(dialog.querySelector('[data-combinations]')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'أرسل' }));
    await screen.findByText('انبعت النقل — البضاعة صارت بالطريق.');
    expect(variantReads()).toEqual([]);
    expect(posts()[0][1].lines).toEqual([{ productId: 'p1', quantity: 6 }]);
  });

  it('NEGATIVE: options saved as an empty list («[]») are no options — nothing is asked', async () => {
    const dialog = await openSend();
    await pickProduct(dialog, 'كاسة');
    expect(variantReads()).toEqual([]);
    expect(dialog.querySelector('[data-combinations]')).toBeNull();
  });
});

describe('the transfer form: a product with combinations', () => {
  it('asks its combinations once, draws a box per ACTIVE one with the source shelf’s figure, and never calls the road a place', async () => {
    const dialog = await openSend();
    await pickProduct(dialog, 'قميص');
    const grid = await waitFor(() => {
      const g = dialog.querySelector('[data-combinations]');
      if (!g) throw new Error('no grid');
      return g as HTMLElement;
    });
    expect(variantReads().map(([u]) => u)).toEqual(['/api/products/p3/variants']);
    expect(within(grid).getByLabelText('عدد «أسود · L» بالسطر 1')).toBeTruthy();
    expect(within(grid).getByLabelText('عدد «كحلي · M» بالسطر 1')).toBeTruthy();
    expect(within(grid).queryByLabelText('عدد «قديم» بالسطر 1')).toBeNull();
    // v1 in the source: the server's 13. v2 has no row in the source: no figure at all (none made up).
    expect(grid.textContent).toContain('على الرف بـمخزن الشمال: 13');
    expect(grid.textContent).not.toMatch(/بلا مكان/);
    expect(grid.textContent).not.toMatch(/: [45]\b/);
    expect(grid.textContent.match(/على الرف/g)).toHaveLength(1);
    // The figure follows the source: from the other warehouse, v2's 2 and not v1's 13.
    radio(dialog, 'من مخزن', 'مخزن الجنوب');
    radio(dialog, 'إلى مخزن', 'مخزن الشمال');
    expect(grid.textContent).toContain('على الرف بـمخزن الجنوب: 2');
    expect(grid.textContent).not.toMatch(/: [45]\b/);
    expect(grid.textContent).not.toContain('13');
    // The grid wraps on a phone: two boxes a row, three from a tablet up.
    expect(grid.querySelector('.grid')!.className).toMatch(/\bgrid-cols-2\b/);
  });

  it('sends the typed boxes as typed — a blank and a zero are not sent; a bad box shuts the press', async () => {
    const dialog = await openSend();
    await pickProduct(dialog, 'قميص');
    const v1 = await within(dialog).findByLabelText('عدد «أسود · L» بالسطر 1');
    const v2 = within(dialog).getByLabelText('عدد «كحلي · M» بالسطر 1');
    fireEvent.change(within(dialog).getByLabelText('كمية السطر 1'), { target: { value: '5' } });
    const press = within(dialog).getByRole('button', { name: 'أرسل' }) as HTMLButtonElement;
    fireEvent.change(v1, { target: { value: '2.5' } });
    expect(press.disabled).toBe(true);
    expect(within(dialog).getByText('رقم صحيح من صفر وطالع')).toBeTruthy();
    fireEvent.change(v1, { target: { value: '5' } });
    fireEvent.change(v2, { target: { value: '0' } });
    expect(press.disabled).toBe(false);
    fireEvent.click(press);
    await screen.findByText('انبعت النقل — البضاعة صارت بالطريق.');
    expect(posts()[0][1].lines).toEqual([{ productId: 'p3', quantity: 5, variants: [{ variantId: 'v1', quantity: 5 }] }]);
  });

  it('the sum and the free pieces are the door’s: its sentences, printed as they came', async () => {
    const dialog = await openSend();
    await pickProduct(dialog, 'قميص');
    fireEvent.change(await within(dialog).findByLabelText('عدد «أسود · L» بالسطر 1'), { target: { value: '3' } });
    fireEvent.change(within(dialog).getByLabelText('كمية السطر 1'), { target: { value: '5' } });
    const press = within(dialog).getByRole('button', { name: 'أرسل' });
    // The screen did not add 3 against 5: it sent, and the door said.
    for (const sentence of [
      'مجموع الخيارات (3) مش قد كمية المنتج بسطره (5). خلّيهم متساويين.',
      'ما في كفاية من هالخيارات ببضاعة مخزن الشمال الحرّة: قميص «أسود · L» (الحر 1، طالب 3).',
      '«قميص» إله خيارات (مقاس/لون): اكتب كم قطعة من كل خيار.',
    ]) {
      onPost = refuse(sentence);
      fireEvent.click(press);
      expect(await within(dialog).findByText(sentence)).toBeTruthy();
    }
  });

  it('a refused read of the combinations is said; the line still goes, and the door names what it needs', async () => {
    variantsAnswer = () => {
      throw new Error('ما معك صلاحية');
    };
    const dialog = await openSend();
    await pickProduct(dialog, 'قميص');
    expect(await within(dialog).findByText(/ما قدرنا نجيب خيارات هالمنتج/)).toBeTruthy();
    expect(dialog.querySelector('[data-combinations]')).toBeNull();
  });

  it('a product picked again on the line forgets the boxes of the one before', async () => {
    const dialog = await openSend();
    await pickProduct(dialog, 'قميص');
    fireEvent.change(await within(dialog).findByLabelText('عدد «أسود · L» بالسطر 1'), { target: { value: '4' } });
    await userEvent.click(within(dialog).getByRole('button', { name: /غيّر المنتج|امسح الاختيار/ }));
    await pickProduct(dialog, 'كريم اليدين');
    fireEvent.change(within(dialog).getByLabelText('كمية السطر 1'), { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أرسل' }));
    await screen.findByText('انبعت النقل — البضاعة صارت بالطريق.');
    expect(posts()[0][1].lines).toEqual([{ productId: 'p1', quantity: 4 }]);
  });
});

describe('the receipt: blind per combination', () => {
  const openReceive = async () => {
    as('inventory.transfer_receive');
    render(<StockTransfersScreen />);
    const t = within((await waitFor(() => { const x = document.querySelector('table'); if (!x) throw new Error('no table'); return x; })) as HTMLElement);
    fireEvent.click(t.getByRole('button', { name: 'استلم' }));
    return screen.findByRole('dialog');
  };

  beforeEach(() => {
    transfers.transfers = [transfer()];
  });

  it('NEGATIVE: names the combinations, never a sent figure — even from a row that carries them', async () => {
    transfers.transfers = [
      transfer({
        blind: false,
        lines: [
          {
            productId: 'p3', productName: 'قميص', quantitySent: 37, quantityReceived: null, difference: null,
            variants: [
              { variantId: 'v1', label: 'أسود · L', quantitySent: 29, quantityReceived: null, difference: null },
              { variantId: 'v2', label: 'كحلي · M', quantitySent: 8, quantityReceived: null, difference: null },
            ],
          },
        ],
      }),
    ];
    const dialog = await openReceive();
    expect(within(dialog).getByLabelText('عدد «قميص» «أسود · L» اللي وصل')).toBeTruthy();
    expect(within(dialog).getByLabelText('عدد «قميص» «كحلي · M» اللي وصل')).toBeTruthy();
    const attrs = [dialog, ...dialog.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => a.name !== 'd').map((a) => a.value));
    for (const n of ['37', '29', '8']) {
      expect(dialog.textContent).not.toMatch(new RegExp(`\\b${n}\\b`));
      expect(attrs.filter((a) => new RegExp(`\\b${n}\\b`).test(a))).toEqual([]);
    }
    // No shelf figure is asked for in the receipt.
    expect(variantReads()).toEqual([]);
  });

  it('every combination must be counted — a zero is a count, a blank is not; the press sends each; the answer says each', async () => {
    onPost = () => ({
      transfer: {
        status: 'RECEIVED_WITH_DIFFERENCE',
        statusAr: 'مستلم بفرق',
        lines: [
          {
            productId: 'p3', quantitySent: 6, quantityReceived: 5, difference: 1,
            variants: [
              { variantId: 'v1', quantitySent: 4, quantityReceived: 4, difference: 0 },
              { variantId: 'v2', quantitySent: 2, quantityReceived: 1, difference: 1 },
            ],
          },
        ],
      },
      replay: false,
    });
    const dialog = await openReceive();
    const press = within(dialog).getByRole('button', { name: 'استلمت' }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText('عدد «قميص» اللي وصل'), { target: { value: '5' } });
    fireEvent.change(within(dialog).getByLabelText('عدد «قميص» «أسود · L» اللي وصل'), { target: { value: '5' } });
    // v2 blank: not counted yet — the press stays shut.
    expect(press.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('عدد «قميص» «كحلي · M» اللي وصل'), { target: { value: 'x' } });
    expect(press.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('عدد «قميص» «كحلي · M» اللي وصل'), { target: { value: '0' } });
    expect(press.disabled).toBe(false);
    fireEvent.click(press);
    expect(await screen.findByText('انستلم النقل')).toBeTruthy();
    expect(posts()).toEqual([
      [
        '/api/inventory/transfers/t1/receive',
        { lines: [{ productId: 'p3', quantity: 5, variants: [{ variantId: 'v1', quantity: 5 }, { variantId: 'v2', quantity: 0 }] }] },
      ],
    ]);
    // The answer's figures per combination — the server's, not the boxes (5 and 0 were typed; 4 and 1 came back).
    const v2 = document.querySelector('[data-figures="v2"]')!.textContent!;
    expect(v2).toContain('كحلي · M');
    expect(v2).toMatch(/انبعت\s*2/);
    expect(v2).toMatch(/انعدّ\s*1/);
    expect(v2).toMatch(/الفرق\s*1/);
    expect(document.querySelector('[data-figures="v1"]')!.textContent).toMatch(/انعدّ\s*4/);
  });

  it('a line WITHOUT combinations is counted as today: no «variants» in its line', async () => {
    transfers.transfers = [transfer({ lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: null, quantityReceived: null, difference: null }] })];
    onPost = () => ({ transfer: { status: 'RECEIVED', statusAr: 'مستلم', lines: [] }, replay: false });
    const dialog = await openReceive();
    expect(dialog.querySelector('[data-combinations]')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('عدد «كريم اليدين» اللي وصل'), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'استلمت' }));
    await screen.findByText('انستلم النقل');
    expect(posts()[0][1]).toEqual({ lines: [{ productId: 'p1', quantity: 3 }] });
  });

  it('the door’s refusals of the counts are its sentences', async () => {
    const dialog = await openReceive();
    fireEvent.change(within(dialog).getByLabelText('عدد «قميص» اللي وصل'), { target: { value: '2' } });
    fireEvent.change(within(dialog).getByLabelText('عدد «قميص» «أسود · L» اللي وصل'), { target: { value: '1' } });
    fireEvent.change(within(dialog).getByLabelText('عدد «قميص» «كحلي · M» اللي وصل'), { target: { value: '0' } });
    for (const sentence of [
      'مجموع الخيارات (1) مش قد العدد اللي كتبته للمنتج (2). خلّيهم متساويين.',
      'عدد خيار أكتر من اللي انبعت منه. عدّ كمان مرة، والزيادة بتنكتب من الجرد مش من هون.',
    ]) {
      onPost = refuse(sentence);
      fireEvent.click(within(dialog).getByRole('button', { name: 'استلمت' }));
      expect(await within(dialog).findByText(sentence)).toBeTruthy();
    }
  });
});

describe('the list says each combination under its line', () => {
  it('blind where the door sent no figure; the server’s figures after receipt — the difference not subtracted here', async () => {
    as('inventory.transfer_receive');
    transfers.transfers = [
      transfer(),
      transfer({
        id: 't2', status: 'RECEIVED_WITH_DIFFERENCE', statusAr: 'مستلم بفرق', blind: false, receivedById: 'u-x',
        lines: [
          {
            productId: 'p3', productName: 'قميص', quantitySent: 6, quantityReceived: 5, difference: 1,
            variants: [{ variantId: 'v2', label: 'كحلي · M', quantitySent: 2, quantityReceived: 1, difference: 9 }],
          },
        ],
      }),
    ];
    render(<StockTransfersScreen />);
    const table = await waitFor(() => { const x = document.querySelector('table'); if (!x) throw new Error('no table'); return x as HTMLElement; });
    const rows = table.querySelectorAll('tbody tr');
    expect(rows[0].textContent).toMatch(/أسود · L:\s*العدد مخفي لحد ما ينعدّ/);
    expect(rows[0].textContent).toMatch(/كحلي · M:\s*العدد مخفي لحد ما ينعدّ/);
    // 2 − 1 is 1; the server said 9, and 9 is what is printed.
    expect(rows[1].textContent).toMatch(/كحلي · M:\s*2 · انعدّ 1 · ناقص 9/);
  });

  it('an exit line says each combination with the server’s figure — in the list and in the decision dialog', async () => {
    as('inventory.exit_approve');
    exits.exits = [
      {
        id: 'x1', warehouseId: 'wA', warehouseName: 'مخزن الشمال', reason: 'DAMAGED', reasonAr: 'تالف', note: null, status: 'PENDING',
        statusAr: 'مستني اعتماد', requestedById: 'u-other', requestedByName: 'رنا', requestedAt: '2026-11-20T08:00:00.000Z',
        decidedById: null, decidedByName: null, decidedAt: null, rejectReason: null,
        lines: [
          {
            productId: 'p3', productName: 'قميص', quantity: 3,
            variants: [{ variantId: 'v1', label: 'أسود · L', quantity: 2 }, { variantId: 'v2', label: 'كحلي · M', quantity: 1 }],
          },
          { productId: 'p1', productName: 'كريم اليدين', quantity: 4 },
        ],
      },
    ];
    render(<StockExitsScreen />);
    const table = await waitFor(() => { const x = document.querySelector('table'); if (!x) throw new Error('no table'); return x as HTMLElement; });
    expect(table.textContent).toMatch(/أسود · L:\s*2/);
    expect(table.textContent).toMatch(/كحلي · M:\s*1/);
    fireEvent.click(within(table).getByRole('button', { name: 'اعتمد' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/أسود · L:\s*2/);
    expect(dialog.textContent).toMatch(/كريم اليدين:\s*4/);
  });
});

describe('the exit request', () => {
  const openRequest = async () => {
    as('inventory.exit');
    render(<StockExitsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'طلب إخراج' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('سبب الإخراج'), { target: { value: 'DAMAGED' } });
    return dialog;
  };

  it('a product with combinations: a box per combination with the warehouse’s shelf figure; the boxes go as typed', async () => {
    const dialog = await openRequest();
    await pickProduct(dialog, 'قميص');
    const v1 = await within(dialog).findByLabelText('عدد «أسود · L» بالسطر 1');
    expect(dialog.querySelector('[data-combinations]')!.textContent).toContain('على الرف بـمخزن الشمال: 13');
    fireEvent.change(within(dialog).getByLabelText('كمية السطر 1'), { target: { value: '2' } });
    fireEvent.change(v1, { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اطلب' }));
    await screen.findByText('انطلب الإخراج — البضاعة موقوفة لحد ما حدا تاني يعتمد.');
    expect(posts()[0][1].lines).toEqual([{ productId: 'p3', quantity: 2, variants: [{ variantId: 'v1', quantity: 2 }] }]);
  });

  it('NEGATIVE: a product without combinations asks nothing and goes out as today', async () => {
    const dialog = await openRequest();
    await pickProduct(dialog, 'كريم اليدين');
    fireEvent.change(within(dialog).getByLabelText('كمية السطر 1'), { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اطلب' }));
    await screen.findByText('انطلب الإخراج — البضاعة موقوفة لحد ما حدا تاني يعتمد.');
    expect(variantReads()).toEqual([]);
    expect(posts()[0][1].lines).toEqual([{ productId: 'p1', quantity: 4 }]);
  });

  it('a bad combination box shuts the press; the door’s refusal is its sentence', async () => {
    const dialog = await openRequest();
    await pickProduct(dialog, 'قميص');
    const v2 = await within(dialog).findByLabelText('عدد «كحلي · M» بالسطر 1');
    fireEvent.change(within(dialog).getByLabelText('كمية السطر 1'), { target: { value: '1' } });
    const press = within(dialog).getByRole('button', { name: 'اطلب' }) as HTMLButtonElement;
    fireEvent.change(v2, { target: { value: '-1' } });
    expect(press.disabled).toBe(true);
    fireEvent.change(v2, { target: { value: '1' } });
    expect(press.disabled).toBe(false);
    const sentence = 'ما في كفاية من هالخيارات ببضاعة مخزن الشمال الحرّة: قميص «كحلي · M» (الحر 0، طالب 1).';
    onPost = refuse(sentence);
    fireEvent.click(press);
    expect(await within(dialog).findByText(sentence)).toBeTruthy();
  });
});

describe('the source', () => {
  it('the grid sums nothing and subtracts no figure; it uses the kit’s box', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/components/inventory/CombinationBoxes.tsx'), 'utf8'));
    expect(src).not.toMatch(/\.reduce\(/);
    expect(src).not.toMatch(/\b(onHand|quantity|quantitySent|quantityReceived)\s*[-+*/]\s*[\w(]/);
    expect(src).not.toMatch(/<input\b/);
    expect(src).toContain("from '@/components/ui/Input'");
  });
});
