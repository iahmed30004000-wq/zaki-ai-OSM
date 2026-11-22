// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * 22/11 (F2): «سعر الصرف» ON THE SCREEN «نقل البضاعة» — a transfer between two stores whose countries keep their costs
 * in different currencies (the owner's word of 22/11). The screen only collects and prints; the door judges and converts.
 *
 * DEFINITION OF DONE it pins:
 *  1. The send form asks «سعر الصرف» ONLY where the door named two currencies (`destinations[].rate`); the press stays
 *     shut until it is a number above zero; the body carries it as a number. NEGATIVE: one currency — no field, no key.
 *  2. The receipt of such a transfer says the stored rate, takes the landed lines in the SENDING store's currency, and
 *     after the press prints the server's conversion («بسعر صرف R: X = Y»). NEGATIVE: without a rate, none of it.
 *  3. The list prints a received line's landed lines in the source currency and its conversion, as the door sent them.
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
      { id: 'p1', name: 'كريم اليدين', sku: 'K-1' },
      { id: 'p2', name: 'صابون الزيت', sku: 'S-2' },
      { id: 'p3', name: 'قميص', sku: 'Q-3', variantOptions: '[{"id":"o1","name":"المقاس","values":[{"id":"l","label":"L"}]}]' },
    ],
  }),
}));

import { StockTransfersScreen } from './StockTransfersScreen';

type T = Record<string, unknown>;

const HERE = { id: 's1', name: 'المتجر', countryId: 'k1', countryName: 'البلد الأول' };
const DEST = [
  { storeId: 's2', storeName: 'متجر تاني', countryId: 'k1', countryName: 'البلد الأول', warehouses: [{ id: 'wC', name: 'مخزن الوسط', countryId: 'k1' }] },
  { storeId: 's3', storeName: 'متجر برّا', countryId: 'k2', countryName: 'البلد التاني', warehouses: [{ id: 'wJ', name: 'مخزن برّا', countryId: 'k2' }] },
];
const W = [
  { id: 'wA', name: 'مخزن الشمال', countryId: 'k1' },
  { id: 'wB', name: 'مخزن الجنوب', countryId: 'k1' },
];

const transfer = (over: T = {}): T => ({
  id: 't1',
  kind: 'BETWEEN_STORES',
  kindAr: 'بين متجرين',
  status: 'SENT',
  statusAr: 'بالطريق',
  blind: true,
  note: null,
  fromName: 'مخزن الشمال',
  toName: 'مخزن الوسط',
  fromStoreName: 'المتجر',
  toStoreName: 'متجر تاني',
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
  mayApprove: false,
  lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: null, quantityReceived: null, difference: null, toProductId: 'q1', toProductName: 'كريم تاني' }],
  ...over,
});

