import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tallyScorecard, type ScoreInputs } from './agent-scorecard';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SCORECARD'S TALLY HANDS THE THREAD BACK, AND COUNTS EXACTLY WHAT IT COUNTED (H2, cause 8 of the hang — 18/11).
 *
 * The tally ran over up to 50,000 claims and 100,000 attempt lines without ever letting the one thread go, and grew its per-order lists by
 * copying them on every line (`[...list, x]`). Now the lists grow with `push`, and the tally (`tallyScorecard`, a promise now) yields a turn
 * every few thousand rows (`breatheEvery`). The ROWS ARE THE SAME: `the-scorecard-breathes-and-counts-the-same.golden.json` was written by this
 * test from osm/main's `tallyScorecard` (`WRITE_GOLDEN=1`, before the change) on the generated window below — two agents and a third, several
 * days across the store's midnight, quick releases, reversed decisions, presses and messages, both grains.
 * ═══════════════════════════════════════════════════════════════════════
 */

const GOLDEN = 'src/lib/the-scorecard-breathes-and-counts-the-same.golden.json';
const CAL = { workHoursStart: '09:00', workHoursEnd: '21:00', weekendDays: [5], timezone: 'Asia/Damascus' };
const START = Date.parse('2026-11-08T05:00:00.000Z');
const NOW = new Date('2026-11-18T09:00:00.000Z');

/** A fixed pseudo-random walk (mulberry32): the same window every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function windowOf(size: number, grain: 'day' | 'week'): ScoreInputs {
  const r = rng(size * 7 + (grain === 'week' ? 1 : 0));
  const users = ['u1', 'u2', 'u3'];
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const at = (base: number, spreadMs: number) => new Date(base + Math.floor(r() * spreadMs));
  const claims: ScoreInputs['claims'][number][] = [];
  const releases: ScoreInputs['releases'][number][] = [];
  const decisions: ScoreInputs['decisions'][number][] = [];
  const attempts: ScoreInputs['attempts'][number][] = [];
  const confirmations: ScoreInputs['confirmations'][number][] = [];
  const winbackOffers: ScoreInputs['winbackOffers'][number][] = [];
  const upsold = new Set<string>();
  for (let k = 0; k < size; k++) {
    const userId = pick(users);
    const orderId = `o${Math.floor(r() * size * 0.6)}`; // the same order claimed more than once, by more than one
    const claimAt = at(START, 10 * 86_400_000);
    claims.push({ userId, orderId, at: claimAt });
    if (r() < 0.3) releases.push({ userId, orderId, at: new Date(claimAt.getTime() + Math.floor(r() * 120_000)) }); // half under a minute
    if (r() < 0.1) releases.push({ userId: pick(users), orderId, at: new Date(claimAt.getTime() - 5_000) }); // before the claim, or a colleague's
    const lines = Math.floor(r() * 4);
    for (let j = 0; j < lines; j++) {
      attempts.push({ userId: r() < 0.85 ? userId : pick(users), orderId, result: pick(['NO_ANSWER', 'BUSY', 'ANSWERED', 'OPENED', 'MESSAGE_SENT', 'CALLBACK_REQUESTED']), at: at(claimAt.getTime() - 600_000, 6 * 3_600_000) });
    }
    if (r() < 0.5) {
      const value = r() < 0.7 ? 'CONFIRMED' : 'REJECTED';
      const decidedAt = at(claimAt.getTime(), 3 * 3_600_000);
      decisions.push({ userId, orderId, value, at: decidedAt });
      if (r() < 0.1) decisions.push({ userId, orderId, value: value === 'CONFIRMED' ? 'REJECTED' : 'CONFIRMED', at: new Date(decidedAt.getTime() + 60_000) });
      if (value === 'CONFIRMED') {
        confirmations.push({ userId, orderId, at: decidedAt, shippingStatus: pick(['DELIVERED', 'RETURNED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'NOT_READY']) });
        if (r() < 0.2) upsold.add(`${userId}|${orderId}`);
      }
    }
    if (r() < 0.05) winbackOffers.push({ userId, at: at(START, 10 * 86_400_000), confirmed: r() < 0.5 });
  }
  return { now: NOW, grain, calendar: CAL, names: new Map([['u1', 'الموظفة أ'], ['u2', 'الموظفة ب']]), claims, releases, decisions, attempts, upsold, confirmations, winbackOffers };
}

const CASES: Array<[string, number, 'day' | 'week']> = [
  ['small-day', 40, 'day'],
  ['small-week', 40, 'week'],
  ['large-day', 6000, 'day'],
  ['large-week', 6000, 'week'],
];

describe('the scorecard counts the same rows', () => {
  it('the tally equals osm/main on every case (golden — written from osm/main\'s sync tally before the change)', async () => {
    const now: Record<string, unknown> = {};
    for (const [name, size, grain] of CASES) now[name] = await tallyScorecard(windowOf(size, grain));
    if (process.env.WRITE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(now)}\n`);
    expect(JSON.parse(JSON.stringify(now))).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('the tally gives the thread back during a large window, and a small one costs no turn', async () => {
    // A task queued just before the tally runs before the tally ends ONLY if the tally lets the thread go (the answer is awaited through
    // microtasks alone otherwise, and `setImmediate` waits for the next turn of the loop).
    const someoneElseRan = async (size: number) => {
      let ran = false;
      setImmediate(() => (ran = true));
      await tallyScorecard(windowOf(size, 'day'));
      return ran;
    };
    expect(await someoneElseRan(6000)).toBe(true);
    expect(await someoneElseRan(40)).toBe(false);
  });
});
