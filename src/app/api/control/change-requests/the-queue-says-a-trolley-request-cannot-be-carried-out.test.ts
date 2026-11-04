import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * THE QUEUE SAYS WHAT PRESSING «نفِّذ» WOULD DO — AND ON AN OPEN TROLLEY, THAT IT WOULD DO NOTHING (the owner's ruling 4/11).
 *
 * `carryOut` is decided by the server for each row so the screen names the act on the button. A request whose order sits
 * on a trolley still being filled cannot be carried out by any door, so the row says REFUSED with the one sentence — the
 * screen shuts «نفِّذ» and leaves «تراجع عن الموافقة». A trolley named but unreadable is an open one; after the handover,
 * and off any trolley, the row says what it always said.
 */

const { db, requireContext } = vi.hoisted(() => ({
  db: {
    orderChangeRequest: { findMany: vi.fn() },
    user: { findMany: vi.fn(async () => []) },
    product: { findMany: vi.fn(async () => []) },
  },
  requireContext: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { ON_TROLLEY_AR } from '@/lib/order-seal';
import { GET } from './route';

async function supervisor(): Promise<SessionUser> {
  const base = { id: 'sup', email: 'sup@x', name: 'ريم', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () =>
        ['control.change_requests', 'control.change_requests_view'].map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => [],
    })
  );
}

const row = (intent: string, order: Record<string, unknown>) => ({
  id: `cr-${intent}`, requestedById: 'agent', intent, status: 'APPROVED', appliedAt: null, changes: {}, slaDueAt: null,
  order: {
    id: 'o1', orderNumber: 'ORD-2026-1584', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', version: 3,
    shippedAt: null, labelPrintedAt: null, customer: { fullName: 'سارة', phone: '0999' }, ...order,
  },
});

async function queue(order: Record<string, unknown>) {
  db.orderChangeRequest.findMany.mockResolvedValue(['EDIT', 'CANCEL', 'POSTPONE'].map((i) => row(i, order)) as never);
  const res = await GET(new Request('http://x/api/control/change-requests?status=AWAITING_APPLY'));
  return ((await res.json()) as { requests: { intent: string; carryOut: Record<string, unknown> }[] }).requests;
}

beforeEach(async () => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: await supervisor(), companyId: 'c1', storeId: 's1', country: { code: 'JO' } });
});

describe('what «نفِّذ» would do, per row', () => {
  it('on a READY trolley: REFUSED, with the one sentence and the code, for all three asks', async () => {
    const rows = await queue({ shippingBatchId: 'b1', shippingBatch: { status: 'READY' } });
    for (const r of rows) expect(r.carryOut, r.intent).toEqual({ kind: 'REFUSED', reason: ON_TROLLEY_AR, code: 'ON_OPEN_TROLLEY' });
  });

  it('on a trolley it names but nobody can read: the same (fail closed)', async () => {
    const rows = await queue({ shippingBatchId: 'b1', shippingBatch: null });
    for (const r of rows) expect(r.carryOut.code, r.intent).toBe('ON_OPEN_TROLLEY');
  });

  it('NEGATIVE: off any trolley, and after the handover, each ask is what it always was', async () => {
    const ours = await queue({ shippingBatchId: null, shippingBatch: null });
    expect(ours.map((r) => r.carryOut.kind)).toEqual(['EDIT_ORDER', 'CANCEL_ORDER', 'HOLD_SHIPMENT']);

    const gone = await queue({ shippingBatchId: 'b1', shippingBatch: { status: 'SHIPPED' } });
    expect(gone.map((r) => r.carryOut.kind)).toEqual(['EDIT_ORDER', 'CANCEL_VIA_COURIER', 'REFUSED']);
    expect(gone[2].carryOut).not.toHaveProperty('code');
  });
});
