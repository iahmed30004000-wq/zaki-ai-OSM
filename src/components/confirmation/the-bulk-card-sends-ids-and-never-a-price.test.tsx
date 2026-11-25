// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «وزّع على الموظفات» (F12): drawn only for who may run it; the plan's words and numbers are the server's; «وزّع» sends the planned ids
 * and the agents — never a price; the prices editor is drawn only for who may change the rule. Arabic words, Western digits, no width
 * that overflows a phone.
 */
const { api, failed, done } = vi.hoisted(() => ({ api: vi.fn(), failed: vi.fn(), done: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed, done, warn: vi.fn() }) }));

import { WinbackBulkCard } from './WinbackBulkCard';

const META = {
  canBulk: true,
  max: 200,
  agents: [
    { id: 'sara', name: 'سارة', room: 480 },
    { id: 'huda', name: 'هدى', room: 500 },
  ],
  reasons: [{ code: 'PRICE_TOO_HIGH', label: 'السعر مرتفع' }],
  periods: [{ code: '30', label: 'آخر 30 يوماً' }],
};
const PRICES = {
  canEdit: true,
  currency: 'USD',
  products: [
    { id: 'scar', name: 'كريم الندبات', price: { one: 12, three: 20, currency: 'USD' } },
    { id: 'soap', name: 'صابون', price: null },
  ],
};
const PLAN = {
  planned: [
    { orderId: 'o1', orderNumber: 'ORD-1', agentId: 'sara', price: 20, tier: 'three' },
    { orderId: 'o2', orderNumber: 'ORD-2', agentId: 'huda', price: 12, tier: 'one' },
  ],
  perAgent: [
    { id: 'sara', name: 'سارة', room: 480, count: 1 },
    { id: 'huda', name: 'هدى', room: 500, count: 1 },
  ],
  skipped: [{ code: 'CUSTOMER_HAS_LIVE_ORDER', count: 3, reasonAr: 'الزبون عندو طلب شغّال' }],
  scanned: 5,
};

const route = (meta: unknown = META, prices: unknown = PRICES) =>
  api.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url === '/api/confirmation/winback/bulk') return meta;
    if (url === '/api/confirmation/winback/prices') return prices;
    const body = JSON.parse(init?.body ?? '{}');
    if (body.action === 'bulk-preview') return PLAN;
    if (body.action === 'bulk-run') return { created: 1, failed: 1, results: [{ orderId: 'o1', orderNumber: 'ORD-1', ok: true }, { orderId: 'o2', orderNumber: 'ORD-2', ok: false, code: 'ALREADY_OFFERED', reasonAr: 'انعرض عليه للتو من ضغطة تانية' }] };
    return {};
  });

beforeEach(() => {
  vi.clearAllMocks();
  route();
});
afterEach(cleanup);

describe('who sees it', () => {
  it('draws nothing for who may not run it, or on a failure', async () => {
    route({ canBulk: false });
    const a = render(<WinbackBulkCard />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(a.container.textContent).toBe('');
    a.unmount();
    api.mockRejectedValue(new Error('403'));
    const b = render(<WinbackBulkCard />);
    await new Promise((r) => setTimeout(r, 10));
    expect(b.container.textContent).toBe('');
  });
});

describe('the plan and the run', () => {
  it('shows the server’s plan, then sends exactly its ids and the agents — and no price', async () => {
    const { container } = render(<WinbackBulkCard />);
    await screen.findByText('وزّع على الموظفات');
    // only priced products are offered in the filter
    const product = screen.getByLabelText('المنتج') as HTMLSelectElement;
    expect([...product.options].map((o) => o.textContent)).toEqual(['كل المنتجات اللي إلها سعر', 'كريم الندبات']);
    expect(container.textContent).toContain('بتقدر تاخد 480 كمان');

    const show = screen.getByRole('button', { name: 'اعرض الخطة' });
    expect((show as HTMLButtonElement).disabled).toBe(true); // no agent picked yet
    fireEvent.click(screen.getByLabelText('سارة'));
    fireEvent.click(screen.getByLabelText('هدى'));
    fireEvent.change(screen.getByLabelText('سبب الإلغاء'), { target: { value: 'PRICE_TOO_HIGH' } });
    fireEvent.click(show);
    await screen.findByText('سارة: 1');
    const previewBody = JSON.parse((api.mock.calls.find((c) => String(c[1]?.body ?? '').includes('bulk-preview'))![1] as { body: string }).body);
    expect(previewBody).toEqual({ action: 'bulk-preview', count: 50, agentIds: ['sara', 'huda'], reason: 'PRICE_TOO_HIGH' });
    expect(container.textContent).toContain('الزبون عندو طلب شغّال: 3');

    fireEvent.click(screen.getByRole('button', { name: 'وزّع 2 طلب' }));
    await screen.findByText('انعمل 1 — وما انعمل 1');
    const runBody = JSON.parse((api.mock.calls.find((c) => String(c[1]?.body ?? '').includes('bulk-run'))![1] as { body: string }).body);
    expect(runBody).toEqual({ action: 'bulk-run', orderIds: ['o1', 'o2'], agentIds: ['sara', 'huda'] });
    expect(JSON.stringify(runBody)).not.toMatch(/price|discount/);
    expect(container.textContent).toContain('ORD-2: انعرض عليه للتو من ضغطة تانية');
  });

  it('a count outside 1–200 cannot be sent', async () => {
    render(<WinbackBulkCard />);
    await screen.findByText('وزّع على الموظفات');
    fireEvent.click(screen.getByLabelText('سارة'));
    fireEvent.change(screen.getByLabelText('العدد (لحد 200)'), { target: { value: '201' } });
    expect((screen.getByRole('button', { name: 'اعرض الخطة' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the prices', () => {
  it('drawn for who may change the rule; one row saved is one request with the product and its two figures', async () => {
    render(<WinbackBulkCard />);
    await screen.findByText('أسعار الاسترجاع');
    fireEvent.click(screen.getByRole('button', { name: 'عدّل الأسعار' }));
    const ones = screen.getAllByLabelText('قطعة أو قطعتين') as HTMLInputElement[];
    expect(ones.map((i) => i.value)).toEqual(['12', '']);
    fireEvent.change(ones[1], { target: { value: '9' } });
    fireEvent.change(screen.getAllByLabelText('3 قطع أو أكتر')[1], { target: { value: '18' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'احفظ' })[1]);
    await waitFor(() => expect(api.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(true));
    const put = api.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(put[0]).toBe('/api/confirmation/winback/prices');
    expect(JSON.parse(put[1].body)).toEqual({ productId: 'soap', one: 9, three: 18, currency: 'USD' });
  });

  it('not drawn for who may not change it', async () => {
    route(META, { ...PRICES, canEdit: false });
    const { container } = render(<WinbackBulkCard />);
    await screen.findByText('وزّع على الموظفات');
    expect(container.textContent).not.toContain('أسعار الاسترجاع');
  });
});

describe('the words', () => {
  it('Arabic, Western digits, and nothing wider than a phone', async () => {
    const { container } = render(<WinbackBulkCard />);
    await screen.findByText('وزّع على الموظفات');
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/[٠-٩]/);
    expect(text).not.toMatch(/\b(bulk|preview|run|agent|price)\b/i);
    expect(container.innerHTML).not.toMatch(/min-w-\[|w-\[\d{3,}px\]|whitespace-nowrap|overflow-x-/);
  });
});
