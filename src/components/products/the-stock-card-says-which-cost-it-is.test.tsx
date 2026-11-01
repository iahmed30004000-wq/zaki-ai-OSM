// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PRODUCT PAGE'S STOCK CARD SAYS WHICH COST THE PRODUCT HAS (the owner, 1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… اللي بيقدر يغيرو الادمنة فقط من قائمة المنتجات.»
 *
 *  · with a fixed figure the first tile says «ثابتة» — it does not call a fixed number a weighted average — and the paragraph that
 *    explains the weighted average is gone; without one, the card reads exactly as it always did;
 *  · the box to set the figure is drawn only for a caller whose answer carries the figures (a caller who may not see a cost gets
 *    neither the tiles nor the box), and its controls only for `products.change_cost`;
 *  · saving reads the stock again, so the tile follows the figure without a reload.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: { id: 'u1', role: 'COMPANY_ADMIN', permissions: [], status: 'ACTIVE' } }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn: vi.fn(), failed: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { ProductStock } from './ProductStock';

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockReset();
});

const STOCK = { onHand: 12, reserved: 2, available: 10, batchCount: 3, currencyCode: 'JOD', sourceType: 'PURCHASED' as const };
/** The answer for a caller who may see a cost, with the batches at 3.5 a unit. */
const WITH_COSTS = { ...STOCK, averageCost: 3.5, nextOutCost: 3, stockValue: 42, fixedCost: null, batchAverageCost: 3.5 };
const WITH_FIGURE = { ...STOCK, averageCost: 5, nextOutCost: 5, stockValue: 60, fixedCost: 5, batchAverageCost: 3.5 };

const draw = (answer: unknown, canChangeCost = true) => {
  apiJson.mockResolvedValue(answer);
  render(<ProductStock productId="p1" canReceive={false} canProduce={false} canChangeCost={canChangeCost} />);
};

describe('a product with no fixed figure', () => {
  it('reads as it always did: the weighted-average tile, the explanation, and the box that says the cost moves', async () => {
    draw(WITH_COSTS);
    await screen.findByText('قيمة المخزون');
    expect(screen.getByText('تكلفة الوحدة (متوسط مرجّح)')).toBeTruthy();
    expect(screen.queryByText('تكلفة الوحدة (ثابتة)')).toBeNull();
    expect(screen.getByText(/«متوسط مرجّح» يعني/)).toBeTruthy();
    expect(screen.getByText(/بلا تكلفة ثابتة/)).toBeTruthy();
  });
});

describe('a product with a fixed figure', () => {
  it('the tile says «ثابتة», the weighted-average explanation is gone, and the box shows the figure', async () => {
    draw(WITH_FIGURE);
    await screen.findByText('قيمة المخزون');
    expect(screen.getByText('تكلفة الوحدة (ثابتة)')).toBeTruthy();
    expect(screen.queryByText('تكلفة الوحدة (متوسط مرجّح)')).toBeNull();
    expect(screen.queryByText(/«متوسط مرجّح» يعني/)).toBeNull();
    expect(screen.getByText(/تكلفة الوحدة الثابتة:/)).toBeTruthy();
    expect(screen.queryByText(/بلا تكلفة ثابتة/)).toBeNull();
  });

  it('the shelf is still the shelf: the batch count line stays', async () => {
    draw(WITH_FIGURE);
    await screen.findByText('قيمة المخزون');
    expect(screen.getByText(/المخزون موزّع على 3 دفعة/)).toBeTruthy();
  });
});

describe('who gets the controls', () => {
  it('products.change_cost → the box to type a figure; without it the sentence only', async () => {
    draw(WITH_COSTS, true);
    await screen.findByText('قيمة المخزون');
    expect(screen.getByLabelText('التكلفة الثابتة')).toBeTruthy();
    cleanup();

    draw(WITH_COSTS, false);
    await screen.findByText('قيمة المخزون');
    expect(screen.getByText(/بلا تكلفة ثابتة/)).toBeTruthy();
    expect(screen.queryByLabelText('التكلفة الثابتة')).toBeNull();
  });

  it('a caller whose answer carries no costs gets no tiles and no box — even holding the key', async () => {
    draw(STOCK, true);
    await screen.findByText('بالمستودع');
    expect(screen.queryByText(/بلا تكلفة ثابتة/)).toBeNull();
    expect(screen.queryByText(/تكلفة الوحدة الثابتة:/)).toBeNull();
    expect(screen.queryByLabelText('التكلفة الثابتة')).toBeNull();
    expect(screen.queryByText('قيمة المخزون')).toBeNull();
  });
});

describe('saving a figure', () => {
  it('PUTs it to the product’s door and reads the stock again, so the tile follows without a reload', async () => {
    let figure: number | null = null;
    apiJson.mockImplementation(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PUT') {
        figure = (JSON.parse(init.body as string) as { amount: number | null }).amount;
        return { success: true };
      }
      return figure === null ? WITH_COSTS : { ...WITH_FIGURE, averageCost: figure, nextOutCost: figure, fixedCost: figure };
    });
    render(<ProductStock productId="p1" canReceive={false} canProduce={false} canChangeCost />);
    await screen.findByText('تكلفة الوحدة (متوسط مرجّح)');

    fireEvent.change(screen.getByLabelText('التكلفة الثابتة'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ' }));

    await screen.findByText('تكلفة الوحدة (ثابتة)');
    const puts = apiJson.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('/api/products/p1/fixed-cost');
    await waitFor(() => expect(screen.getByText(/تكلفة الوحدة الثابتة:/)).toBeTruthy());
  });
});
