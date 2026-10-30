import { db } from '../db';

/**
 * IS THE SCHEDULER ALIVE?
 *
 * The worker (scripts/worker.ts) is a SEPARATE PROCESS from the web app.
 * That is deliberate — but it means the app has no idea whether it is
 * running. Nothing crashes, nothing 500s, no screen turns red: the orders
 * simply stop being released back to the shared stock, the courier statuses
 * stop updating, the closing reminder stops arriving, and everybody assumes
 * it is a quiet day. This is the failure that motivated this file: a dead
 * worker is INVISIBLE, and an app that answers 200 while the worker is dead
 * buys false confidence, which is worse than no monitoring at all.
 *
 * The only trace the worker leaves is the run log — `JobRun`. So liveness is
 * answered the same way the schedule itself is answered: from the rows the
 * worker wrote, not from a variable a restart resets.
 *
 * ── WHY THESE THREE JOB NAMES, COPIED RATHER THAN DERIVED ──
 *
 * The honest heartbeat is "a job that fires every minute has fired
 * recently". Three jobs in `definitions/` have `everySeconds: 60`, so a
 * living worker writes a `JobRun` row at least once a minute.
 *
 * The names are COPIED here instead of being computed from `JOBS` on
 * purpose, and both reasons matter:
 *
 *   - `definitions/` pulls in commission accrual, backups, ad-spend
 *     providers, courier clients — the whole business. A health endpoint
 *     that cannot even be IMPORTED because an unrelated module threw at
 *     load time is a health endpoint that reports nothing exactly when
 *     something is wrong. This file imports the database client and nothing
 *     else.
 *   - It is polled every minute forever. Paying for that import graph on
 *     every cold start, for three string constants, is not a trade worth
 *     making.
 *
 * The copy cannot drift silently: `heartbeat.test.ts` asserts these are
 * still exactly the 60-second interval jobs in `JOBS`, and fails the build
 * if someone renames, retimes or removes one.
 */
export const HEARTBEAT_JOBS = [
  'deliver-app-events',
  'deliver-conversions',
  'escalate-change-requests',
] as const;

/**
 * How long without a single heartbeat row before the scheduler is called
 * dead.
 *
 * Three missed cycles of a 60-second job. Not one: a deploy, a slow
 * courier call or a long transaction can swallow a cycle, and a monitor
 * that flaps is a monitor somebody mutes — after which it is decoration.
 * Not ten minutes either: the whole point is to find out before the day's
 * work has silently stopped.
 */
export const SCHEDULER_STALE_SECONDS = 180;

/**
 * HOW LONG THE HEALTH QUESTION MAY TAKE BEFORE «NO ANSWER» IS THE ANSWER.
 *
 * A database that REFUSES a connection is easy: the query rejects and this
 * file says `db: 'down'` at once. The dangerous state is a database that
 * accepts the connection and never replies — the pool exhausted, the
 * server swapping, a lock held by a long transaction. Then the query hangs,
 * the route hangs with it, and the probe reading it learns nothing:
 *
 *   - Docker's `HEALTHCHECK` eventually kills its own `wget` on `--timeout`
 *     and counts a failure, so the container does come out right, three
 *     intervals late.
 *   - An uptime monitor records a slow 200 or a client timeout, which is
 *     not the same as 503 and does not page anybody.
 *   - And the hung request is holding a connection from the same exhausted
 *     pool it is waiting on.
 *
 * Two seconds. The real query is one index seek — about 0.1 ms measured —
 * so anything near this is already a sick database, and no honest reading
 * is lost by refusing to wait longer. It is not a retry and not a
 * circuit-breaker: it only turns «hanging» into the word the probe needs.
 */
export const DB_PING_TIMEOUT_MS = 2_000;

/** The race's loser, as a value that cannot collide with a row or `null`. */
const TIMED_OUT = Symbol('db-ping-timeout');

export type SchedulerState =
  /** A heartbeat row inside the window. The worker loop is turning. */
  | 'alive'
  /**
   * No heartbeat row inside the window — including "no rows at all", which
   * is a worker that has never started. Reported as stale rather than as
   * some gentler third word, because on a fresh install the jobs are just
   * as not-running as they are on a crashed one.
   */
  | 'stale'
  /**
   * The run log could not be read. The database answered, so the app is
   * fine, but nothing can be said about the worker — and claiming "alive"
   * because the question failed is precisely the false confidence this
   * file exists to prevent.
   */
  | 'unknown';

