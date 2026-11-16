import { describe, expect, it } from 'vitest';
import {
  QUEUE_PRIORITY,
  backlogShare,
  freshSince,
  isAged,
  laneOfMetadata,
  queueModeAt,
  shareNote,
  wantsBacklog,
  type PullLane,
} from './queue-priority';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PURE RULES OF QUEUE PRIORITY v2 (step D1)
 *
 *  1. The share is (backlog that entered in 7 days [+ stock over 48 h ÷ 5 while the stock is over 50]) ÷ (new unique + backlog that entered), clamped to 25%–50%, and the
 *     study's 37% when there is nothing to count. The study's own figures come out where it says they do: today ≈ 47%, steady state ≈ 37%.
 *  2. The ratio is kept by the agent's own latest pulls: at 37% about one pull in three goes to the backlog, never two in a row at 37%, never zero for long.
 *  3. The modes are 09:00–11:00 and 21:00–24:00, the end exclusive; fresh is under 15 minutes; aged is MORE than 2 hours.
 *  4. The note says the number and its rule in plain Arabic with Western digits.
 *  5. The lane on a history line is read back safely: anything but NEW or BACKLOG is «not counted».
 * ═════════════════════════════════════════════════════════════════
 */

describe('the share', () => {
  it('is the ratio of the last 7 days, clamped to 25%–50%', () => {
    expect(backlogShare({ newUnique: 600, backlogEntered: 300, staleStock: 0 }).share).toBeCloseTo(300 / 900, 10);
    expect(backlogShare({ newUnique: 900, backlogEntered: 100, staleStock: 0 })).toMatchObject({ share: 0.25, clamp: 'MIN' });
    expect(backlogShare({ newUnique: 100, backlogEntered: 900, staleStock: 0 })).toMatchObject({ share: 0.5, clamp: 'MAX' });
  });

  it('adds a fifth of the stock older than 48 hours to the numerator while the stock is over 50 — and only then', () => {
    const base = { newUnique: 700, backlogEntered: 300 };
    expect(backlogShare({ ...base, staleStock: 50 }).numerator).toBe(300); // 50 is not over 50
    expect(backlogShare({ ...base, staleStock: 51 }).numerator).toBeCloseTo(300 + 51 / 5, 10);
    expect(backlogShare({ ...base, staleStock: 200 })).toMatchObject({ numerator: 340, denominator: 1000, staleAdded: 40 });
    expect(backlogShare({ ...base, staleStock: 200 }).share).toBeCloseTo(0.34, 10);
  });

  it('lands on the study\'s two figures: ≈47% today (a pile of stock) and ≈37% in steady state', () => {
    // steady state: ~1100 customers a week and ~650 orders that came back as backlog, no old stock to add
    expect(backlogShare({ newUnique: 1100, backlogEntered: 650, staleStock: 0 }).share).toBeCloseTo(0.371, 2);
    // today: the same kind of week plus 400 orders older than two days (400 ÷ 5 = 80 added) — the study's 47%
    expect(backlogShare({ newUnique: 900, backlogEntered: 650, staleStock: 400 }).share).toBeCloseTo(0.471, 2);
  });

  it('with nothing to count it is the steady-state default, and never divides by zero', () => {
    const r = backlogShare({ newUnique: 0, backlogEntered: 0, staleStock: 0 });
    expect(r).toMatchObject({ share: QUEUE_PRIORITY.shareDefault, clamp: 'DEFAULT', raw: null });
    expect(Number.isFinite(backlogShare({ newUnique: 0, backlogEntered: 0, staleStock: 900 }).share)).toBe(true);
  });
});

describe('the ratio is kept by the agent\'s own latest pulls', () => {
  /** Deal 30 pulls to one agent: each one asks the rule, and the lane it gets is written back as the newest. */
  function deal(share: number, pulls: number): PullLane[] {
    const history: PullLane[] = [];
    for (let i = 0; i < pulls; i++) history.unshift(wantsBacklog(share, history) ? 'BACKLOG' : 'NEW');
    return history.reverse();
  }

  it('at 37% it deals new, new, BACKLOG, new, new, BACKLOG — one pull in three', () => {
    expect(deal(0.37, 6)).toEqual(['NEW', 'NEW', 'BACKLOG', 'NEW', 'NEW', 'BACKLOG']);
  });

  it('over 30 pulls the backlog gets its share to within one pull, at 25%, 37% and 50%', () => {
    for (const share of [0.25, 0.37, 0.5]) {
      const lanes = deal(share, 30);
      const backlog = lanes.filter((l) => l === 'BACKLOG').length;
      expect(Math.abs(backlog - 30 * share), `share ${share}`).toBeLessThanOrEqual(1);
    }
  });

  it('never deals the backlog twice in a row below 50%, and at 50% alternates', () => {
    const at37 = deal(0.37, 40);
    expect(at37.some((l, i) => l === 'BACKLOG' && at37[i + 1] === 'BACKLOG')).toBe(false);
    expect(deal(0.5, 6)).toEqual(['NEW', 'BACKLOG', 'NEW', 'BACKLOG', 'NEW', 'BACKLOG']);
  });

  it('looks only at her latest pulls: old ones fall out of the window', () => {
    const old: PullLane[] = Array.from({ length: QUEUE_PRIORITY.recentPulls }, () => 'BACKLOG');
    expect(wantsBacklog(0.37, old)).toBe(false);
    // newest first: twelve NEW pushed all the BACKLOGs out of the window
    expect(wantsBacklog(0.37, [...Array.from({ length: QUEUE_PRIORITY.recentPulls }, () => 'NEW' as PullLane), 'BACKLOG', 'BACKLOG'])).toBe(true);
  });

  it('an agent with no lane yet starts with a new order', () => {
    expect(wantsBacklog(0.37, [])).toBe(false);
    expect(wantsBacklog(0.5, [])).toBe(false);
  });
});

