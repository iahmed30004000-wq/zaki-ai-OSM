import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN ORDER THE SYSTEM TAKES BACK IS TAKEN BY THE SYSTEM — AND SHE IS TOLD (the owner's ruling 4/11).
 *
 * The ninety-minute release and the two releases of «نظام الجولات» wrote their history line under the agent's own id and
 * an English code: the order's history read «تحرير الطلب — سارة · AUTO_RELEASE_90_BUSINESS_MINUTES», as though she had let
 * it go. And she heard nothing — the card left «طلباتي», and her next press on it was refused «اسحب الطلب أولاً».
 *
 *   · each release writes ONE notification to the agent who held the order, in its own transaction, with the reason in
 *     Arabic and a link to «طلباتي»; a release that did not happen tells nobody;
 *   · the history line says nobody pressed it (`metadata.automatic`), and the timeline writes «النظام» as the actor, with
 *     the reason in words — for rows written before this rule too, by their reason;
 *   · a person's own release is still hers.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    orderClaimHistory: { create: vi.fn(), findMany: vi.fn() },
    notification: { createMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderContactAttempt: { findMany: vi.fn() },
    callLog: { findMany: vi.fn() },
    deliveryAttempt: { findMany: vi.fn() },
    orderNote: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderIssue: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('./db', () => ({ db }));

import { AUTO_RELEASE_BUSINESS_MINUTES, releaseStaleClaims } from './confirmation-queue';
import { REPULL_RELEASE_REASON, ROUND_RELEASE_REASON } from './no-answer-rounds';
import { AUTO_RELEASE_WHY, NINETY_MINUTE_RELEASE_REASON, isAutomaticRelease } from './auto-release';
import { orderTimeline } from './order-timeline';
import { zonedTimeToInstant } from './business-calendar';

const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const t = (day: number, h: number, m = 0) => zonedTimeToInstant(JO.timezone, 2026, 11, day, h, m);
const scope = { companyId: 'c1', storeId: 's1' };
const ON = { enabled: true, enabledAt: t(1, 8) };

type Row = Record<string, unknown>;
const isRoundsQuery = (q: { where: Row }) => !!(q.where.contactAttempts as Row | undefined)?.some;

let ninetyRows: Row[] = [];
let roundsRows: Row[] = [];

function heldRow(over: Row = {}): Row {
  return {
    id: 'o2',
    orderNumber: 'ORD-2',
    claimedAt: t(1, 9),
    claimedById: 'sara',
    companyId: 'c1',
    customerId: null,
    postponedUntil: null,
    nextFollowUpAt: null,
    contactAttempts: [
      { createdAt: t(1, 9, 29), result: 'OPENED', attemptNumber: 1 },
      { createdAt: t(1, 9, 30), result: 'NO_ANSWER', attemptNumber: 2 },
    ],
    ...over,
  };
}

/** Every notification row written, across every `createMany`. */
const told = () => db.notification.createMany.mock.calls.flatMap((c) => (c[0] as { data: Row[] }).data);

beforeEach(() => {
  vi.clearAllMocks();
  ninetyRows = [];
  roundsRows = [];
  db.order.findMany.mockImplementation(async (q: { where: Row }) => (isRoundsQuery(q) ? roundsRows : ninetyRows));
  db.order.updateMany.mockResolvedValue({ count: 1 });
  for (const table of [
    db.orderStatusLog, db.orderClaimHistory, db.orderContactAttempt, db.deliveryAttempt,
    db.orderNote, db.orderActivity, db.orderChangeRequest, db.orderIssue, db.callLog,
  ]) {
    table.findMany.mockResolvedValue([]);
  }
  db.user.findMany.mockResolvedValue([{ id: 'sara', name: 'سارة' }]);
});

describe('the ninety-minute release tells her', () => {
  it('one notification, to the agent who held it, with the reason in Arabic and «طلباتي» as the link', async () => {
    ninetyRows = [{ id: 'o1', orderNumber: 'ORD-7', claimedAt: t(1, 9), claimedById: 'sara', companyId: 'c1' }];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 11))).toBe(1);

    expect(told(), 'التحرير التلقائي ما بلّغ الموظفة').toHaveLength(1);
    const [notice] = told();
    expect(notice).toMatchObject({ companyId: 'c1', storeId: 's1', userId: 'sara', link: '/confirmation/mine' });
    expect(notice.title).toBe('رجع ORD-7 للطابور');
    expect(notice.message).toBe('رجع ORD-7 للطابور: ما انسجّلت عليه محاولة خلال 90 دقيقة عمل');
    expect(String(notice.message)).not.toMatch(/AUTO_RELEASE/);
  });

  it('and the history line says nobody pressed it — whose order it was stays in `userId`', async () => {
    ninetyRows = [{ id: 'o1', orderNumber: 'ORD-7', claimedAt: t(1, 9), claimedById: 'sara', companyId: 'c1' }];
    await releaseStaleClaims(db as never, scope, JO, t(1, 11));
    const line = db.orderClaimHistory.create.mock.calls[0][0].data;
    expect(line.userId).toBe('sara');
    expect(line.reason).toBe(NINETY_MINUTE_RELEASE_REASON);
    expect(JSON.parse(line.metadata)).toEqual({ automatic: true, holder: 'sara' });
  });

  it('the reason it writes is the one the words are kept under', () => {
    expect(`AUTO_RELEASE_${AUTO_RELEASE_BUSINESS_MINUTES}_BUSINESS_MINUTES`).toBe(NINETY_MINUTE_RELEASE_REASON);
  });

  it('NEGATIVE: nothing released, nobody told', async () => {
    // Claimed at 09:00, read at 10:00 — sixty working minutes, not ninety.
    ninetyRows = [{ id: 'o1', orderNumber: 'ORD-7', claimedAt: t(1, 9), claimedById: 'sara', companyId: 'c1' }];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 10))).toBe(0);
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the write matched nothing (the order changed hands since the read) — no history line, no notice', async () => {
    ninetyRows = [{ id: 'o1', orderNumber: 'ORD-7', claimedAt: t(1, 9), claimedById: 'sara', companyId: 'c1' }];
    db.order.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 11))).toBe(0);
    expect(db.notification.createMany, 'انبعت إشعار عن تحرير ما صار').not.toHaveBeenCalled();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  });

  it('two released, two told — each the one who held it', async () => {
    ninetyRows = [
      { id: 'o1', orderNumber: 'ORD-7', claimedAt: t(1, 9), claimedById: 'sara', companyId: 'c1' },
      { id: 'o3', orderNumber: 'ORD-9', claimedAt: t(1, 9), claimedById: 'huda', companyId: 'c1' },
    ];
    await releaseStaleClaims(db as never, scope, JO, t(1, 11));
    expect(told().map((n) => [n.userId, n.title])).toEqual([
      ['sara', 'رجع ORD-7 للطابور'],
      ['huda', 'رجع ORD-9 للطابور'],
    ]);
  });
});