export interface HeartbeatReading {
  db: 'up' | 'down';
  scheduler: SchedulerState;
}

/**
 * "The table does not exist yet" — code deployed ahead of its migration.
 * On this project migrations are applied by hand (the dev server holds a
 * lock), so that window is normal and must not read as a database outage:
 * the app is reachable, the worker's state is simply unanswerable.
 *
 * Only P2021. A connection failure or a permissions problem is a different
 * fault and must not be laundered into "unknown".
 */
function missingTable(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2021';
}

/** The latest of the watched jobs' last runs. Null when none of them has ever run. */
function newest(rows: ({ startedAt: Date } | null)[]): { startedAt: Date } | null {
  let best: { startedAt: Date } | null = null;
  for (const row of rows) {
    if (row && (!best || row.startedAt.getTime() > best.startedAt.getTime())) best = row;
  }
  return best;
}

/**
 * ── COST PER CALL: ONE ROW PER WATCHED JOB, STRAIGHT OFF THE INDEX ──
 *
 * `JobRun` carries `@@index([jobName, startedAt])`. ONE job name with a
 * descending order on `startedAt` and a limit of one is a backward
 * index-only scan that stops at the first entry: no table access, no sort,
 * and flat however long the run log grows.
 *
 * It used to be ONE query with `jobName IN (three names)`, on the belief
 * that Postgres merges the three index ranges and stops at the first row.
 * It does not (Postgres 16, `EXPLAIN` on this schema): the index orders by
 * name first, so it read EVERY run of the three jobs and sorted them for
 * the newest. Each of them writes a row a minute and nothing prunes the
 * log, so that was ~4,300 more rows to read and sort every day, every five
 * seconds. Calm, it cost tens of milliseconds. On 27/10, while a deploy was
 * building on the same server, it crossed the 2 s cap below for twenty
 * minutes. So the endpoint said «db: down» with a working database, and
 * the container's own HEALTHCHECK, three misses in a row, can mark the app
 * unhealthy. A proxy that follows that stops routing to it.
 *
 * Three single-name reads in parallel cost one round trip of wall time and
 * stay one row each forever. The newest of the three answers the question
 * the single query asked.
 *
 * NOTE what is deliberately NOT here: no `count()`, no "last run of every
 * job", no `SELECT 1` liveness probe on top. A separate `SELECT 1` would
 * be another round trip to learn what these reads already prove: if they
 * returned, the database is up.
 *
 * `select: { startedAt: true }` and not the row: `detail` and `error` are
 * free text written by jobs, and an unauthenticated endpoint must not be
 * able to pull them into memory at all, let alone risk echoing them.
 */
export async function readHeartbeat(now: Date = new Date()): Promise<HeartbeatReading> {
  let latest: { startedAt: Date } | null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = Promise.all(
      HEARTBEAT_JOBS.map((jobName) =>
        db.jobRun.findFirst({
          where: { jobName },
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true },
        })
      )
    ).then(newest);
    /*
     * `Promise.race` subscribes to `query` itself, so a rejection that
     * arrives AFTER the timer won is already handled — it is ignored
     * rather than left to crash the process as an unhandled rejection.
     * That is the whole reason there is no second `.catch()` here.
     */
    const answer = await Promise.race([
      query,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), DB_PING_TIMEOUT_MS);
      }),
    ]);
    // A database that hangs is reported exactly like one that refused: the
    // app cannot serve, and the probe needs a word, not a longer wait.
    if (answer === TIMED_OUT) return { db: 'down', scheduler: 'unknown' };
    latest = answer;
  } catch (e) {
    // The query reaching the server and failing on a missing relation
    // proves the connection; anything else does not.
    if (missingTable(e)) return { db: 'up', scheduler: 'unknown' };
    return { db: 'down', scheduler: 'unknown' };
  } finally {
    // Otherwise every answered request leaves a pending timer behind, and
    // a process with pending timers does not exit when it is asked to.
    clearTimeout(timer);
  }

  if (!latest) return { db: 'up', scheduler: 'stale' };

  const ageSeconds = (now.getTime() - latest.startedAt.getTime()) / 1000;
  return { db: 'up', scheduler: ageSeconds <= SCHEDULER_STALE_SECONDS ? 'alive' : 'stale' };
}
