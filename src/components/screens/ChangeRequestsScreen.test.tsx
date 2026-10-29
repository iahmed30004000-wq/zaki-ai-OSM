// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * CONTRACT INVARIANT 7, THE HALF THAT HAD TO BE SEEN.
 *
 * A courier feed is never blocked by a change request — it flags it. The flag
 * is only worth writing if the person deciding reads it, and a guard that
 * looked for `r.changedDuringReview` in this file's source was satisfied by
 * `{false && r.changedDuringReview && …}`: the NAME was there and the chip
 * was not. That is the same defect this codebase has now caught six times —
 * a guard checking a name's presence instead of its use.
 *
 * So the chip is rendered, and read off the screen.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));

vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: vi.fn(),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/control/change-requests' }));
// The order number is an OrderLink now (it asks who is looking); these tests are not about who may open an order.
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => false }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useTell: () => vi.fn(),
}));

import { ChangeRequestsScreen } from './ChangeRequestsScreen';

/** A postponement raised on a parcel that is still in the warehouse. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'cr-1',
  reason: 'الزبون طلب تأجيل التسليم',
  status: 'PENDING',
  blocking: true,
  changedDuringReview: false,
  createdAt: '2026-10-01T10:00:00.000Z',
  slaDueAt: null,
  overdue: false,
  decisionNote: null,
  requestedByName: 'سارة',
  requestedRole: 'CONFIRMATION_AGENT',
  isMine: false,
  intent: 'POSTPONE',
  postponeUntil: '2026-10-05T00:00:00.000Z',
  cancelReason: null,
  carryOut: { kind: 'EDIT' },
  changes: {},
  order: {
    id: 'o1',
    orderNumber: 'SY-2026-0148',
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'PACKING',
    version: 3,
    customer: { fullName: 'سارة', phone: '0999' },
  },
  ...over,
});

const FLAG = 'تغيّرت حالة الطلب أثناء المراجعة';

function serve(pending: unknown[]) {
  apiJson.mockReset();
  apiJson.mockImplementation(async (url: string) =>
    url.includes('status=PENDING') ? { requests: pending } : { requests: [] }
  );
}

afterEach(cleanup);

describe('the review queue tells the decider the parcel moved', () => {
  it('draws the flag on a request the courier overtook', async () => {
    serve([row({ changedDuringReview: true })]);
    render(<ChangeRequestsScreen />);
    expect(await screen.findByText(FLAG)).toBeTruthy();
  });

  it('and draws nothing on one that nothing overtook', async () => {
    serve([row()]);
    render(<ChangeRequestsScreen />);
    // Wait for the list, then assert the absence — asserting it before the
    // fetch resolves would pass against an empty screen.
    expect(await screen.findByText('SY-2026-0148')).toBeTruthy();
    expect(screen.queryByText(FLAG)).toBeNull();
  });

  it('and the flag is not confused with the one that stops the pipeline', async () => {
    // Two different facts: «يوقف تقدّم الطلب» is about our own transitions,
    // the flag is about the courier's. A row can carry both.
    serve([row({ changedDuringReview: true, blocking: true })]);
    render(<ChangeRequestsScreen />);
    expect(await screen.findByText(FLAG)).toBeTruthy();
    expect(screen.getByText('يوقف تقدّم الطلب')).toBeTruthy();
  });
});
