// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «نقل البضاعة» ACROSS STORES AND COUNTRIES (warehouse plan W7c) — the screen of W7b's doors and W7a's pair doors.
 *
 * DEFINITION OF DONE it pins:
 *  1. The destination store is chosen (this one or another she reaches — the door's `destinations`), and its country's
 *     warehouses are the ones offered; the kind is said BEFORE the press, «بدّو اعتماد المالك» for another country, and
 *     without the abroad key the press stays shut with its sentence.
 *  2. The twin picker: a product with no twin keeps the press shut with its sentence; a proposal or a hand-picked twin is
 *     saved by the pair door; «فك الربط» removes it; the send carries `toStoreId` and no combinations.
 *  3. The owner's «اعتمد وابعت» is drawn only where the door said `mayApprove` — never from the keys she holds.
 *  4. A receipt from another store asks «وصلت كلها ولا لأ؟» and takes landed cost lines (add / remove; amount; what it was);
 *     the receiver still sees no sent figure before the press; a zero cost asks its reason when the door names it.
 *  5. «بضاعة بالطريق» is the door's report, drawn as it came; costs only where the door sent them.
 *  6. Every refusal is the door's sentence (a product with combinations across stores included).
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
const refuse = (sentence: string, data: T = {}) => () => {
  throw Object.assign(new Error(sentence), { data: { errorAr: sentence, ...data } });
};
const btn = (name: string) => screen.queryAllByRole('button', { name })[0] ?? null;
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

describe('the destination and the kind, before the press', () => {
  it('another store swaps the warehouses to its country’s; the kind sentence names both stores', async () => {
    const dialog = await openForm();
    // This store first: its own two warehouses.
    expect(within(within(dialog).getByRole('radiogroup', { name: 'إلى مخزن' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['مخزن الشمال', 'مخزن الجنوب']);
    pick(dialog, 'إلى متجر', 'متجر تاني');
    expect(within(within(dialog).getByRole('radiogroup', { name: 'إلى مخزن' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['مخزن الوسط']);
    pick(dialog, 'من مخزن', 'مخزن الشمال');
    pick(dialog, 'إلى مخزن', 'مخزن الوسط');
    expect(dialog.querySelector('[data-kind]')!.getAttribute('data-kind')).toBe('BETWEEN_STORES');
    expect(dialog.textContent).toContain('من المتجر إلى متجر تاني');
    expect(dialog.querySelector('[data-owner-approval]')).toBeNull();
  });

  it('another country: «بدّو اعتماد المالك» and the press asks for it; NEGATIVE: without the abroad key it stays shut, with its sentence', async () => {
    const dialog = await openForm();
    pick(dialog, 'إلى متجر', 'متجر برّا — البلد التاني');
    pick(dialog, 'من مخزن', 'مخزن الشمال');
    pick(dialog, 'إلى مخزن', 'مخزن برّا');
    expect(dialog.querySelector('[data-kind]')!.getAttribute('data-kind')).toBe('BETWEEN_COUNTRIES');
    expect(dialog.querySelector('[data-owner-approval]')!.textContent).toContain('بدّو اعتماد المالك');
    pairs = { ...pairs, pairs: [{ id: 'pr2', product: { id: 'p1' }, otherProduct: { id: 'r1', name: 'كريم برّا', sku: null }, otherStore: { id: 's3' } }] };
    await fillLine(dialog);
    const press = within(dialog).getByRole('button', { name: 'اطلب الاعتماد' }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    expect(within(dialog).getByText(/بدّو صلاحية «نقل بضاعة لبلد تاني»/)).toBeTruthy();
  });

  it('with the abroad key the request is written and the screen says nothing has left yet', async () => {
    list = { ...list, mayAbroad: true };
    pairs = { ...pairs, pairs: [{ id: 'pr2', product: { id: 'p1' }, otherProduct: { id: 'r1', name: 'كريم برّا', sku: null }, otherStore: { id: 's3' } }] };
    onPost = () => ({ transfer: { status: 'AWAITING_APPROVAL' }, replay: false });
    const dialog = await openForm();
    pick(dialog, 'إلى متجر', 'متجر برّا — البلد التاني');
    pick(dialog, 'من مخزن', 'مخزن الشمال');
    pick(dialog, 'إلى مخزن', 'مخزن برّا');
    await fillLine(dialog);
    const press = within(dialog).getByRole('button', { name: 'اطلب الاعتماد' }) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    fireEvent.click(press);
    expect(await screen.findByText('انكتب طلب النقل — مستني اعتماد المالك، والبضاعة لسا ما طلعت.')).toBeTruthy();
    const [, body] = calls('POST').find(([u]) => u === '/api/inventory/transfers')!;
    expect(body).toMatchObject({ fromWarehouseId: 'wA', toWarehouseId: 'wJ', toStoreId: 's3', expectKind: 'BETWEEN_COUNTRIES', lines: [{ productId: 'p1', quantity: 3 }] });
  });
});

describe('the twin picker', () => {
  const across = async () => {
    const dialog = await openForm();
    pick(dialog, 'إلى متجر', 'متجر تاني');
    pick(dialog, 'من مخزن', 'مخزن الشمال');
    pick(dialog, 'إلى مخزن', 'مخزن الوسط');
    await fillLine(dialog);
    return dialog;
  };

  it('NEGATIVE: a product with no twin keeps the press shut, with its sentence', async () => {
    const dialog = await across();
    expect(await within(dialog).findByText(/ما إله توأم بـمتجر تاني، وما بينبعت لمتجر تاني بلا توأم/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'أرسل' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api).toHaveBeenCalledWith('/api/inventory/pairs?otherStoreId=s2');
  });

  it('the proposal is one press; the pair door saves it; the line then shows its twin and the press opens; the send carries the store', async () => {
    onPost = (url) => {
      if (url === '/api/inventory/pairs') {
        pairs = { ...pairs, proposals: [], pairs: [{ id: 'pr1', product: { id: 'p1' }, otherProduct: { id: 'q1', name: 'كريم تاني', sku: 'K-1' }, otherStore: { id: 's2' } }] };
        return { pair: {}, replay: false };
      }
      return { transfer: { status: 'SENT' }, replay: false };
    };
    const dialog = await across();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'اربط بـكريم تاني (K-1)' }));
    expect(await within(dialog).findByText(/بيدخل على توأمه بـمتجر تاني/)).toBeTruthy();
    expect(calls('POST')[0]).toEqual(['/api/inventory/pairs', { productId: 'p1', otherProductId: 'q1' }]);
    const press = within(dialog).getByRole('button', { name: 'أرسل' }) as HTMLButtonElement;
    expect(press.disabled).toBe(false);
    fireEvent.click(press);
    expect(await screen.findByText('انبعت النقل — البضاعة صارت بالطريق.')).toBeTruthy();
    const [, body] = calls('POST').find(([u]) => u === '/api/inventory/transfers')!;
    expect(body).toMatchObject({ toWarehouseId: 'wC', toStoreId: 's2', expectKind: 'BETWEEN_STORES' });
    // No combinations across stores — the door refuses such a product in its own sentence.
    expect(body.lines).toEqual([{ productId: 'p1', quantity: 3 }]);
  });

  it('a twin picked by hand among the other store’s products, then «فك الربط» removes it by the pair door', async () => {
    onPost = (url) => {
      if (url === '/api/inventory/pairs') {
        pairs = { ...pairs, proposals: [], pairs: [{ id: 'pr9', product: { id: 'p1' }, otherProduct: { id: 'q2', name: 'صابون تاني', sku: 'S-9' }, otherStore: { id: 's2' } }] };
      }
      if (url === '/api/inventory/pairs/pr9') pairs = { ...pairs, pairs: [] };
      return {};
    };
    const dialog = await across();
    await userEvent.click(await within(dialog).findByPlaceholderText(/ابحث عن توأم السطر 1/));
    await userEvent.click(within(dialog).getByText('صابون تاني'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'احفظ الربط' }));
    expect(await within(dialog).findByText('صابون تاني (S-9)')).toBeTruthy();
    expect(calls('POST')[0]).toEqual(['/api/inventory/pairs', { productId: 'p1', otherProductId: 'q2' }]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'فك الربط' }));
    expect(await within(dialog).findByText(/ما إله توأم/)).toBeTruthy();
    expect(calls('DELETE')).toEqual([['/api/inventory/pairs/pr9', null]]);
  });

  it('NEGATIVE: combinations typed for this store are not carried to another store — the door judges the product itself', async () => {
    pairs = { ...pairs, pairs: [{ id: 'pr3', product: { id: 'p3' }, otherProduct: { id: 'q3', name: 'قميص تاني', sku: null }, otherStore: { id: 's2' } }] };
    const dialog = await openForm();
    pick(dialog, 'من مخزن', 'مخزن الشمال');
    pick(dialog, 'إلى مخزن', 'مخزن الجنوب');
    await fillLine(dialog, 'قميص', '5');
    fireEvent.change(await within(dialog).findByLabelText('عدد «أسود · L» بالسطر 1'), { target: { value: '5' } });
    pick(dialog, 'إلى متجر', 'متجر تاني');
    pick(dialog, 'إلى مخزن', 'مخزن الوسط');
    expect(within(dialog).queryByLabelText('عدد «أسود · L» بالسطر 1')).toBeNull();
    const press = within(dialog).getByRole('button', { name: 'أرسل' }) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    fireEvent.click(press);
    await screen.findByText('انبعت النقل — البضاعة صارت بالطريق.');
    const [, body] = calls('POST').find(([u]) => u === '/api/inventory/transfers')!;
    expect(body.lines).toEqual([{ productId: 'p3', quantity: 5 }]);
  });

  it('the door’s refusals are printed as they came — a product with combinations across stores, a twin already taken', async () => {
    pairs = { ...pairs, pairs: [{ id: 'pr1', product: { id: 'p1' }, otherProduct: { id: 'q1', name: 'كريم تاني', sku: 'K-1' }, otherStore: { id: 's2' } }] };
    const sentence = 'المنتج اللي إله خيارات (مقاس/لون) ما بينقل لمتجر تاني لسا: ما في ربط بين خيارات المتجرين.';
    onPost = refuse(sentence, { code: 'VARIANTS_ACROSS' });
    const dialog = await across();
    const press = within(dialog).getByRole('button', { name: 'أرسل' }) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    fireEvent.click(press);
    expect(await within(dialog).findByText(sentence)).toBeTruthy();
  });
});

describe('the owner’s press — the door decides who sees it', () => {
  const awaiting = (over: T = {}) =>
    transfer({ kind: 'BETWEEN_COUNTRIES', kindAr: 'بين بلدين', status: 'AWAITING_APPROVAL', statusAr: 'مستني اعتماد المالك', toStoreName: 'متجر برّا', ...over });

  it('NEGATIVE: a person holding every key is not offered it when the door says no', async () => {
    as('inventory.transfer', 'inventory.transfer_receive', 'inventory.difference_approve', 'inventory.transfer_abroad', 'costs.view');
    list = { ...list, transfers: [awaiting({ mayApprove: false })] };
    await mount();
    const t = await table();
    expect(t.getByText('البضاعة لسا ما طلعت — بدّو اعتماد المالك')).toBeTruthy();
    expect(btn('اعتمد وابعت')).toBeNull();
    // The sender's own cancel is still there before the goods leave.
    expect(t.getByRole('button', { name: 'إلغاء' })).toBeTruthy();
  });

  it('where the door says yes: «اعتمد وابعت» posts the approval and the list reloads', async () => {
    list = { ...list, transfers: [awaiting({ mayApprove: true })] };
    await mount();
    fireEvent.click((await table()).getByRole('button', { name: 'اعتمد وابعت' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعتمد وابعت' }));
    expect(await screen.findByText('انعتمد النقل وانبعت — البضاعة صارت بالطريق.')).toBeTruthy();
    expect(calls('POST')).toEqual([['/api/inventory/transfers/t1/approve', {}]]);
  });

  it('the door’s refusal of the press is its sentence', async () => {
    list = { ...list, transfers: [awaiting({ mayApprove: true })] };
    onPost = refuse('اعتماد النقل لبلد تاني إلو للمالك بس.');
    await mount();
    fireEvent.click((await table()).getByRole('button', { name: 'اعتمد وابعت' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعتمد وابعت' }));
    expect(await within(dialog).findByText('اعتماد النقل لبلد تاني إلو للمالك بس.')).toBeTruthy();
  });
});

describe('the receipt from another store', () => {
  const openReceipt = async (row: T = transfer()) => {
    as('inventory.transfer_receive');
    list = { ...list, transfers: [row] };
    await mount();
    fireEvent.click((await table()).getByRole('button', { name: 'استلم' }));
    return screen.findByRole('dialog');
  };

  it('NEGATIVE: the arrival question must be answered; the dialog still shows no sent figure; landed lines go to the door as typed', async () => {
    // A row that carries the sent figure and a currency: neither the figure nor the costOut may show before the press.
    const dialog = await openReceipt(transfer({ blind: false, toCurrency: { code: 'USD', minorUnit: 2 }, lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: 37, quantityReceived: null, difference: null, toProductId: 'q1' }] }));
    expect(dialog.textContent).not.toMatch(/37/);
    expect(dialog.textContent).toContain('مصاريف وصول «كريم اليدين» (بـUSD)');
    fireEvent.change(within(dialog).getByLabelText('عدد «كريم اليدين» اللي وصل'), { target: { value: '30' } });
    const press = within(dialog).getByRole('button', { name: 'استلمت' }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    pick(dialog, 'وصلت كلها ولا لأ؟', 'في ناقص أو تالف');
    expect(press.disabled).toBe(false);
    // Two cost lines, one removed, one «غيره» that needs its word.
    fireEvent.click(within(dialog).getByRole('button', { name: /زيد مصروف/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /زيد مصروف/ }));
    fireEvent.change(within(dialog).getByLabelText('مبلغ مصروف 1 لـ«كريم اليدين»'), { target: { value: '12.5' } });
    fireEvent.click(within(within(dialog).getByRole('radiogroup', { name: 'نوع مصروف 2 لـ«كريم اليدين»' })).getByRole('radio', { name: 'غيره' }));
    fireEvent.change(within(dialog).getByLabelText('مبلغ مصروف 2 لـ«كريم اليدين»'), { target: { value: '3' } });
    expect(press.disabled).toBe(true);
    expect(within(dialog).getByText(/«غيره» بدّو كلمة/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('شو مصروف 2 لـ«كريم اليدين»'), { target: { value: 'تخليص' } });
    expect(press.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('مبلغ مصروف 1 لـ«كريم اليدين»'), { target: { value: 'عشرة' } });
    expect(press.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'شيل مصروف 1 لـ«كريم اليدين»' }));
    expect(press.disabled).toBe(false);
    expect(dialog.textContent).not.toMatch(/37/);
    onPost = () => ({
      transfer: { status: 'RECEIVED_WITH_DIFFERENCE', statusAr: 'مستلم بفرق', lines: [{ productId: 'p1', quantitySent: 37, quantityReceived: 30, difference: 7, unitCostIn: 2.1 }] },
      replay: false,
    });
    fireEvent.click(press);
    expect(await screen.findByText('انستلم النقل')).toBeTruthy();
    expect(calls('POST')).toEqual([
      ['/api/inventory/transfers/t1/receive', { lines: [{ productId: 'p1', quantity: 30, costs: [{ kind: 'OTHER', amount: 3, note: 'تخليص' }] }] }],
    ]);
    // After the press: the server's unit cost, and the shortfall is a report only.
    expect(document.querySelector('[data-unit-cost="p1"]')!.textContent).toContain('2.10 USD');
    expect(screen.getByText(/بينكتب بتقرير بس: ما بينحسب على حدا ولا على الربح/)).toBeTruthy();
  });

  it('she said «وصلت كلها» but the server found it short: the screen says so', async () => {
    const dialog = await openReceipt();
    fireEvent.change(within(dialog).getByLabelText('عدد «كريم اليدين» اللي وصل'), { target: { value: '2' } });
    pick(dialog, 'وصلت كلها ولا لأ؟', 'وصلت كلها');
    onPost = () => ({ transfer: { status: 'RECEIVED_WITH_DIFFERENCE', statusAr: 'مستلم بفرق', lines: [{ productId: 'p1', quantitySent: 3, quantityReceived: 2, difference: 1 }] }, replay: false });
    fireEvent.click(within(dialog).getByRole('button', { name: 'استلمت' }));
    expect(await screen.findByText('قلت «وصلت كلها»، بس اللي عدّيته أقل من اللي انبعت.')).toBeTruthy();
    // No unit cost drawn where the door sent none (no cost key).
    expect(document.querySelector('[data-unit-cost]')).toBeNull();
  });

  it('a zero unit cost: the door names the product, the reason box opens, and the second press carries the reason', async () => {
    const dialog = await openReceipt();
    fireEvent.change(within(dialog).getByLabelText('عدد «كريم اليدين» اللي وصل'), { target: { value: '3' } });
    pick(dialog, 'وصلت كلها ولا لأ؟', 'وصلت كلها');
    onPost = refuse('كلفة القطعة صفر. اكتب ليش.', { code: 'ZERO_COST_UNEXPLAINED', productId: 'p1' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'استلمت' }));
    expect(await within(dialog).findByText('كلفة القطعة صفر. اكتب ليش.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('ليش كلفة «كريم اليدين» صفر؟'), { target: { value: 'هدية من المورّد' } });
    onPost = () => ({ transfer: { status: 'RECEIVED', statusAr: 'مستلم', lines: [{ productId: 'p1', quantitySent: 3, quantityReceived: 3, difference: 0 }] }, replay: false });
    fireEvent.click(within(dialog).getByRole('button', { name: 'استلمت' }));
    expect(await screen.findByText('انستلم النقل')).toBeTruthy();
    expect(calls('POST').at(-1)).toEqual(['/api/inventory/transfers/t1/receive', { lines: [{ productId: 'p1', quantity: 3, zeroCostReason: 'هدية من المورّد' }] }]);
  });

  it('NEGATIVE: a receipt inside one store asks no arrival question and takes no cost line — as before', async () => {
    const dialog = await openReceipt(transfer({ kind: 'INTERNAL', kindAr: 'نقل داخل المتجر', fromStoreName: undefined, toStoreName: undefined, lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: null, quantityReceived: null, difference: null }] }));
    expect(within(dialog).queryByRole('radiogroup', { name: 'وصلت كلها ولا لأ؟' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /زيد مصروف/ })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('عدد «كريم اليدين» اللي وصل'), { target: { value: '3' } });
    expect((within(dialog).getByRole('button', { name: 'استلمت' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the list across stores, and «بضاعة بالطريق»', () => {
  it('a received row across stores: both stores named, the twin, and the costs exactly as the door sent them', async () => {
    list = {
      ...list,
      transfers: [
        transfer({
          status: 'RECEIVED_WITH_DIFFERENCE', statusAr: 'مستلم بفرق', blind: false, receivedById: 'u-x',
          fromCurrency: { code: 'JOD', minorUnit: 3 }, toCurrency: { code: 'JOD', minorUnit: 3 },
          lines: [{
            productId: 'p1', productName: 'كريم اليدين', quantitySent: 4, quantityReceived: 3, difference: 1, toProductId: 'q1', toProductName: 'كريم تاني',
            costOut: 8, landedCosts: [{ kind: 'CUSTOMS', amount: 1.5 }, { kind: 'OTHER', amount: 0.25, note: 'تخليص' }], unitCostIn: 2.583, missingValue: 2,
          }],
        }),
      ],
    };
    await mount();
    const t = await table();
    expect(t.getByText(/المتجر — مخزن الشمال ← متجر تاني — مخزن الوسط/)).toBeTruthy();
    expect(t.getByText('بيدخل على: كريم تاني')).toBeTruthy();
    expect(t.getByText(/طلع بكلفة 8\.000 JOD/).textContent).toContain('القطعة هناك 2.583 JOD');
    expect(t.getByText('جمرك: 1.500 JOD')).toBeTruthy();
    expect(t.getByText('غيره (تخليص): 0.250 JOD')).toBeTruthy();
    expect(t.getByText(/قيمة الناقص 2\.000 JOD — تقرير بس/)).toBeTruthy();
  });

  it('NEGATIVE: a row the door sent with no cost draws no cost at all', async () => {
    list = { ...list, transfers: [transfer({ status: 'RECEIVED', statusAr: 'مستلم', blind: false, lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: 4, quantityReceived: 4, difference: 0, toProductId: 'q1', toProductName: 'كريم تاني' }] })] };
    await mount();
    await table();
    expect(document.querySelector('[data-cost]')).toBeNull();
    expect(screen.queryByText(/طلع بكلفة/)).toBeNull();
  });

  it('the road: the door’s counts and its totals per store, as they came; the held-back sentence', async () => {
    list = {
      ...list,
      road: { onTheRoad: 3, internal: 1, across: 2, heldBack: 1, totals: [{ storeId: 's1', storeName: 'المتجر', currency: { code: 'JOD', minorUnit: 3 }, transfers: 1, cost: 6 }] },
    };
    await mount();
    const road = await screen.findByRole('region', { name: 'بضاعة بالطريق' });
    expect(road.textContent).toContain('1 داخل المتجر · 2 لمتجر تاني');
    expect(road.textContent).toContain('قيمة اللي طالع من المتجر');
    expect(road.textContent).toContain('6.000 JOD');
    expect(road.textContent).toContain('في 1 نقل قيمته مخفية عنك');
  });

  it('NEGATIVE: nothing on the road draws no report; no cost key draws no value tile', async () => {
    await mount();
    expect(screen.queryByRole('region', { name: 'بضاعة بالطريق' })).toBeNull();
    cleanup();
    list = { ...list, road: { onTheRoad: 2, internal: 0, across: 2, heldBack: 0, totals: null } };
    await mount();
    const road = await screen.findByRole('region', { name: 'بضاعة بالطريق' });
    expect(road.textContent).not.toMatch(/قيمة/);
  });
});

describe('the sources', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

  it('no arithmetic on a figure in the browser: nothing is summed, no cost is multiplied or divided', () => {
    for (const p of ['src/components/screens/StockTransfersScreen.tsx', 'src/components/inventory/TransferAcross.tsx']) {
      const code = read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, p).not.toMatch(/\.reduce\(/);
      expect(code, p).not.toMatch(/(costOut|unitCostIn|amount|cost)\s*[*/]/);
    }
  });

  it('a column as wide as the phone: no fixed width, no horizontal scroll, no nowrap, no text-xs', () => {
    const src = read('src/components/inventory/TransferAcross.tsx');
    expect(src).not.toMatch(/\bw-\[\d|min-w-\[|overflow-x|whitespace-nowrap|text-xs/);
  });
});
