// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * «رحّل إلى الشركة» REFUSED A GOVERNORATE THE COURIER HAS NO ID FOR — ONLY AFTER THE PRESS (RV166).
 *
 * The batch list now carries `courierCityGap`, and the screen says it ABOVE the buttons: how many, which governorate,
 * where the id is typed. It warns; it does not take the press away. These render the real screen.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/batches',
}));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => async () => null,
  useConfirm: () => async () => false,
  useTell: () => vi.fn(),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: null }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  },
}));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => ({ dims: { width: 100, height: 150 } }), LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({
  BLOCKED_WAYBILLS: 'x',
  describeRefused: () => '',
  openWaybills: vi.fn(),
  WaybillError: class extends Error {},
}));
vi.mock('@/components/scan/ScanButton', () => ({ ScanSheet: () => null }));

import { ShippingBatchesScreen } from './ShippingBatchesScreen';

const WAIT = { timeout: 8000 };
const SEND = 'رحّل إلى الشركة واجلب الباركود';

const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b1', batchNumber: 'BATCH-2026-0001', status: 'READY',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: true },
  creator: { id: 'u1', name: 'سارة' }, createdAt: '2026-10-28T08:00:00.000Z', shippedAt: null, notes: null,
  _count: { orders: 6 }, courierCityGap: null, ...over,
});
const serve = (b: unknown) => apiJson.mockImplementation(async () => ({ batches: [b], pagination: { total: 1 } }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('«دفعات الشحن» — the warning above the press', () => {
  it('says how many parcels, which governorate and where the id goes — and the press is still there', async () => {
    serve(batch({ courierCityGap: { count: 2, regions: ['السويداء'] } }));
    render(<ShippingBatchesScreen />);
    expect(await screen.findByText(/تنبيه: 2 طلب \(السويداء\) بلا رمز عند الشركة/, undefined, WAIT)).toBeTruthy();
    expect(screen.getByText(/«رمزها عند الشركة»/)).toBeTruthy();
    // It warns; it does not block.
    expect((screen.getByRole('button', { name: SEND }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('NEGATIVE: no gap, no warning', async () => {
    serve(batch());
    render(<ShippingBatchesScreen />);
    await screen.findByRole('button', { name: SEND }, WAIT);
    expect(screen.queryByText(/تنبيه:.*بلا رمز عند الشركة/)).toBeNull();
  });

  it('NEGATIVE: a trolley already handed over shows none, even if the server sent one', async () => {
    serve(batch({ status: 'SHIPPED', courierCityGap: { count: 2, regions: ['السويداء'] } }));
    render(<ShippingBatchesScreen />);
    await screen.findByText('BATCH-2026-0001', undefined, WAIT);
    expect(screen.queryByText(/بلا رمز عند الشركة/)).toBeNull();
  });
});
