import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * THE REPORTS LANE — slow, many-query reads run apart from the work people are waiting on (the owner, 13/11).
 *
 *   «لوحة الأداء فيها مشاكل كثيييرة بتضل تعلق والسايت في بطئ بشكل عام — حل المشكلة من جذورها»
 *
 * ── THE CAUSE, MEASURED IN THE CODE ──
 *
 * One page of the performance board makes four requests at the same moment (`PerformanceScreen`). Each of them starts its queries
 * with `Promise.all`: the shipping answer starts SEVEN per delivery company (about seventy for ten companies), the people answer
 * fourteen, the totals fourteen, the team table twelve — a hundred and more in the same instant, against ONE pool of twenty
 * connections that every other screen shares. The pool is full for as long as the report runs, so a girl's «اسحب» and every
 * navigation's session check wait in the same queue, and a query that waits past Prisma's ten seconds fails with P2024 — the «stuck»
 * screen. A report is only a few seconds of work; the damage is that it is done IN FRONT of everybody else, and again for every tab
 * that asks.
 *
 * ── THE TWO PARTS OF THE ANSWER ──
 *
 * 1. THE LANE. `runInHeavyLane` marks everything started inside it, and `db` (lib/db.ts) sends the marked queries to a second client
 *    whose pool is `HEAVY_POOL` (6) connections. However many queries a report fans out, six run at a time and the rest wait their
 *    turn INSIDE the report's own pool; the twenty connections the rest of the site uses are never touched by a report.
 * 2. ONE ANSWER FOR ONE QUESTION (`heavyOnce`). Two people (or one person's four tabs, or a screen that comes back into focus) asking
 *    the same question for the same window share ONE computation while it runs, and the finished answer is kept for a short while
 *    (`REPORT_TTL_MS`). A page that timed out on the client is not wasted work either: the computation keeps going, and «إعادة
 *    المحاولة» finds it done.
 *
 * What is cached is the USER-INDEPENDENT answer only. Who may see which part of it is decided after, per person, by the caller
 * (`projectAnalytics` and the `can(...)` checks) — the cache never holds a figure on behalf of somebody who may not read it.
 *
 * The lane keeps no state of its own beyond the small map of answers (at most `MAX_ANSWERS`, oldest dropped); a failed computation
 * is never kept, and the next asker recomputes.
 */

interface Lane {
  heavy: true;
}

/**
 * KEPT ON `globalThis`, FOR THE REASON `db.ts` KEEPS ITS CLIENTS THERE (RV187).
 *
 * A production build evaluates a module once per BUNDLE — the route layers and the server-rendered pages each get a copy — so two
 * files that both import this one can hold two different `AsyncLocalStorage`s: the route would mark the lane in one and `db` would
 * look for the mark in another, and nothing would ever be routed. `globalThis` is shared across those copies: one lane, one map.
 */
const shared = globalThis as unknown as {
  __osmReportsLane?: AsyncLocalStorage<Lane>;
  __osmReportsAnswers?: Map<string, Slot>;
};

const lane = (shared.__osmReportsLane ??= new AsyncLocalStorage<Lane>());

/** Is the code running here a report? `db` reads this to pick its client. */
export function inHeavyLane(): boolean {
  return lane.getStore()?.heavy === true;
}

/** Run `work` — and every query it starts, however deep — as a report. */
export function runInHeavyLane<T>(work: () => Promise<T>): Promise<T> {
  return lane.run({ heavy: true }, work);
}

/**
 * How long a finished report is kept. The dashboard has always refreshed «الكل» every two minutes and the board only when somebody
 * comes back to it, so a minute of sameness is not a lie anyone can tell — and it turns «every tab asks again» into one question.
 * Zero under test, so a test that changes its mock between two calls is never answered from the first.
 */
export const REPORT_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 60_000;

const MAX_ANSWERS = 200;

interface Slot {
  /** When the kept answer was made (or when the question was first asked, while it is still being computed). */
  at: number;
  /** The kept answer, once there is one. */
  kept?: { value: unknown };
  /** The computation in flight, while there is one: everybody who asks meanwhile joins it. */
  flight?: Promise<unknown>;
}

const answers = (shared.__osmReportsAnswers ??= new Map<string, Slot>());

/** The map of kept answers — read by the lane itself (to drop the oldest) and cleared by a test. */
export const laneAnswers = {
  get size() {
    return answers.size;
  },
  clear() {
    answers.clear();
  },
};

function dropOldest() {
  while (laneAnswers.size > MAX_ANSWERS) {
    let oldest: string | null = null;
    let at = Infinity;
    for (const [key, slot] of answers) {
      if (!slot.flight && slot.at < at) {
        at = slot.at;
        oldest = key;
      }
    }
    if (oldest === null) return;
    answers.delete(oldest);
  }
}

/**
 * ONE ANSWER FOR ONE QUESTION, computed in the lane.
 *
 * `key` names the question completely (route, company, store, the window — never a user). `compute` is what answers it; it runs
 * at most once at a time for a key, and its result is kept `ttlMs` (0: only shared while it is running, never kept).
 */
export async function heavyOnce<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const slot = answers.get(key);
  if (slot?.kept && ttlMs > 0 && now - slot.at < ttlMs) return slot.kept.value as T;
  if (slot?.flight) return slot.flight as Promise<T>;

  const flight = runInHeavyLane(compute).then(
    (value) => {
      if (ttlMs > 0) {
        answers.set(key, { at: Date.now(), kept: { value } });
        dropOldest();
      } else {
        answers.delete(key);
      }
      return value;
    },
    (error) => {
      // A failure is nobody's answer: the next one to ask computes again.
      answers.delete(key);
      throw error;
    }
  );
  answers.set(key, { at: now, flight });
  return flight;
}
