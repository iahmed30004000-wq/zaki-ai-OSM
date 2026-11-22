// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * 22/11 (F1) — THE OWNER'S «صلحها»: A STORE PLACED ON WAREHOUSES CAN BE WORKED FROM ITS SCREENS.
 *
 *   «تشغيلة إنتاج» (ManufacturingScreen → POST /api/production): a placed store's run names its warehouse. The choices
 *     and the one chosen for her come from the server (`GET /api/production` → `warehouses`, `defaultWarehouseId`).
 *   «المقاسات والألوان» (ProductVariants → PUT /api/products/[id]/variants): a placed store's count is a WAREHOUSE's,
 *     with a reason; without a warehouse the totals go back untouched, so a price or a SKU still saves. The pieces on a
 *     transfer's road are «بالطريق», never «بلا مكان».
 *   A store that is NOT placed: no picker, and the body on the wire has exactly the keys it had.
 *
 * Every assertion reads what is drawn or THE BODY ON THE WIRE. Nothing behind the login opens in a browser here (every
 * account has a second factor), so the screens are proven rendered in jsdom.
 */

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar' }),
}));
vi.mock('@/components/ui/ProductPicker', () => ({
  ProductPicker: ({ value }: { value: string }) => <div data-testid="picker">{value}</div>,
}));
vi.mock('@/components/production/BatchCostDialog', () => ({
  BatchCostDialog: () => null,
}));

const api = vi.hoisted(() => ({
  answer: null as unknown,
  sent: [] as { url: string; body: Record<string, unknown> }[],
}));
vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiJson: async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      api.sent.push({ url, body: JSON.parse(String(init.body)) });
      return {};
    }
    return api.answer;
  },
}));

import { ManufacturingScreen } from './ManufacturingScreen';
import { ProductVariants } from '@/components/products/ProductVariants';

const MAIN = { id: 'wh-main', name: 'المخزن الرئيسي' };
const BRANCH = { id: 'wh-branch', name: 'مخزن الفرع' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ───────────────────────── «تشغيلة إنتاج» ───────────────────────── */

const PRODUCT = { id: 'prod-1', name: 'كريم', sku: 'KR-1', sourceType: 'MANUFACTURED', basePrice: 10 };
let production: Record<string, unknown> = {};
let posted: Record<string, unknown>[] = [];

beforeEach(() => {
  posted = [];
  api.sent = [];
  production = { batches: [], currency: 'JOD' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        posted.push(JSON.parse(String(init!.body)));
        return { ok: true, json: async () => ({ success: true, batch: { id: 'b1' } }) } as unknown as Response;
      }
      if (url.startsWith('/api/products')) return { ok: true, json: async () => ({ products: [PRODUCT] }) } as unknown as Response;
      return { ok: true, json: async () => production } as unknown as Response;
    })
  );
});

const PICK = 'المخزن اللي نزلت عليه التشغيلة *';
const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<ManufacturingScreen />);
  await waitFor(() => expect(screen.getByText('لا تشغيلاتِ إنتاجٍ بعد')).toBeTruthy());
  await user.click(screen.getByText('تشغيلة جديدة'));
  await waitFor(() => expect(screen.getByTestId('picker').textContent).toBe('prod-1'));
};
const fillRun = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('رقم التشغيلة *'), 'RUN-1');
  await user.type(screen.getByLabelText('الكمية المنتَجة (قطعة) *'), '10');
};
const saveRun = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByText('احفظ الدفعة وأضفها للمخزون'));
/** The keys the screen sent before F1 (an empty cost box is absent: `onTheWire` → undefined). */
const OLD_KEYS = ['productId', 'batchNumber', 'quantityProduced', 'manufacturingCost', 'packagingCost', 'rawMaterialCost', 'otherCosts', 'costLines', 'notes'];

describe('«تشغيلة إنتاج» — a store that is NOT placed is the screen it was', () => {
  it('no warehouse picker, and the body carries no warehouse', async () => {
    const user = userEvent.setup();
    await openForm(user);
    expect(screen.queryByLabelText(PICK)).toBeNull();
    expect(screen.queryByText(/موزّع على مخازن/)).toBeNull();
    await fillRun(user);
    await saveRun(user);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(Object.keys(posted[0]).every((k) => OLD_KEYS.includes(k))).toBe(true);
    expect('warehouseId' in posted[0]).toBe(false);
  });
});

