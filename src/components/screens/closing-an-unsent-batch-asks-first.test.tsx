// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE
 *
 * «إغلاق الشحنة — سُلّمت للشركة» pressed before «رحّل إلى الشركة واجلب الباركود» left BATCH-2026-0004 with 147 orders that can
 * never be sent. The door now stops that press (BATCH_UNSENT); the screen turns the refusal into ONE question, in the door's
 * own words, and only a yes sends the press again with `acknowledgeUnsent`.
 *
 *  1. BATCH_UNSENT → a danger question titled with the count; «سلّم رغم ذلك» sends the second press with the flag.
 *  2. «رجوع» sends nothing more: one press in all, and no error toast.
 *  3. Any other refusal is the toast it always was, with no question.
 *  4. A press that goes through carries no flag at all.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, confirm, failed } = vi.hoisted(() => ({ apiJson: vi.fn(), confirm: vi.fn(), failed: vi.fn() }));
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
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
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
const SENTENCE = '2 طلب من هالدفعة ما انرحّل للشركة وما إله باركودها (ORD-2026-0497، ORD-2026-0551). بعد «إغلاق الشحنة» ما بيصير ترحيله من هون، وما بتنطبع بوالصه.';
const SHIP = { name: 'إغلاق الشحنة — سُلّمت للشركة' };

const batch = {
  id: 'b4', batchNumber: 'BATCH-2026-0004', status: 'READY',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: true },
  creator: { id: 'u1', name: 'Qabas' }, createdAt: '2026-10-31T10:00:00.000Z', shippedAt: null, notes: null,
  _count: { orders: 147 }, courierCityGap: null,
};

const refusal = (data: Record<string, unknown>) => Object.assign(new Error(String(data.errorAr)), { status: 409, data });
const unsent = () => refusal({ code: 'BATCH_UNSENT', unsent: 2, orders: ['ORD-2026-0497', 'ORD-2026-0551'], errorAr: SENTENCE });
const patches = () => apiJson.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
const bodies = () => patches().map((c) => JSON.parse(String((c[1] as RequestInit).body)));

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return { success: true };
    return { batches: [batch], pagination: { total: 1 } };
  });
});
afterEach(cleanup);

const press = async () => {
  render(<ShippingBatchesScreen />);
  fireEvent.click(await screen.findByRole('button', SHIP, WAIT));
};

describe('the handover of a batch that was never sent to its courier', () => {
  it('asks once, titled with the count and in the door’s own words, and a yes presses again WITH the flag', async () => {
    let first = true;
    apiJson.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        if (first) { first = false; throw unsent(); }
        return { success: true };
      }
      return { batches: [batch], pagination: { total: 1 } };
    });
    confirm.mockResolvedValue(true);
    await press();

    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: '2 طلب ما انرحّل للشركة', body: SENTENCE, confirmLabel: 'سلّم رغم ذلك', tone: 'danger',
    });
    expect(bodies()).toEqual([{ status: 'SHIPPED' }, { status: 'SHIPPED', acknowledgeUnsent: true }]);
    expect(failed).not.toHaveBeenCalled();
  });

  it('«رجوع» sends nothing more: one press in all, and no error toast', async () => {
    apiJson.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') throw unsent();
      return { batches: [batch], pagination: { total: 1 } };
    });
    confirm.mockResolvedValue(false);
    await press();

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(patches()).toHaveLength(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('any other refusal is the toast it always was, with no question', async () => {
    apiJson.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') throw refusal({ code: 'PENDING_CHANGES', errorAr: 'على هالطلبات إلغاء أو تأجيل لسّا ما انحسم' });
      return { batches: [batch], pagination: { total: 1 } };
    });
    await press();

    await waitFor(() => expect(failed).toHaveBeenCalledWith('على هالطلبات إلغاء أو تأجيل لسّا ما انحسم'));
    expect(confirm).not.toHaveBeenCalled();
    expect(patches()).toHaveLength(1);
  });

  it('a press that goes through carries no flag at all, and asks nothing', async () => {
    await press();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(bodies()).toEqual([{ status: 'SHIPPED' }]);
    expect(confirm).not.toHaveBeenCalled();
  });
});
