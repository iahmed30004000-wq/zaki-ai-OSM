// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A COST THE CALLER MAY NOT SEE IS NOT DRAWN — NOT AS A ZERO, NOT AS A DASH (perm-plan PR-10, D3).
 *
 * `costs.view` is one key now. A caller without it gets the quantities and none of the three cost figures from
 * `GET /api/products/:id/stock` (absent, never zero: a zero says «this stock cost nothing»), and the receiving dialog gets no
 * `lastUnitCost` (absent, never null: a null says «never costed»). The return-risk tier of a customer's history is a smart
 * card (`insights.view`) and is absent too. What each screen does with an ABSENT field is held here.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, viewer } = vi.hoisted(() => ({ apiJson: vi.fn(), viewer: { current: { id: 'u1', role: 'CUSTOM', permissions: [] as string[], status: 'ACTIVE' } } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: viewer.current }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { ProductStock } from './ProductStock';
import { ReceiveDialog } from '@/components/inventory/ReceiveDialog';
import { CustomerHistoryModal } from '@/components/orders/CustomerHistory';

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const STOCK = { onHand: 12, reserved: 2, available: 10, batchCount: 3, currencyCode: 'JOD', sourceType: 'PURCHASED' as const };

describe('the product page’s stock card', () => {
  it('without costs.view: the quantities, and none of the three cost tiles — no zero in their place', async () => {
    apiJson.mockResolvedValue(STOCK);
    render(<ProductStock productId="p1" canReceive={false} canProduce={false} />);
    await screen.findByText('بالمستودع');
    expect(screen.getByText('متاح للبيع')).toBeTruthy();
    for (const label of ['تكلفة الوحدة (متوسط مرجّح)', 'تكلفة الدفعة القادمة للخروج', 'قيمة المخزون']) expect(screen.queryByText(label), label).toBeNull();
    expect(screen.queryByText(/متوسط مرجّح/)).toBeNull();
    expect(screen.getByText(/المخزون موزّع على 3 دفعة/)).toBeTruthy();
  });

  it('NEGATIVE (the test of the test): with the three figures the tiles are drawn', async () => {
    apiJson.mockResolvedValue({ ...STOCK, averageCost: 3.5, nextOutCost: 3, stockValue: 42 });
    render(<ProductStock productId="p1" canReceive={false} canProduce={false} />);
    await screen.findByText('قيمة المخزون');
    expect(screen.getByText('تكلفة الوحدة (متوسط مرجّح)')).toBeTruthy();
    expect(screen.getByText('تكلفة الدفعة القادمة للخروج')).toBeTruthy();
  });
});

describe('the receiving dialog', () => {
  const draw = (lastUnitCost?: number | null) =>
    render(<ReceiveDialog product={{ id: 'p1', name: 'سيروم', remaining: 5, ...(lastUnitCost === undefined ? {} : { lastUnitCost }) }} onClose={() => {}} onSaved={() => {}} />);
  const box = () => screen.getByLabelText(/تكلفة الوحدة في هذه الدفعة/) as HTMLInputElement;

  it('without costs.view: no price is printed, nothing is claimed about it, and a blank is still allowed (the server decides)', () => {
    draw(undefined);
    expect(box().required).toBe(false);
    expect(box().placeholder).not.toMatch(/\d/);
    expect(box().placeholder).not.toContain('undefined');
    expect(screen.queryByText('(مطلوبة)')).toBeNull();
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('with a known price: the price is the placeholder, as before', () => {
    draw(4.25);
    expect(box().placeholder).toBe('4.25');
    expect(box().required).toBe(false);
  });

  it('never costed (null): the box is required, as before', () => {
    draw(null);
    expect(box().required).toBe(true);
    expect(screen.getByText('(مطلوبة)')).toBeTruthy();
  });
});

describe('the customer’s history', () => {
  const HISTORY = { customer: { fullName: 'سارة', totalOrders: 3, deliveredOrders: 2, cancelledOrders: 1 }, count: 0, orders: [] };

  it('without insights.view the answer has no risk, and the modal draws no tier and no prepayment line', async () => {
    apiJson.mockResolvedValue(HISTORY);
    render(<CustomerHistoryModal customerId="c1" orderId="o1" onClose={() => {}} />);
    await screen.findByText(/إجمالي 3/);
    expect(screen.queryByText(/مرتجع من/)).toBeNull();
    expect(screen.queryByText(/دفعاً مسبقاً/)).toBeNull();
  });

  it('NEGATIVE (the test of the test): with the risk in the answer the tier is drawn', async () => {
    apiJson.mockResolvedValue({ ...HISTORY, risk: { tier: 'HIGH', returnRate: 0.5, orders: 4, returns: 2, requiresPrepaymentOrApproval: true } });
    render(<CustomerHistoryModal customerId="c1" orderId="o1" onClose={() => {}} />);
    await screen.findByText(/مرتجع من 4 طلب/);
    expect(screen.getByText(/دفعاً مسبقاً/)).toBeTruthy();
  });
});

describe('the headline on the product page', () => {
  it('without costs.view: the stock chip is drawn, the average-cost chip is not, and nothing throws', async () => {
    apiJson.mockResolvedValue({ onHand: 12, available: 10, currencyCode: 'JOD' });
    const { ProductHeadline } = await import('./ProductHeadline');
    render(<ProductHeadline productId="p1" />);
    await screen.findByText('متاح');
    expect(screen.queryByText('متوسط كلفة الوحدة')).toBeNull();
  });

  it('NEGATIVE (the test of the test): with the figure the chip is drawn', async () => {
    apiJson.mockResolvedValue({ onHand: 12, available: 10, averageCost: 3.5, currencyCode: 'JOD' });
    const { ProductHeadline } = await import('./ProductHeadline');
    render(<ProductHeadline productId="p1" />);
    await screen.findByText('متوسط كلفة الوحدة');
  });
});
