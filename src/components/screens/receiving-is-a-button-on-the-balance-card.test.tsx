// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «استلام بضاعة جاهزة» IS A BUTTON ON THE BALANCE CARD, NOT A SCREEN.
 *
 * `/inventory/receiving` read the same `/api/inventory` as the balances and
 * offered a second list of the same products for one form. The form is
 * `ReceiveDialog` now and the button sits on the card that says the product is
 * running out. These render the balances and press it:
 *
 *   · only a product you BUY ready, and only for someone holding
 *     `inventory.adjust` (the door asks again — this is what is DRAWN);
 *   · `?product=<id>` — what the product page's «إضافة مخزون» and the old
 *     receiving address (which redirects here, query and all) carry — opens
 *     that product's dialog at once, and a made product gets the sentence
 *     instead of a dialog that would end in WRONG_DOOR;
 *   · a blank price is sent as ABSENT, never as zero (the cost rule).
 */

const { api, params, user } = vi.hoisted(() => ({
  api: vi.fn(),
  params: { current: new URLSearchParams() },
  user: { current: { id: 'u1', name: 'سارة', role: 'COMPANY_ADMIN', permissions: ['inventory.view', 'inventory.adjust'], status: 'ACTIVE' } as Record<string, unknown> },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => params.current,
  usePathname: () => '/inventory/balances',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: {}, locale: 'ar', currentUser: user.current }),
}));
vi.mock('@/components/inventory/OpeningStockCount', () => ({ OpeningStockCountBanner: () => null }));
// 19/11 (W1b): the placement banner reads its own door on mount; the first call this file reads is the receive's, as before.
vi.mock('@/components/inventory/PlacementSheet', () => ({ PlacementBanner: () => null }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => null }));

import { InventoryBalancesScreen } from './InventoryBalancesScreen';

const health = {
  tone: 'ok',
  label: 'متوفر',
  why: 'تكفي مدة جيدة',
  state: 'healthy',
  available: 10,
  perDay: null,
  coverDays: null,
  windowDays: 13,
  score: null,
  bands: [],
  needsRestock: false,
};
const row = (id: string, sourceType: 'PURCHASED' | 'MANUFACTURED', over: Record<string, unknown> = {}) => ({
  id,
  name: `منتج ${id}`,
  sku: `SKU-${id}`,
  sourceType,
  produced: 20,
  sold: 10,
  remaining: 10,
  reserved: 0,
  lastUnitCost: 3,
  health,
  ...over,
});
const ROWS = [row('B', 'PURCHASED'), row('M', 'MANUFACTURED')];

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ ok: true });
  params.current = new URLSearchParams();
  user.current = { id: 'u1', name: 'سارة', role: 'COMPANY_ADMIN', permissions: ['inventory.view', 'inventory.adjust'], status: 'ACTIVE' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ stockSummary: ROWS, alerts: [], ledgerDays: 13 }) }))
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = async () => {
  render(<InventoryBalancesScreen />);
  await screen.findByText('منتج B');
};

describe('the «استلام» button on the card', () => {
  it('is on a product you buy ready — and not on one you make', async () => {
    await mount();
    const buttons = screen.getAllByRole('button', { name: 'استلام' });
    expect(buttons).toHaveLength(1);
    const cardOfB = screen.getByText('منتج B').closest('div[class*="space-y-3"]') as HTMLElement;
    expect(cardOfB.contains(buttons[0])).toBe(true);
  });

  it('NEGATIVE: someone without inventory.adjust is not offered it at all', async () => {
    user.current = { ...user.current, role: 'WAREHOUSE', permissions: ['inventory.view'] };
    await mount();
    expect(screen.queryByRole('button', { name: 'استلام' })).toBeNull();
  });

  it('opens the dialog for THAT product, with its balance and last price in it', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'استلام' }));
    expect(screen.getByText('استلام بضاعة — منتج B')).toBeTruthy();
    expect(screen.getByText(/الرصيد الحالي/)).toBeTruthy();
    expect((screen.getByPlaceholderText('3') as HTMLInputElement).placeholder).toBe('3');
  });

  it('saves with a blank price as ABSENT, says what arrived, and closes', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'استلام' }));
    fireEvent.change(screen.getByLabelText('الكمية المستلمة'), { target: { value: '12' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'استلام' }).at(-1)!);
    await waitFor(() => expect(api).toHaveBeenCalled());
    const [url, init] = api.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/inventory');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ action: 'receive', productId: 'B', quantity: 12 });
    expect('unitCost' in body, 'السعر الفاضي انبعت كصفر').toBe(false);
    await screen.findByText('أُضيفت 12 وحدة إلى منتج B');
    expect(screen.queryByText('استلام بضاعة — منتج B')).toBeNull();
  });
});

describe('?product=<id> — arriving from one product', () => {
  it('opens that product’s dialog at once', async () => {
    params.current = new URLSearchParams('product=B');
    await mount();
    expect(screen.getByText('استلام بضاعة — منتج B')).toBeTruthy();
  });

  it('and a closed dialog stays closed while the parameter is still in the address', async () => {
    params.current = new URLSearchParams('product=B');
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByText('استلام بضاعة — منتج B')).toBeNull();
  });

  it('a MADE product gets the sentence, not a dialog that would end in WRONG_DOOR', async () => {
    params.current = new URLSearchParams('product=M');
    await mount();
    expect(screen.queryByText(/استلام بضاعة —/)).toBeNull();
    expect(screen.getByText(/منتج مصنّع — تُضاف كميته من «تشغيلات الإنتاج»/)).toBeTruthy();
  });

  it('NEGATIVE: someone without inventory.adjust gets no dialog from a link either', async () => {
    user.current = { ...user.current, role: 'WAREHOUSE', permissions: ['inventory.view'] };
    params.current = new URLSearchParams('product=B');
    await mount();
    expect(screen.queryByText(/استلام بضاعة —/)).toBeNull();
  });
});

describe('the old address', () => {
  const ROOT = process.cwd();

  it('redirects permanently to the balances, so a bookmark or a pasted link still lands on the dialog', () => {
    const config = stripComments(readFileSync(join(ROOT, 'next.config.ts'), 'utf8'));
    expect(config).toMatch(
      /source:\s*'\/inventory\/receiving'\s*,\s*destination:\s*'\/inventory\/balances'\s*,\s*permanent:\s*true/
    );
  });

  it('has no page of its own any more — a page and a redirect at one address is a redirect nobody reaches', () => {
    expect(existsSync(join(ROOT, 'src/app/(system)/(shell)/inventory/receiving/page.tsx'))).toBe(false);
  });

  it('is linked from nowhere in the app — every link goes to the balances', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (stripComments(readFileSync(full, 'utf8')).includes('/inventory/receiving')) offenders.push(full.replace(ROOT, ''));
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders, 'روابط للعنوان القديم').toEqual([]);
  });
});
