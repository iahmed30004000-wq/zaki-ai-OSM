import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import { SHIPPING_STATUSES, STATUS_TIMESTAMP, type ShippingStatus } from './shipping-workflow';

vi.mock('./db', () => ({ db: {}, default: {} }));

import { editLockHeldByAnother, recordShippingMove, shippingAuditEntry, shippingMoveColumns } from './shipping-move';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the move of a shipping status is written in ONE place.
 *
 * The order's own door and the batch's «خرج للتوصيل لكل الدفعة» move a status by a person's press, and they must leave the same
 * trace. These are the four pieces both of them call, tested alone: what the move writes on the order, the two rows it leaves on
 * the order's history, the audit row's content, and the edit-lock rule. The two doors' own tests prove they call them;
 * `the-batch-door-moves-what-the-order-door-moves.test.ts` proves the traces are equal by running both.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-02T10:15:00.000Z');

describe('shippingMoveColumns — what a move writes on the order', () => {
  it('OUT_FOR_DELIVERY: the status and the server’s stamp, and nothing else', () => {
    expect(shippingMoveColumns('OUT_FOR_DELIVERY', NOW)).toEqual({ shippingStatus: 'OUT_FOR_DELIVERY', outForDeliveryAt: NOW });
  });

  const expected: [ShippingStatus, Record<string, unknown>][] = [
    ['SHIPPED', { shippingStatus: 'SHIPPED', shippedAt: NOW, status: 'SHIPPED' }],
    ['DELIVERED', { shippingStatus: 'DELIVERED', deliveredAt: NOW, status: 'DELIVERED', settlementStatus: 'COLLECTED' }],
    ['PARTIALLY_DELIVERED', { shippingStatus: 'PARTIALLY_DELIVERED', deliveredAt: NOW }],
    ['FAILED_DELIVERY', { shippingStatus: 'FAILED_DELIVERY', failedAt: NOW }],
    ['RETURNED', { shippingStatus: 'RETURNED', returnedAt: NOW, status: 'RETURNED' }],
    ['PACKING', { shippingStatus: 'PACKING' }],
    ['READY_FOR_PICKUP', { shippingStatus: 'READY_FOR_PICKUP' }],
    ['RETURN_REQUESTED', { shippingStatus: 'RETURN_REQUESTED' }],
  ];
  it.each(expected)('%s writes exactly what the order’s door has always written for it', (to, columns) => {
    expect(shippingMoveColumns(to, NOW)).toEqual(columns);
  });

  it('the stamp column of every status is the one `STATUS_TIMESTAMP` names — one table, not a copy', () => {
    for (const to of SHIPPING_STATUSES) {
      const columns = shippingMoveColumns(to, NOW);
      const stamp = STATUS_TIMESTAMP[to];
      if (stamp) expect(columns[stamp], `${to} → ${stamp}`).toBe(NOW);
      else expect(Object.keys(columns).filter((k) => /At$/.test(k)), `${to} stamps nothing`).toEqual([]);
    }
  });

  it('the clock is the caller’s, and the version is not written here (each door steps it in its own write)', () => {
    const later = new Date('2026-11-03T00:00:00.000Z');
    expect(shippingMoveColumns('OUT_FOR_DELIVERY', later).outForDeliveryAt).toBe(later);
    for (const to of SHIPPING_STATUSES) expect(shippingMoveColumns(to, NOW)).not.toHaveProperty('version');
  });
});

