import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readingLine } from './call-outcome';
import { repoFile, stripComments } from './guard-source';

/**
 * «مساعد الاتصال» IN THE ORDER'S LOG — what her phone's call log said about the call, as a line of the history.
 *
 * The owner (8/11): «بدي أدخل مدة المكالمة أو اللارد بسجل الطلبات». The app already sends the reading
 * (`/api/call-helper/reading`) and the call sheet already words it («رد — 2:13» · «ما رد — رنّ 25 ث»). This is the same
 * fact written on the order itself, where whoever opens it reads it next to the attempts she pressed.
 *
 * IT IS EVIDENCE, NOT AN ATTEMPT. The line is read from `call_helper_readings`; nothing is written, no attempt number is
 * made up, and the count and the rounds still come only from what a person pressed
 * (`a-reading-is-evidence-only.test.ts` holds the door that receives it).
 */

const { db, rows } = vi.hoisted(() => {
  const rows: Record<string, Record<string, unknown>[]> = {};
  const USERS = [
    { id: 'u1', name: 'سارة' },
    { id: 'u2', name: 'ليلى' },
  ];
  const source = (name: string) => ({
    // Prisma's reading of a missing filter is no filter: a query that forgets its order gets every order's rows.
    findMany: vi.fn(async ({ where }: { where: { orderId?: string } }) =>
      (rows[name] ?? []).filter((r) => where.orderId === undefined || r.orderId === where.orderId)
    ),
  });
  const db = {
    orderStatusLog: source('orderStatusLog'),
    orderClaimHistory: source('orderClaimHistory'),
    orderContactAttempt: source('orderContactAttempt'),
    callLog: source('callLog'),
    callHelperReading: source('callHelperReading'),
    deliveryAttempt: source('deliveryAttempt'),
    orderNote: source('orderNote'),
    orderActivity: source('orderActivity'),
    orderChangeRequest: source('orderChangeRequest'),
    orderIssue: source('orderIssue'),
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => USERS.filter((u) => where.id.in.includes(u.id))),
    },
  };
  return { db, rows };
});
vi.mock('./db', () => ({ db }));

import { orderTimeline } from './order-timeline';

const at = (iso: string) => new Date(iso);

function reading(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    orderId: 'o1',
    userId: 'u1',
    startedAt: at('2026-11-08T09:00:00Z'),
    receivedAt: at('2026-11-08T09:03:00Z'),
    answered: true,
    talkSeconds: 133,
    ringSeconds: 8,
    ...over,
  };
}

/** The lines of one order that came from a reading. */
const helperLines = async (orderId = 'o1') => (await orderTimeline(db as never, orderId)).filter((e) => e.id.startsWith('ch_'));

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(rows)) delete rows[k];
});

