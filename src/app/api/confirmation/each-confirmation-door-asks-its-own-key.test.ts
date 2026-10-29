import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EACH CONFIRMATION DOOR ASKS ITS OWN KEY (perm-plan PR-7).
 *
 *   winback POST          confirmation.supervise → confirmation.winback      (the list keeps supervise; it says `canOffer`)
 *   postponed POST        a COLLEAGUE'S order: supervise → confirmation.reassign   (her own needs nothing more; `mayHandBack`)
 *   issues POST           confirmation.issues → confirmation.raise_issue     (the list keeps issues)
 *   issues/[id] PATCH     "correct": confirmation.issues → confirmation.issues_correct   (the void keeps orders.cancel)
 *
 * Through the REAL engine. The same questions at each door: the new key → past the gate; the OLD key alone → 403 and nothing
 * touched; the new key alone → past the gate (it asks only itself — the catalog says what it sits behind, not the door);
 * a «منع» on the new key beats a role that carries it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, current } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderIssue: { findFirst: vi.fn(), findMany: vi.fn(async () => []), update: vi.fn(), create: vi.fn() },
    orderStatusLog: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  current: { user: null as unknown as SessionUser },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn() }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: vi.fn(async () => ({ allowed: false })) }));
vi.mock('@/lib/winback-rule', async (orig) => ({
  ...(await orig<typeof import('@/lib/winback-rule')>()),
  winbackRule: vi.fn(async () => (await import('@/lib/winback')).DEFAULT_WINBACK_RULE),
}));
vi.mock('@/lib/winback-list', async (orig) => ({
  ...(await orig<typeof import('@/lib/winback-list')>()),
  readWinbackPage: vi.fn(async () => ({ rows: [], total: 0, page: 1, limit: 25, totalPages: 1 })),
  winbackFacts: vi.fn(async () => ({})),
}));
vi.mock('@/lib/postponed-list', async (orig) => ({
  ...(await orig<typeof import('@/lib/postponed-list')>()),
  readPostponedPage: vi.fn(async () => ({
    rows: [
      { id: 'mine', claimedById: 'u1', postponedUntil: new Date('2026-11-01'), nextFollowUpAt: null, customer: null },
      { id: 'hers', claimedById: 'someone-else', postponedUntil: new Date('2026-11-01'), nextFollowUpAt: null, customer: null },
    ],
    total: 2, page: 1, limit: 25, totalPages: 1,
  })),
  postponedFacts: vi.fn(async () => ({})),
}));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { GET as winbackGET, POST as winbackPOST } from './winback/route';
import { GET as postponedGET, POST as postponedPOST } from './postponed/route';
import { GET as issuesGET, POST as issuesPOST } from './issues/route';
import { PATCH as issuePATCH } from './issues/[id]/route';

async function person(roleKeys: string[], deny: string[] = []): Promise<SessionUser> {
  const base = { id: 'u1', email: 'u@x', name: 'سارة', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => deny.map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
    })
  );
}

async function as(roleKeys: string[], deny: string[] = []) {
  current.user = await person(roleKeys, deny);
  requireContext.mockResolvedValue({ user: current.user, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } });
}

const body = (b: unknown, method = 'POST') => new Request('http://x/api', { method, body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } });
const ID = '11111111-2222-4333-8444-555555555555';
const params = { params: Promise.resolve({ id: ID }) };
const forbidden = (res: Response) => res.status === 403;

beforeEach(() => {
  vi.clearAllMocks();
  db.order.findFirst.mockResolvedValue(null);
  db.orderIssue.findFirst.mockResolvedValue(null);
});

describe('the win-back offer', () => {
  // an empty body is refused with a 400 AFTER the gate — so 400 means "past the gate", 403 means "stopped at it"
  const offer = () => winbackPOST(body({}));

  it('lets in who holds the offer’s box (and the list it sits behind)', async () => {
    await as(['confirmation.supervise', 'confirmation.winback']);
    expect((await offer()).status).toBe(400);
  });

  it('NEGATIVE: refuses who only SEES the list — the old key no longer opens the offer, and nothing is read', async () => {
    await as(['confirmation.supervise']);
    expect(forbidden(await offer())).toBe(true);
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });

  it('the door asks ONLY its own key: the box without the list is past the gate (the catalog says it requires the list, the roles door refuses to SAVE it)', async () => {
    await as(['confirmation.winback']);
    expect((await offer()).status).toBe(400);
    const { catalogItem } = await import('@/lib/permission-catalog');
    expect(catalogItem('confirmation.winback')!.requires).toBe('confirmation.supervise');
  });

  it('NEGATIVE: a «منع» on the box beats a role that carries it', async () => {
    await as(['confirmation.supervise', 'confirmation.winback'], ['confirmation.winback']);
    expect(forbidden(await offer())).toBe(true);
  });

  it('the LIST keeps its own key, and says whether the reader may press the offer', async () => {
    await as(['confirmation.supervise']);
    const seeOnly = await winbackGET(new Request('http://x/api/confirmation/winback'));
    expect(seeOnly.status).toBe(200);
    expect((await seeOnly.json()).canOffer).toBe(false);
    await as(['confirmation.supervise', 'confirmation.winback']);
    expect((await (await winbackGET(new Request('http://x/api/confirmation/winback'))).json()).canOffer).toBe(true);
    // NEGATIVE: the box without the list reads nothing
    await as(['confirmation.winback']);
    expect(forbidden(await winbackGET(new Request('http://x/api/confirmation/winback')))).toBe(true);
  });
});