describe('«تشغيلة إنتاج» — a placed store names the warehouse', () => {
  it('the keeper: her warehouse is chosen for her and goes on the wire', async () => {
    production = { ...production, placed: true, warehouses: [MAIN, BRANCH], defaultWarehouseId: MAIN.id };
    const user = userEvent.setup();
    await openForm(user);
    const pick = screen.getByLabelText(PICK) as HTMLSelectElement;
    expect(pick.value).toBe(MAIN.id);
    expect([...pick.options].map((o) => o.textContent)).toEqual(['اختار المخزن', MAIN.name, BRANCH.name]);
    await fillRun(user);
    await saveRun(user);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].warehouseId).toBe(MAIN.id);
  });

  it('NEGATIVE: two warehouses and none chosen — the form says so and sends nothing; once chosen, it sends that one', async () => {
    production = { ...production, placed: true, warehouses: [MAIN, BRANCH], defaultWarehouseId: null };
    const user = userEvent.setup();
    await openForm(user);
    await fillRun(user);
    await saveRun(user);
    expect(await screen.findByText('اختار المخزن اللي نزلت عليه التشغيلة.')).toBeTruthy();
    expect(posted).toEqual([]);
    await user.selectOptions(screen.getByLabelText(PICK), BRANCH.id);
    await saveRun(user);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].warehouseId).toBe(BRANCH.id);
  });

  it('one warehouse only: it is the choice, with no empty line', async () => {
    production = { ...production, placed: true, warehouses: [BRANCH], defaultWarehouseId: BRANCH.id };
    const user = userEvent.setup();
    await openForm(user);
    const pick = screen.getByLabelText(PICK) as HTMLSelectElement;
    expect([...pick.options].map((o) => o.value)).toEqual([BRANCH.id]);
  });

  it('none reached: the form says why instead of offering a picker', async () => {
    production = { ...production, placed: true, warehouses: [], defaultWarehouseId: null };
    const user = userEvent.setup();
    await openForm(user);
    expect(screen.queryByLabelText(PICK)).toBeNull();
    expect(screen.getByText(/ما إلك وصول على ولا مخزن منها/)).toBeTruthy();
  });
});

/* ───────────────────────── «المقاسات والألوان» ───────────────────────── */

const OPTIONS = [{ id: 'size', name: 'المقاس', values: [{ id: 's', label: 'S', swatch: null }, { id: 'm', label: 'M', swatch: null }] }];
const combo = (id: string, v: string, onHand: number, extra: Record<string, unknown> = {}) => ({
  id, values: [v], label: v.toUpperCase(), sku: null, priceDelta: 0, onHand, held: 0, free: onHand, status: 'ACTIVE', ...extra,
});
const renderVariants = async () => {
  render(<ProductVariants productId="prod-1" canManage canChangePrice currency="JOD" />);
  await waitFor(() => expect(screen.getByText('حفظ المقاسات والألوان')).toBeTruthy());
};
const firstBox = (label: string) => screen.getAllByLabelText(label)[0] as HTMLInputElement;
const COUNT_PICK = 'المخزن اللي عدّيته';

describe('«المقاسات والألوان» — a store that is NOT placed is the screen it was', () => {
  it('no picker; the PUT has exactly {options, combinations} and the typed total', async () => {
    api.answer = { options: OPTIONS, combinations: [combo('v-small', 's', 6), combo('v-medium', 'm', 3)] };
    const user = userEvent.setup();
    await renderVariants();
    expect(screen.queryByLabelText(COUNT_PICK)).toBeNull();
    expect(screen.queryAllByLabelText('عدد S بالمخزن')).toHaveLength(0);
    const box = firstBox('مخزون S');
    await user.clear(box);
    await user.type(box, '9');
    await user.click(screen.getByText('حفظ المقاسات والألوان'));
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(Object.keys(api.sent[0].body)).toEqual(['options', 'combinations']);
    expect((api.sent[0].body.combinations as { onHand: number }[]).map((c) => c.onHand)).toEqual([9, 3]);
  });
});

