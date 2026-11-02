import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORK_KINDS, kindsFor, visibleWork, type WorkItem, type WorkKey } from './my-work';
import { MISSION_COPY, missionFor } from './mission-card';
import { ICONS } from '@/components/shell/icons';

/**
 * «شغلك اليوم» HAD SIX KINDS, ALL ON THE ROAD'S MIDDLE AND END.
 *
 * Somebody with `ops.prepare` saw nothing of the warehouse's own list; a bookkeeper
 * with `settlement.review` nothing of the statements waiting on them; an agent nothing
 * of the orders whose day had come. Four kinds were added, each a count the owning
 * screen already shows — the card and the screen must agree to the digit, so each
 * count below is asked with the same condition the screen's door uses.
 *
 * Not added, and why (the plan listed five): «تنبيهات الخصم» is a REPORT, not a queue —
 * nothing is approved there, so its count could never reach zero, and a number that
 * cannot be cleared teaches people to stop reading the row.
 */

const { db, requireContext, perms } = vi.hoisted(() => ({
  db: {
    order: { count: vi.fn(), findMany: vi.fn() },
    orderIssue: { count: vi.fn() },
    courierStatement: { count: vi.fn() },
    orderChangeRequest: { count: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  perms: { has: new Set<string>() },
}));
vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: (...a: unknown[]) => requireContext(...a),
  ContextError: class extends Error {},
}));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, p: string) => perms.has.has(p) }));
vi.mock('@/lib/confirmation-queue', () => ({
  POSTPONE_LEAD_DAYS: 2,
  waitingCount: vi.fn(async () => 0),
  awaitingConfirmationCount: vi.fn(async () => 0),
}));

import { GET } from '@/app/api/me/work/route';

const may = (...p: string[]) => (x: string) => p.includes(x);
const keys = (ks: { key: WorkKey }[]) => ks.map((k) => k.key);
const ask = async (...p: string[]) => {
  perms.has = new Set(p);
  return ((await (await GET()).json()) as { items: WorkItem[] }).items;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u-me' }, companyId: 'co', storeId: 'st' });
  db.order.count.mockResolvedValue(7);
  db.order.findMany.mockResolvedValue([]);
  db.orderIssue.count.mockResolvedValue(3);
  db.courierStatement.count.mockResolvedValue(2);
  db.orderChangeRequest.count.mockResolvedValue(0);
  db.deliveryFee.findMany.mockResolvedValue([]);
});

