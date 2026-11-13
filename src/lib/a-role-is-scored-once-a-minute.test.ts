import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { db, measure, sampleSize, moderatorPerformance, teamPerformance } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn(async (): Promise<unknown[]> => []) } },
  measure: vi.fn(async () => ({ count: 0, amount: 0, orderIds: [] as string[] })),
  sampleSize: vi.fn(async () => 0),
  moderatorPerformance: vi.fn(async () => [] as unknown[]),
  teamPerformance: vi.fn(async (): Promise<{ employees: unknown[]; totals: object }> => ({ employees: [], totals: {} })),
}));
vi.mock('./db', () => ({ db }));
vi.mock('./commission-metrics', () => ({
  measure: (...a: unknown[]) => measure(...(a as [])),
  sampleSize: (...a: unknown[]) => sampleSize(...(a as [])),
}));
vi.mock('./attribution-performance', () => ({ moderatorPerformance: () => moderatorPerformance() }));
vi.mock('./team-performance', () => ({ teamPerformance: (...a: unknown[]) => teamPerformance(...(a as [])) }));

import { scoreRole } from './performance-metrics';
import { laneAnswers } from './heavy-lane';

/**
 * A ROLE IS SCORED ONCE FOR EVERYBODY WHO ASKS IN THE SAME MINUTE.
 *
 * The owner, 13/11: the site hung, and the team table was the one thing computed for every person who opened her profile.
 * The card, the score board and the users list all score the WHOLE role, so the first to ask works it out — in the reports'
 * lane — and whoever asks while it is being worked out, or within the minute after, reads that. What is shared is the
 * user-independent answer: who may read whose row is decided by each door before it asks.
 */

const SCOPE = {
  companyId: 'c1',
  storeId: 's1',
  start: new Date('2026-10-01T00:00:00Z'),
  end: new Date('2026-11-01T00:00:00Z'),
  calendar: { workHoursStart: '09:00', workHoursEnd: '18:00', weekendDays: [5, 6], timezone: 'Asia/Damascus' },
};
const PEOPLE = [{ id: 'a', name: 'وكيل' }];

/** A computation that waits until the test says so, so that «at the same time» is real. */
function slowTeam() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  teamPerformance.mockImplementation(async () => {
    await gate;
    return { employees: [], totals: {} };
  });
  return release;
}

beforeEach(() => {
  vi.clearAllMocks();
  laneAnswers.clear();
  db.order.findMany.mockResolvedValue([]);
  teamPerformance.mockResolvedValue({ employees: [], totals: {} });
});