describe('«المقاسات والألوان» — a placed store counts one warehouse', () => {
  const placedAnswer = (defaultWarehouseId: string | null) => ({
    options: OPTIONS,
    placed: true,
    warehouses: [MAIN, BRANCH],
    defaultWarehouseId,
    combinations: [
      combo('v-small', 's', 10, {
        places: [
          { warehouseId: MAIN.id, onHand: 4 },
          { warehouseId: null, onHand: 2 },
          // The pieces on a transfer's road — ONE figure, flagged: never «بلا مكان».
          { warehouseId: null, onHand: 3, inTransit: true },
          { warehouseId: 'wh-elsewhere', onHand: 1 },
        ],
      }),
      combo('v-medium', 'm', 3, { places: [{ warehouseId: null, onHand: 3 }] }),
    ],
  });

  it('the box holds the chosen warehouse\'s count; under it every place by name, the road apart from «بلا مكان»', async () => {
    api.answer = placedAnswer(MAIN.id);
    await renderVariants();
    expect((screen.getByLabelText(COUNT_PICK) as HTMLSelectElement).value).toBe(MAIN.id);
    expect(firstBox('عدد S بالمخزن').value).toBe('4');
    expect(firstBox('عدد M بالمخزن').value).toBe('0');
    const line = screen.getAllByText(/^الكل 10:/)[0].textContent!;
    expect(line).toContain('المخزن الرئيسي 4');
    expect(line).toContain('بلا مكان 2');
    expect(line).toContain('بالطريق 3');
    expect(line).toContain('مخزن تاني 1');
    expect(line).not.toMatch(/بلا مكان (3|5)/);
  });

  it('a count with a reason: the warehouse, the reason, and THAT warehouse\'s numbers go on the wire', async () => {
    api.answer = placedAnswer(MAIN.id);
    const user = userEvent.setup();
    await renderVariants();
    const box = firstBox('عدد S بالمخزن');
    await user.clear(box);
    await user.type(box, '5');
    await user.type(screen.getByLabelText('سبب العدّ'), 'جرد آخر الشهر');
    await user.click(screen.getByText('حفظ المقاسات والألوان'));
    await waitFor(() => expect(api.sent).toHaveLength(1));
    const body = api.sent[0].body;
    expect(body.warehouseId).toBe(MAIN.id);
    expect(body.reason).toBe('جرد آخر الشهر');
    // S as typed; M is what the main warehouse holds of it (nothing) — never the store total.
    expect((body.combinations as { onHand: number }[]).map((c) => c.onHand)).toEqual([5, 0]);
  });

  it('switching warehouse shows that warehouse\'s numbers, and drops what was typed for the other', async () => {
    api.answer = placedAnswer(MAIN.id);
    const user = userEvent.setup();
    await renderVariants();
    await user.clear(firstBox('عدد S بالمخزن'));
    await user.type(firstBox('عدد S بالمخزن'), '8');
    await user.selectOptions(screen.getByLabelText(COUNT_PICK), BRANCH.id);
    expect(firstBox('عدد S بالمخزن').value).toBe('0');
  });

  it('no warehouse chosen: the boxes are shut, a SKU still saves, and the totals go back untouched with no warehouse', async () => {
    api.answer = placedAnswer(null);
    const user = userEvent.setup();
    await renderVariants();
    expect((screen.getByLabelText(COUNT_PICK) as HTMLSelectElement).value).toBe('');
    expect(firstBox('عدد S بالمخزن').disabled).toBe(true);
    expect(screen.queryByLabelText('سبب العدّ')).toBeNull();
    await user.type(firstBox('SKU S'), 'S-1');
    await user.click(screen.getByText('حفظ المقاسات والألوان'));
    await waitFor(() => expect(api.sent).toHaveLength(1));
    const body = api.sent[0].body;
    expect('warehouseId' in body).toBe(false);
    expect('reason' in body).toBe(false);
    expect((body.combinations as { onHand: number; sku: string | null }[]).map((c) => [c.onHand, c.sku])).toEqual([[10, 'S-1'], [3, null]]);
  });

  it('none reached: the screen says why, and offers no picker', async () => {
    api.answer = { ...placedAnswer(null), warehouses: [] };
    await renderVariants();
    expect(screen.queryByLabelText(COUNT_PICK)).toBeNull();
    expect(screen.getByText(/ما إلك وصول على ولا مخزن منها/)).toBeTruthy();
  });
});
