import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/stock-transfers.memory-db.test';

/**
 * «بدّو إياك هلق» COUNTS A TRANSFER THAT NEEDS SOMEBODY (the warehouse plan, request W3c).
 *
 * On the road for more than a store day, or received short with the difference not approved — counted by the real work
 * door over the in-memory database of the transfer tests, which judges the `where` itself (so WHICH transfers count is the
 * code's answer, not the fake's). Who sees the card is decided by the real `can` over persons built by
 * `computeEffectiveGrants` (role rows, a personal DENY, a roleId-null legacy account) — never by a hand-written key list.
 */

const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  m: null as unknown as { db: Record<string, unknown>; data: Record<string, Row[]> },
  timezone: 'Asia/Amman',
}));

vi.mock('@/lib/db', () => {
  const zero = { count: async () => 0, findMany: async () => [] };
  const extra: Row = { order: zero, orderIssue: zero, courierStatement: zero, orderChangeRequest: zero, deliveryFee: zero };
  const db = new Proxy({} as Row, { get: (_t, prop: string) => (prop in extra ? extra[prop] : (S.m.db as Row)[prop]) });
  return { db, default: db };
});
vi.mock('@/lib/geo-context', async (orig) => {
  const real = await orig<typeof import('@/lib/geo-context')>();
  return {
    ...real,
    requireContext: async () => ({ user: S.current, companyId: 'c1', storeId: 's1', country: { timezone: S.timezone, workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [] } }),
  };
});
vi.mock('@/lib/confirmation-queue', () => ({
  POSTPONE_LEAD_DAYS: 2,
  readReturnsMode: async () => null,
  waitingCount: async () => 0,
  awaitingConfirmationCount: async () => 0,
}));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants, type GrantSource } from '@/lib/permissions-core';
import { memoryDb } from '@/lib/stock-transfers.memory-db.test';
import { oneStoreDayBefore, stuckTransfersWhere } from '@/lib/stock-transfer-watch';
import { GET } from './route';

