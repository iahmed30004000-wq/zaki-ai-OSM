import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE WORKER ASKED THE DATABASE 28 QUESTIONS A SECOND TO LEARN NOTHING.
 *
 * Every second, for each of the fourteen jobs: «is it parked?» and «when
 * did it last run?». These tests drive the loop's one pass (`tick`) over a
 * simulated minute with a counting fake in place of the database, and say
 * two things at once:
 *
 *   1. an idle scheduler asks almost nothing, and
 *   2. everything the scheduler DID do is unchanged: a job still starts
 *      the second it is due, a parked job still wakes when a person presses
 *      «try again», a failing job still waits out its backoff, and a job
 *      that just ran is not run again in the same interval.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db } = vi.hoisted(() => ({ db: { jobRun: { findFirst: vi.fn(), findMany: vi.fn() } } }));
vi.mock('../db', () => ({ db, default: db }));

import { JOBS } from './definitions';
import {
  CLOCK_RECHECK_MS,
  PARKED_RECHECK_MS,
  lookAgainAt,
  newTickState,
  tick,
  type JobLike,
} from './tick';

const T0 = new Date('2026-10-30T09:00:00.000Z').getTime();

/** A database that is only a run log, with a counter on every question. */
function world() {
  const log = new Map<string, { startedAt: Date; status: string }[]>();
  const asked = { isParked: 0, lastRun: 0 };
  const ran: { name: string; at: number }[] = [];
  let clock = T0;
  let failNext = new Set<string>();

  const lastOf = (name: string) => (log.get(name) ?? []).at(-1) ?? null;
  const deps = {
    now: () => clock,
    isParked: async (name: string) => {
      asked.isParked++;
      const rows = (log.get(name) ?? []).filter((r) => ['SUCCEEDED', 'FAILED', 'GAVE_UP'].includes(r.status));
      return rows.at(-1)?.status === 'GAVE_UP';
    },
    lastRun: async (name: string) => {
      asked.lastRun++;
      return lastOf(name);
    },
    attempt: async (job: JobLike) => {
      ran.push({ name: job.name, at: clock });
      const failed = failNext.has(job.name);
      log.set(job.name, [...(log.get(job.name) ?? []), { startedAt: new Date(clock), status: failed ? 'FAILED' : 'SUCCEEDED' }]);
      return failed ? 30 : 0;
    },
  };
  return {
    deps,
    asked,
    ran,
    log,
    failing: (names: string[]) => (failNext = new Set(names)),
    advance: (ms: number) => (clock += ms),
    at: () => clock,
    ranAt: (name: string) => ran.filter((r) => r.name === name).map((r) => (r.at - T0) / 1000),
  };
}

/** What the real loop does: a pass, then a second of rest. */
async function runFor(seconds: number, w: ReturnType<typeof world>, jobs: JobLike[], state = newTickState()) {
  for (let s = 0; s < seconds; s++) {
    await tick(jobs, state, w.deps);
    w.advance(1000);
  }
  return state;
}

const every = (name: string, everySeconds: number): JobLike => ({ name, everySeconds });
const daily = (name: string, at: string): JobLike => ({ name, everySeconds: 86_400, at, timezone: 'UTC' });

let w: ReturnType<typeof world>;
beforeEach(() => {
  w = world();
});

describe('an idle scheduler asks the database almost nothing', () => {
  it('fourteen jobs for ten minutes: about four hundred questions, not the sixteen thousand it used to be', async () => {
    // Everything ran a moment ago, so for ten minutes the only thing that can happen is the
    // minute jobs coming due. The old loop asked 2 × 14 × 600 = 16 800 questions.
    for (const j of JOBS) w.log.set(j.name, [{ startedAt: new Date(T0 - 1000), status: 'SUCCEEDED' }]);
    await runFor(600, w, JOBS);

    const questions = w.asked.isParked + w.asked.lastRun;
    expect(questions, 'المجدول ما زال يسأل القاعدة كل ثانية').toBeLessThan(600);
  });

  it('and a pass in which nothing is due, straight after a pass that found that out, asks nothing at all', async () => {
    const jobs = [every('slow', 3600), daily('night', '23:00')];
    for (const j of jobs) w.log.set(j.name, [{ startedAt: new Date(T0 - 1000), status: 'SUCCEEDED' }]);
    const state = newTickState();
    await tick(jobs, state, w.deps);
    const afterFirst = { ...w.asked };
    w.advance(1000);
    await tick(jobs, state, w.deps);
    expect(w.asked).toEqual(afterFirst);
  });
});