describe('the rounds releases tell her too', () => {
  it('a round nobody answered for three working hours', async () => {
    roundsRows = [heldRow()];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 12, 30), { rounds: ON })).toBe(1);
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatchObject({ userId: 'sara', storeId: 's1', link: '/confirmation/mine' });
    expect(told()[0].message).toBe(`رجع ORD-2 للطابور: ${AUTO_RELEASE_WHY[ROUND_RELEASE_REASON]}`);
    expect(JSON.parse(db.orderClaimHistory.create.mock.calls[0][0].data.metadata)).toEqual({ automatic: true, holder: 'sara' });
  });

  it('a re-pulled order nobody touched', async () => {
    roundsRows = [heldRow({ claimedAt: t(1, 13) })];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 14, 30), { rounds: ON })).toBe(1);
    expect(told()).toHaveLength(1);
    expect(told()[0].message).toBe(`رجع ORD-2 للطابور: ${AUTO_RELEASE_WHY[REPULL_RELEASE_REASON]}`);
  });

  it('NEGATIVE: a press that won the race keeps the order — and nobody is told it went', async () => {
    roundsRows = [heldRow()];
    db.order.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 12, 30), { rounds: ON })).toBe(0);
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('the timeline writes «النظام», not her name', () => {
  const claimRow = (over: Row) => ({ id: 'h1', createdAt: t(1, 11), action: 'RELEASED', userId: 'sara', reason: null, metadata: null, ...over });

  it('an automatic release: the system as the actor, the reason in words', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      claimRow({ reason: NINETY_MINUTE_RELEASE_REASON, metadata: JSON.stringify({ automatic: true, holder: 'sara' }) }),
    ]);
    const [line] = await orderTimeline(db as never, 'o1');
    expect(line.actorName, 'التحرير التلقائي انكتب باسمها').toBe('النظام');
    expect(line.actorId).toBeNull();
    expect(line.detail).toBe('تحرير تلقائي — ما انسجّلت عليه محاولة خلال 90 دقيقة عمل');
  });

  it('a row written before this rule (no metadata) is read by its reason — all three', async () => {
    for (const reason of [NINETY_MINUTE_RELEASE_REASON, ROUND_RELEASE_REASON, REPULL_RELEASE_REASON]) {
      db.orderClaimHistory.findMany.mockResolvedValue([claimRow({ reason })]);
      const [line] = await orderTimeline(db as never, 'o1');
      expect(line.actorName, reason).toBe('النظام');
      expect(line.detail, `${reason} طلع بالإنجليزي`).not.toMatch(/[A-Z_]{6,}/);
    }
  });

  it('NEGATIVE: her own release is still hers', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([claimRow({ reason: 'MANUAL_RELEASE' })]);
    const [line] = await orderTimeline(db as never, 'o1');
    expect(line.actorName).toBe('سارة');
    expect(line.actorId).toBe('sara');
  });

  it('NEGATIVE: and a claim is never the system’s, whatever its metadata says', () => {
    expect(isAutomaticRelease({ action: 'CLAIMED', reason: 'PULL_NEXT', metadata: JSON.stringify({ automatic: true }) })).toBe(false);
    expect(isAutomaticRelease({ action: 'RELEASED', reason: null, metadata: '{not json' })).toBe(false);
    expect(isAutomaticRelease({ action: 'RELEASED', reason: null, metadata: JSON.stringify({ automatic: true }) })).toBe(true);
  });
});
