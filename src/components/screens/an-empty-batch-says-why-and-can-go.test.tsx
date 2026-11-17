// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * A BATCH THAT HOLDS NO ORDER SAYS SO, AND CAN GO (the owner, 17/11: BATCH-2026-0020 · «قيد التجميع» · 0 طلب).
 *
 * A trolley empties when its last parcel leaves it — a cancel, a postponement, a move to another courier — and nothing removed the
 * shell: every press greyed, no word on why, and a handover press that looked pressable and could never answer. Now an OPEN batch with
 * no order says it in words, offers «احذف الدفعة» to whoever holds the shipping-status key, and does not draw the handover press.
 * Everything else about the card — the other presses staying greyed, a batch with orders, a handed-over batch — is as it was.
 */
const { apiJson, held, ask } = vi.hoisted(() => ({ apiJson: vi.fn(), held: new Set<string>(), ask: { yes: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/batches',
}));
const toast = { failed: vi.fn(), done: vi.fn() };
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => ask.yes, useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useCan', () => ({ useCan: (k: string) => held.has(k) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: null }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  },
}));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => ({ dims: { width: 100, height: 150 } }), LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({ BLOCKED_WAYBILLS: 'x', describeRefused: () => '', openWaybills: vi.fn(), WaybillError: class extends Error {} }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanSheet: () => null }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));

import { ShippingBatchesScreen } from './ShippingBatchesScreen';

const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b20', batchNumber: 'BATCH-2026-0020', status: 'READY',
  provider: { id: 'dp1', name: 'ابو طلال', code: 'AT', kind: 'AGENT', apiEnabled: false },
  creator: { id: 'u1', name: 'احمد' }, createdAt: '2026-11-17T12:26:00.000Z', shippedAt: null, notes: null,
  _count: { orders: 0 }, courierCityGap: null, shippedCount: 0, ...over,
});

const mount = async (b: Record<string, unknown>, keys: string[]) => {
  held.clear();
  for (const k of keys) held.add(k);
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') return { success: true };
    if (String(url).startsWith('/api/shipping-batches')) return { batches: [b], total: 1 };
    return {};
  });
  render(<ShippingBatchesScreen />);
  await screen.findByText('BATCH-2026-0020', undefined, { timeout: 8000 });
};
const buttons = () => screen.getAllByRole('button').map((x) => (x.textContent ?? '').trim());

beforeEach(() => {
  apiJson.mockReset();
  toast.failed.mockReset();
  toast.done.mockReset();
  ask.yes = true;
});
afterEach(cleanup);

describe('an empty open batch', () => {
  it('says in words that it is empty, whose it is, and what fills it', async () => {
    await mount(batch(), ['ops.batches', 'orders.change_status']);
    const said = screen.getByRole('status');
    expect(said.textContent).toContain('الدفعة فاضية');
    expect(said.textContent).toContain('بتتعبّى بأول شحنة لـابو طلال');
  });

  it('does not draw the handover press — it can never answer an empty trolley — and the greyed presses stay greyed', async () => {
    await mount(batch(), ['ops.batches', 'orders.change_status', 'ops.ship']);
    expect(buttons().some((t) => t.includes('إغلاق الشحنة'))).toBe(false);
    const print = screen.getByText('طباعة بوالص الدفعة').closest('button') as HTMLButtonElement;
    expect(print.disabled).toBe(true);
  });

  it('offers «احذف الدفعة» to whoever holds the shipping-status key, and a yes sends one DELETE for that batch and reloads', async () => {
    await mount(batch(), ['ops.batches', 'orders.change_status']);
    fireEvent.click(screen.getByText('احذف الدفعة'));
    await waitFor(() => expect(apiJson).toHaveBeenCalledWith('/api/shipping-batches/b20', { method: 'DELETE' }));
    expect(apiJson.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'DELETE')).toHaveLength(1);
    await waitFor(() => expect(toast.done).toHaveBeenCalledWith('انحذفت BATCH-2026-0020'));
  });

  it('a no keeps the batch: nothing is sent', async () => {
    ask.yes = false;
    await mount(batch(), ['ops.batches', 'orders.change_status']);
    fireEvent.click(screen.getByText('احذف الدفعة'));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiJson.mock.calls.some((c) => (c[1] as { method?: string } | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('without the shipping-status key the sentence is there and the delete is not', async () => {
    await mount(batch(), ['ops.batches']);
    expect(screen.getByRole('status').textContent).toContain('الدفعة فاضية');
    expect(buttons()).not.toContain('احذف الدفعة');
  });

  it('a refusal from the server (a parcel arrived meanwhile) is read out, and the batch stays on the screen', async () => {
    await mount(batch(), ['ops.batches', 'orders.change_status']);
    apiJson.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') throw new Error('الدفعة فيها طلبات — ما بتنحذف.');
      return { batches: [batch()], total: 1 };
    });
    fireEvent.click(screen.getByText('احذف الدفعة'));
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('الدفعة فيها طلبات — ما بتنحذف.'));
    expect(screen.getByText('BATCH-2026-0020')).toBeTruthy();
  });
});

describe('a batch that is not an empty open one is as it was', () => {
  it('a batch with orders has the handover press and no empty sentence', async () => {
    await mount(batch({ _count: { orders: 12 } }), ['ops.batches', 'orders.change_status', 'ops.ship']);
    expect(buttons().some((t) => t.includes('إغلاق الشحنة'))).toBe(true);
    expect(screen.queryByText('احذف الدفعة')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a handed-over batch with 0 orders is not offered a delete — only an open one goes', async () => {
    await mount(batch({ status: 'SHIPPED', _count: { orders: 0 } }), ['ops.batches', 'orders.change_status']);
    expect(screen.queryByText('احذف الدفعة')).toBeNull();
  });
});
