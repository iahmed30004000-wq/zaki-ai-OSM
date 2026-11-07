import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = vi.hoisted(() => ({
  db: {
    attendanceMark: { findMany: vi.fn(), create: vi.fn() },
    orderClaimHistory: { findMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderContactAttempt: { findMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { attendance, markLogin } from './attendance';
import { NINETY_MINUTE_RELEASE_REASON, automaticReleaseMetadata } from './auto-release';
import { DUE_RELEASE_REASON, REPULL_RELEASE_REASON, ROUND_RELEASE_REASON } from './no-answer-rounds';

/**
 * The fingerprint. These numbers decide whether somebody is called late, so
 * the cases below are the ways this could accuse the wrong person.
 */

/** Sunday to Thursday, 09:00–17:00, Amman. */
const CAL = {
  workHoursStart: '09:00',
  workHoursEnd: '17:00',
  weekendDays: [5, 6],
  timezone: 'Asia/Amman',
};

/** A local wall-clock moment in Amman (UTC+3 across this window). */
const at = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, day, hour - 3, minute));

const SARA = 'user-sara';
const base = {
  companyId: 'c1',
  storeId: 's1',
  userIds: [SARA],
  calendar: CAL,
  start: at(14, 0),
  end: at(25, 23, 59),
};

const mark = (kind: string, when: Date, userId = SARA) => ({ userId, kind, at: when });

beforeEach(() => {
  vi.clearAllMocks();
  db.attendanceMark.findMany.mockResolvedValue([]);
  db.orderClaimHistory.findMany.mockResolvedValue([]);
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.orderContactAttempt.findMany.mockResolvedValue([]);
});

const rowOf = async () => (await attendance(base)).get(SARA)!;
const dayOf = async (date: string) => (await rowOf()).days.find((d) => d.date === date)!;

describe('arriving', () => {
  it('treats the login as the fingerprint', async () => {
    db.attendanceMark.findMany.mockResolvedValue([mark('LOGIN', at(20, 8, 55))]);
    const day = await dayOf('2026-09-20');
    expect(day.arrivedAt).toEqual(at(20, 8, 55));
    expect(day.lateMinutes).toBe(0);
  });

  it('counts the minutes past the shift when somebody is late', async () => {
    db.attendanceMark.findMany.mockResolvedValue([mark('LOGIN', at(20, 9, 37))]);
    const row = await rowOf();
    expect(row.days[0].lateMinutes).toBe(37);
    expect(row.daysLate).toBe(1);
    expect(row.totalLateMinutes).toBe(37);
  });

  it('takes the earlier of a login and a pressed check-in', async () => {
    // She opened the app at 08:50 and pressed the button at 09:10. She was
    // here at 08:50, and the button is not a way to look worse.
    db.attendanceMark.findMany.mockResolvedValue([
      mark('LOGIN', at(20, 8, 50)),
      mark('CHECK_IN', at(20, 9, 10)),
    ]);
    expect((await dayOf('2026-09-20')).lateMinutes).toBe(0);
  });

  it('counts somebody present from their first piece of work when no mark exists', async () => {
    // A forgotten button press is not a missing day.
    db.orderClaimHistory.findMany.mockResolvedValue([{ userId: SARA, createdAt: at(20, 9, 20) }]);
    const day = await dayOf('2026-09-20');
    expect(day.arrivedAt).toEqual(at(20, 9, 20));
    expect(day.lateMinutes).toBe(20);
  });

  it('never calls a weekend day late', async () => {
    // Friday. The shift does not begin on a day that is not a work day, so
    // coming in at noon to clear a backlog is extra, not lateness.
    db.attendanceMark.findMany.mockResolvedValue([mark('LOGIN', at(18, 12, 0))]);
    const row = await rowOf();
    expect(row.days[0].lateMinutes).toBeNull();
    expect(row.daysLate).toBe(0);
    expect(row.daysPresent).toBe(1);
  });

  it('does not count a day nobody came as late', async () => {
    // Absent is absent. Treating an off day as infinitely late would drown
    // every real figure in the column.
    db.attendanceMark.findMany.mockResolvedValue([mark('LOGIN', at(20, 9, 30))]);
    const row = await rowOf();
    expect(row.days).toHaveLength(1);
    expect(row.daysLate).toBe(1);
  });
});

describe('leaving', () => {
  it('measures the day from arriving to the pressed check-out', async () => {
    db.attendanceMark.findMany.mockResolvedValue([
      mark('LOGIN', at(20, 9, 0)),
      mark('CHECK_OUT', at(20, 17, 30)),
    ]);
    const day = await dayOf('2026-09-20');
    expect(day.presentMinutes).toBe(510);
    expect(day.checkedOut).toBe(true);
    expect(day.leftEarly).toBe(false);
  });

  it('falls back to the last thing they were seen doing', async () => {
    // No check-out pressed. Claiming any later moment would be inventing
    // minutes nobody observed.
    db.attendanceMark.findMany.mockResolvedValue([mark('LOGIN', at(20, 9, 0))]);
    db.orderStatusLog.findMany.mockResolvedValue([{ changedById: SARA, createdAt: at(20, 15, 0) }]);
    const day = await dayOf('2026-09-20');
    expect(day.leftAt).toEqual(at(20, 15, 0));
    expect(day.presentMinutes).toBe(360);
    expect(day.checkedOut).toBe(false);
  });

  it('does not let a later login stretch the day past a pressed check-out', async () => {
    // She signed off at 16:00 and checked something from home at 21:00.
    // The evening peek is not eight more hours of shift.
    db.attendanceMark.findMany.mockResolvedValue([
      mark('LOGIN', at(20, 9, 0)),
      mark('CHECK_OUT', at(20, 16, 0)),
    ]);
    expect((await dayOf('2026-09-20')).presentMinutes).toBe(420);
  });

  it('notices leaving before the shift ends', async () => {
    db.attendanceMark.findMany.mockResolvedValue([
      mark('LOGIN', at(20, 9, 0)),
      mark('CHECK_OUT', at(20, 14, 0)),
    ]);
    expect((await dayOf('2026-09-20')).leftEarly).toBe(true);
  });
});

describe('present against working', () => {
  it('keeps the two apart so the gap is visible', async () => {
    // Signed in at nine, first real work at eleven, last at three.
    db.attendanceMark.findMany.mockResolvedValue([
      mark('LOGIN', at(20, 9, 0)),
      mark('CHECK_OUT', at(20, 17, 0)),
    ]);
    db.orderClaimHistory.findMany.mockResolvedValue([{ userId: SARA, createdAt: at(20, 11, 0) }]);
    db.orderStatusLog.findMany.mockResolvedValue([{ changedById: SARA, createdAt: at(20, 15, 0) }]);
    const day = await dayOf('2026-09-20');
    expect(day.presentMinutes).toBe(480);
    expect(day.workedMinutes).toBe(240);
  });

  it('flags a day spent present with nothing to show for it', async () => {
    db.attendanceMark.findMany.mockResolvedValue([
      mark('LOGIN', at(20, 9, 0)),
      mark('CHECK_OUT', at(20, 17, 0)),
    ]);
    const row = await rowOf();
    expect(row.daysWithoutWork).toBe(1);
    expect(row.days[0].workedMinutes).toBeNull();
  });

  it('does not invent a working span from a single action', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([{ userId: SARA, createdAt: at(20, 11, 0) }]);
    expect((await dayOf('2026-09-20')).workedMinutes).toBe(0);
  });
});

describe('across several days', () => {
  it('totals the days present and averages the hours', async () => {
    db.attendanceMark.findMany.mockResolvedValue([
      mark('LOGIN', at(20, 9, 0)),
      mark('CHECK_OUT', at(20, 17, 0)),
      mark('LOGIN', at(21, 9, 30)),
      mark('CHECK_OUT', at(21, 15, 30)),
    ]);
    const row = await rowOf();
    expect(row.daysPresent).toBe(2);
    expect(row.totalPresentMinutes).toBe(480 + 360);
    expect(row.avgPresentMinutes).toBe(420);
    expect(row.daysLate).toBe(1);
    expect(row.totalLateMinutes).toBe(30);
  });

  it('gives an untouched employee a row of nothing, not a row of zeros in disguise', async () => {
    const row = await rowOf();
    expect(row.days).toEqual([]);
    expect(row.daysPresent).toBe(0);
    expect(row.avgPresentMinutes).toBeNull();
  });

  it('asks only for this company and store', async () => {
    await attendance(base);
    for (const call of [
      db.orderClaimHistory.findMany.mock.calls[0][0],
      db.orderStatusLog.findMany.mock.calls[0][0],
      db.orderContactAttempt.findMany.mock.calls[0][0],
    ]) {
      expect(call.where.companyId).toBe('c1');
      expect(call.where.order).toEqual({ storeId: 's1' });
    }
  });
});

describe('recording a login', () => {
  it('never costs anyone a login when the database refuses', async () => {
    // The session is already issued by the time this runs. A hiccup here
    // must not turn "not recorded" into "cannot sign in".
    db.attendanceMark.create.mockRejectedValue(new Error('connection lost'));
    await expect(markLogin('c1', SARA)).resolves.toBeUndefined();
  });

  it('stamps it as something the system saw, not something pressed', async () => {
    db.attendanceMark.create.mockResolvedValue({});
    await markLogin('c1', SARA);
    expect(db.attendanceMark.create.mock.calls[0][0].data).toMatchObject({
      userId: SARA,
      kind: 'LOGIN',
      source: 'AUTO',
    });
  });
});

describe('an arrival nobody marked', () => {
  it('is flagged as guessed from the first piece of work', async () => {
    // A session lasts days, so somebody who never signs out produces no
    // login in the morning. Their first order is later than the moment they
    // sat down, and lateness built on it is an upper bound — the manager
    // has to be told which is which.
    db.orderClaimHistory.findMany.mockResolvedValue([{ userId: SARA, createdAt: at(20, 10, 30) }]);
    const row = await rowOf();
    expect(row.days[0].arrivalFromWork).toBe(true);
    expect(row.daysLate).toBe(1);
    expect(row.daysLateEstimated).toBe(1);
  });

  it('is not flagged when she actually pressed the button', async () => {
    db.attendanceMark.findMany.mockResolvedValue([mark('CHECK_IN', at(20, 10, 30))]);
    db.orderClaimHistory.findMany.mockResolvedValue([{ userId: SARA, createdAt: at(20, 11, 0) }]);
    const row = await rowOf();
    expect(row.days[0].arrivalFromWork).toBe(false);
    expect(row.daysLate).toBe(1);
    expect(row.daysLateEstimated).toBe(0);
  });
});

describe('a line written in her name that she did not write', () => {
  /*
   * The clock gives an order back in the HOLDER's name (the line says whose order it was), and a colleague's take «على
   * الخط» does too. Neither is work anybody saw her do. Counted as work, a day she never came looked like a day she was
   * there (present, "worked"), and an arrival she had marked was pulled back to the line's moment, so she read as less late
   * than she was.
   */
  const line = (extra: { action?: string; reason?: string | null; metadata?: string | null }, when: Date) => ({
    userId: SARA,
    createdAt: when,
    action: 'RELEASED',
    reason: null,
    metadata: null,
    ...extra,
  });

  it('a day nobody came is still a day nobody came when the clock gave her orders back', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      line({ reason: NINETY_MINUTE_RELEASE_REASON, metadata: automaticReleaseMetadata(SARA) }, at(20, 10, 0)),
    ]);
    const row = await rowOf();
    expect(row.days).toEqual([]);
    expect(row.daysPresent).toBe(0);
  });

  it.each([ROUND_RELEASE_REASON, REPULL_RELEASE_REASON, DUE_RELEASE_REASON])('and so is every round of the rounds (%s)', async (reason) => {
    db.orderClaimHistory.findMany.mockResolvedValue([line({ reason, metadata: automaticReleaseMetadata(SARA) }, at(20, 10, 0))]);
    expect((await rowOf()).days).toEqual([]);
  });

  it('a release written before the line carried a mark is read by its reason', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([line({ reason: NINETY_MINUTE_RELEASE_REASON, metadata: null }, at(20, 10, 0))]);
    expect((await rowOf()).days).toEqual([]);
  });

  it('a colleague taking the order on the line is not work of the one it was taken from', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      line({ reason: 'TAKEN_ON_THE_LINE', metadata: JSON.stringify({ automatic: false, takenBy: 'user-noor' }) }, at(20, 10, 0)),
    ]);
    expect((await rowOf()).days).toEqual([]);
  });

  it('an arrival is not moved before her login by a line the clock wrote', async () => {
    // Her login is 09:30 — half an hour late. The clock gave an order back at 09:05, before she came; taken as work it
    // pulled her arrival to 09:05 and she read as 5 minutes late instead of 30.
    db.attendanceMark.findMany.mockResolvedValue([mark('LOGIN', at(20, 9, 30))]);
    db.orderClaimHistory.findMany.mockResolvedValue([
      line({ reason: NINETY_MINUTE_RELEASE_REASON, metadata: automaticReleaseMetadata(SARA) }, at(20, 9, 5)),
    ]);
    const day = await dayOf('2026-09-20');
    expect(day.arrivedAt).toEqual(at(20, 9, 30));
    expect(day.lateMinutes).toBe(30);
    expect(day.workStartedAt).toBeNull();
  });

  it('what she really did on the same day still counts, from its own moment', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      line({ reason: NINETY_MINUTE_RELEASE_REASON, metadata: automaticReleaseMetadata(SARA) }, at(20, 8, 0)),
      { userId: SARA, createdAt: at(20, 11, 0), action: 'CLAIMED', reason: 'PULL_NEXT', metadata: null },
    ]);
    const day = await dayOf('2026-09-20');
    expect(day.workStartedAt).toEqual(at(20, 11, 0));
    expect(day.workEndedAt).toEqual(at(20, 11, 0));
  });

  it('NEGATIVE: a release she pressed herself is still hers', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      line({ reason: 'MANUAL_RELEASE', metadata: JSON.stringify({ previousOwner: SARA }) }, at(20, 10, 0)),
    ]);
    const day = await dayOf('2026-09-20');
    expect(day.workStartedAt).toEqual(at(20, 10, 0));
  });

  it('NEGATIVE: and so is a supervisor pulling an order back, written in the presser’s name', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      line({ reason: 'PULLED_BACK', metadata: JSON.stringify({ previousOwner: 'user-noor', pulledBackBy: SARA }) }, at(20, 10, 0)),
    ]);
    expect((await dayOf('2026-09-20')).workStartedAt).toEqual(at(20, 10, 0));
  });

  it('asks for the columns the rule reads', async () => {
    await attendance(base);
    expect(db.orderClaimHistory.findMany.mock.calls[0][0].select).toEqual({
      userId: true,
      createdAt: true,
      action: true,
      reason: true,
      metadata: true,
    });
  });
});
