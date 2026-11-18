// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «هاي منصّة تجريب — طلباتها بتوقف عند التأكيد» (B2, 18/11).
 *
 * The packing list and «إنشاء شحنة» of a bench store are empty by design: its orders stop at confirmation. Each screen
 * prints the server's sentence (`benchNote`) instead of a «done» that would read as broken. Without the sentence — a real
 * store — the screens say what they always said.
 */

const { apiJson, user } = vi.hoisted(() => ({ apiJson: vi.fn(), user: { current: null as unknown } }));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => false }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void> | void) => {
    React.useEffect(() => {
      void load();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
  },
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ChangeRequestReview', () => ({ ChangeRequestReview: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));

import { PreparationScreen } from './PreparationScreen';
import { ShipmentsNewScreen } from './ShipmentsNewScreen';
import { BENCH_LIST_EMPTY_AR } from '@/lib/test-store';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 20000 });

beforeEach(() => {
  vi.clearAllMocks();
  user.current = { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.ship', 'ops.prepare'] };
});
afterEach(cleanup);

const prep = (benchNote?: string) =>
  apiJson.mockResolvedValue({
    allowNegativeStock: false,
    totals: { products: 0, orders: 0, shortages: 0 },
    groups: [],
    ...(benchNote ? { benchNote } : {}),
  });

const ship = (benchNote?: string) =>
  apiJson.mockImplementation(async (url: string) =>
    url.includes('/api/ops/shipments')
      ? { count: 0, heldCount: 0, orders: [], ...(benchNote ? { benchNote } : {}) }
      : { providers: [{ id: 'p1', name: 'شركة الشحن أ' }], regions: [] }
  );

describe('the packing list of a bench', () => {
  it('says why it is empty, in the server’s sentence', async () => {
    prep(BENCH_LIST_EMPTY_AR);
    render(<PreparationScreen />);
    await waitFor(() => expect(screen.getByText(BENCH_LIST_EMPTY_AR)).toBeTruthy(), WAIT);
  });

  it('NEGATIVE: a real store’s empty list says what it always said', async () => {
    prep();
    render(<PreparationScreen />);
    await waitFor(() => expect(screen.getByText('لا توجد طلبات مؤكدة بانتظار التجهيز.')).toBeTruthy(), WAIT);
    expect(screen.queryByText(BENCH_LIST_EMPTY_AR)).toBeNull();
  });
});

describe('«إنشاء شحنة» of a bench', () => {
  it('says why it is empty, in the server’s sentence', async () => {
    ship(BENCH_LIST_EMPTY_AR);
    render(<ShipmentsNewScreen />);
    await waitFor(() => expect(screen.getByText(BENCH_LIST_EMPTY_AR)).toBeTruthy(), WAIT);
  });

  it('NEGATIVE: a real store’s empty list says what it always said', async () => {
    ship();
    render(<ShipmentsNewScreen />);
    await waitFor(() => expect(screen.getByText(/لا طلبات جاهزة للشحن الآن/)).toBeTruthy(), WAIT);
    expect(screen.queryByText(BENCH_LIST_EMPTY_AR)).toBeNull();
  });
});