describe('and nothing the scheduler did is different', () => {
  it('an interval job starts the second its interval has passed — a minute job runs once a minute', async () => {
    const job = every('deliver-like', 60);
    w.log.set(job.name, [{ startedAt: new Date(T0), status: 'SUCCEEDED' }]);
    await runFor(185, w, [job]);
    // Last started at 0; due at 60, then 120, then 180 — the very second, not a beat later.
    expect(w.ranAt(job.name)).toEqual([60, 120, 180]);
  });

  it('a job that has never run starts on the first pass', async () => {
    const job = every('fresh', 300);
    await runFor(2, w, [job]);
    expect(w.ranAt(job.name)).toEqual([0]);
  });

  it('a job that just ran is not run again inside its interval — however many passes there are', async () => {
    const job = every('once-an-hour', 3600);
    await runFor(600, w, [job]);
    expect(w.ranAt(job.name), 'اشتغلت مرتين بنفس الفاصل').toEqual([0]);
  });

  it('EVERY real job runs at most once in a window shorter than its interval, run twice in a row or not', async () => {
    // The scheduler-level «run it twice» claim for all fourteen: the second pass, right after the first,
    // must not start anything the first one started.
    const state = newTickState();
    await tick(JOBS, state, w.deps);
    const first = w.ran.length;
    expect(first, 'ولا مهمة اشتغلت').toBeGreaterThan(0);
    w.advance(1000);
    await tick(JOBS, state, w.deps);
    expect(w.ran.length, 'مهمة اشتغلت مرتين ورا بعض').toBe(first);
    // …and a brand-new loop (a restarted worker) reads the same log and runs nothing new either.
    await tick(JOBS, newTickState(), w.deps);
    expect(w.ran.length, 'عامل أُعيد تشغيله شغّل مهمة مرتين').toBe(first);
  });

  it('a daily job at a clock time runs once, when its time comes, and not again that day', async () => {
    const job = daily('night', '09:01');
    w.log.set(job.name, [{ startedAt: new Date(T0 - 24 * 3600 * 1000), status: 'SUCCEEDED' }]);
    await runFor(180, w, [job]);
    // 09:01 is second 60 of the simulation; the beat is 30 s, so it starts within one beat of the minute.
    const [first, ...rest] = w.ranAt(job.name);
    expect(first).toBeGreaterThanOrEqual(60);
    expect(first).toBeLessThanOrEqual(60 + CLOCK_RECHECK_MS / 1000);
    expect(rest, 'اشتغلت مرتين باليوم').toEqual([]);
  });

  it('a parked job stays parked, and wakes within one beat of a person pressing «try again»', async () => {
    const job = every('parked', 60);
    w.log.set(job.name, [{ startedAt: new Date(T0 - 600_000), status: 'GAVE_UP' }]);
    const state = newTickState();
    await runFor(120, w, [job], state);
    expect(w.ranAt(job.name), 'اشتغلت وهي موقوفة').toEqual([]);

    // The press: a SUCCEEDED row written by `unpark`.
    const pressedAt = (w.at() - T0) / 1000;
    w.log.set(job.name, [...w.log.get(job.name)!, { startedAt: new Date(w.at()), status: 'SUCCEEDED' }]);
    await runFor(120, w, [job], state);
    // Not parked any more; its interval counts from the press, so it runs 60 s after it.
    const [first] = w.ranAt(job.name);
    expect(first).toBeGreaterThanOrEqual(pressedAt + 60);
    expect(first).toBeLessThanOrEqual(pressedAt + 60 + PARKED_RECHECK_MS / 1000);
  });

  it('a failing job waits out its backoff and then tries again', async () => {
    const job = every('flaky', 60);
    w.failing(['flaky']);
    const state = await runFor(25, w, [job]);
    // Failed at 0 and asked to be left alone 30 s: one try in the first 25 seconds.
    expect(w.ranAt(job.name)).toEqual([0]);
    expect(state.retryAfter.get('flaky')).toBe(T0 + 30_000);
    await runFor(40, w, [job], state);
    // After the backoff the interval (60 s from the failed start) still has to pass: due at 60.
    expect(w.ranAt(job.name)).toEqual([0, 60]);
  });

  it('a shutdown signal between jobs starts no further job', async () => {
    const jobs = [every('a', 60), every('b', 60)];
    let stop = false;
    const deps = { ...w.deps, attempt: async (j: JobLike) => { stop = true; return w.deps.attempt(j); } };
    await tick(jobs, newTickState(), deps, () => stop);
    expect(w.ran.map((r) => r.name)).toEqual(['a']);
  });

  it('a job another worker ran in the meantime is seen at the next look, and not run on top of it', async () => {
    const job = every('shared', 60);
    w.log.set(job.name, [{ startedAt: new Date(T0), status: 'SUCCEEDED' }]);
    const state = newTickState();
    await tick([job], state, w.deps); // not due; will look again at 60
    // Another container runs it at 59.5 s.
    w.advance(59_500);
    w.log.set(job.name, [...w.log.get(job.name)!, { startedAt: new Date(w.at()), status: 'SUCCEEDED' }]);
    w.advance(500);
    await tick([job], state, w.deps);
    expect(w.ran, 'شغّلتها فوق عامل تاني').toEqual([]);
  });
});

describe('when to look again', () => {
  const NOW = T0;
  it('an interval job: exactly when its interval ends', () => {
    expect(lookAgainAt(every('x', 60), new Date(NOW - 10_000), NOW)).toBe(NOW + 50_000);
  });
  it('a clock job: one beat from now', () => {
    expect(lookAgainAt(daily('x', '08:00'), new Date(NOW - 10_000), NOW)).toBe(NOW + CLOCK_RECHECK_MS);
  });
  it('NEGATIVE: never in the past — a job whose moment has passed is looked at now, not before', () => {
    expect(lookAgainAt(every('x', 60), new Date(NOW - 120_000), NOW)).toBe(NOW);
    expect(lookAgainAt(every('x', 60), null, NOW)).toBe(NOW);
  });
});

describe('and the real worker uses this pass, not a loop of its own', () => {
  const worker = stripComments(readFileSync(join(process.cwd(), 'scripts', 'worker.ts'), 'utf8'));

  it('the continuous loop calls tick, and does not ask the log about a job itself', () => {
    expect(worker, 'العامل ما عاد يستعمل tick').toMatch(/await tick\(/);
    expect(worker, 'العامل رجع يسأل القاعدة عن كل مهمة كل ثانية').not.toMatch(/isParked\(job\.name\)/);
    expect(worker).not.toMatch(/lastRun\(job\.name\)/);
  });
});
