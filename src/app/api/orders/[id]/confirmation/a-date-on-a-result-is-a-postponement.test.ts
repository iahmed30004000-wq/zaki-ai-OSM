import { beforeEach, describe, expect, it, vi } from 'vitest';
import { needsContactFirst } from '@/lib/confirmation-queue';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A RESULT THAT CARRIES A DATE IS A POSTPONEMENT, AND A POSTPONEMENT NEEDS AN ATTEMPT (RV5).
 *
 * «الاتصال أوّل»: a holder may not dispose of an order — confirm, reject, cancel, postpone, edit — before she has tried to
 * reach the customer (`needsContactFirst`). `contact_result` was left out ON PURPOSE: it is the recording of the very
 * attempt being demanded, and binding it would be a door locked with its own key inside. But the same action handed a
 * `nextFollowUpAt` ALSO schedules a follow-up and hides the order — `schedule_follow_up` by another name. A bare call to
 * `POST /api/orders/[id]/confirmation` with `{ action: 'contact_result', nextFollowUpAt }` postponed an order nobody had
 * rung. No screen sends that (`ConfirmationActions` records the attempt first, always), so the only way in was a call
 * made by hand.
 *
 * What stays open: «لا يرد» with no date (the way out the refusal itself names), a holder who HAS an attempt, and
 * somebody who does not hold the order (a supervisor is not working a queue).
 *
 * The decision — the owner, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي». The conservative reading: the rule that
 * already binds `schedule_follow_up` binds the same act whatever it is called.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, can, createNotification } = vi.hoisted(() => {
  const db: any = {
    order: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderContactAttempt: { count: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return { db, requireContext: vi.fn(), assertOrderAccess: vi.fn(), can: vi.fn(), createNotification: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, FORBIDDEN: 403 },
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: () => ({ allowed: true }),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines: vi.fn(), releaseOrderLines: vi.fn(), orderLinesForGuard: vi.fn(async () => []) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));

import { POST } from '@/app/api/orders/[id]/confirmation/route';

const ME = { id: 'actor-1', name: 'منفّذ', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' };
const ctx = {
  user: ME, companyId: 'c1', storeId: 'store-a', countryId: 'jo',
  country: {
    id: 'jo', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman',
    orderPrefix: 'ORD', allowNegativeStock: false, workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5],
  },
};
const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 'store-a', orderNumber: 'ORD-1', version: 1,
  moderatorId: 'mod-1', claimedById: ME.id,
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY',
  lockedById: null, lockExpiresAt: null, shippedAt: null, nextFollowUpAt: null, followUpStatus: null,
  ...over,
});
const params = { params: Promise.resolve({ id: 'o1' }) };
const post = (body: unknown) =>
  POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), params);

const inTwoDays = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(ctx);
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log');
  createNotification.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (fn: any) => (typeof fn === 'function' ? fn(db) : fn));
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue(order());
  assertOrderAccess.mockResolvedValue({ allowed: true, order: order() });
  db.orderContactAttempt.count.mockResolvedValue(0);
});

describe('the rule, as a function', () => {
  it('contact_result alone is never bound — it IS the attempt being recorded', () => {
    expect(needsContactFirst({ action: 'contact_result', isHolder: true, hasAttempt: false })).toBe(false);
    expect(needsContactFirst({ action: 'contact_result', isHolder: true, hasAttempt: false, schedulesFollowUp: false })).toBe(false);
  });

  it('contact_result that schedules a follow-up is bound for the holder, like schedule_follow_up', () => {
    expect(needsContactFirst({ action: 'contact_result', isHolder: true, hasAttempt: false, schedulesFollowUp: true })).toBe(true);
    expect(needsContactFirst({ action: 'schedule_follow_up', isHolder: true, hasAttempt: false })).toBe(true);
  });

  it('…and not once an attempt exists, nor for somebody who does not hold the order', () => {
    expect(needsContactFirst({ action: 'contact_result', isHolder: true, hasAttempt: true, schedulesFollowUp: true })).toBe(false);
    expect(needsContactFirst({ action: 'contact_result', isHolder: false, hasAttempt: false, schedulesFollowUp: true })).toBe(false);
  });

  it('and a date on some other action changes nothing: start and resolve_follow_up are never bound', () => {
    for (const action of ['start', 'resolve_follow_up']) {
      expect(needsContactFirst({ action, isHolder: true, hasAttempt: false, schedulesFollowUp: true })).toBe(false);
    }
  });
});

describe('POST /api/orders/[id]/confirmation', () => {
  it('NEGATIVE: «نتيجة اتصال» مع موعد على طلب بيدّي وبلا أي محاولة تُرفض ٤٠٩ ولا يُكتب شيء', async () => {
    const res = await post({ action: 'contact_result', result: 'CALLBACK_REQUESTED', nextFollowUpAt: inTwoDays(), expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONTACT_FIRST');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('وإذا سُجّلت محاولة قبلها (كما تفعل الشاشة دائماً) يمرّ ويُجدوِل', async () => {
    db.orderContactAttempt.count.mockResolvedValue(1);
    const res = await post({ action: 'contact_result', result: 'CALLBACK_REQUESTED', nextFollowUpAt: inTwoDays(), expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it('و«لا يرد» بلا موعد يبقى مفتوحاً بلا محاولة — هو المخرج الذي تذكره الرسالة', async () => {
    const res = await post({ action: 'contact_result', result: 'NO_ANSWER', expectedVersion: 1 });
    expect(res.status).toBe(200);
  });

  it('ومن لا يحمل الطلب (مشرف) لا يُقيَّد', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ claimedById: 'someone-else' }) });
    const res = await post({ action: 'contact_result', result: 'CALLBACK_REQUESTED', nextFollowUpAt: inTwoDays(), expectedVersion: 1 });
    expect(res.status).toBe(200);
  });

  it('والباب يمرّر وجود الموعد للقاعدة — لا يكتفي بتعريف المتغير', () => {
    const src = stripComments(repoFile('src/app/api/orders/[id]/confirmation/route.ts'));
    const at = src.indexOf('needsContactFirst({');
    expect(src.slice(at, at + 300), 'الموعد لا يصل القاعدة').toContain('schedulesFollowUp: !!nextFollowUpAt');
  });
});
