import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the line «أرجِع «لا يرد» للطابور» leaves on an order says WHO PRESSED, and is not her work.
 *
 * The line is written in the HOLDER's name (`userId`: the column cannot be empty). Drawn as it stands it would read as though
 * she had let her own order go — what `auto-release.ts` closed for the clock's releases — and attendance would read it as work
 * of hers on a day she may never have come. So:
 *
 *  1. The order's timeline writes the SUPERVISOR as the actor and says it («أرجعها <name>»); not «النظام», not her.
 *  2. The supervisor's current name wins over the one the line was written with; an account gone since is still named, by
 *     the line; a line that cannot say who keeps the static words and the holder.
 *  3. Her own release, a supervisor's one-order pull-back, and the clock's releases read exactly as before.
 *  4. Attendance does not count the line as her work: a day nobody came stays a day nobody came, and an arrival is not moved.
 *
 * Blockers: no money, no permission, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderClaimHistory: { findMany: vi.fn() },
    orderContactAttempt: { findMany: vi.fn() },
    callLog: { findMany: vi.fn() },
    callHelperReading: { findMany: vi.fn() },
    deliveryAttempt: { findMany: vi.fn() },
    orderNote: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderIssue: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    attendanceMark: { findMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { attendance } from './attendance';
import { MANAGER_RETURNED_REASON, NINETY_MINUTE_RELEASE_REASON, automaticReleaseMetadata, managerReturnMetadata } from './auto-release';
import { orderTimeline } from './order-timeline';

const at = (iso: string) => new Date(iso);
const SARA = 'user-sara';
const OWNER = 'user-owner';

const claimRow = (over: Record<string, unknown> = {}) => ({
  id: 'h1',
  createdAt: at('2026-11-08T10:00:00Z'),
  action: 'RELEASED',
  userId: SARA,
  reason: MANAGER_RETURNED_REASON,
  metadata: managerReturnMetadata(SARA, { id: OWNER, name: 'أحمد' }),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const table of [
    db.orderStatusLog, db.orderClaimHistory, db.orderContactAttempt, db.deliveryAttempt,
    db.orderNote, db.orderActivity, db.orderChangeRequest, db.orderIssue, db.callLog, db.callHelperReading, db.attendanceMark,
  ]) {
    table.findMany.mockResolvedValue([]);
  }
  db.user.findMany.mockResolvedValue([{ id: SARA, name: 'سلوى' }, { id: OWNER, name: 'أحمد' }]);
});

describe('the timeline names the supervisor', () => {
  it('the actor is the supervisor, the sentence says «أرجعها <name>», and it is neither «النظام» nor her', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([claimRow()]);
    const [line] = await orderTimeline(db as never, 'o1');
    expect(line.title).toBe('تحرير الطلب');
    expect(line.actorId).toBe(OWNER);
    expect(line.actorName).toBe('أحمد');
    expect(line.detail).toBe('أرجعها أحمد للطابور — ما حدا وصل لزبونها');
    expect(line.actorName, 'اتكتب باسم النظام').not.toBe('النظام');
    expect(line.actorName, 'اتكتب باسمها هي').not.toBe('سلوى');
    expect(line.detail, 'طلع الكود بالإنجليزي').not.toMatch(/MANAGER_RETURNED/);
  });

  it('the supervisor is looked up with the others, so his CURRENT name is the one printed', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([claimRow()]);
    db.user.findMany.mockResolvedValue([{ id: SARA, name: 'سلوى' }, { id: OWNER, name: 'أحمد الكوري' }]);
    const [line] = await orderTimeline(db as never, 'o1');
    const asked = (db.user.findMany.mock.calls[0][0] as { where: { id: { in: string[] } } }).where.id.in;
    expect(asked).toEqual(expect.arrayContaining([SARA, OWNER]));
    expect(line.actorName).toBe('أحمد الكوري');
    expect(line.detail).toBe('أرجعها أحمد الكوري للطابور — ما حدا وصل لزبونها');
  });

  it('an account deleted since is still named — by the line, which was written with his name', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([claimRow()]);
    db.user.findMany.mockResolvedValue([{ id: SARA, name: 'سلوى' }]);
    const [line] = await orderTimeline(db as never, 'o1');
    expect(line.actorId).toBe(OWNER);
    expect(line.actorName).toBe('أحمد');
    expect(line.detail).toBe('أرجعها أحمد للطابور — ما حدا وصل لزبونها');
  });

  it('a line that cannot say who (no metadata) keeps the static words, in Arabic, and the holder as the actor', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([claimRow({ metadata: null })]);
    const [line] = await orderTimeline(db as never, 'o1');
    expect(line.detail).toBe('أرجعها مشرف للطابور — ما حدا وصل لزبونها');
    expect(line.actorName).toBe('سلوى');
  });

  it('NEGATIVE: her own release, a supervisor’s one-order pull-back and the clock’s releases read as they always did', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      claimRow({ id: 'a', reason: 'MANUAL_RELEASE', metadata: JSON.stringify({ previousOwner: SARA }) }),
      claimRow({ id: 'b', userId: OWNER, reason: 'PULLED_BACK', metadata: JSON.stringify({ previousOwner: SARA, pulledBackBy: OWNER }) }),
      claimRow({ id: 'c', reason: NINETY_MINUTE_RELEASE_REASON, metadata: automaticReleaseMetadata(SARA) }),
    ]);
    const lines = await orderTimeline(db as never, 'o1');
    expect(lines.map((l) => [l.actorName, l.actorId])).toEqual([['سلوى', SARA], ['أحمد', OWNER], ['النظام', null]]);
    expect(lines[0].detail).toBe('MANUAL_RELEASE');
  });

  it('NEGATIVE: the reason on a line that is not a release is not a return (a claim keeps its owner)', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([claimRow({ action: 'CLAIMED' })]);
    const [line] = await orderTimeline(db as never, 'o1');
    expect(line.actorName).toBe('سلوى');
  });
});

