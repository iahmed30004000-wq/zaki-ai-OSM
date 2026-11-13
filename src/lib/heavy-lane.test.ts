import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_TTL_MS, heavyOnce, inHeavyLane, laneAnswers, runInHeavyLane } from './heavy-lane';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE REPORTS' LANE (the owner, 13/11: «لوحة الأداء بتضل تعلق والسايت بطيء بشكل عام — حل المشكلة من جذورها»)
 *
 *  1. Code run inside `runInHeavyLane` — and everything it starts, through awaits, `Promise.all` and timers — is marked as a report;
 *     code outside it, and the next request after it, is not.
 *  2. `heavyOnce` computes ONE answer for one question however many ask at once, in the lane; it keeps the finished answer for the
 *     ttl it was given (never when the ttl is 0), and never keeps a failure.
 *  3. Different questions never share an answer; the kept answers are bounded.
 *  4. Two copies of this module (a production build makes one per bundle) share ONE lane and ONE map: the route marks the lane in
 *     one copy and `db` reads it in another.
 * ═══════════════════════════════════════════════════════════════════════
 */

beforeEach(() => laneAnswers.clear());
afterEach(() => {
  vi.useRealTimers();
  laneAnswers.clear();
});

describe('the lane marks a report, and only a report', () => {
  it('is off outside, on inside — through awaits, Promise.all and timers — and off again after', async () => {
    expect(inHeavyLane()).toBe(false);
    const seen: boolean[] = [];
    await runInHeavyLane(async () => {
      seen.push(inHeavyLane());
      await Promise.resolve();
      seen.push(inHeavyLane());
      await Promise.all([
        (async () => {
          await new Promise((r) => setTimeout(r, 1));
          seen.push(inHeavyLane());
        })(),
        Promise.resolve().then(() => seen.push(inHeavyLane())),
      ]);
    });
    expect(seen).toEqual([true, true, true, true]);
    expect(inHeavyLane()).toBe(false);
  });

  it('a request that is NOT a report, running at the same moment, is not marked', async () => {
    let inside = false;
    let outside = true;
    const report = runInHeavyLane(async () => {
      await new Promise((r) => setTimeout(r, 5));
      inside = inHeavyLane();
    });
    const other = (async () => {
      await new Promise((r) => setTimeout(r, 2));
      outside = inHeavyLane();
    })();
    await Promise.all([report, other]);
    expect(inside).toBe(true);
    expect(outside).toBe(false);
  });
});

describe('one answer for one question', () => {
  it('computes ONCE for four askers at the same moment, in the lane, and all four get the same answer', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const compute = vi.fn(async () => {
      calls += 1;
      expect(inHeavyLane(), 'the computation must run in the lane').toBe(true);
      await gate;
      return { n: calls };
    });
    const asks = [1, 2, 3, 4].map(() => heavyOnce('q', 0, compute));
    release();
    const answers = await Promise.all(asks);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }, { n: 1 }]);
    // the very same object — nobody got a private copy that could drift
    expect(new Set(answers).size).toBe(1);
  });

  it('with a ttl of 0 nothing is kept: the next asker computes again', async () => {
    const compute = vi.fn(async () => ({ at: Math.random() }));
    const a = await heavyOnce('q', 0, compute);
    const b = await heavyOnce('q', 0, compute);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
    expect(laneAnswers.size).toBe(0);
  });

  it('with a ttl the finished answer is kept until it runs out — then computed again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
    const compute = vi.fn(async () => ({ at: Date.now() }));
    const a = await heavyOnce('q', 60_000, compute);
    vi.setSystemTime(new Date('2026-11-13T00:00:59Z'));
    const b = await heavyOnce('q', 60_000, compute);
    expect(b).toBe(a);
    expect(compute).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-13T00:01:01Z'));
    const c = await heavyOnce('q', 60_000, compute);
    expect(c).not.toBe(a);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('a ttl is the CALLER’s: the same key asked with a ttl of 0 is never answered from a kept one', async () => {
    const compute = vi.fn(async () => ({ at: Math.random() }));
    await heavyOnce('q', 60_000, compute);
    await heavyOnce('q', 0, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('NEGATIVE: a failure is nobody’s answer — every asker in flight sees it, and the next one computes again', async () => {
    let n = 0;
    const compute = vi.fn(async () => {
      n += 1;
      await Promise.resolve();
      if (n === 1) throw new Error('the database said no');
      return 'ok';
    });
    const first = [heavyOnce('q', 60_000, compute), heavyOnce('q', 60_000, compute)];
    const settled = await Promise.allSettled(first);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(laneAnswers.size).toBe(0);
    await expect(heavyOnce('q', 60_000, compute)).resolves.toBe('ok');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('different questions never share an answer', async () => {
    const compute = vi.fn(async (...a: string[]) => a[0]);
    const [x, y] = await Promise.all([heavyOnce('team|c1|s1', 0, () => compute('x')), heavyOnce('team|c1|s2', 0, () => compute('y'))]);
    expect([x, y]).toEqual(['x', 'y']);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('the kept answers are bounded — the oldest are dropped first, and never one that is still being computed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = heavyOnce('slow', 60_000, async () => {
      await gate;
      return 'slow';
    });
    for (let i = 0; i < 230; i += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 13, 0, 0, 0, i)));
      await heavyOnce(`k${i}`, 60_000, async () => i);
    }
    expect(laneAnswers.size).toBeLessThanOrEqual(201);
    // k0 is the oldest and is gone: asking again computes again
    const again = vi.fn(async () => 'again');
    await heavyOnce('k0', 60_000, again);
    expect(again).toHaveBeenCalledTimes(1);
    // the newest is still kept
    const kept = vi.fn(async () => 'x');
    expect(await heavyOnce('k229', 60_000, kept)).toBe(229);
    expect(kept).not.toHaveBeenCalled();
    release();
    expect(await slow).toBe('slow');
  });

  it('the ttl is zero under test (so a test that changes its mock is never answered from an older call), a minute otherwise', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(REPORT_TTL_MS).toBe(0);
  });
});

describe('two copies of the module share one lane and one map (a production build makes a copy per bundle)', () => {
  it('a report started through one copy is a report for the other, and an answer made by one is read by the other', async () => {
    vi.resetModules();
    const a = await import('./heavy-lane');
    vi.resetModules();
    const b = await import('./heavy-lane');
    expect(a).not.toBe(b);

    let seenByB = false;
    await a.runInHeavyLane(async () => {
      seenByB = b.inHeavyLane();
    });
    expect(seenByB).toBe(true);

    const compute = vi.fn(async () => 'once');
    await a.heavyOnce('shared', 60_000, compute);
    await b.heavyOnce('shared', 60_000, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    b.laneAnswers.clear();
  });
});
