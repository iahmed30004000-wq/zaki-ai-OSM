// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «بدي لما يصير الفشل زر اظهار هذا الفشل او انزال القائمة او رفع لأنها بتاخذ كل الصفحة».
 *
 * BATCH-2026-0003 («قيد التجميع», الباشا, 36 طلب) answered «رُحّل 0 · تُخطّي 1 · فشل 35» with one line per order, and
 * the lines filled the page. The batches screen now groups them behind a button; this renders the REAL screen, presses
 * the real «رحّل إلى الشركة واجلب الباركود», and reads what is on the page. The banner after «إنشاء شحنة» shows the same
 * component (its own test file feeds it a grouped answer) — and the last test below holds that there is one copy.
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

const REFUSAL = 'الباشا رفض: رقم تعريف الشركة غير صحيح (400)';
const WAIT = { timeout: 8000 };

const batch = {
  id: 'b3', batchNumber: 'BATCH-2026-0003', status: 'READY',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: true },
  creator: { id: 'u1', name: 'سارة' }, createdAt: '2026-10-28T08:00:00.000Z', shippedAt: null, notes: null,
  _count: { orders: 36 },
};

/** The 36 orders of the batch with no barcode yet: 35 the courier refuses, and one governorate it has no id for. */
const PENDING = [...Array.from({ length: 35 }, (_, i) => `o${i + 4}`), 'sw'];
const numberOf = (id: string) => (id === 'sw' ? 'ORD-2026-0508' : `ORD-2026-${String(Number(id.slice(1))).padStart(4, '0')}`);

/** What the courier's door answers for the orders it was handed — one outcome each, as the server does. */
const answerFor = (ids: string[]) => ({
  sent: 0,
  skipped: ids.filter((id) => id === 'sw').length,
  failed: ids.filter((id) => id !== 'sw').length,
  outcomes: ids.map((id) =>
    id === 'sw'
      ? { orderId: 'sw', orderNumber: numberOf('sw'), ok: false, skipped: 'NO_COURIER_CITY', regionName: 'السويداء' }
      : { orderId: id, orderNumber: numberOf(id), ok: false, error: REFUSAL }
  ),
});

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    // Which orders are left (GET), then the pieces (POST, a few `orderIds` at a time).
    if (url.endsWith('/dispatch') && !init?.method) return { pending: PENDING.map((id) => ({ id, orderNumber: numberOf(id) })), sent: [] };
    if (init?.method === 'POST' && url.endsWith('/dispatch')) return answerFor(JSON.parse(init.body as string).orderIds);
    return { batches: [batch], pagination: { total: 1 } };
  });
});
afterEach(cleanup);

describe('«دفعات الشحن» — the failed orders of a dispatch', () => {
  it('«قيد التجميع» still offers the button (the failed orders can be sent again), and the result is grouped and closed', async () => {
    render(<ShippingBatchesScreen />);
    const send = await screen.findByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }, WAIT);
    await act(async () => {
      fireEvent.click(send);
    });

    expect(await screen.findByText('رُحّل 0 · تُخطّي 1 · فشل 35', undefined, WAIT)).toBeTruthy();
    // One line for the 35, one for the governorate with no code.
    expect(screen.getByText(`35 طلب — ${REFUSAL}`)).toBeTruthy();
    expect(screen.getByText(/1 طلب — السويداء: لا رمز لها عند الشركة بعد/)).toBeTruthy();
    // And not a single order number on the page until it is asked for.
    expect(screen.queryByText('ORD-2026-0004')).toBeNull();
    expect(screen.queryByText('ORD-2026-0508')).toBeNull();
    expect(screen.getByRole('button', { name: 'اعرض الطلبات (35)' }).getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'اعرض الطلبات (35)' }));
    expect(screen.getByText('ORD-2026-0004')).toBeTruthy();

    // The button to send again is still there after a failure — nothing was sent, nothing was handed over.
    expect((screen.getByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('pressing it again asks again which orders are left and sends them again, a few at a time — the server decides what is skipped', async () => {
    render(<ShippingBatchesScreen />);
    const press = async () => {
      const send = await screen.findByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }, WAIT);
      await act(async () => {
        fireEvent.click(send);
      });
    };
    await press();
    await press();
    const calls = apiJson.mock.calls.filter((c) => String(c[0]).endsWith('/dispatch'));
    // each press: one question, then the pieces — 36 orders, eight at a time, is five requests
    const posts = calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(calls.filter((c) => !(c[1] as RequestInit | undefined)?.method)).toHaveLength(2);
    expect(posts).toHaveLength(10);
    expect(new Set(posts.map((c) => c[0]))).toEqual(new Set(['/api/ops/shipments/b3/dispatch']));
    const pieces = posts.map((c) => JSON.parse((c[1] as RequestInit).body as string).orderIds as string[]);
    expect(pieces.slice(0, 5).map((p) => p.length)).toEqual([8, 8, 8, 8, 4]);
    expect(pieces.slice(0, 5).flat()).toEqual(PENDING);
    expect(pieces.slice(5).flat()).toEqual(PENDING);
    // and each piece is given longer than the fifteen seconds every other request gets
    for (const c of posts) expect((c[1] as { timeoutMs?: number }).timeoutMs).toBeGreaterThan(15_000);
  });

  it('NEGATIVE: a batch already handed over (سُلّمت) has no send button — there is nothing left to send', async () => {
    apiJson.mockImplementation(async () => ({ batches: [{ ...batch, status: 'SHIPPED' }], pagination: { total: 1 } }));
    render(<ShippingBatchesScreen />);
    await screen.findByText('BATCH-2026-0003', undefined, WAIT);
    expect(screen.queryByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' })).toBeNull();
  });
});

describe('one component, not two copies', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  it('both screens draw the shared result and neither keeps its own per-order list', () => {
    for (const screenFile of ['src/components/screens/ShippingBatchesScreen.tsx', 'src/components/screens/ShipmentsNewScreen.tsx']) {
      const src = read(screenFile);
      expect(src, `${screenFile} لا يرسم المكوّن المشترك`).toContain('<DispatchResult');
      expect(src, `${screenFile} عاد لسطر لكل طلب`).not.toContain('dispatchReasonAr');
    }
  });
});