describe('attendance does not read the line as her work', () => {
  const CAL = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
  /** A local wall-clock moment in Amman (UTC+3 all year since 2022). */
  const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour - 3, minute));
  const base = { companyId: 'c1', storeId: 's1', userIds: [SARA], calendar: CAL, start: at(1, 0), end: at(30, 23, 59) };
  const rowOf = async () => (await attendance(base)).get(SARA)!;
  const line = (extra: Record<string, unknown>, when: Date) => ({ userId: SARA, createdAt: when, action: 'RELEASED', reason: null, metadata: null, ...extra });

  it('a day she never came is still a day she never came when a supervisor returned her pile', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      line({ reason: MANAGER_RETURNED_REASON, metadata: managerReturnMetadata(SARA, { id: OWNER, name: 'أحمد' }) }, at(10, 10, 0)),
    ]);
    const row = await rowOf();
    expect(row.days).toEqual([]);
    expect(row.daysPresent).toBe(0);
  });

  it('and so is a line whose metadata cannot be read — the reason is enough', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([line({ reason: MANAGER_RETURNED_REASON, metadata: '{not json' }, at(10, 10, 0))]);
    expect((await rowOf()).days).toEqual([]);
  });

  it('an arrival she marked is not pulled back to the moment of the supervisor’s press', async () => {
    db.attendanceMark.findMany.mockResolvedValue([{ userId: SARA, kind: 'LOGIN', at: at(10, 9, 30) }]);
    db.orderClaimHistory.findMany.mockResolvedValue([
      line({ reason: MANAGER_RETURNED_REASON, metadata: managerReturnMetadata(SARA, { id: OWNER, name: 'أحمد' }) }, at(10, 9, 5)),
    ]);
    const day = (await rowOf()).days.find((d) => d.date === '2026-11-10')!;
    expect(day.arrivedAt).toEqual(at(10, 9, 30));
    expect(day.lateMinutes).toBe(30);
    expect(day.workStartedAt).toBeNull();
  });

  it('NEGATIVE: what she really did the same day still counts, from its own moment', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      line({ reason: MANAGER_RETURNED_REASON, metadata: managerReturnMetadata(SARA, { id: OWNER, name: 'أحمد' }) }, at(10, 8, 0)),
      { userId: SARA, createdAt: at(10, 11, 0), action: 'CLAIMED', reason: 'PULL_NEXT', metadata: null },
    ]);
    const day = (await rowOf()).days.find((d) => d.date === '2026-11-10')!;
    expect(day.workStartedAt).toEqual(at(10, 11, 0));
  });
});
