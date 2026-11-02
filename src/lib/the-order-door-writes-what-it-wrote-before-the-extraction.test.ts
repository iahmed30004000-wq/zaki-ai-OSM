import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '@/types/auth';
import { stripComments } from './guard-source';
import { can } from './authorization';
import { SHIPPING_STATUSES, STATUS_TIMESTAMP, type ShippingStatus } from './shipping-workflow';

vi.mock('./db', () => ({ db: {}, default: {} }));

import { editLockHeldByAnother, recordShippingMove, shippingAuditEntry, shippingMoveColumns } from './shipping-move';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * BEFORE AND AFTER — the order's own shipping door writes what it wrote before the extraction (2/11).
 *
 * Four blocks of `/api/orders/[id]/shipping` moved into `shipping-move.ts` so the batch's «خرج للتوصيل لكل الدفعة» writes the same
 * trace. The door's behaviour must not change. Each block is copied below AS IT WAS in the door before the move (main d708e6f9),
 * word for word, and run beside the shared function on every input that matters: every status, every note, every lock, every
 * courier. The two must agree on all of them — a difference is a change to the order's door, whatever the reason.
 *
 * The door's own call sites are pinned too (section 5): the arguments it hands the functions are the expressions the old blocks
 * read, so «the same function» is also «the same inputs».
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;
const NOW = new Date('2026-11-02T10:15:00.000Z');

/* ───────────── the four blocks, verbatim from the door before the extraction (d708e6f9) ───────────── */

/** route.ts ~347–358 (the `transition` case): the status, its stamp and the legacy `status` sync. */
function beforeColumns(updateData: Row, newShippingStatus: ShippingStatus, now: Date): Row {
  updateData.shippingStatus = newShippingStatus;
  // Server-set timestamp (never client)
  const tsField = STATUS_TIMESTAMP[newShippingStatus];
  if (tsField) updateData[tsField] = now;
  // Legacy combined status sync for list compatibility
  if (newShippingStatus === 'SHIPPED') updateData.status = 'SHIPPED';
  if (newShippingStatus === 'DELIVERED') {
    updateData.status = 'DELIVERED';
    // Match the legacy PATCH behavior: delivery marks the COD collected
    updateData.settlementStatus = 'COLLECTED';
  }
  if (newShippingStatus === 'RETURNED') updateData.status = 'RETURNED';
  return updateData;
}

interface DoorFacts {
  companyId: string;
  id: string;
  from: string;
  newShippingStatus: string;
  user: { id: string; name: string; role: string };
  shippingNote?: string;
  deliveryFailureReason?: string;
  returnReason?: string;
  deliveryProviderId?: string;
  order: { deliveryProviderId: string | null; trackingNumber: string | null };
  action: string;
}

/** route.ts ~627–645: the timeline line and the activity row, written on `db` after the save. */
async function beforeLogs(db: FakeDb, f: DoorFacts) {
  const { companyId, id, from, newShippingStatus, user, shippingNote, deliveryFailureReason, returnReason, deliveryProviderId, order } = f;
  await db.orderStatusLog.create({
    data: {
      companyId, orderId: id, statusType: 'SHIPPING',
      previousValue: from, newValue: newShippingStatus,
      changedById: user.id, changedByRole: user.role,
      note: shippingNote?.trim() || deliveryFailureReason || returnReason || null,
    },
  });
  await db.orderActivity.create({
    data: {
      companyId, orderId: id, userId: user.id,
      action: 'SHIPPING_STATUS_CHANGED', previousStatus: from, newStatus: newShippingStatus,
      metadata: JSON.stringify({
        by: user.name, role: user.role,
        provider: deliveryProviderId || order.deliveryProviderId || null,
        note: shippingNote || null,
      }),
    },
  });
}

/** route.ts ~676–682: the argument of `logAudit`. */
function beforeAudit(f: { companyId: string; userId: string; id: string; from: string; newShippingStatus: string | null | undefined; trackingNumber: string | null; action: string; by: string }) {
  const { companyId, id, from, newShippingStatus, action } = f;
  return {
    companyId, userId: f.userId,
    action: newShippingStatus ? 'SHIPPING_STATUS_CHANGED' : 'SHIPPING_INFO_UPDATED',
    entity: 'Order', entityId: id,
    previousData: { shippingStatus: from, trackingNumber: f.trackingNumber },
    newData: { shippingStatus: newShippingStatus, action, by: f.by },
  };
}

/** route.ts ~104–108: is the order locked against this person? */
function beforeLocked(order: { lockedById?: string | null; lockExpiresAt?: Date | string | null }, user: SessionUser): boolean {
  const lockActive =
    order.lockedById &&
    order.lockExpiresAt &&
    new Date(order.lockExpiresAt).getTime() > Date.now();
  return !!(lockActive && order.lockedById !== user.id && !can(user, 'orders.unlock'));
}

