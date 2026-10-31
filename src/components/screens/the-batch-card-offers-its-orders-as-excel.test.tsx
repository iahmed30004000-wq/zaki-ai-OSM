// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE
 *
 * BATCH-2026-0004 (الباشا, 147 orders) was closed before it was sent, so its waybills and its CSV are refused for want of
 * the courier's barcode. The card of EVERY batch — open, handed over or ended — offers «إكسل»: the batch's orders as a file.
 *
 *  1. The button is drawn for whoever holds `ops.batches` AND `customers.view`, on a batch in any status.
 *  2. Pressing it fetches `/api/shipping-batches/:id/export` and saves `BATCH-….xlsx`.
 *  3. A refusal is said on the screen, in the server's words, and nothing is saved.
 *  4. Without the address-book key the button is not drawn at all.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, perms } = vi.hoisted(() => ({ apiJson: vi.fn(), apiFetch: vi.fn(), perms: { list: [] as string[] } }));
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
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: perms.list } }),
}));
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
const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b4', batchNumber: 'BATCH-2026-0004', status: 'CLOSED',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: true },
  creator: { id: 'u1', name: 'Qabas' }, createdAt: '2026-10-31T10:00:00.000Z', shippedAt: '2026-10-31T13:23:00.000Z', notes: null,
  _count: { orders: 147 }, courierCityGap: null, ...over,
});

const serve = (b: Record<string, unknown>) =>
  apiJson.mockImplementation(async () => ({ batches: [b], pagination: { total: 1 } }));

const xlsx = (status = 200, body: BodyInit | null = new Blob(['PK']), json?: unknown) =>
  ({
    ok: status < 400,
    status,
    blob: async () => body as Blob,
    json: async () => json ?? {},
    headers: new Headers(),
    clone() { return this; },
  }) as unknown as Response;

let saved: { download: string; href: string }[];
beforeEach(() => {
  vi.clearAllMocks();
  perms.list = ['ops.batches', 'customers.view'];
  saved = [];
  // jsdom has no object URLs and does not follow a download: the click is what is observed.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:fake';
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ download: this.download, href: this.href });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('«إكسل» on the batch card', () => {
  it('is drawn on an ENDED batch with 147 orders, and saves BATCH-2026-0004.xlsx from the export door', async () => {
    serve(batch());
    apiFetch.mockResolvedValue(xlsx());
    render(<ShippingBatchesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'إكسل' }, WAIT));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(apiFetch).toHaveBeenCalledWith('/api/shipping-batches/b4/export');
    expect(saved[0].download).toBe('BATCH-2026-0004.xlsx');
  });

  it.each(['READY', 'SHIPPED', 'CLOSED'])('is drawn on a %s batch too — the status does not matter', async (status) => {
    serve(batch({ status }));
    render(<ShippingBatchesScreen />);
    expect(await screen.findByRole('button', { name: 'إكسل' }, WAIT)).toBeTruthy();
  });

  it('a refusal is said on the screen in the server’s words, and nothing is saved', async () => {
    serve(batch());
    apiFetch.mockResolvedValue(xlsx(403, null, { errorAr: 'ملف الدفعة فيه أسماء وأرقام وعناوين الزبائن، فيحتاج صلاحية «عرض العملاء». اطلبها من مدير النظام.' }));
    render(<ShippingBatchesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'إكسل' }, WAIT));

    expect(await screen.findByText(/فيحتاج صلاحية «عرض العملاء»/, undefined, WAIT)).toBeTruthy();
    expect(saved).toHaveLength(0);
  });

  it('NEGATIVE: without the address-book key the button is not drawn', async () => {
    perms.list = ['ops.batches'];
    serve(batch());
    render(<ShippingBatchesScreen />);
    await screen.findByText('BATCH-2026-0004', undefined, WAIT);
    expect(screen.queryByRole('button', { name: 'إكسل' })).toBeNull();
  });

  it('NEGATIVE: an empty batch has nothing to export, so the button is shut', async () => {
    serve(batch({ _count: { orders: 0 } }));
    render(<ShippingBatchesScreen />);
    const button = (await screen.findByRole('button', { name: 'إكسل' }, WAIT)) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
