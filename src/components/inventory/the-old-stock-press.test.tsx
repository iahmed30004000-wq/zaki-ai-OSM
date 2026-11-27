// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE ONE PRESS THAT GIVES THE OLD STOCK ITS WAREHOUSE, AND «متاح» BESIDE A TRANSFER LINE (the owner, 27/11).
 *
 * The sheet draws the server's «after», sends exactly what it shows, and stays shut until a home is chosen and the preview
 * is of what is on the screen. The transfer line says the warehouse's three figures and judges only «more than متاح».
 */

const { api, perms } = vi.hoisted(() => ({ api: vi.fn(), perms: { value: ['inventory.view', 'inventory.adjust'] as string[] } }));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    t: { cancel: 'إلغاء' },
    locale: 'ar',
    currentUser: { id: 'u1', name: 'سارة', role: 'COMPANY_ADMIN', permissions: perms.value, status: 'ACTIVE' },
  }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));

import { OldStockBanner } from './OldStockHome';
import { ShelfLine, overFree } from './ShelfFigures';

const WAREHOUSES = [{ id: 'q', name: 'قدسيا' }, { id: 't', name: 'عين ترما' }];
const fig = (onHand: number, held: number) => ({ onHand, held, free: onHand - held });
const ROWS = [
  {
    productId: 'p', name: 'ماء', unplaced: 663, oldHeld: 504,
    warehouses: [
      { id: 'q', before: fig(177, 0), after: fig(825, 504), restore: 0, suggested: 0 },
      { id: 't', before: fig(380, 134), after: fig(395, 134), restore: 15, suggested: 15 },
    ],
  },
];

beforeEach(() => {
  perms.value = ['inventory.view', 'inventory.adjust'];
  api.mockReset();
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { orders: 3, rows: ROWS };
    return { warehouses: WAREHOUSES, orders: 3, rows: url.includes('warehouse=') ? ROWS : [] };
  });
});
afterEach(cleanup);

const press = () => screen.getByRole('button', { name: 'نفّذ — مرة وحدة' }) as HTMLButtonElement;

describe('the old stock press', () => {
  it('waits for a home, shows the server’s «after», and sends the figures on the screen', async () => {
    const done = vi.fn();
    render(<OldStockBanner onDone={done} />);
    fireEvent.click(screen.getByRole('button', { name: 'ضمّ القديم لمخزنه' }));
    expect(press().disabled).toBe(true);
    fireEvent.click(await screen.findByText('قدسيا'));
    await waitFor(() => expect(press().disabled).toBe(false));
    expect(document.body.textContent).toContain('على الرف 825 · محجوز 504');
    expect(document.body.textContent).toContain('متاح 321');
    fireEvent.click(press());
    await waitFor(() => expect(done).toHaveBeenCalled());
    const post = api.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'POST') as [string, RequestInit];
    expect(post[0]).toBe('/api/inventory/old-stock');
    expect(JSON.parse(post[1].body as string)).toEqual({ warehouseId: 'q', restores: [{ productId: 'p', warehouseId: 't', quantity: 15 }] });
  });

  it('NEGATIVE: without the key there is no press, only the sentence', () => {
    perms.value = ['inventory.view'];
    render(<OldStockBanner onDone={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/بيعملها اللي معه صلاحية/)).toBeTruthy();
  });
});

describe('«متاح» beside a transfer line', () => {
  const shelf = { p: fig(74, 74), w: fig(396, 130) };

  it('says the three figures, and says when the quantity is more than free', () => {
    render(<ShelfLine shelf={shelf} productId="w" typed="300" warehouseName="عين ترما" />);
    expect(document.body.textContent).toContain('على الرف 396 · محجوز 130 · متاح 266');
    expect(document.body.textContent).toContain('الكمية أكتر من المتاح');
  });

  it('exactly the free units is allowed; one more is not; nothing free refuses one', () => {
    expect(overFree(shelf, 'w', '266')).toBe(false);
    expect(overFree(shelf, 'w', '267')).toBe(true);
    expect(overFree(shelf, 'p', '1')).toBe(true);
    // A product the warehouse never held has nothing free.
    expect(overFree(shelf, 'x', '1')).toBe(true);
  });

  it('NEGATIVE: an unknown shelf, no product or no quantity judges nothing', () => {
    expect(overFree(null, 'w', '999')).toBe(false);
    expect(overFree(shelf, '', '999')).toBe(false);
    expect(overFree(shelf, 'w', '')).toBe(false);
  });
});
