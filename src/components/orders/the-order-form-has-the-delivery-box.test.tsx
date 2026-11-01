// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «السعر شامل التوصيل» — THE BOX ON THE NEW-ORDER FORM (the owner, 1/11)
 *
 * «يكون حاط شيك بوكس شامل التوصيل، لو مش محطوط صح يضيف توصيل. الافتراضي فيه شامل التوصيل يعني البوكس صح».
 *
 *  · the form draws the box, TICKED, and says what each state means;
 *  · whatever the state, the order request carries `priceIncludesDelivery` (the door reads it as the person's word);
 *  · unticking it sends false; opening the form again starts ticked again — a box left unticked once does not stay so;
 *  · the other fields of the request are what they were.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, apiJson, toast, user } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() },
  user: { current: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: (k: string) => k, locale: 'ar', isRtl: true, currentUser: user.current }),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({
    regions: [{ id: 'r1', name: 'عمّان', delivery: null, deliveryAr: null }],
    countryName: 'الأردن',
    currency: { code: 'JOD', minorUnit: 3 },
    loading: false,
  }),
}));
vi.mock('@/hooks/useDeliveryEta', () => ({ useDeliveryEta: () => ({ eta: null, loading: false }) }));
vi.mock('@/hooks/useProducts', () => ({
  useProducts: () => ({ products: [{ id: 'p1', name: 'كريم', basePrice: 10, offers: [] }], loading: false }),
}));

import { CreateOrderModal } from './CreateOrderModal';

const ORDER = { id: 'o-1', orderNumber: 'ORD-26-0001' };
const onSuccess = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  user.current = { id: 'u1', status: 'ACTIVE', role: 'MODERATOR', permissions: ['orders.create'] };
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') return { ok: true, json: async () => ({ order: ORDER }) };
    return { ok: true, json: async () => ({}) };
  });
  apiJson.mockResolvedValue({});
});
afterEach(cleanup);

const open = async () => {
  render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={onSuccess} />);
  await screen.findByLabelText('المحافظة');
};
const fill = () => {
  fireEvent.change(screen.getByPlaceholderText('مثال: 0936654998'), { target: { value: '0791234567' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: عبدالله عبدالقادر'), { target: { value: 'سامر أحمد' } });
  fireEvent.change(screen.getByPlaceholderText('الشارع، البناء، المنطقة...'), { target: { value: 'عمّان - الجبيهة' } });
  fireEvent.change(screen.getByLabelText('المحافظة'), { target: { value: 'r1' } });
};
const submit = async () => {
  const button = await screen.findByRole('button', { name: /إنشاء الطلب/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.click(button);
  });
};
const sent = () => {
  const call = apiFetch.mock.calls.find((c) => c[0] === '/api/orders' && (c[1] as RequestInit | undefined)?.method === 'POST');
  return JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
};
const box = () => screen.getByRole('checkbox', { name: /شامل التوصيل/ }) as HTMLInputElement;

describe('the new-order form', () => {
  it('draws the box ticked, and says what ticked means', async () => {
    await open();
    expect(box().checked).toBe(true);
    expect(screen.getByText('الزبون بيدفع سعر الطلب بس، وأجرة التوصيل على المتجر.')).toBeTruthy();
  });

  it('left ticked, the request says so — the offer or the store policy is not asked about by the screen', async () => {
    await open();
    fill();
    await submit();
    expect(sent().priceIncludesDelivery).toBe(true);
    expect(sent().customerName).toBe('سامر أحمد');
    expect(Array.isArray(sent().items)).toBe(true);
  });

  it('UNTICKED: the request says false, and the hint says the fee is added', async () => {
    await open();
    fill();
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    expect(screen.getByText('بينضاف توصيل على الزبون لما تنعمل الشحنة.')).toBeTruthy();
    await submit();
    expect(sent().priceIncludesDelivery).toBe(false);
  });

  it('NEGATIVE: opening the form again starts ticked — a box unticked once does not stay unticked', async () => {
    const { rerender } = render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={onSuccess} />);
    await screen.findByLabelText('المحافظة');
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    rerender(<CreateOrderModal isOpen={false} onClose={() => {}} onSuccess={onSuccess} />);
    rerender(<CreateOrderModal isOpen onClose={() => {}} onSuccess={onSuccess} />);
    await screen.findByLabelText('المحافظة');
    expect(box().checked).toBe(true);
  });
});