describe('who sees which new number', () => {
  it('each permission opens exactly its own card', () => {
    expect(keys(kindsFor(may('ops.prepare')))).toEqual(['TO_PREPARE']);
    expect(keys(kindsFor(may('confirmation.issues')))).toEqual(['ISSUES_OPEN']);
    expect(keys(kindsFor(may('confirmation.work')))).toEqual(['POSTPONED_DUE']);
    expect(keys(kindsFor(may('settlement.review')))).toEqual(['STATEMENTS_OPEN']);
  });

  it('NEGATIVE: a permission next door opens none of them', () => {
    // viewing a statement is not reviewing it; a pull is not a desk
    expect(keys(kindsFor(may('settlement.view', 'finance.view', 'confirmation.pull', 'orders.view')))).toEqual(['CONFIRM_POOL']);
  });

  it('the postponed card opens the tab for an agent and «المتابعة» for a supervisor', () => {
    const href = (...p: string[]) => kindsFor(may(...p)).find((k) => k.key === 'POSTPONED_DUE')?.href;
    expect(href('confirmation.work')).toBe('/confirmation/mine?tab=postponed');
    expect(href('confirmation.supervise')).toBe('/confirmation/follow-up');
    expect(href('confirmation.work', 'confirmation.supervise')).toBe('/confirmation/follow-up');
  });

  it('every kind has distinct rank, words for the mission card, and an icon the shell has', () => {
    const ranks = WORK_KINDS.map((k) => k.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    for (const k of WORK_KINDS) {
      expect(MISSION_COPY[k.key], k.key).toBeDefined();
      expect(ICONS[k.icon as keyof typeof ICONS], `${k.key}: ${k.icon}`).toBeDefined();
    }
  });

  it('the old order of urgency is unchanged — the new kinds slot in, none jumps the queue', () => {
    const all = keys(kindsFor(() => true));
    const old = ['LATE_SHIPMENTS', 'CHANGE_REQUESTS', 'RETURNS_WAITING', 'READY_TO_SHIP', 'CONFIRM_POOL'];
    expect(all.filter((k) => old.includes(k))).toEqual(old);
  });

  it('a new kind with a door becomes the mission when it is the only work, and only for who may open it', () => {
    const item: WorkItem = { key: 'TO_PREPARE', ar: 'x', count: 4, href: '/ops/preparation', icon: 'PackageCheck', tone: 'normal' };
    expect(missionFor([item], () => true)?.cta).toBe('ابدأ التجهيز');
    expect(missionFor([item], () => false)).toBeNull();
    expect(visibleWork([{ ...item, count: 0 }], 3)).toEqual([]);
  });
});

describe('what each count asks', () => {
  const countOf = (items: WorkItem[], key: WorkKey) => items.find((i) => i.key === key)?.count;

  it('the warehouse: confirmed orders that have not left, the ones the preparation list is made of', async () => {
    const items = await ask('ops.prepare');
    expect(countOf(items, 'TO_PREPARE')).toBe(7);
    expect(db.order.count.mock.calls[0][0].where).toEqual({
      companyId: 'co', storeId: 'st', confirmationStatus: 'CONFIRMED', shippingStatus: { in: ['NOT_READY', 'PACKING'] }, items: { some: {} },
    });
  });

  it('the issues: the open ones of THIS store, as the issues list reads them', async () => {
    const items = await ask('confirmation.issues');
    expect(countOf(items, 'ISSUES_OPEN')).toBe(3);
    expect(db.orderIssue.count.mock.calls[0][0].where).toEqual({ companyId: 'co', status: 'OPEN', order: { storeId: 'st' } });
  });

  // (Was: not approved by either mark of approval. Since 2/11 the approval posts the money and a statement whose lines
  // are still a question keeps its matching open — that is still work, until «إغلاق المطابقة».)
  it('the statements: open until their matching is closed', async () => {
    const items = await ask('settlement.review');
    expect(countOf(items, 'STATEMENTS_OPEN')).toBe(2);
    expect(db.courierStatement.count.mock.calls[0][0].where).toEqual({
      companyId: 'co', storeId: 'st', matchingClosedAt: null,
    });
  });

  it('the postponed: an AGENT counts only her own', async () => {
    await ask('confirmation.work');
    const where = db.order.count.mock.calls[0][0].where;
    expect(where.claimedById).toBe('u-me');
    expect(where.companyId).toBe('co');
    expect(where.confirmationStatus).toEqual({ in: ['POSTPONED', 'FOLLOW_UP_REQUIRED'] });
    expect(JSON.stringify(where.AND)).toContain('postponedUntil');
  });

  it('the postponed: a SUPERVISOR counts everybody’s', async () => {
    await ask('confirmation.supervise');
    expect(db.order.count.mock.calls[0][0].where.claimedById).toBeUndefined();
  });

  it('NEGATIVE: nobody pays for a number they are not shown — no permission, no query', async () => {
    const items = await ask('finance.view');
    expect(items).toEqual([]);
    expect(db.order.count).not.toHaveBeenCalled();
    expect(db.orderIssue.count).not.toHaveBeenCalled();
    expect(db.courierStatement.count).not.toHaveBeenCalled();
  });

  it('and one permission asks only its own question', async () => {
    await ask('settlement.review');
    expect(db.order.count).not.toHaveBeenCalled();
    expect(db.orderIssue.count).not.toHaveBeenCalled();
  });

  it('a huge number is «999», the server’s ceiling', async () => {
    db.orderIssue.count.mockResolvedValue(5000);
    expect(countOf(await ask('confirmation.issues'), 'ISSUES_OPEN')).toBe(999);
  });
});
