import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelled, pulseReport, startPulse } from './server-pulse';
import { heavyOnce, laneAnswers } from './heavy-lane';

/**
 * THE PULSE — a stalled server writes down how long and what it was doing.
 *
 * The owner, 13/11: the site hung and nothing in any log said why. A timer that should fire every 100 ms and fires late IS the
 * stall; these cases hold that it is written down, that it names OUR computations and nothing else, and that it costs nothing
 * the rest of the time.
 */

const shared = globalThis as unknown as { __osmPulse?: { timer: ReturnType<typeof setInterval> | null } };

/** The module keeps its state on `globalThis`: forget it, and stop its timer, between cases. */
function forget() {
  if (shared.__osmPulse?.timer) clearInterval(shared.__osmPulse.timer);
  delete shared.__osmPulse;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  forget();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  forget();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A clock the case moves by hand: a blocked loop is a tick that arrives after the clock jumped. */
function clock(start = 1000) {
  let t = start;
  return { now: () => t, jump: (ms: number) => (t += ms) };
}

describe('a server that answers', () => {
  it('records nothing, and says nothing, while the timer comes on time', () => {
    const c = clock();
    startPulse(c.now);
    for (let i = 0; i < 50; i++) {
      c.jump(100);
      vi.advanceTimersByTime(100);
    }
    const report = pulseReport();
    expect(report.stalls).toEqual([]);
    expect(report.stallsLastHour).toBe(0);
    expect(report.watching).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('forgives a little lateness: 200 ms is a busy moment, not a stall', () => {
    const c = clock();
    startPulse(c.now);
    c.jump(100 + 200);
    vi.advanceTimersByTime(100);
    expect(pulseReport().stalls).toEqual([]);
  });
});

describe('a server that stopped answering', () => {
  it('writes down how long, once, in the log and in the report', () => {
    const c = clock();
    startPulse(c.now);
    c.jump(100 + 3000);
    vi.advanceTimersByTime(100);
    const report = pulseReport();
    expect(report.stalls).toHaveLength(1);
    expect(report.stalls[0].ms).toBe(3000);
    expect(report.stalls[0].running).toEqual([]);
    expect(report.stallsLastHour).toBe(1);
    expect(report.worstStallMsLastHour).toBe(3000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('3000 ms');
    // and the tick after it is on time again: one stall is one line
    c.jump(100);
    vi.advanceTimersByTime(100);
    expect(pulseReport().stalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('names the computations that were running, by our own word', async () => {
    const c = clock();
    startPulse(c.now);
    let finish: () => void = () => {};
    const running = labelled('report:team', () => new Promise<void>((resolve) => (finish = resolve)));
    const second = labelled('report:analytics', () => new Promise<void>((resolve) => void resolve()));
    c.jump(100 + 15_000);
    vi.advanceTimersByTime(100);
    const stall = pulseReport().stalls[0];
    expect([...stall.running].sort()).toEqual(['report:analytics', 'report:team']);
    expect(String(warn.mock.calls[0][0])).toContain('report:team');
    finish();
    await running;
    await second;
  });

  it('keeps the newest hundred, newest first', () => {
    const c = clock();
    startPulse(c.now);
    for (let i = 1; i <= 120; i++) {
      c.jump(100 + 300 + i);
      vi.advanceTimersByTime(100);
    }
    const { stalls } = pulseReport();
    expect(stalls).toHaveLength(100);
    expect(stalls[0].ms).toBe(300 + 120);
    expect(stalls[99].ms).toBe(300 + 21);
  });

  it('starts one timer however often it is asked to', () => {
    startPulse(clock().now);
    startPulse(clock().now);
    startPulse(clock().now);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('a computation under a name', () => {
  it('gives back its result, and its error, as they are', async () => {
    await expect(labelled('report:x', async () => 42)).resolves.toBe(42);
    await expect(
      labelled('report:x', async () => {
        throw new Error('the database did not answer');
      })
    ).rejects.toThrow('the database did not answer');
  });

  it('is on the list while it runs and off it afterwards, win or lose', async () => {
    let finish: () => void = () => {};
    const ok = labelled('report:one', () => new Promise<void>((resolve) => (finish = resolve)));
    expect(pulseReport().runningNow).toEqual(['report:one']);
    finish();
    await ok;
    expect(pulseReport().runningNow).toEqual([]);
    await labelled('report:two', async () => {
      throw new Error('x');
    }).catch(() => undefined);
    expect(pulseReport().runningNow).toEqual([]);
  });

  it('remembers one that was slow', async () => {
    let t = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => t);
    try {
      await labelled('report:slow', async () => {
        t += 2500;
      });
      await labelled('report:quick', async () => {
        t += 50;
      });
    } finally {
      spy.mockRestore();
    }
    const { slow } = pulseReport();
    expect(slow).toHaveLength(1);
    expect(slow[0].label).toBe('report:slow');
    expect(slow[0].ms).toBe(2500);
  });
});

describe('what the report says', () => {
  it('is numbers, times and our own words — and nothing else', async () => {
    const c = clock();
    startPulse(c.now);
    c.jump(100 + 900);
    vi.advanceTimersByTime(100);
    const report = pulseReport();
    expect(Object.keys(report).sort()).toEqual(
      ['eventLoopUtilization', 'memoryMb', 'runningNow', 'slow', 'stalls', 'stallsLastHour', 'uptimeSeconds', 'watching', 'worstStallMsLastHour'].sort()
    );
    expect(Object.keys(report.stalls[0]).sort()).toEqual(['at', 'ms', 'running']);
    expect(Object.keys(report.memoryMb).sort()).toEqual(['external', 'heapTotal', 'heapUsed', 'rss']);
    expect(Number.isFinite(report.memoryMb.rss) && report.memoryMb.rss > 0).toBe(true);
    expect(Number.isFinite(report.uptimeSeconds)).toBe(true);
  });
});

describe('the reports lane names what it runs', () => {
  beforeEach(() => laneAnswers.clear());

  it('by the first word of the question — never by its company, its store or its window', async () => {
    const seen = await heavyOnce('analytics|company-9f3a|store-77b1|all|2026-10-01', 0, async () => pulseReport().runningNow);
    expect(seen).toEqual(['report:analytics']);
    const text = JSON.stringify(seen);
    expect(text).not.toContain('company-9f3a');
    expect(text).not.toContain('store-77b1');
  });

  it('and a question with no separator is named by the whole word', async () => {
    const seen = await heavyOnce('shipping', 0, async () => pulseReport().runningNow);
    expect(seen).toEqual(['report:shipping']);
  });
});