describe('«مساعد الاتصال» — a reading is a line of the order’s log', () => {
  it('a call that was picked up reads with its length, at the moment it was placed, in the name of the one who placed it', async () => {
    rows.callHelperReading = [reading()];

    expect(await helperLines()).toEqual([
      {
        id: 'ch_r1',
        kind: 'CONTACT',
        at: at('2026-11-08T09:00:00Z'),
        title: 'مساعد الاتصال: رد — 2:13',
        detail: 'من سجلّ مكالمات الهاتف — لا تُحسب محاولة',
        actorId: 'u1',
        actorName: 'سارة',
      },
    ]);
  });

  it('a call nobody picked up reads with how long it rang', async () => {
    rows.callHelperReading = [reading({ id: 'r2', answered: false, talkSeconds: 0, ringSeconds: 25 })];

    const [line] = await helperLines();
    expect(line.title).toBe('مساعد الاتصال: ما رد — رنّ 25 ث');
  });

  it('the words are the call sheet’s own — one builder, so the two screens cannot drift apart', async () => {
    const cases = [
      { answered: true, talkSeconds: 42, ringSeconds: 5 },
      { answered: true, talkSeconds: 725, ringSeconds: 3 },
      { answered: true, talkSeconds: 3729, ringSeconds: 3 },
      { answered: false, talkSeconds: 0, ringSeconds: 25 },
      { answered: false, talkSeconds: 0, ringSeconds: 0 },
    ];
    for (const [i, c] of cases.entries()) {
      rows.callHelperReading = [reading({ id: `c${i}`, ...c })];
      const [line] = await helperLines();
      expect(line.title, JSON.stringify(c)).toBe(`مساعد الاتصال: ${readingLine(c)}`);
    }

    // ...and the log does not carry a second copy of those words that could be edited on its own.
    const src = stripComments(repoFile('src/lib/order-timeline.ts'));
    expect(src).toContain("from './call-outcome'");
    expect(src).not.toMatch(/ما رد|رنّ/);
  });

  it('it stands where the call was placed, not where the phone got round to sending it', async () => {
    // Placed at 09:00, but the phone was offline and the reading arrived the next morning; a status change happened at 12:00.
    rows.callHelperReading = [reading({ startedAt: at('2026-11-08T09:00:00Z'), receivedAt: at('2026-11-09T05:00:00Z') })];
    rows.orderStatusLog = [
      { id: 's1', orderId: 'o1', createdAt: at('2026-11-08T12:00:00Z'), statusType: 'CONFIRMATION', previousValue: 'NEW', newValue: 'CONFIRMED', changedById: 'u1', note: null },
    ];

    const events = await orderTimeline(db as never, 'o1');
    expect(events.map((e) => e.id)).toEqual(['ch_r1', 'st_s1']);
    expect(events[0].at).toEqual(at('2026-11-08T09:00:00Z'));
  });

  it('it is evidence, not an attempt: no attempt number anywhere, and the line says so', async () => {
    rows.callHelperReading = [reading({ answered: false, talkSeconds: 0, ringSeconds: 25 })];

    const events = await orderTimeline(db as never, 'o1');
    expect(events).toHaveLength(1);
    expect(events.filter((e) => e.title.startsWith('محاولة اتصال'))).toEqual([]);
    expect(events[0].detail).toContain('لا تُحسب محاولة');
  });

  it('it stands beside the attempt she pressed and does not replace it', async () => {
    rows.callHelperReading = [reading({ startedAt: at('2026-11-08T09:00:00Z') })];
    rows.orderContactAttempt = [
      { id: 't1', orderId: 'o1', createdAt: at('2026-11-08T09:04:00Z'), attemptNumber: 1, contactMethod: 'PHONE', result: 'NO_ANSWER', employeeId: 'u1', note: null },
    ];

    const events = await orderTimeline(db as never, 'o1');
    expect(events.map((e) => e.id)).toEqual(['ch_r1', 'ct_t1']);
    expect(events[1].title).toBe('محاولة اتصال 1 عبر هاتف — لم يرد');
    // The two disagree here on purpose: the phone says she talked, the log says nobody answered. Both are shown as they are.
    expect(events[0].title).toBe('مساعد الاتصال: رد — 2:13');
  });

  it('it reads THIS order’s readings only', async () => {
    rows.callHelperReading = [
      reading({ id: 'mine', orderId: 'o1' }),
      reading({ id: 'other', orderId: 'o2', startedAt: at('2026-11-08T10:00:00Z') }),
    ];

    expect((await helperLines('o1')).map((e) => e.id)).toEqual(['ch_mine']);
    expect((await helperLines('o2')).map((e) => e.id)).toEqual(['ch_other']);
    expect(db.callHelperReading.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'o1' } }));
  });

  it('the one who placed it is named; someone who is gone leaves the name empty and the line stays', async () => {
    rows.callHelperReading = [
      reading({ id: 'r1', userId: 'u2' }),
      reading({ id: 'r2', userId: 'u9', startedAt: at('2026-11-08T09:30:00Z') }),
    ];

    const lines = await helperLines();
    expect(lines.map((l) => [l.id, l.actorId, l.actorName])).toEqual([
      ['ch_r1', 'u2', 'ليلى'],
      ['ch_r2', 'u9', null],
    ]);
  });

  it('two calls on one order are two lines, oldest first', async () => {
    rows.callHelperReading = [
      reading({ id: 'late', startedAt: at('2026-11-08T15:00:00Z'), answered: true, talkSeconds: 60 }),
      reading({ id: 'early', startedAt: at('2026-11-08T09:00:00Z'), answered: false, talkSeconds: 0, ringSeconds: 18 }),
    ];

    const lines = await helperLines();
    expect(lines.map((l) => l.title)).toEqual(['مساعد الاتصال: ما رد — رنّ 18 ث', 'مساعد الاتصال: رد — 1:00']);
  });

  it('an order with no reading has no such line, and an order with nothing at all has none at all', async () => {
    expect(await helperLines()).toEqual([]);
    expect(await orderTimeline(db as never, 'o1')).toEqual([]);
  });

  it('the log only reads: no write call anywhere in the builder', () => {
    const src = stripComments(repoFile('src/lib/order-timeline.ts'));
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
  });
});
