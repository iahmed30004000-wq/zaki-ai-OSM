// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE
 *
 * «إغلاق الشحنة — سُلّمت للشركة» refused with PENDING_CHANGES (ORD-2026-1584: a cancel or a postponement still unanswered)
 * said what to do and gave no way to do it. The toast now carries the way out.
 *
 *  1. Whoever may open «طلبات التعديل» gets the door's sentence and a button «افتح طلبات التعديل» to /control/change-requests.
 *  2. Whoever may not gets the same sentence, no button, and one line naming who decides and where.
 *  3. It stays a toast: no question, one press, nothing sent again.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, confirm, failed, mayOpen } = vi.hoisted(() => ({ apiJson: vi.fn(), confirm: vi.fn(), failed: vi.fn(), mayOpen: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/batches',
}));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => async () => null,
  useConfirm: () => (...a: unknown[]) => confirm(...a),
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: (...a: unknown[]) => failed(...a), done: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => (href: string) => mayOpen(href) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: null }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  },
}));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => ({ dims: { width: 100, height: 150 } }), LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({
  BLOCKED_WAYBILLS: 'x', describeRefused: () => '', openWaybills: vi.fn(), WaybillError: class extends Error {},
}));
vi.mock('@/components/scan/ScanButton', () => ({ ScanSheet: () => null }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));

import { ShippingBatchesScreen } from './ShippingBatchesScreen';

const WAIT = { timeout: 8000 };
const SENTENCE = 'ما بيصير تسلّم الدفعة: على هالطلبات إلغاء أو تأجيل لسّا ما انحسم (ORD-2026-1584). قرّروا فيهم أوّلاً.';
const SHIP = { name: 'إغلاق الشحنة — سُلّمت للشركة' };

const batch = {
  id: 'b4', batchNumber: 'BATCH-2026-0004', status: 'READY',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: true },
  creator: { id: 'u1', name: 'Qabas' }, createdAt: '2026-10-31T10:00:00.000Z', shippedAt: null, notes: null,
  _count: { orders: 147 }, courierCityGap: null,
};

const refusal = (data: Record<string, unknown>) => Object.assign(new Error(String(data.errorAr)), { status: 409, data });
const pending = () => refusal({ code: 'PENDING_CHANGES', orders: ['ORD-2026-1584'], errorAr: SENTENCE });
const patches = () => apiJson.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') throw pending();
    return { batches: [batch], pagination: { total: 1 } };
  });
});
afterEach(cleanup);

const press = async () => {
  render(<ShippingBatchesScreen />);
  fireEvent.click(await screen.findByRole('button', SHIP, WAIT));
};

describe('a handover stopped by a cancel or a postponement still unanswered', () => {
  it('whoever may decide gets the sentence and a button to the requests screen', async () => {
    mayOpen.mockReturnValue(true);
    await press();

    await waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(failed).toHaveBeenCalledWith(SENTENCE, undefined, { label: 'افتح طلبات التعديل', href: '/control/change-requests' });
    expect(mayOpen).toHaveBeenCalledWith('/control/change-requests');
    expect(confirm).not.toHaveBeenCalled();
    expect(patches()).toHaveLength(1);
  });

  it('whoever may not open it is told who decides, and offered no link that ends in a refusal', async () => {
    mayOpen.mockReturnValue(false);
    await press();

    await waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    const [text, detail, action] = failed.mock.calls[0];
    expect(text).toBe(SENTENCE);
    expect(detail).toContain('طلبات التعديل');
    expect(detail).toContain('المشرفة أو المدير');
    expect(action).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(patches()).toHaveLength(1);
  });
});
