// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «السعر شامل التوصيل» — THE BOX ON THE «طلب بالذكاء» REVIEW (the owner, 1/11).
 *
 * After the paste is read, the reviewer sees the order before it is written. The box sits under the price, TICKED, and the
 * confirm request carries it (`parsed.priceIncludesDelivery`) — the door reads it as her word for this order. Unticked it says
 * false; opening the dialog again starts ticked.
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), apiJson: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar', isRtl: true }) }));
vi.mock('@/context/StoreCurrency', () => ({ useStoreCurrency: () => ({ code: 'JOD', minorUnit: 2 }) }));
vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({ regions: [{ id: 'r1', name: 'دمشق' }], countryName: 'سوريا', currency: { code: 'JOD', minorUnit: 2 } }),
}));
vi.mock('@/hooks/useProducts', () => ({
  useProducts: () => ({ products: [{ id: 'prod-a', name: 'كريم' }, { id: 'prod-b', name: 'زيت' }] }),
}));
vi.mock('@/components/ui/ProductPicker', () => ({
  ProductPicker: ({ value, onChange, products }: { value: string; onChange: (id: string) => void; products: { id: string; name: string }[] }) => (
    <select aria-label="المنتج" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {products.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  ),
}));

import { AiOrderModal } from './AiOrderModal';

const PREVIEW = {
  parsed: {
    customerName: 'عبدالله', phone: '0936654998', governorate: 'دمشق', address: 'بانياس',
    productQuery: 'كريم', quantity: 1, price: 22, notes: '', source: 'الشيت',
  },
  engine: 'deterministic',
  matchedProduct: { id: 'prod-a', name: 'كريم', score: 40 },
  productMatchConfident: true,
  suggestedPrice: 22,
  suggestedOfferName: 'قطعة',
  priceFromOffer: true,
  typedPrice: null,
  offerPrices: [{ quantity: 1, price: 22, name: 'قطعة' }],
  existingCustomer: null,
  aiSkipped: null,
};

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const bodies: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  bodies.length = 0;
  apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    bodies.push(body);
    return body.confirm ? reply(200, { success: true }) : reply(200, PREVIEW);
  });
});
afterEach(cleanup);

async function parse(isOpen = true) {
  const view = render(<AiOrderModal isOpen={isOpen} onClose={vi.fn()} onSuccess={vi.fn()} />);
  fireEvent.change(screen.getByPlaceholderText(/الاسم:/), { target: { value: 'الاسم: عبدالله' } });
  fireEvent.click(screen.getByRole('button', { name: /تحليل الطلب/ }));
  await waitFor(() => expect((screen.getByLabelText(/الإجمالي/) as HTMLInputElement).value).toBe('22'));
  return view;
}
const box = () => screen.getByRole('checkbox', { name: /شامل التوصيل/ }) as HTMLInputElement;
const confirmed = () => bodies.find((b) => b.confirm)!.parsed as Record<string, unknown>;
const save = async () => {
  fireEvent.click(screen.getByRole('button', { name: /تسجيل الطلب/ }));
  await waitFor(() => expect(bodies.some((b) => b.confirm)).toBe(true));
};

describe('the review of a pasted order', () => {
  it('draws the box ticked under the price, and says what ticked means', async () => {
    await parse();
    expect(box().checked).toBe(true);
    expect(screen.getByText('الزبون بيدفع السعر بس، وأجرة التوصيل على المتجر.')).toBeTruthy();
  });

  it('left ticked, the confirm request says delivery is in the price', async () => {
    await parse();
    await save();
    expect(confirmed().priceIncludesDelivery).toBe(true);
    expect(confirmed().finalPrice).toBe('22');
  });

  it('UNTICKED, it says false — and the hint says the fee is added', async () => {
    await parse();
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    expect(screen.getByText('بينضاف توصيل على الزبون لما تنعمل الشحنة.')).toBeTruthy();
    await save();
    expect(confirmed().priceIncludesDelivery).toBe(false);
  });

  it('NEGATIVE: opening the dialog again starts ticked', async () => {
    const view = await parse();
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    view.rerender(<AiOrderModal isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />);
    view.rerender(<AiOrderModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/الاسم:/), { target: { value: 'الاسم: عبدالله' } });
    fireEvent.click(screen.getByRole('button', { name: /تحليل الطلب/ }));
    await waitFor(() => expect((screen.getByLabelText(/الإجمالي/) as HTMLInputElement).value).toBe('22'));
    expect(box().checked).toBe(true);
  });
});