const HOUR = 3_600_000;
const ROLES: Record<string, string[]> = {
  'r-approver': ['inventory.view', 'inventory.difference_approve'],
  'r-all': ['inventory.view', 'inventory.transfer', 'inventory.transfer_receive', 'inventory.difference_approve'],
  'r-movers': ['inventory.view', 'inventory.transfer', 'inventory.transfer_receive'],
  'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
};
const DENIES: Record<string, string[]> = { 'u-denied': ['inventory.difference_approve'] };
const source: GrantSource = {
  roleRows: async (u) => (ROLES[u.roleId ?? `template:${u.role}`] ?? []).map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
  overrideRows: async (id) => (DENIES[id] ?? []).map((permission) => ({ permission, effect: 'DENY', scope: 'ALL_COMPANY', scopeIds: null })),
};
async function as(id: string, role: string, roleId: string | null) {
  S.current = attachGrants(
    { id, name: id, email: `${id}@test.local`, role, status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser,
    await computeEffectiveGrants({ id, role, roleId }, source)
  );
}
const card = async () => {
  const items = ((await (await GET()).json()) as { items: { key: string; count: number; href: string | null; tone: string }[] }).items;
  return items.find((i) => i.key === 'TRANSFERS_STUCK');
};

const t = (id: string, over: Row): Row => ({
  id, companyId: 'c1', storeId: 's1', kind: 'INTERNAL', fromWarehouseId: 'wA', toWarehouseId: 'wB', status: 'SENT',
  sentById: 'u-x', sentAt: new Date(), differenceApprovedAt: null, ...over,
});

beforeEach(() => {
  S.timezone = 'Asia/Amman';
  const now = Date.now();
  S.m = memoryDb({
    stockTransfer: [
      t('sent-25h', { sentAt: new Date(now - 25 * HOUR) }),
      t('sent-23h', { sentAt: new Date(now - 23 * HOUR) }),
      t('short-open', { status: 'RECEIVED_WITH_DIFFERENCE', sentAt: new Date(now - 2 * HOUR) }),
      t('short-approved', { status: 'RECEIVED_WITH_DIFFERENCE', sentAt: new Date(now - 90 * HOUR), differenceApprovedAt: new Date(now - HOUR) }),
      t('cancelled-old', { status: 'CANCELLED', sentAt: new Date(now - 90 * HOUR) }),
      t('received-old', { status: 'RECEIVED', sentAt: new Date(now - 90 * HOUR) }),
      t('other-store', { storeId: 's2', sentAt: new Date(now - 90 * HOUR) }),
      t('other-company', { companyId: 'c2', sentAt: new Date(now - 90 * HOUR) }),
    ],
  }) as never;
});

describe('what is counted', () => {
  it('on the road past a store day, and short with the difference unapproved — of THIS store and company only', async () => {
    await as('u-owner', 'SUPER_ADMIN', null);
    const c = await card();
    expect(c?.count).toBe(2);
    expect(c?.href).toBe('/inventory/transfers');
    expect(c?.tone).toBe('urgent');
  });

  it('NEGATIVE: under a day on the road is not stuck; once it passes the day it is', async () => {
    await as('u-owner', 'SUPER_ADMIN', null);
    S.m.data.stockTransfer = S.m.data.stockTransfer.filter((r) => r.id === 'sent-23h');
    expect((await card())?.count).toBe(0);
    S.m.data.stockTransfer[0].sentAt = new Date(Date.now() - 24 * HOUR - 60_000);
    expect((await card())?.count).toBe(1);
  });

  it('NEGATIVE: received in full, cancelled, or short and approved — none of them is work', async () => {
    await as('u-owner', 'SUPER_ADMIN', null);
    S.m.data.stockTransfer = S.m.data.stockTransfer.filter((r) => ['short-approved', 'cancelled-old', 'received-old'].includes(r.id));
    expect((await card())?.count).toBe(0);
  });
});

describe('who sees it — persons built as a session builds them', () => {
  it('whoever approves the differences: the owner, an approver role, a role holding every transfer key', async () => {
    for (const [id, role, roleId] of [['u-owner', 'SUPER_ADMIN', null], ['u-approver', 'CUSTOM', 'r-approver'], ['u-all', 'CUSTOM', 'r-all']] as const) {
      await as(id, role, roleId);
      expect((await card())?.count, id).toBe(2);
    }
  });

  it('NEGATIVE: the sender and the receiver keys alone, a personal DENY, a legacy keeper — no card', async () => {
    for (const [id, role, roleId] of [['u-movers', 'CUSTOM', 'r-movers'], ['u-denied', 'CUSTOM', 'r-all'], ['u-legacy', 'WAREHOUSE', null]] as const) {
      await as(id, role, roleId);
      expect(await card(), id).toBeUndefined();
    }
  });
});

describe('a day is the store’s day', () => {
  it('in a fixed-offset country it is the same moment yesterday — 24 hours', () => {
    const now = new Date('2026-11-20T10:00:00Z');
    expect(now.getTime() - oneStoreDayBefore(now, 'Asia/Amman').getTime()).toBe(24 * HOUR);
  });

  it('across a night the clocks move forward it is the same wall-clock time yesterday — 23 hours, not 24', () => {
    // Berlin moves 02:00 → 03:00 on 29 March 2026; noon on the 29th is 10:00Z, noon on the 28th was 11:00Z.
    const now = new Date('2026-03-29T10:00:00Z');
    expect(oneStoreDayBefore(now, 'Europe/Berlin').toISOString()).toBe('2026-03-28T11:00:00.000Z');
  });

  it('on the first of a month it reaches back into the month before', () => {
    expect(oneStoreDayBefore(new Date('2026-12-01T09:30:00Z'), 'UTC').toISOString()).toBe('2026-11-30T09:30:00.000Z');
  });

  it('the door reads the clock in the STORE’s timezone, not the server’s', async () => {
    const where = stuckTransfersWhere({ companyId: 'c1', storeId: 's1' }, new Date('2026-03-29T10:00:00Z'), 'Europe/Berlin');
    expect(where.OR[0]).toEqual({ status: 'SENT', sentAt: { lt: new Date('2026-03-28T11:00:00.000Z') } });

    // Sent 23½ hours before the Berlin noon after the clocks moved: past ONE BERLIN DAY (the wall clock read 11:30 the day
    // before, then 12:00 now), short of 24 hours. The store's day says stuck; a 24-hour clock would not.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-29T10:00:00Z'));
    try {
      S.m.data.stockTransfer = [t('dst', { sentAt: new Date('2026-03-28T10:30:00Z') })];
      await as('u-owner', 'SUPER_ADMIN', null);
      S.timezone = 'Europe/Berlin';
      expect((await card())?.count).toBe(1);
      S.timezone = 'UTC';
      expect((await card())?.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
