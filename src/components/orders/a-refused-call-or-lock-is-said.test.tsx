// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A REFUSED CALL LINE OR A REFUSED LOCK IS SAID — NOT SWALLOWED.
 *
 * The agent rang from the strip and the line in the contact log was refused
 * (403, 404): nothing on screen, and «تأكيد» stayed locked under «اتصل
 * بالزبون أول». She pressed «تعديل» and the lock was refused: the edit lock
 * hook set a message only for 423 and 409, so a 403 or a 404 returned
 * `{ ok: false }` and nothing else, and the order window never showed it.
 *
 *   · the strip says the line was not recorded — in the server's Arabic, and
 *     in its own when the server's is English — and never stops the dial;
 *   · the lock hook hands the door's own words back, for 403 and 404 too;
 *   · and the order window puts them where its other answers are.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, acquireLock } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  acquireLock: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    isRtl: true,
    t: { editingBy: 'يعدّله', actionError: 'تعذّر تنفيذ الإجراء' },
    currentUser: { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.work'], status: 'ACTIVE' },
  }),
}));
// The order window's own subject here is the banner; the lock hook it calls is
// stood in for, and its real answers are asked further down.
vi.mock('@/hooks/useOrderOwnership', () => ({
  useOrderOwnership: () => ({ acquireLock, releaseLock: vi.fn(async () => {}), inEditMode: false, message: null }),
}));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => vi.fn() }));
vi.mock('@/components/orders/OrderResponsibility', () => ({ OrderResponsibility: () => null }));
vi.mock('@/components/orders/CustomerCard', () => ({
  CustomerCard: ({ onAcquireLock }: { onAcquireLock: () => void }) => (
    <button type="button" onClick={() => onAcquireLock()}>
      عدّل العميل
    </button>
  ),
}));
vi.mock('@/components/orders/OrderLinesCard', () => ({ OrderLinesCard: () => null }));
vi.mock('@/components/orders/ConfirmationActions', () => ({ ConfirmationActions: () => null }));
vi.mock('@/components/orders/ShapeRiskPanel', () => ({ ShapeRiskPanel: () => null }));
vi.mock('@/components/orders/ShippingSection', () => ({ ShippingSection: () => null }));
vi.mock('@/components/orders/OrderStages', () => ({ OrderStages: () => null }));
vi.mock('@/components/orders/OrderNotes', () => ({ OrderNotes: () => null }));
vi.mock('@/components/orders/OrderStateBadge', () => ({ OrderStateBadge: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryModal: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null }));
vi.mock('@/components/orders/raiseChangeRequest', () => ({ raiseChangeRequest: vi.fn() }));

import { ContactButtons } from './ContactButtons';
import { OrderDetailModal } from './OrderDetailModal';

const { useOrderOwnership } = await vi.importActual<typeof import('@/hooks/useOrderOwnership')>(
  '@/hooks/useOrderOwnership'
);