describe('handing a postponed order back to the pool', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    id: ID, orderNumber: 'JO-1', confirmationStatus: 'NEW', claimedById: 'u1', postponedUntil: null, nextFollowUpAt: null, version: 1, ...over,
  });
  // NEW is "not postponed": a 409 AFTER the ownership check — so 409 means "past it", 403 means "stopped at it"
  const hand = () => postponedPOST(body({ orderId: ID }));

  it('lets a person hand back HER OWN order with only the desk key', async () => {
    await as(['confirmation.work']);
    db.order.findFirst.mockResolvedValue(order({ claimedById: 'u1' }));
    expect((await hand()).status).toBe(409);
  });

  it('lets who holds the reassign box hand back a COLLEAGUE’S', async () => {
    await as(['confirmation.work', 'confirmation.reassign']);
    db.order.findFirst.mockResolvedValue(order({ claimedById: 'someone-else' }));
    expect((await hand()).status).toBe(409);
  });

  it('NEGATIVE: refuses a COLLEAGUE’S order to who only supervises the list — the old key no longer reaches it', async () => {
    await as(['confirmation.work', 'confirmation.supervise']);
    db.order.findFirst.mockResolvedValue(order({ claimedById: 'someone-else' }));
    const res = await hand();
    expect(forbidden(res)).toBe(true);
    expect((await res.json()).error).toContain('ليس بين يديك');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a «منع» on the reassign box beats a role that carries it — and her own order is still hers', async () => {
    await as(['confirmation.work', 'confirmation.reassign'], ['confirmation.reassign']);
    db.order.findFirst.mockResolvedValue(order({ claimedById: 'someone-else' }));
    expect(forbidden(await hand())).toBe(true);
    db.order.findFirst.mockResolvedValue(order({ claimedById: 'u1' }));
    expect((await hand()).status).toBe(409);
  });

  it('the list says, row by row, which it may be handed back from', async () => {
    await as(['confirmation.work', 'confirmation.supervise']);
    let rows = (await (await postponedGET(new Request('http://x/api/confirmation/postponed'))).json()).orders as Array<{ id: string; mayHandBack: boolean }>;
    expect(rows.map((r) => [r.id, r.mayHandBack])).toEqual([['mine', true], ['hers', false]]);
    await as(['confirmation.work', 'confirmation.supervise', 'confirmation.reassign']);
    rows = (await (await postponedGET(new Request('http://x/api/confirmation/postponed'))).json()).orders;
    expect(rows.map((r) => [r.id, r.mayHandBack])).toEqual([['mine', true], ['hers', true]]);
  });
});

describe('raising an entry issue', () => {
  // an empty body is a 400 AFTER the gate
  const raise = () => issuesPOST(body({}));

  it('lets in who holds the raise box — WITHOUT the issues list (the agent was never given it)', async () => {
    await as(['confirmation.raise_issue']);
    expect((await raise()).status).toBe(400);
  });

  it('NEGATIVE: refuses who only SEES the issues list — the old key no longer opens the raising, and nothing is written', async () => {
    await as(['confirmation.issues']);
    expect(forbidden(await raise())).toBe(true);
    expect(db.orderIssue.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a «منع» on the raise box beats a role that carries it', async () => {
    await as(['confirmation.issues', 'confirmation.raise_issue'], ['confirmation.raise_issue']);
    expect(forbidden(await raise())).toBe(true);
  });

  it('and the LIST keeps the old key: the raise box alone reads nothing', async () => {
    await as(['confirmation.issues']);
    expect((await issuesGET(new Request('http://x/api/confirmation/issues'))).status).toBe(200);
    await as(['confirmation.raise_issue']);
    expect(forbidden(await issuesGET(new Request('http://x/api/confirmation/issues')))).toBe(true);
  });
});

describe('correcting an entry issue', () => {
  const correct = () => issuePATCH(body({ action: 'correct' }, 'PATCH'), params);
  const voidIt = () => issuePATCH(body({ action: 'void', note: 'خطأ إدخال' }, 'PATCH'), params);

  it('lets in who holds the correction’s box (and the list it sits behind)', async () => {
    await as(['confirmation.issues', 'confirmation.issues_correct']);
    expect((await correct()).status).toBe(404); // past the gate: the issue is not there
  });

  it('NEGATIVE: refuses who only SEES the list — the old key no longer closes an issue, and nothing is read or written', async () => {
    await as(['confirmation.issues']);
    const res = await correct();
    expect(forbidden(res)).toBe(true);
    expect((await res.json()).code).toBe('ISSUE_CORRECT_FORBIDDEN');
    expect(db.orderIssue.findFirst).not.toHaveBeenCalled();
    expect(db.orderIssue.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the entry gate is still the list — the correction box alone reaches nothing', async () => {
    await as(['confirmation.issues_correct']);
    expect(forbidden(await correct())).toBe(true);
  });

  it('NEGATIVE: a «منع» on the correction box beats a role that carries it', async () => {
    await as(['confirmation.issues', 'confirmation.issues_correct'], ['confirmation.issues_correct']);
    expect(forbidden(await correct())).toBe(true);
  });

  it('the VOID is untouched: it asks the cancel box, not the correction box', async () => {
    await as(['confirmation.issues', 'orders.cancel']); // no issues_correct
    db.orderIssue.findFirst.mockResolvedValue({ id: ID, status: 'OPEN', orderId: 'o1', note: null, order: { id: 'o1', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null } });
    db.$transaction.mockImplementation(async () => ({ id: ID }));
    expect((await voidIt()).status).toBe(200);
    // and the correction box without the cancel box does not void
    await as(['confirmation.issues', 'confirmation.issues_correct']);
    db.$transaction.mockClear();
    const res = await voidIt();
    expect(forbidden(res)).toBe(true);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