describe('two askers at the same time', () => {
  it('share one computation, and read the very same rows', async () => {
    const release = slowTeam();
    const first = scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    const second = scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(teamPerformance).toHaveBeenCalledTimes(1);
    expect(measure.mock.calls.length).toBeGreaterThan(0);
    const readsForOne = measure.mock.calls.length;
    expect(b).toBe(a);
    // and the work of ONE pass is the work that was done, not two passes' worth
    measure.mockClear();
    await scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    expect(measure.mock.calls.length).toBe(readsForOne);
  });

  it('even when their windows end a second apart — the end is «now», and it is not part of the question', async () => {
    const release = slowTeam();
    const first = scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    const second = scoreRole({ ...SCOPE, end: new Date(SCOPE.end.getTime() + 1000) }, 'CONFIRMATION_AGENT', PEOPLE, 10);
    release();
    await Promise.all([first, second]);
    expect(teamPerformance).toHaveBeenCalledTimes(1);
  });

  it('but a different role, window, minimum sample, people or calendar is another question', async () => {
    // what ONE pass of one person costs in reads, measured alone first
    await scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    const onePerson = measure.mock.calls.length;
    expect(onePerson).toBeGreaterThan(0);
    vi.clearAllMocks();
    laneAnswers.clear();
    teamPerformance.mockResolvedValue({ employees: [], totals: {} });
    db.order.findMany.mockResolvedValue([]);

    const release = slowTeam();
    const asks = [
      scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10),
      scoreRole(SCOPE, 'CONFIRMATION_SUPERVISOR', PEOPLE, 10),
      scoreRole({ ...SCOPE, start: new Date('2026-10-08T00:00:00Z') }, 'CONFIRMATION_AGENT', PEOPLE, 10),
      scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 25),
      scoreRole(SCOPE, 'CONFIRMATION_AGENT', [...PEOPLE, { id: 'b', name: 'وكيلة' }], 10),
      scoreRole({ ...SCOPE, storeId: 's2' }, 'CONFIRMATION_AGENT', PEOPLE, 10),
      scoreRole({ ...SCOPE, calendar: { ...SCOPE.calendar, workHoursEnd: '20:00' } }, 'CONFIRMATION_AGENT', PEOPLE, 10),
    ];
    release();
    await Promise.all(asks);
    // Seven different questions of the score: seven passes. They ask for FOUR different team tables — the table's own question
    // is the store, the window and the calendar, so the two roles, the other minimum sample and the longer list of people all
    // read the first one — and each of the four was worked out once.
    // eight person-passes in all (the list of two people is two), none of them shared
    expect(measure.mock.calls.length).toBe(8 * onePerson);
    expect(teamPerformance).toHaveBeenCalledTimes(4);
  });
});

describe('the two agent roles ask for one team table', () => {
  it('and the second joins the first while it is being worked out', async () => {
    const release = slowTeam();
    const asks = [scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10), scoreRole(SCOPE, 'CONFIRMATION_SUPERVISOR', PEOPLE, 10)];
    release();
    await Promise.all(asks);
    expect(teamPerformance).toHaveBeenCalledTimes(1);
    // each role was still scored for itself
    expect(measure.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('but the table is never kept for the next asker (a second pass, one after the other, reads it again)', async () => {
    await scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    await scoreRole(SCOPE, 'CONFIRMATION_SUPERVISOR', PEOPLE, 10);
    expect(teamPerformance).toHaveBeenCalledTimes(2);
  });
});

describe('a failed pass is nobody\'s answer', () => {
  it('is not kept: the next to ask works it out again', async () => {
    teamPerformance.mockRejectedValueOnce(new Error('the database did not answer'));
    await expect(scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10)).rejects.toThrow('the database did not answer');
    teamPerformance.mockResolvedValue({ employees: [], totals: {} });
    await expect(scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10)).resolves.toBeTruthy();
    expect(teamPerformance).toHaveBeenCalledTimes(2);
  });

  it('and the two who were waiting on it both hear the failure', async () => {
    let fail: (e: Error) => void = () => {};
    teamPerformance.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const first = scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    const second = scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    // let both reach the shared computation before it fails
    await new Promise((r) => setImmediate(r));
    fail(new Error('timed out'));
    await expect(first).rejects.toThrow('timed out');
    await expect(second).rejects.toThrow('timed out');
    expect(teamPerformance).toHaveBeenCalledTimes(1);
  });
});

describe('for the minute after, outside a test (a real lifetime)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is kept for sixty seconds and worked out again after that', async () => {
    // the lifetime is read when the lane loads, and it is zero under test: load it as production would
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
    const lane = await import('./heavy-lane');
    lane.laneAnswers.clear();
    const metrics = await import('./performance-metrics');

    const a = await metrics.scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    vi.setSystemTime(new Date('2026-11-13T10:00:40Z'));
    const b = await metrics.scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    expect(b).toBe(a);
    expect(teamPerformance).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-13T10:01:05Z'));
    const c = await metrics.scoreRole(SCOPE, 'CONFIRMATION_AGENT', PEOPLE, 10);
    expect(c).not.toBe(a);
    expect(teamPerformance).toHaveBeenCalledTimes(2);
    lane.laneAnswers.clear();
  });
});