describe('the clock rules', () => {
  const at = (h: number, m = 0) => queueModeAt(h * 60 + m);

  it('09:00–11:00 and 21:00–24:00 are the two modes, the end exclusive', () => {
    expect(at(8, 59)).toBe('NORMAL');
    expect(at(9)).toBe('NIGHT_FIRST');
    expect(at(10, 59)).toBe('NIGHT_FIRST');
    expect(at(11)).toBe('NORMAL');
    expect(at(20, 59)).toBe('NORMAL');
    expect(at(21)).toBe('PEAK_NEW_FIRST');
    expect(at(23, 59)).toBe('PEAK_NEW_FIRST');
    expect(at(0)).toBe('NORMAL');
    expect(at(3)).toBe('NORMAL');
  });

  it('fresh is strictly younger than 15 minutes; aged is strictly more than 2 hours past the due', () => {
    const now = new Date('2026-11-12T12:00:00.000Z');
    const fresh = freshSince(now);
    expect(fresh.getTime()).toBe(now.getTime() - 15 * 60_000);
    // an order created exactly at `fresh` is NOT fresh (the query is `createdAt > fresh`)
    expect(now.getTime() - fresh.getTime()).toBe(QUEUE_PRIORITY.freshMinutes * 60_000);
    expect(isAged(new Date(now.getTime() - 2 * 3_600_000), now)).toBe(false);
    expect(isAged(new Date(now.getTime() - 2 * 3_600_000 - 1), now)).toBe(true);
    expect(isAged(new Date(now.getTime() + 60_000), now)).toBe(false);
  });
});

describe('the lane on a history line', () => {
  it('reads NEW and BACKLOG, and nothing else', () => {
    expect(laneOfMetadata('{"role":"CONFIRMATION_AGENT","lane":"BACKLOG"}')).toBe('BACKLOG');
    expect(laneOfMetadata('{"lane":"NEW"}')).toBe('NEW');
    for (const bad of [null, undefined, '', '{"role":"X"}', '{"lane":"OTHER"}', '{"lane":1}', 'not json', '[]']) expect(laneOfMetadata(bad as never)).toBeNull();
  });
});

describe('the note: the number and its rule, in plain Arabic', () => {
  const inputs = { newUnique: 700, backlogEntered: 300, staleStock: 200 };
  const note = shareNote(backlogShare(inputs), inputs);

  it('says the percentage, the counts it came from and the clamp', () => {
    expect(note).toContain('34%');
    expect(note).toContain('قاعدة الاحتساب');
    expect(note).toContain('300 طلب');
    expect(note).toContain('700 زبون جديد');
    expect(note).toContain('200 طلب أقدم من 48 ساعة');
    expect(shareNote(backlogShare({ newUnique: 900, backlogEntered: 100, staleStock: 0 }), { newUnique: 900, backlogEntered: 100, staleStock: 0 })).toContain('للحد الأدنى 25%');
    expect(shareNote(backlogShare({ newUnique: 100, backlogEntered: 900, staleStock: 0 }), { newUnique: 100, backlogEntered: 900, staleStock: 0 })).toContain('للحد الأعلى 50%');
  });

  it('is Arabic with Western digits and no Latin letters, also for the default', () => {
    const def = shareNote(backlogShare({ newUnique: 0, backlogEntered: 0, staleStock: 0 }), { newUnique: 0, backlogEntered: 0, staleStock: 0 });
    for (const text of [note, def]) {
      expect(text).not.toMatch(/[A-Za-z]/);
      expect(text).not.toMatch(/[٠-٩]/);
    }
    expect(def).toContain('37%');
  });
});