const CONTEXT = { orderNumber: 'JO-1', customerName: 'سعاد', amount: 25 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('open', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the call strip', () => {
  it('says the line was not recorded, in the server’s own Arabic', async () => {
    apiJson.mockRejectedValue(new Error('الطلب غير موجود أو ليس بين يديك.'));
    render(<ContactButtons phone="0791234567" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('اتصال'));
    const said = await screen.findByRole('alert');
    expect(said.textContent).toContain('ما انسجّلت المحاولة على الطلب');
    expect(said.textContent).toContain('الطلب غير موجود أو ليس بين يديك.');
  });

  it('and in its own words when the server’s are not Arabic', async () => {
    apiJson.mockRejectedValue(new Error('Forbidden: cannot record contact attempts'));
    render(<ContactButtons phone="0791234567" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('اتصال'));
    const said = await screen.findByRole('alert');
    expect(said.textContent).toBe('ما انسجّلت المحاولة على الطلب.');
    expect(said.textContent, 'انعرضت جملة إنجليزية للموظفة').not.toMatch(/Forbidden/);
  });

  it('and still dials — the call matters more than its line', async () => {
    apiJson.mockRejectedValue(new Error('403'));
    render(<ContactButtons phone="0791234567" orderId="o1" context={CONTEXT} />);
    expect(screen.getByTitle('اتصال').getAttribute('href')).toBe('tel:0791234567');
  });

  it('NEGATIVE: a recorded line says nothing', async () => {
    apiJson.mockResolvedValue({ success: true });
    render(<ContactButtons phone="0791234567" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('اتصال'));
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('NEGATIVE: and a number with no order records nothing, so it has nothing to say', async () => {
    render(<ContactButtons phone="0791234567" plain context={{}} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    await new Promise((r) => setTimeout(r, 0));
    expect(apiJson).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the edit lock', () => {
  const answer = (status: number, body: Record<string, unknown>) =>
    apiFetch.mockResolvedValue({ ok: status < 400, status, json: async () => body });

  it.each([
    [404, { error: 'Order not found or not assigned to you', errorAr: 'الطلب غير موجود أو ليس بين يديك.' }, 'الطلب غير موجود أو ليس بين يديك.'],
    [403, { error: 'Forbidden: missing required permission orders.view', errorAr: 'لا تملك صلاحية «عرض الطلبات». اطلبها من مدير النظام إن كانت من عملك.' }, 'لا تملك صلاحية «عرض الطلبات». اطلبها من مدير النظام إن كانت من عملك.'],
    [403, { error: 'Forbidden' }, 'تعذّر فتح الطلب للتعديل.'],
  ])('a %s is handed back in words, not as a bare «no»', async (status, body, words) => {
    answer(status, body);
    const { result } = renderHook(() => useOrderOwnership('o1'));
    let got: { ok: boolean; error?: string } = { ok: true };
    await act(async () => {
      got = await result.current.acquireLock('o1');
    });
    expect(got).toEqual({ ok: false, error: words });
    expect(result.current.message).toEqual({ type: 'error', text: words });
  });

  it('NEGATIVE: a lock that is taken says nothing to explain', async () => {
    answer(200, { success: true, lockExpiresAt: '2026-10-28T09:05:00.000Z' });
    const { result } = renderHook(() => useOrderOwnership('o1'));
    let got: { ok: boolean; error?: string } = { ok: false };
    await act(async () => {
      got = await result.current.acquireLock('o1');
    });
    expect(got).toEqual({ ok: true, lockExpiresAt: '2026-10-28T09:05:00.000Z' });
    expect(result.current.message).toBeNull();
    act(() => result.current.stopHeartbeat());
  });
});

describe('the order window', () => {
  const ORDER = {
    id: 'o1', orderNumber: 'JO-1', createdAt: '2026-10-28T06:00:00.000Z', source: 'Manual', status: 'IN_PROGRESS',
    confirmationStatus: 'IN_PROGRESS', customer: { id: 'cu1', fullName: 'سعاد', phone: '079', city: 'عمّان' },
    items: [], addOns: [], totalAmount: 25,
  };

  beforeEach(() => {
    apiFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ order: ORDER, currency: 'JOD', cod: null, previousOrderId: null, nextOrderId: null }),
    }));
    apiJson.mockResolvedValue({ events: [], channels: [] });
  });

  it('puts the lock’s refusal where its other answers are', async () => {
    acquireLock.mockResolvedValue({ ok: false, error: 'الطلب غير موجود أو ليس بين يديك.' });
    render(<OrderDetailModal orderId="o1" isOpen onClose={() => {}} onRefresh={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'عدّل العميل' }));
    expect(await screen.findByText('الطلب غير موجود أو ليس بين يديك.')).toBeTruthy();
  });

  it('NEGATIVE: and says nothing when the lock is taken', async () => {
    acquireLock.mockResolvedValue({ ok: true, lockExpiresAt: '2026-10-28T09:05:00.000Z' });
    render(<OrderDetailModal orderId="o1" isOpen onClose={() => {}} onRefresh={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'عدّل العميل' }));
    await waitFor(() => expect(acquireLock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('الطلب غير موجود أو ليس بين يديك.')).toBeNull();
  });
});