/* ─────────────────────────────── a recording db ─────────────────────────────── */

type FakeDb = { orderStatusLog: { create: (a: { data: Row }) => Promise<Row> }; orderActivity: { create: (a: { data: Row }) => Promise<Row> } };
function recorder() {
  const calls: [string, Row][] = [];
  const db: FakeDb = {
    orderStatusLog: { create: async (a) => { calls.push(['orderStatusLog', a.data]); return {}; } },
    orderActivity: { create: async (a) => { calls.push(['orderActivity', a.data]); return {}; } },
  };
  return { db, calls };
}

const person = (keys: string[], id = 'u1'): SessionUser =>
  ({
    id, email: 'q@z.test', name: 'قبس', role: 'WAREHOUSE', status: 'ACTIVE', companyId: 'c1', permissions: keys,
    effectiveGrants: { fullAccess: false, grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])) },
  }) as unknown as SessionUser;

/* ═════════════════════════════════════ 1 · COLUMNS ═════════════════════════════════════ */

describe('1 · the columns of a move: every status, on top of whatever the case already put in the write', () => {
  // What the `transition` case may have written before the block ran: nothing, a reason, a note, or a stale status.
  const already: Row[] = [
    {},
    { returnReason: 'DAMAGED_PRODUCT' },
    { deliveryFailureReason: 'WRONG_ADDRESS', shippingNote: 'ما رد' },
    { status: 'CONFIRMED', settlementStatus: 'PENDING_COLLECTION', version: { increment: 1 } },
  ];

  for (const to of SHIPPING_STATUSES) {
    it(`${to}: the same write, key for key`, () => {
      for (const pre of already) {
        const old = beforeColumns(structuredClone(pre), to, NOW);
        const now = Object.assign(structuredClone(pre), shippingMoveColumns(to, NOW));
        expect(now).toEqual(old);
        expect(Object.keys(now).sort()).toEqual(Object.keys(old).sort());
      }
    });
  }

  it('the sweep is not empty: some statuses stamp, some sync the legacy status, one marks the COD collected', () => {
    const writes = SHIPPING_STATUSES.map((to) => shippingMoveColumns(to, NOW));
    expect(writes.filter((w) => Object.values(w).includes(NOW)).length).toBeGreaterThan(4);
    expect(writes.filter((w) => 'status' in w)).toHaveLength(3);
    expect(writes.filter((w) => w.settlementStatus === 'COLLECTED')).toHaveLength(1);
  });
});

/* ═════════════════════════════════════ 2 · ROWS ═════════════════════════════════════ */

describe('2 · the timeline line and the activity row: every note, reason and courier the door can hand over', () => {
  const notes = [undefined, '', '   ', '  طرد مكسور  '];
  const failures = [undefined, 'CUSTOMER_NOT_AVAILABLE'];
  const returns = [undefined, 'CUSTOMER_REFUSED'];
  const typedProviders = [undefined, '', 'dp2'];
  const orderProviders = [null, 'dp1'];
  const moves: [string, string][] = [['SHIPPED', 'OUT_FOR_DELIVERY'], ['OUT_FOR_DELIVERY', 'FAILED_DELIVERY'], ['FAILED_DELIVERY', 'RETURNED'], ['READY_FOR_PICKUP', 'SHIPPED']];

  const facts: DoorFacts[] = [];
  for (const [from, to] of moves)
    for (const shippingNote of notes)
      for (const deliveryFailureReason of failures)
        for (const returnReason of returns)
          for (const deliveryProviderId of typedProviders)
            for (const providerOnOrder of orderProviders)
              facts.push({
                companyId: 'c1', id: 'o1', from, newShippingStatus: to,
                user: { id: 'u1', name: 'قبس', role: 'WAREHOUSE' },
                shippingNote, deliveryFailureReason, returnReason, deliveryProviderId,
                order: { deliveryProviderId: providerOnOrder, trackingNumber: 'T-1' },
                action: 'transition',
              });

  it(`the same two rows, in the same order, for all ${facts.length} combinations`, async () => {
    expect(facts.length).toBe(4 * 4 * 2 * 2 * 3 * 2);
    for (const f of facts) {
      const a = recorder();
      await beforeLogs(a.db, f);
      const b = recorder();
      // The call the door makes now — its arguments pinned to the door's source in section 5.
      await recordShippingMove(b.db as never, {
        companyId: f.companyId, orderId: f.id, from: f.from, to: f.newShippingStatus,
        user: { id: f.user.id, name: f.user.name, role: f.user.role },
        logNote: f.shippingNote?.trim() || f.deliveryFailureReason || f.returnReason || null,
        typedNote: f.shippingNote || null,
        provider: f.deliveryProviderId || f.order.deliveryProviderId || null,
      });
      expect(b.calls, JSON.stringify(f)).toEqual(a.calls);
      expect(a.calls).toHaveLength(2);
    }
  });
});

