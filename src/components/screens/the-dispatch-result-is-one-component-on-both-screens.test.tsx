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

const refusedAll = {
  sent: 0, skipped: 1, failed: 35,
  outcomes: [
    ...Array.from({ length: 35 }, (_, i) => ({
      orderId: `o${i + 4}`, orderNumber: `ORD-2026-${String(i + 4).padStart(4, '0')}`, ok: false, error: REFUSAL,
    })),
    { orderId: 'sw', orderNumber: 'ORD-2026-0508', ok: false, skipped: 'NO_COURIER_CITY', regionName: 'السويداء' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.endsWith('/dispatch')) return refusedAll;
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

  it('pressing it again sends the whole batch to the same door — the server decides what is skipped', async () => {
    render(<ShippingBatchesScreen />);
    const press = async () => {
      const send = await screen.findByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }, WAIT);
      await act(async () => {
        fireEvent.click(send);
      });
    };
    await press();
    await press();
    const sends = apiJson.mock.calls.filter((c) => String(c[0]).endsWith('/dispatch'));
    expect(sends.map((c) => c[0])).toEqual(['/api/ops/shipments/b3/dispatch', '/api/ops/shipments/b3/dispatch']);
    expect(JSON.parse((sends[1][1] as RequestInit).body as string)).toEqual({});
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