describe('recordShippingMove — the two rows a move leaves on the order’s history', () => {
  const user = { id: 'u1', name: 'قبس', role: 'WAREHOUSE' };
  const input = {
    companyId: 'c1', orderId: 'o1', from: 'SHIPPED', to: 'OUT_FOR_DELIVERY', user,
    logNote: 'خرجت الدفعة BATCH-1 للتوصيل', typedNote: null as string | null, provider: 'dp1' as string | null,
  };
  const fakeTx = () => {
    const calls: { model: string; data: Record<string, unknown> }[] = [];
    const tx = {
      orderStatusLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { calls.push({ model: 'orderStatusLog', data }); }) },
      orderActivity: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { calls.push({ model: 'orderActivity', data }); }) },
    };
    return { tx: tx as never, calls };
  };

  it('writes the timeline line first, then the activity row, through the transaction it is given', async () => {
    const { tx, calls } = fakeTx();
    await recordShippingMove(tx, input);

    expect(calls.map((c) => c.model)).toEqual(['orderStatusLog', 'orderActivity']);
    expect(calls[0].data).toEqual({
      companyId: 'c1', orderId: 'o1', statusType: 'SHIPPING',
      previousValue: 'SHIPPED', newValue: 'OUT_FOR_DELIVERY',
      changedById: 'u1', changedByRole: 'WAREHOUSE',
      note: 'خرجت الدفعة BATCH-1 للتوصيل',
    });
    expect(calls[1].data).toMatchObject({
      companyId: 'c1', orderId: 'o1', userId: 'u1',
      action: 'SHIPPING_STATUS_CHANGED', previousStatus: 'SHIPPED', newStatus: 'OUT_FOR_DELIVERY',
    });
    expect(JSON.parse(calls[1].data.metadata as string)).toEqual({ by: 'قبس', role: 'WAREHOUSE', provider: 'dp1', note: null });
  });

  it('keeps the timeline note and the typed note apart (the order’s door always has)', async () => {
    const { tx, calls } = fakeTx();
    await recordShippingMove(tx, { ...input, logNote: 'سبب', typedNote: 'ملاحظة كتبتها', provider: null });
    expect(calls[0].data.note).toBe('سبب');
    expect(JSON.parse(calls[1].data.metadata as string)).toEqual({ by: 'قبس', role: 'WAREHOUSE', provider: null, note: 'ملاحظة كتبتها' });
  });

  it('a failure of the first write stops the second — no activity row for a move whose line was not written', async () => {
    const tx = {
      orderStatusLog: { create: vi.fn(async () => { throw new Error('dropped'); }) },
      orderActivity: { create: vi.fn() },
    };
    await expect(recordShippingMove(tx as never, input)).rejects.toThrow('dropped');
    expect(tx.orderActivity.create).not.toHaveBeenCalled();
  });
});

describe('shippingAuditEntry — the audit row of a shipping action', () => {
  const base = { companyId: 'c1', userId: 'u1', orderId: 'o1', from: 'SHIPPED', trackingNumber: 'BSH-1', action: 'transition', by: 'قبس' };

  it('a status that changed: «تغيير حالة الشحن», with the order before and after', () => {
    expect(shippingAuditEntry({ ...base, to: 'OUT_FOR_DELIVERY' })).toEqual({
      companyId: 'c1', userId: 'u1', action: 'SHIPPING_STATUS_CHANGED', entity: 'Order', entityId: 'o1',
      previousData: { shippingStatus: 'SHIPPED', trackingNumber: 'BSH-1' },
      newData: { shippingStatus: 'OUT_FOR_DELIVERY', action: 'transition', by: 'قبس' },
    });
  });

  it('anything else the door was asked to do (a courier, a batch, a barcode): «تعديل معلومات الشحن», the status null', () => {
    const entry = shippingAuditEntry({ ...base, to: null, action: 'assign_batch' });
    expect(entry.action).toBe('SHIPPING_INFO_UPDATED');
    expect(entry.newData).toEqual({ shippingStatus: null, action: 'assign_batch', by: 'قبس' });
  });
});

describe('editLockHeldByAnother — somebody else is editing it right now', () => {
  const grants = (keys: string[]): SessionUser =>
    ({
      id: 'me', email: 'me@x', name: 'أنا', role: 'WAREHOUSE', status: 'ACTIVE', companyId: 'c1', permissions: keys,
      effectiveGrants: { fullAccess: false, grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])) },
    }) as unknown as SessionUser;
  const plain = grants(['orders.change_status']);
  const breaker = grants(['orders.change_status', 'orders.unlock']);
  const later = new Date(Date.now() + 5 * 60_000);
  const earlier = new Date(Date.now() - 5 * 60_000);

  it('another person’s active lock blocks, unless the one moving may break locks', () => {
    expect(editLockHeldByAnother({ lockedById: 'other', lockExpiresAt: later }, plain)).toBe(true);
    expect(editLockHeldByAnother({ lockedById: 'other', lockExpiresAt: later }, breaker)).toBe(false);
  });

  it('her own lock, an expired lock, a lock with no end and no lock at all block nobody', () => {
    expect(editLockHeldByAnother({ lockedById: 'me', lockExpiresAt: later }, plain)).toBe(false);
    expect(editLockHeldByAnother({ lockedById: 'other', lockExpiresAt: earlier }, plain)).toBe(false);
    expect(editLockHeldByAnother({ lockedById: 'other', lockExpiresAt: null }, plain)).toBe(false);
    expect(editLockHeldByAnother({ lockedById: null, lockExpiresAt: later }, plain)).toBe(false);
    expect(editLockHeldByAnother({}, plain)).toBe(false);
  });

  it('an expiry that arrives as text (a JSON read) is still an expiry', () => {
    expect(editLockHeldByAnother({ lockedById: 'other', lockExpiresAt: later.toISOString() }, plain)).toBe(true);
    expect(editLockHeldByAnother({ lockedById: 'other', lockExpiresAt: earlier.toISOString() }, plain)).toBe(false);
  });
});