/* ═════════════════════════════════════ 3 · AUDIT ═════════════════════════════════════ */

describe('3 · the audit row: a status that changed, and every other action of the door', () => {
  const tos: (string | null | undefined)[] = [undefined, null, ...SHIPPING_STATUSES];
  const actions = ['transition', 'assign_provider', 'assign_batch', 'update_tracking'];
  const tracking = [null, 'T-1'];

  it('the same argument to `logAudit` for every status (and none), action and barcode', () => {
    let n = 0;
    for (const to of tos)
      for (const action of actions)
        for (const trackingNumber of tracking) {
          const old = beforeAudit({ companyId: 'c1', userId: 'u1', id: 'o1', from: 'SHIPPED', newShippingStatus: to, trackingNumber, action, by: 'قبس' });
          const now = shippingAuditEntry({
            companyId: 'c1', userId: 'u1', orderId: 'o1', from: 'SHIPPED', to: to as string | null, trackingNumber, action, by: 'قبس',
          });
          expect(now, `${to} ${action} ${trackingNumber}`).toEqual(old);
          n++;
        }
    expect(n).toBe(tos.length * actions.length * tracking.length);
  });
});

/* ═════════════════════════════════════ 4 · LOCK ═════════════════════════════════════ */

describe('4 · the edit lock: every holder, every expiry, with and without the key that breaks locks', () => {
  const soon = new Date(Date.now() + 10 * 60_000);
  const gone = new Date(Date.now() - 10 * 60_000);
  const holders = [null, undefined, 'u1', 'u2'];
  const expiries: (Date | string | null | undefined)[] = [null, undefined, soon, gone, soon.toISOString(), gone.toISOString()];
  const users = [person(['orders.change_status']), person(['orders.change_status', 'orders.unlock'])];

  it('the same answer on the whole grid — and the grid has both answers in it', () => {
    const answers = new Set<boolean>();
    for (const lockedById of holders)
      for (const lockExpiresAt of expiries)
        for (const user of users) {
          const order = { lockedById, lockExpiresAt };
          const old = beforeLocked(order, user);
          expect(editLockHeldByAnother(order, user), JSON.stringify({ order, unlock: can(user, 'orders.unlock') })).toBe(old);
          answers.add(old);
        }
    expect([...answers].sort()).toEqual([false, true]);
  });
});

/* ═════════════════════════════════════ 5 · THE DOOR'S CALLS ═════════════════════════════════════ */

describe('5 · the door hands the shared functions what the old blocks read', () => {
  const door = stripComments(readFileSync(join(process.cwd(), 'src/app/api/orders/[id]/shipping/route.ts'), 'utf8'));
  const flat = door.replace(/\s+/g, ' ');

  it('the columns: merged into the same write, with the same status and clock', () => {
    expect(flat).toContain('Object.assign(updateData, shippingMoveColumns(newShippingStatus, now));');
  });

  it('the rows: the same notes and courier, on `db`, only when the status really changed', () => {
    const call = flat.slice(flat.indexOf('if (newShippingStatus && newShippingStatus !== from) { await recordShippingMove(db, {'));
    expect(call.length, 'the call is not under the «status changed» test any more').toBeLessThan(flat.length);
    const args = call.slice(0, call.indexOf('});'));
    expect(args).toContain('companyId, orderId: id, from, to: newShippingStatus,');
    expect(args).toContain('user: { id: user.id, name: user.name, role: user.role },');
    expect(args).toContain('logNote: shippingNote?.trim() || deliveryFailureReason || returnReason || null,');
    expect(args).toContain('typedNote: shippingNote || null,');
    expect(args).toContain('provider: deliveryProviderId || order.deliveryProviderId || null,');
  });

  it('the audit row: the same facts', () => {
    expect(flat).toContain(
      'await logAudit(shippingAuditEntry({ companyId, userId: user.id, orderId: id, from, to: newShippingStatus, trackingNumber: order.trackingNumber, action, by: user.name, }));'
    );
  });

  it('the lock: asked of the loaded order and the person, before the body is read', () => {
    const lock = flat.indexOf('if (editLockHeldByAnother(order, user)) {');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(flat.indexOf('const body = await req.json();'));
  });
});