let list: T;
let confirmSays = true;
let asked: string[] = [];
let pairs: T;
let onPost: (url: string, body: T) => unknown;
const calls = (method: string) =>
  api.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === method)
    .map(([u, init]) => [u, (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : null]);

const as = (...keys: string[]) => {
  user.current = { ...user.current, permissions: ['inventory.view', ...keys] };
};

beforeEach(() => {
  api.mockReset();
  as();
  confirmSays = true;
  asked = [];
  vi.spyOn(window, 'confirm').mockImplementation((text?: string) => (asked.push(String(text)), confirmSays));
  list = { warehouses: W, here: HERE, destinations: DEST, mayAbroad: false, transfers: [], road: { onTheRoad: 0, internal: 0, across: 0, totals: null, heldBack: 0 } };
  pairs = {
    pairs: [],
    proposals: [{ hintAr: 'نفس الرمز', sure: true, product: { id: 'p1', name: 'كريم اليدين', sku: 'K-1' }, candidates: [{ id: 'q1', name: 'كريم تاني', sku: 'K-1' }] }],
    otherProducts: [
      { id: 'q1', name: 'كريم تاني', sku: 'K-1' },
      { id: 'q2', name: 'صابون تاني', sku: 'S-9' },
    ],
  };
  onPost = () => ({ transfer: { status: 'SENT' }, replay: false });
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'DELETE') return onPost(url, init.body ? JSON.parse(init.body as string) : {});
    if (url === '/api/inventory/transfers') return list;
    if (url.startsWith('/api/inventory/pairs?otherStoreId=')) return pairs;
    if (url === '/api/products/p3/variants') return { options: [], placed: true, combinations: [{ id: 'v1', label: 'أسود · L', status: 'ACTIVE', onHand: 9, places: [{ warehouseId: 'wA', onHand: 9 }] }] };
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => cleanup());

const mount = async () => {
  render(<StockTransfersScreen />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/inventory/transfers'));
};
const table = async () => within((await waitFor(() => { const t = document.querySelector('table'); if (!t) throw new Error('no table'); return t; })) as HTMLElement);
const pick = (dialog: HTMLElement, group: string, name: string) =>
  fireEvent.click(within(within(dialog).getByRole('radiogroup', { name: group })).getByRole('radio', { name }));

const openForm = async () => {
  as('inventory.transfer');
  await mount();
  fireEvent.click(await screen.findByRole('button', { name: 'نقل جديد' }));
  return screen.findByRole('dialog');
};
const fillLine = async (dialog: HTMLElement, product = 'كريم اليدين', qty = '3') => {
  await userEvent.click(within(dialog).getAllByPlaceholderText(/ابحث بالاسم/)[0]);
  await userEvent.click(within(dialog).getByText(product));
  fireEvent.change(within(dialog).getByLabelText('كمية السطر 1'), { target: { value: qty } });
};

const SYP = { code: 'SYP', minorUnit: 2 };
const JOD = { code: 'JOD', minorUnit: 3 };
const withRate = () => DEST.map((d) => (d.storeId === 's3' ? { ...d, rate: { fromCode: 'SYP', toCode: 'JOD' } } : d));

describe('the send form asks the rate only between two currencies', () => {
  const toAbroad = async () => {
    list = { ...list, destinations: withRate(), mayAbroad: true };
    pairs = { ...pairs, pairs: [{ id: 'pr2', product: { id: 'p1' }, otherProduct: { id: 'r1', name: 'كريم برّا', sku: null }, otherStore: { id: 's3' } }] };
    onPost = () => ({ transfer: { status: 'AWAITING_APPROVAL' }, replay: false });
    const dialog = await openForm();
    pick(dialog, 'إلى متجر', 'متجر برّا — البلد التاني');
    pick(dialog, 'من مخزن', 'مخزن الشمال');
    pick(dialog, 'إلى مخزن', 'مخزن برّا');
    await fillLine(dialog);
    return dialog;
  };

  it('the field names both currencies; the press waits for a number above zero; the body carries it as a number', async () => {
    const dialog = await toAbroad();
    expect(dialog.querySelector('[data-exchange-rate="ask"]')!.textContent).toContain('كم بتساوي 1 SYP بـJOD؟');
    const press = within(dialog).getByRole('button', { name: 'اطلب الاعتماد' }) as HTMLButtonElement;
    await waitFor(() => expect(within(dialog).getByText(/بيدخل على توأمه/)).toBeTruthy());
    expect(press.disabled).toBe(true);
    const box = within(dialog).getByLabelText('سعر الصرف');
    for (const bad of ['عشرة', '0', '-1', '1.2.3']) {
      fireEvent.change(box, { target: { value: bad } });
      expect(press.disabled, bad).toBe(true);
    }
    expect(within(dialog).getByText('سعر الصرف لازم يكون رقم أكبر من صفر.')).toBeTruthy();
    fireEvent.change(box, { target: { value: '0.000071' } });
    expect(press.disabled).toBe(false);
    fireEvent.click(press);
    await screen.findByText('انكتب طلب النقل — مستني اعتماد المالك، والبضاعة لسا ما طلعت.');
    const [, body] = calls('POST').find(([u]) => u === '/api/inventory/transfers')!;
    expect(body).toMatchObject({ toStoreId: 's3', exchangeRate: 0.000071, expectKind: 'BETWEEN_COUNTRIES' });
  });

  it('a rate typed for one store is forgotten when another store is chosen', async () => {
    const dialog = await toAbroad();
    fireEvent.change(within(dialog).getByLabelText('سعر الصرف'), { target: { value: '2' } });
    pick(dialog, 'إلى متجر', 'متجر تاني');
    pick(dialog, 'إلى متجر', 'متجر برّا — البلد التاني');
    pick(dialog, 'إلى مخزن', 'مخزن برّا');
    expect((within(dialog).getByLabelText('سعر الصرف') as HTMLInputElement).value).toBe('');
  });

  it('NEGATIVE: one currency (a store the door named no `rate` for) — no field, and the body carries no rate key', async () => {
    list = { ...list, destinations: withRate() };
    pairs = { ...pairs, pairs: [{ id: 'pr1', product: { id: 'p1' }, otherProduct: { id: 'q1', name: 'كريم تاني', sku: 'K-1' }, otherStore: { id: 's2' } }] };
    const dialog = await openForm();
    pick(dialog, 'إلى متجر', 'متجر تاني');
    pick(dialog, 'من مخزن', 'مخزن الشمال');
    pick(dialog, 'إلى مخزن', 'مخزن الوسط');
    await fillLine(dialog);
    expect(dialog.querySelector('[data-exchange-rate]')).toBeNull();
    const press = within(dialog).getByRole('button', { name: 'أرسل' }) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    fireEvent.click(press);
    await screen.findByText('انبعت النقل — البضاعة صارت بالطريق.');
    const [, body] = calls('POST').find(([u]) => u === '/api/inventory/transfers')!;
    expect(body).not.toHaveProperty('exchangeRate');
  });
});

describe('the receipt of a transfer between two currencies', () => {
  const rated = (over: T = {}) =>
    transfer({
      kind: 'BETWEEN_COUNTRIES',
      kindAr: 'بين بلدين',
      toStoreName: 'متجر برّا',
      exchange: { rate: 0.000071, from: SYP, to: JOD },
      ...over,
    });
  const openReceipt = async (row: T) => {
    as('inventory.transfer_receive', 'costs.view');
    list = { ...list, transfers: [row] };
    await mount();
    fireEvent.click((await table()).getByRole('button', { name: 'استلم' }));
    return screen.findByRole('dialog');
  };

  it('says the stored rate, takes the landed lines in SYP, and prints the server’s conversion after the press', async () => {
    const dialog = await openReceipt(rated({ fromCurrency: SYP, toCurrency: JOD }));
    expect(dialog.querySelector('[data-exchange-rate="shown"]')!.textContent).toContain('1 SYP = 0.000071 JOD');
    expect(dialog.textContent).toContain('مصاريف وصول «كريم اليدين» (بـSYP)');
    fireEvent.change(within(dialog).getByLabelText('عدد «كريم اليدين» اللي وصل'), { target: { value: '10' } });
    pick(dialog, 'وصلت كلها ولا لأ؟', 'وصلت كلها');
    fireEvent.click(within(dialog).getByRole('button', { name: /زيد مصروف/ }));
    fireEvent.change(within(dialog).getByLabelText('مبلغ مصروف 1 لـ«كريم اليدين»'), { target: { value: '20' } });
    onPost = () => ({
      transfer: {
        status: 'RECEIVED',
        statusAr: 'مستلم',
        exchangeRate: 0.000071,
        lines: [{ productId: 'p1', quantitySent: 10, quantityReceived: 10, difference: 0, unitCostIn: 0.071, converted: { rate: 0.000071, sourceTotal: 10020, total: 0.71142 } }],
      },
      replay: false,
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'استلمت' }));
    expect(await screen.findByText('انستلم النقل')).toBeTruthy();
    expect(calls('POST')).toEqual([['/api/inventory/transfers/t1/receive', { lines: [{ productId: 'p1', quantity: 10, costs: [{ kind: 'TRANSPORT', amount: 20 }] }] }]]);
    expect(document.querySelector('[data-unit-cost="p1"]')!.textContent).toContain('0.071 JOD');
    expect(document.querySelector('[data-converted="p1"]')!.textContent).toBe('بسعر صرف 0.000071: 10020.00 SYP = 0.711 JOD');
  });

  it('NEGATIVE: without the cost key the currency is still SYP (the door said it), and no conversion is drawn where the door sent none', async () => {
    const dialog = await openReceipt(rated());
    expect(dialog.textContent).toContain('مصاريف وصول «كريم اليدين» (بـSYP)');
    fireEvent.change(within(dialog).getByLabelText('عدد «كريم اليدين» اللي وصل'), { target: { value: '3' } });
    pick(dialog, 'وصلت كلها ولا لأ؟', 'وصلت كلها');
    onPost = () => ({ transfer: { status: 'RECEIVED', statusAr: 'مستلم', lines: [{ productId: 'p1', quantitySent: 3, quantityReceived: 3, difference: 0 }] }, replay: false });
    fireEvent.click(within(dialog).getByRole('button', { name: 'استلمت' }));
    await screen.findByText('انستلم النقل');
    expect(document.querySelector('[data-converted]')).toBeNull();
  });

  it('NEGATIVE: a transfer of one currency says no rate and keeps the receiving store’s currency, as before', async () => {
    const dialog = await openReceipt(transfer({ toCurrency: { code: 'USD', minorUnit: 2 } }));
    expect(dialog.querySelector('[data-exchange-rate]')).toBeNull();
    expect(dialog.textContent).toContain('مصاريف وصول «كريم اليدين» (بـUSD)');
  });
});

describe('the list', () => {
  it('a received line between two currencies: landed lines in the source currency, and the conversion as the door sent it', async () => {
    as('costs.view');
    list = {
      ...list,
      transfers: [
        transfer({
          kind: 'BETWEEN_COUNTRIES',
          status: 'RECEIVED',
          statusAr: 'مستلم',
          blind: false,
          receivedById: 'u-x',
          receivedByName: 'منى',
          fromCurrency: SYP,
          toCurrency: JOD,
          exchange: { rate: 0.000071, from: SYP, to: JOD },
          lines: [
            {
              productId: 'p1',
              productName: 'كريم اليدين',
              quantitySent: 10,
              quantityReceived: 10,
              difference: 0,
              toProductId: 'r1',
              toProductName: 'كريم برّا',
              costOut: 10000,
              landedCosts: [{ kind: 'TRANSPORT', amount: 20 }],
              unitCostIn: 0.071,
              converted: { rate: 0.000071, sourceTotal: 10020, total: 0.71142 },
            },
          ],
        }),
      ],
    };
    await mount();
    const t = await table();
    expect(t.getByText('شحن: 20.00 SYP')).toBeTruthy();
    expect(document.querySelector('[data-converted="p1"]')!.textContent).toBe('بسعر صرف 0.000071: 10020.00 SYP = 0.711 JOD');
  });
});
