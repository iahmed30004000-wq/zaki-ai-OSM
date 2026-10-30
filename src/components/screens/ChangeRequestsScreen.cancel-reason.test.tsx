// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * AN OLD CANCELLATION, STORED WITHOUT ITS REASON, CAN BE CARRIED OUT.
 *
 * «بانتظار التطبيق» showed «سبب الإلغاء: —» and a button that always failed
 * with «سبب الإلغاء مطلوب». For those requests — and only those — the card now
 * carries the choice, the button waits for it, and the press sends it to the
 * stand-down door. A request that has its reason, or that is a message to the
 * courier, shows no such field. Read off the rendered screen, not the source.
 */

const { apiJson, apiFetch } = vi.hoisted(() => ({
  apiJson: vi.fn<(url: string) => Promise<unknown>>(),
  apiFetch: vi.fn<(url: string, init?: { body?: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(),
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: (url: string) => apiJson(url),
  apiFetch: (url: string, init?: { body?: string }) => apiFetch(url, init),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/control/change-requests' }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => false }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useTell: () => vi.fn(),
}));

import { ChangeRequestsScreen } from './ChangeRequestsScreen';

const cancelRow = (over: Record<string, unknown> = {}) => ({
  id: 'cr-1',
  reason: 'الزبون تراجع بالاتصال',
  status: 'APPROVED',
  blocking: true,
  changedDuringReview: false,
  createdAt: '2026-10-01T10:00:00.000Z',
  slaDueAt: null,
  overdue: false,
  decisionNote: 'تم',
  requestedByName: 'عبير',
  requestedRole: 'CONFIRMATION_AGENT',
  isMine: false,
  intent: 'CANCEL',
  postponeUntil: null,
  cancelReason: null,
  carryOut: { kind: 'CANCEL_ORDER' },
  changes: {},
  order: {
    id: 'o1',
    orderNumber: 'ORD-2026-0585',
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'PACKING',
    version: 3,
    customer: { fullName: 'سارة', phone: '0999' },
  },
  ...over,
});

function serve(awaiting: unknown[]) {
  apiJson.mockReset();
  apiJson.mockImplementation(async (url: string) =>
    url.includes('status=AWAITING_APPLY') ? { requests: awaiting } : { requests: [] }
  );
}

const PICK = 'اختر سبب الإلغاء';

async function openApplyTab() {
  render(<ChangeRequestsScreen />);
  fireEvent.click(await screen.findByRole('button', { name: /بانتظار التطبيق/ }));
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
});
afterEach(cleanup);

describe('an old cancellation with no stored reason', () => {
  it('shows the choice on the card and keeps the button shut until it is made', async () => {
    serve([cancelRow()]);
    await openApplyTab();

    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    expect(screen.getByRole('option', { name: PICK })).toBeTruthy();
    const button = screen.getByRole('button', { name: 'ألغِ الطلب' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(apiFetch).not.toHaveBeenCalled();

    fireEvent.change(select, { target: { value: 'CUSTOMER_CHANGED_MIND' } });
    expect((screen.getByRole('button', { name: 'ألغِ الطلب' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers only what a person may choose — never the two the system owns', async () => {
    serve([cancelRow()]);
    await openApplyTab();

    await screen.findByRole('combobox');
    const values = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain('CUSTOMER_CHANGED_MIND');
    expect(values).toContain('OTHER');
    expect(values).not.toContain('NO_ANSWER_3_ATTEMPTS');
    expect(values).not.toContain('MODERATOR_DATA_ERROR');
  });

  it('presses the stand-down door with the request and the picked reason', async () => {
    serve([cancelRow()]);
    await openApplyTab();

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'PRICE_TOO_HIGH' } });
    fireEvent.click(screen.getByRole('button', { name: 'ألغِ الطلب' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [url, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/ops/shipments/stand-down');
    expect(JSON.parse(init.body)).toEqual({
      orderId: 'o1', outcome: 'CANCEL', changeRequestId: 'cr-1', reason: 'PRICE_TOO_HIGH',
    });
  });
});

describe('everything else is as it was', () => {
  it('a request that has its reason shows no field, and presses with the id alone', async () => {
    serve([cancelRow({ cancelReason: 'FAKE_ORDER' })]);
    await openApplyTab();

    await screen.findByText('ORD-2026-0585');
    expect(screen.queryByRole('combobox')).toBeNull();
    const button = screen.getByRole('button', { name: 'ألغِ الطلب' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const init = apiFetch.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ orderId: 'o1', outcome: 'CANCEL', changeRequestId: 'cr-1' });
  });

  it('a cancellation that is a message to the courier needs no reason from the decider', async () => {
    serve([cancelRow({ carryOut: { kind: 'CANCEL_VIA_COURIER' } })]);
    await openApplyTab();

    await screen.findByText('ORD-2026-0585');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect((screen.getByRole('button', { name: 'أبلغ شركة الشحن بالإلغاء' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a postponement has no such field either', async () => {
    serve([cancelRow({ intent: 'POSTPONE', carryOut: { kind: 'HOLD_SHIPMENT' }, postponeUntil: '2026-10-05T00:00:00.000Z' })]);
    await openApplyTab();

    await screen.findByText('ORD-2026-0585');
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
