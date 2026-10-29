import { isDue, type Schedule } from './schedule';

/**
 * ONE PASS OF THE WORKER'S LOOP — AND WHEN IT NEXT HAS TO LOOK.
 *
 * What stood in `scripts/worker.ts` asked the database two questions about
 * EVERY job on EVERY second: «is it parked?» and «when did it last run?».
 * Fourteen jobs, two questions, once a second: about 28 queries a second,
 * two and a half million a day, on the same container as the website — to
 * learn, almost every time, that nothing was due yet.
 *
 * A job's next moment is not a surprise. The run log says when it last
 * started, the schedule says how long it waits, and between the two there
 * is nothing to find out. So a job that was found NOT due is not asked
 * about again until the moment it could become due.
 *
 * WHAT IS DELIBERATELY NOT CHANGED
 *   - when a job runs: an interval job still starts the second its
 *     interval has passed (`deliver-app-events` stays one run a minute);
 *   - how a job fails, backs off, alerts or is parked: that is `attempt`,
 *     passed in, untouched;
 *   - the run log stays the truth: after every run the job is asked about
 *     again from the log, never from this pass's memory of it.
 */

/**
 * A PARKED job waits for a person to press «try again», and that press is
 * a row in the log — so a parked job is looked at on a short beat, and the
 * press is seen within this long. Not at its interval: a parked daily job
 * would otherwise ignore the press for a day.
 */
export const PARKED_RECHECK_MS = 10_000;

/**
 * A job with a time of day («16:45») is looked at on a beat, not computed.
 * Working out the exact second a clock time arrives means time zones and
 * daylight saving, and a mistake there is a daily job that never runs.
 * The schedule itself has a minute's resolution, and half a minute late on a
 * job that runs once a day is not late.
 */
export const CLOCK_RECHECK_MS = 30_000;

/** What the loop remembers between passes. Both maps are about THIS process only. */
export interface TickState {
  /** A failing job's patience: not before this moment (ms). */
  retryAfter: Map<string, number>;
  /** A job that was found not due: not asked about before this moment (ms). */
  lookAt: Map<string, number>;
}

export function newTickState(): TickState {
  return { retryAfter: new Map(), lookAt: new Map() };
}

export interface TickDeps<J extends JobLike = JobLike> {
  isParked: (jobName: string) => Promise<boolean>;
  lastRun: (jobName: string) => Promise<{ startedAt: Date } | null>;
  /** Runs the job; returns the seconds to leave it alone after a failure (0 on success). */
  attempt: (job: J) => Promise<number>;
  /** The clock, in ms. */
  now: () => number;
}

export type JobLike = Schedule & { name: string };

/**
 * The moment (ms) a job that is NOT due now could first become due.
 *
 * Only called for a job `isDue` just said no to, so for an interval job the
 * answer is simply «last start + interval», which is in the future.
 */
export function lookAgainAt(job: Schedule, lastStartedAt: Date | null, now: number): number {
  if (job.at) return now + CLOCK_RECHECK_MS;
  if (!lastStartedAt) return now;
  return Math.max(lastStartedAt.getTime() + job.everySeconds * 1000, now);
}

/**
 * Walk the jobs once. `stopped` is asked between jobs, as the loop did, so a
 * shutdown signal waits for the current job and starts no further one.
 */
export async function tick<J extends JobLike>(
  jobs: readonly J[],
  state: TickState,
  deps: TickDeps<J>,
  stopped: () => boolean = () => false
): Promise<void> {
  const now = deps.now();
  for (const job of jobs) {
    if (stopped()) break;
    if ((state.retryAfter.get(job.name) ?? 0) > now) continue;
    // Found not due a moment ago, and nothing has happened that could change that yet.
    if ((state.lookAt.get(job.name) ?? 0) > now) continue;

    // Parked after too many consecutive failures. It stays parked until
    // a person presses "try again" on the jobs screen — retrying for ever
    // hammers a provider that is plainly not coming back, and buries every
    // other job's history under four thousand identical errors.
    if (await deps.isParked(job.name)) {
      state.lookAt.set(job.name, now + PARKED_RECHECK_MS);
      continue;
    }

    const last = await deps.lastRun(job.name);
    const startedAt = last?.startedAt ?? null;
    if (!isDue(job, startedAt, new Date(deps.now()))) {
      state.lookAt.set(job.name, lookAgainAt(job, startedAt, deps.now()));
      continue;
    }

    // It runs; whatever it leaves in the log is read afresh on the next pass.
    state.lookAt.delete(job.name);
    const wait = await deps.attempt(job);
    // Only a failure parks it; a success leaves the schedule to decide.
    if (wait > 0) state.retryAfter.set(job.name, deps.now() + wait * 1000);
  }
}
