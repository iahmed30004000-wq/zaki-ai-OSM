// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «تراجع عن الموافقة» ON THE TAB «بانتظار التطبيق» (the owner's ruling 4/11).
 *
 * ORD-2026-1584: an approved cancel on an open trolley, never carried out, held the press of the whole trolley, and no screen
 * could take the approval back. Each awaiting row now carries the button — only where the decide buttons are drawn (never on
 * the reader's own request) — it asks for a written reason, and it sends `decision: 'REVOKED'` with that reason. And a row
 * the server says cannot be carried out (on an open trolley) says why, with its «نفِّذ» shut. Read off the rendered screen.
 */

const { apiJson, apiFetch, ask } = vi.hoisted(() => ({
  apiJson: vi.fn<(url: string, init?: { method?: string; body?: string }) => Promise<unknown>>(),
  apiFetch: vi.fn<(url: string, init?: { body?: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(),
  ask: vi.fn<(o: unknown) => Promise<string | null>>(),
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: (url: string, init?: { method?: string; body?: string }) => apiJson(url, init),
  apiFetch: (url: string, init?: { body?: string }) => apiFetch(url, init),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/control/change-requests' }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => false }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => ask,
  useTell: () => vi.fn(),
}));

import { ON_TROLLEY_AR } from '@/lib/order-seal';
import { ChangeRequestsScreen } from './ChangeRequestsScreen';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'cr-1584',
  reason: 'الزبون تراجع بالاتصال',
  status: 'APPROVED',
  blocking: true,
  changedDuringReview: false,
  createdAt: '2026-11-03T10:00:00.000Z',
  slaDueAt: null,
  overdue: false,
  decisionNote: 'تم',
  requestedByName: 'عبير',
  requestedRole: 'CONFIRMATION_AGENT',
  isMine: false,
  intent: 'CANCEL',
  postponeUntil: null,
  cancelReason: 'CUSTOMER_CHANGED_MIND',
  carryOut: { kind: 'REFUSED', reason: ON_TROLLEY_AR, code: 'ON_OPEN_TROLLEY' },
  changes: {},
  order: {
    id: 'o1', orderNumber: 'ORD-2026-1584', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', version: 3,
    customer: { fullName: 'سارة', phone: '0999' },
  },
  ...over,
});

function serve(awaiting: unknown[]) {
  apiJson.mockReset();
  apiJson.mockImplementation(async (url: string) =>
    url.includes('status=AWAITING_APPLY') ? { requests: awaiting } : url.includes('?status=') ? { requests: [] } : { request: {} }
  );
}

const REVOKE = 'تراجع عن الموافقة';
const patches = () => apiJson.mock.calls.filter(([, init]) => init?.method === 'PATCH');

beforeEach(() => {
  ask.mockReset();
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
});
afterEach(cleanup);

describe('«تراجع عن الموافقة» on an awaiting row', () => {
  it('is drawn on a colleague’s approved request', async () => {
    serve([row()]);
    render(<ChangeRequestsScreen />);

    expect(await screen.findByRole('button', { name: REVOKE })).toBeTruthy();
  });

  it('asks for a written reason, and sends REVOKED with it to the decide door', async () => {
    serve([row()]);
    ask.mockResolvedValue('انوافق عليه بالغلط');
    render(<ChangeRequestsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: REVOKE }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(ask).toHaveBeenCalledTimes(1);
    expect((ask.mock.calls[0][0] as { input: { required?: boolean } }).input.required).toBe(true);
    const [url, init] = patches()[0];
    expect(url).toBe('/api/control/change-requests/cr-1584');
    expect(JSON.parse(init!.body!)).toEqual({ decision: 'REVOKED', note: 'انوافق عليه بالغلط' });
  });

  it('sends nothing when the person declines to write a reason', async () => {
    serve([row()]);
    ask.mockResolvedValue(null);
    render(<ChangeRequestsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: REVOKE }));

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(patches()).toHaveLength(0);
  });

  it('NEGATIVE: is NOT drawn on the reader’s own request — nobody decides their own', async () => {
    serve([row({ isMine: true })]);
    render(<ChangeRequestsScreen />);

    await screen.findByText('ORD-2026-1584');
    expect(screen.queryByRole('button', { name: REVOKE })).toBeNull();
  });

  it('a row the server says cannot be carried out (an open trolley) says why, and its «نفِّذ» is shut', async () => {
    serve([row()]);
    render(<ChangeRequestsScreen />);

    expect(await screen.findByText(ON_TROLLEY_AR)).toBeTruthy();
    const carry = screen.getByRole('button', { name: 'نفِّذ القرار' }) as HTMLButtonElement;
    expect(carry.disabled).toBe(true);
    fireEvent.click(carry);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a row that can be carried out keeps its «نفِّذ» open, beside the take-back', async () => {
    serve([row({ carryOut: { kind: 'CANCEL_ORDER' } })]);
    render(<ChangeRequestsScreen />);

    const carry = (await screen.findByRole('button', { name: 'ألغِ الطلب' })) as HTMLButtonElement;
    expect(carry.disabled).toBe(false);
    expect(screen.getByRole('button', { name: REVOKE })).toBeTruthy();
    expect(screen.queryByText(ON_TROLLEY_AR)).toBeNull();
  });
});
