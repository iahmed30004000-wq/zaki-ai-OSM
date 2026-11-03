// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «لصق الباركودات» on the batch card (RV165, the owner 3/11)
 *
 *  1. The card of a batch with parcels — a handed-over one too — offers «لصق الباركودات» to whoever holds `ops.ship`.
 *  2. The box asks «تحقّق» first (a dry run, nothing written) and shows each line's answer; «اكتب» is offered only for the
 *     exact text that was checked, and sends the same paste without `dryRun`.
 *  3. Without the key the button is not drawn.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, perms, done } = vi.hoisted(() => ({
  apiJson: vi.fn(), apiFetch: vi.fn(), perms: { list: [] as string[] }, done: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
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
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: perms.list } }),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => { void load(); }, [load]);
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
const BATCH = {
  id: 'b4', batchNumber: 'BATCH-2026-0004', status: 'SHIPPED',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: true },
  creator: { id: 'u1', name: 'Qabas' }, createdAt: '2026-10-31T10:00:00.000Z', shippedAt: '2026-10-31T13:23:00.000Z', notes: null,
  _count: { orders: 147 }, courierCityGap: null,
};
const answer = (dryRun: boolean) => ({
  dryRun,
  batchNumber: 'BATCH-2026-0004',
  counts: { written: 1, unchanged: 0, refused: 1 },
  lines: [
    { line: 1, ref: 'ORD-2026-0722', barcode: '1234567890', outcome: 'written', orderId: 'o1', orderNumber: 'ORD-2026-0722', previous: null },
    { line: 2, ref: 'ORD-2026-0555', barcode: '1234567891', outcome: 'refused', code: 'NOT_IN_BATCH', reason: 'الطلب مش من هالدفعة' },
  ],
});

const PASTE = 'ORD-2026-0722, 1234567890\nORD-2026-0555\t1234567891';

beforeEach(() => {
  vi.clearAllMocks();
  perms.list = ['ops.batches', 'ops.ship'];
  apiJson.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/tracking')) return answer(JSON.parse(init!.body!).dryRun === true);
    return { batches: [BATCH], pagination: { total: 1 } };
  });
});
afterEach(cleanup);

const trackingCalls = () => apiJson.mock.calls.filter(([url]) => String(url).endsWith('/tracking'));

describe('«لصق الباركودات» on a handed-over batch', () => {
  it('checks first (nothing written), shows each line, then writes exactly the checked paste', async () => {
    render(<ShippingBatchesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'لصق الباركودات' }, WAIT));

    const box = await screen.findByLabelText('الباركودات', undefined, WAIT);
    fireEvent.change(box, { target: { value: PASTE } });
    // «اكتب» waits for a «تحقّق».
    expect((screen.getByRole('button', { name: 'اكتب' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'تحقّق' }));
    expect(await screen.findByText(/الطلب مش من هالدفعة/, undefined, WAIT)).toBeTruthy();
    expect(screen.getByText(/نتيجة التحقّق \(ما انكتب شي\)/)).toBeTruthy();
    expect(trackingCalls()).toHaveLength(1);
    expect(trackingCalls()[0][0]).toBe('/api/shipping-batches/b4/tracking');
    expect(JSON.parse(trackingCalls()[0][1].body)).toEqual({ text: PASTE, dryRun: true });

    fireEvent.click(screen.getByRole('button', { name: 'اكتب (1)' }));
    await waitFor(() => expect(trackingCalls()).toHaveLength(2));
    expect(JSON.parse(trackingCalls()[1][1].body)).toEqual({ text: PASTE, dryRun: false });
    await waitFor(() => expect(done).toHaveBeenCalledWith('انكتب الباركود على طلب واحد من BATCH-2026-0004'));
  });

  it('an edit after «تحقّق» takes «اكتب» away until the paste is checked again', async () => {
    render(<ShippingBatchesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'لصق الباركودات' }, WAIT));
    const box = await screen.findByLabelText('الباركودات', undefined, WAIT);
    fireEvent.change(box, { target: { value: PASTE } });
    fireEvent.click(screen.getByRole('button', { name: 'تحقّق' }));
    await screen.findByRole('button', { name: 'اكتب (1)' }, WAIT);

    fireEvent.change(box, { target: { value: `${PASTE}\nORD-2026-0963, 1234567892` } });
    expect((screen.getByRole('button', { name: 'اكتب' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/تغيّرت اللصقة بعد التحقّق/)).toBeTruthy();
  });

  it('the overwrite box goes with the request only when ticked', async () => {
    render(<ShippingBatchesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'لصق الباركودات' }, WAIT));
    fireEvent.change(await screen.findByLabelText('الباركودات', undefined, WAIT), { target: { value: PASTE } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'تحقّق' }));
    await waitFor(() => expect(trackingCalls()).toHaveLength(1));
    expect(JSON.parse(trackingCalls()[0][1].body)).toEqual({ text: PASTE, dryRun: true, overwrite: true });
  });

  it('NEGATIVE: without `ops.ship` the button is not drawn', async () => {
    perms.list = ['ops.batches'];
    render(<ShippingBatchesScreen />);
    await screen.findByText('BATCH-2026-0004', undefined, WAIT);
    expect(screen.queryByRole('button', { name: 'لصق الباركودات' })).toBeNull();
  });
});
