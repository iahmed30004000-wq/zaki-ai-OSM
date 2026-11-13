import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollGate } from './poll-gate';

/**
 * A POLL THAT DOES NOT ASK ON TOP OF ITS OWN QUESTION (13/11 — the site's slow-down, plan PR-5).
 *
 * The rule, to the millisecond: a call that is still out blocks the next automatic one (until it has been out for ninety
 * seconds); a call that took more than two seconds makes the next automatic one wait four times as long as it took — a minute at
 * most; only the newest call counts; a call that returns nothing is not followed at all.
 */

const T0 = new Date('2026-11-13T09:00:00Z').getTime();

/** A call the test settles by hand. */
function deferred() {
  let ok!: (v?: unknown) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise((resolve, reject) => {
    ok = resolve;
    fail = reject;
  });
  return { promise, ok, fail };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('nothing out, nothing slow', () => {
  it('a fresh gate lets everything through', () => {
    const gate = pollGate();
    expect(gate.busy(T0)).toBe(false);
    expect(gate.tooSoonAfterSlow(T0)).toBe(false);
  });
});

describe('a call that is still out', () => {
  it('blocks the next automatic call until it has been out for ninety seconds, and not a millisecond longer', () => {
    const gate = pollGate();
    gate.follow(deferred().promise, T0);
    expect(gate.busy(T0)).toBe(true);
    expect(gate.busy(T0 + 89_999)).toBe(true);
    expect(gate.busy(T0 + 90_000), 'تسعين ثانية: الطلب اللي ما بيجاوب ما بيضل يمنع').toBe(false);
  });

  it('is out of the way the moment it answers — either way', async () => {
    const gate = pollGate();
    const a = deferred();
    gate.follow(a.promise, T0);
    a.ok();
    await settled();
    expect(gate.busy(T0 + 1)).toBe(false);

    // …and a failure is an end too (the rejection itself is rethrown to nobody who listens, as before: see the next test)
    const seen: unknown[] = [];
    const thenable = { then: (_ok: (v: unknown) => void, bad: (e: unknown) => void) => { try { bad(new Error('boom')); } catch (e) { seen.push(e); } } };
    gate.follow(deferred().promise, T0 + 2);
    expect(gate.busy(T0 + 3)).toBe(true);
    gate.follow(thenable, T0 + 4);
    expect(gate.busy(T0 + 5), 'فشل الطلب لازم ينهي «طالع»').toBe(false);
    expect(String(seen[0]), 'الفشل بيرجع متل ما هو').toContain('boom');
  });

  it('only the NEWEST call counts: an older one that settles late does not say «nothing is out»', async () => {
    const gate = pollGate();
    const older = deferred();
    const newer = deferred();
    gate.follow(older.promise, T0);
    gate.follow(newer.promise, T0 + 10);
    older.ok();
    await settled();
    expect(gate.busy(T0 + 20), 'الأقدم خلص بس الأحدث لسا طالع').toBe(true);
    newer.ok();
    await settled();
    expect(gate.busy(T0 + 30)).toBe(false);
  });

  it('a call that returns nothing is not followed at all, so the screen behaves as it always did', () => {
    const gate = pollGate();
    gate.follow(undefined, T0);
    gate.follow(null, T0);
    gate.follow(42, T0);
    gate.follow({}, T0);
    expect(gate.busy(T0 + 1)).toBe(false);
    expect(gate.tooSoonAfterSlow(T0 + 1)).toBe(false);
  });
});

describe('a slow answer makes the next automatic call wait four times as long as it took, a minute at most', () => {
  /** A call that is out from `T0` and answers after `ms`, with the clock moved to its arrival. */
  async function tookMs(gate: ReturnType<typeof pollGate>, ms: number) {
    const call = deferred();
    gate.follow(call.promise, T0);
    vi.setSystemTime(T0 + ms);
    call.ok();
    await settled();
    return T0 + ms; // when it arrived
  }

  it('five seconds: quiet for twenty, to the millisecond', async () => {
    const gate = pollGate();
    const arrived = await tookMs(gate, 5_000);
    expect(gate.tooSoonAfterSlow(arrived)).toBe(true);
    expect(gate.tooSoonAfterSlow(arrived + 19_999)).toBe(true);
    expect(gate.tooSoonAfterSlow(arrived + 20_000)).toBe(false);
  });

  it('thirty seconds: four times would be two minutes, so a minute', async () => {
    const gate = pollGate();
    const arrived = await tookMs(gate, 30_000);
    expect(gate.tooSoonAfterSlow(arrived + 59_999)).toBe(true);
    expect(gate.tooSoonAfterSlow(arrived + 60_000)).toBe(false);
  });

  it('two seconds exactly is NOT slow, two seconds and a millisecond is', async () => {
    const exact = pollGate();
    const e = await tookMs(exact, 2_000);
    expect(exact.tooSoonAfterSlow(e)).toBe(false);

    vi.setSystemTime(T0);
    const over = pollGate();
    const o = await tookMs(over, 2_001);
    expect(over.tooSoonAfterSlow(o)).toBe(true);
  });

  it('a fast answer after a slow one ends the quiet: the NEWEST answer is the one that counts', async () => {
    const gate = pollGate();
    const arrived = await tookMs(gate, 5_000);
    expect(gate.tooSoonAfterSlow(arrived + 1)).toBe(true);
    const quick = deferred();
    gate.follow(quick.promise, arrived + 2);
    vi.setSystemTime(arrived + 100);
    quick.ok();
    await settled();
    expect(gate.tooSoonAfterSlow(arrived + 101)).toBe(false);
  });

  it('a slow FAILURE counts as slow too — a server that took ten seconds to say no is still a slow server', async () => {
    const gate = pollGate();
    const seen: unknown[] = [];
    let release!: () => void;
    const slowFailure = { then: (_ok: (v: unknown) => void, bad: (e: unknown) => void) => { release = () => { try { bad(new Error('x')); } catch (e) { seen.push(e); } }; } };
    gate.follow(slowFailure, T0);
    vi.setSystemTime(T0 + 10_000);
    release();
    expect(gate.tooSoonAfterSlow(T0 + 10_000)).toBe(true);
    expect(gate.tooSoonAfterSlow(T0 + 10_000 + 39_999)).toBe(true);
    expect(gate.tooSoonAfterSlow(T0 + 10_000 + 40_000)).toBe(false);
  });
});
