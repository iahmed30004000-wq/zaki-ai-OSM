import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

vi.mock('./db', () => ({ db: {} }));

import { median } from './team-performance';
import { MANUAL_ENTRY_REASON } from './confirmation-queue';
import { CUSTOMER_CALLED_BACK_REASON, TAKEN_ON_THE_LINE_REASON } from './customer-on-the-line';
import { DUE_RELEASE_REASON, REPULL_RELEASE_REASON, ROUND_RELEASE_REASON } from './no-answer-rounds';
import { DATE_RETURNED_REASON, IDLE_RETURNED_REASON, NO_ANSWER_RETURNED_REASON } from './no-answer-returns';
import { MANAGER_RETURNED_REASON, NINETY_MINUTE_RELEASE_REASON } from './auto-release';
import {
  BOUNCE_MIN_ORDERS,
  BOUNCE_PROBLEM_PERCENT,
  BOUNCE_WATCH_PERCENT,
  DEFAULT_FLOW_WINDOW,
  DRAIN_EXIT_PERCENT,
  FAST_MINUTES,
  FAST_PROBLEM_PERCENT,
  FAST_WATCH_PERCENT,
  FLOW_MIN_EVENTS,
  FLOW_WINDOWS,
  FLOW_WINDOW_KEYS,
  HANDED_OVER_REASON,
  OLD_HELD_MIN,
  OLD_PROBLEM_PERCENT,
  OLD_WATCH_PERCENT,
  ON_THE_LINE_REASON,
  PILE_PROBLEM_EXIT_PERCENT,
  PILE_WATCH_EXIT_PERCENT,
  PULL_REASON,
  QUIET_WORK_MINUTES,
  SPEED_MIN_PULLS,
  TYPED_REASON,
  ageWords,
  bucketHeld,
  claimKindOf,
  daysWords,
  flowWindowKey,
  hoursWords,
  middle,
  minutesWords,
  ordersWords,
  percentOf,
  readFlow,
  tallyFlow,
  type AttemptLine,
  type ClaimLine,
  type DecisionLine,
  type FlowInput,
  type HeldFlowFigures,
  type Truncated,
} from './held-flow';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «حركة الطلبات» — THE ARITHMETIC AGAINST HAND-BUILT LEDGERS, AND AGAINST A REFERENCE THAT WALKS THE EVENTS ONE BY ONE.
 *
 * `held-flow.ts` is pure, so every claim here is about NUMBERS: that a reason lands in the tile the header table says, that an order
 * pulled twice is two pulls and one bounce, that a typed order never becomes a pull, that a young pull is not yet a miss, that each
 * threshold of the sentence flips at its own boundary and not one count away. The reference at the bottom shares no code with the
 * file under test: it re-encodes the table as a lookup and finds every «next line» and «first attempt» by scanning all rows.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-13T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
/** Whole minutes between two instants, floored — the clock when nobody asks for the calendar. */
const wall = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
const NOT_CUT: Truncated = { ledger: false, decisions: false, attempts: false, held: false };

const claim = (orderId: string, userId: string, action: string, reason: string | null, minutesAgo: number): ClaimLine => ({
  orderId,
  userId,
  action,
  reason,
  at: ago(minutesAgo),
});
const pull = (orderId: string, userId: string, minutesAgo: number) => claim(orderId, userId, 'CLAIMED', PULL_REASON, minutesAgo);
const release = (orderId: string, userId: string, reason: string | null, minutesAgo: number) => claim(orderId, userId, 'RELEASED', reason, minutesAgo);
const attempt = (orderId: string, userId: string, minutesAgo: number): AttemptLine => ({ orderId, userId, at: ago(minutesAgo) });
const decided = (orderId: string, to: string, minutesAgo: number): DecisionLine => ({ orderId, to, at: ago(minutesAgo) });

function tally(over: Partial<FlowInput> = {}): HeldFlowFigures {
  return tallyFlow({
    created: 0,
    claims: [],
    decisions: [],
    attempts: [],
    held: [],
    now: NOW,
    minutesBetween: wall,
    workMinutes: 480,
    truncated: NOT_CUT,
    ...over,
  });
}

// ───────────────────────── the table ─────────────────────────

describe('the claim ledger, reason by reason', () => {
  const CASES: [string, string | null, string][] = [
    ['CLAIMED', 'PULL_NEXT', 'PULLED'],
    ['CLAIMED', 'MANUAL_ENTRY', 'TYPED'],
    ['CLAIMED', 'CUSTOMER_CALLED_BACK', 'ON_THE_LINE'],
    // A claim whose reason this table does not know is NOT guessed into a pull.
    ['CLAIMED', null, 'UNKNOWN'],
    ['CLAIMED', '', 'UNKNOWN'],
    ['CLAIMED', 'استلام يدوي', 'UNKNOWN'],
    ['CLAIMED', 'pull_next', 'UNKNOWN'],
    ['CLAIMED', 'PULL_NEXT_V2', 'UNKNOWN'],
    // A release is an exit by its action: the reason only says why.
    ['RELEASED', 'AUTO_RELEASE_90_BUSINESS_MINUTES', 'RETURNED'],
    ['RELEASED', 'AUTO_RELEASE_NO_ANSWER_ROUND', 'RETURNED'],
    ['RELEASED', 'AUTO_RELEASE_REPULLED_UNTOUCHED', 'RETURNED'],
    ['RELEASED', 'AUTO_RELEASE_DATE_PASSED', 'RETURNED'],
    ['RELEASED', 'AUTO_RELEASE_IDLE_RETURNED', 'RETURNED'],
    ['RELEASED', 'NO_ANSWER_RETURNED', 'RETURNED'],
    ['RELEASED', 'DATE_RETURNED', 'RETURNED'],
    ['RELEASED', 'MANAGER_RETURNED', 'RETURNED'],
    ['RELEASED', null, 'RETURNED'],
    ['RELEASED', '', 'RETURNED'],
    ['RELEASED', '   ', 'RETURNED'],
    // The button writes whatever the person typed — words, in any language, even a lowercase «ok».
    ['RELEASED', 'ما بقدر أكمل الطلب', 'RETURNED'],
    ['RELEASED', 'done', 'RETURNED'],
    ['RELEASED', 'Customer Cancelled', 'RETURNED'],
    ['RELEASED', 'AUTO_RELEASE_A_RULE_ADDED_LATER', 'RETURNED'], // the whole family is the system's, by its prefix
    // A reason written like a machine that this table was never taught is «غير ذلك» — said, never folded into an exit.
    ['RELEASED', 'A_REASON_NOBODY_WROTE_YET', 'UNKNOWN'],
    ['RELEASED', 'LOCK_EXPIRED', 'UNKNOWN'],
    ['RELEASED', 'REASSIGNED', 'UNKNOWN'],
    ['RELEASED', 'PULL_NEXT', 'UNKNOWN'],
    ['RELEASED', 'X', 'UNKNOWN'],
    // …except the colleague's side of «الزبون على الخط»: the order stays in a hand.
    ['RELEASED', 'TAKEN_ON_THE_LINE', 'HANDED_OVER'],
    ['TRANSFERRED', 'حوّلتو لسارة', 'MOVED'],
    ['TRANSFERRED', null, 'MOVED'],
    ['OVERRIDDEN', 'استلمه المالك', 'MOVED'],
    ['UNLOCKED', null, 'UNKNOWN'],
    ['SOMETHING_NEW', 'PULL_NEXT', 'UNKNOWN'],
    ['', null, 'UNKNOWN'],
  ];
  it.each(CASES)('%s / %s is %s', (action, reason, kind) => {
    expect(claimKindOf(action, reason)).toBe(kind);
  });

  it('the reasons are the writers’ own words — a renamed reason turns this red, not the owner’s screen', () => {
    expect(TYPED_REASON).toBe(MANUAL_ENTRY_REASON);
    expect(ON_THE_LINE_REASON).toBe(CUSTOMER_CALLED_BACK_REASON);
    expect(HANDED_OVER_REASON).toBe(TAKEN_ON_THE_LINE_REASON);
    // The pull's reason is a constant its file keeps to itself: read from the source that writes it.
    const queue = readFileSync(join(process.cwd(), 'src/lib/confirmation-queue.ts'), 'utf8');
    expect(queue).toMatch(new RegExp(`const PULL_NEXT_REASON = '${PULL_REASON}'`));
    expect(queue).toMatch(/action: 'CLAIMED',\s*reason: PULL_NEXT_REASON/);
  });

  it('every release the writers know is an exit, and none of them a pull', () => {
    const writers = [
      NINETY_MINUTE_RELEASE_REASON,
      ROUND_RELEASE_REASON,
      REPULL_RELEASE_REASON,
      DUE_RELEASE_REASON,
      IDLE_RETURNED_REASON,
      NO_ANSWER_RETURNED_REASON,
      DATE_RETURNED_REASON,
      MANAGER_RETURNED_REASON,
    ];
    for (const reason of writers) {
      expect(claimKindOf('RELEASED', reason), reason).toBe('RETURNED');
      expect(claimKindOf('CLAIMED', reason), reason).toBe('UNKNOWN');
    }
  });
});

describe('the windows', () => {
  it('three words, 6 hours · 24 hours · 7 days, and nothing else is one', () => {
    expect([...FLOW_WINDOW_KEYS]).toEqual(['6h', '24h', '7d']);
    expect(FLOW_WINDOWS['6h'].ms).toBe(6 * 3_600_000);
    expect(FLOW_WINDOWS['24h'].ms).toBe(24 * 3_600_000);
    expect(FLOW_WINDOWS['7d'].ms).toBe(7 * 24 * 3_600_000);
    expect(DEFAULT_FLOW_WINDOW).toBe('24h');
    for (const ok of ['6h', '24h', '7d']) expect(flowWindowKey(ok)).toBe(ok);
    for (const bad of ['', '1h', '12h', '24H', ' 24h', '7d ', '30d', 'day', '0', 'null', 'undefined']) expect(flowWindowKey(bad), bad).toBeNull();
    expect(flowWindowKey(null)).toBeNull();
  });

  it('every label is Arabic, and is the words the buttons and the refusal say', () => {
    for (const key of FLOW_WINDOW_KEYS) expect(FLOW_WINDOWS[key].label).not.toMatch(/[A-Za-z]/);
    expect(Object.fromEntries(FLOW_WINDOW_KEYS.map((k) => [k, FLOW_WINDOWS[k].label]))).toEqual({
      '6h': 'آخر 6 ساعات',
      '24h': 'آخر 24 ساعة',
      '7d': 'آخر 7 أيام',
    });
  });
});

// ───────────────────────── the flow ─────────────────────────

describe('the flow — hand-built ledgers', () => {
  it('an empty store is zeros and a dash-able speed, never a NaN', () => {
    const f = tally();
    expect(f.created).toBe(0);
    expect(f.entered).toEqual({ pulled: 0, typed: 0, onTheLine: 0, total: 0 });
    expect(f.exits).toEqual({ confirmed: 0, returned: 0, cancelled: 0, total: 0 });
    expect(f.net).toBe(0);
    expect(f.moved).toBe(0);
    expect(f.unknown).toBe(0);
    expect(f.held).toEqual({ total: 0, under6h: 0, from6hTo24h: 0, from1dTo3d: 0, over3d: 0, unknownAge: 0, oldestMs: null });
    expect(f.speed).toEqual({ judged: 0, withAttempt: 0, fast: 0, medianMinutes: null });
    expect(f.bounced).toEqual({ orders: 0, of: 0 });
  });

  it('the figures of one shift add up: entered, exited, net', () => {
    const f = tally({
      created: 40,
      claims: [
        // five pulls…
        pull('o1', 'a', 300),
        pull('o2', 'a', 290),
        pull('o3', 'b', 280),
        pull('o4', 'b', 270),
        pull('o5', 'c', 260),
        // …two orders the agent typed herself…
        claim('t1', 'a', 'CLAIMED', 'MANUAL_ENTRY', 250),
        claim('t2', 'b', 'CLAIMED', 'MANUAL_ENTRY', 240),
        // …a customer rang back and the agent took it from the pool…
        claim('l1', 'c', 'CLAIMED', 'CUSTOMER_CALLED_BACK', 230),
        // …and five ways back to the pool, one for each writer.
        release('o1', 'a', 'AUTO_RELEASE_90_BUSINESS_MINUTES', 200),
        release('o2', 'a', 'NO_ANSWER_RETURNED', 190),
        release('o3', 'b', 'MANAGER_RETURNED', 180),
        release('o4', 'b', null, 170),
        release('o5', 'c', 'تعبت من الطلب', 160),
      ],
      decisions: [decided('t1', 'CONFIRMED', 100), decided('t2', 'CONFIRMED', 90), decided('l1', 'REJECTED', 80), decided('x', 'CANCELLED', 70)],
    });
    expect(f.created).toBe(40);
    expect(f.entered).toEqual({ pulled: 5, typed: 2, onTheLine: 1, total: 8 });
    expect(f.exits).toEqual({ confirmed: 2, returned: 5, cancelled: 2, total: 9 });
    expect(f.net).toBe(-1);
    expect(f.unknown).toBe(0);
    expect(f.moved).toBe(0);
  });

  it('MANUAL_ENTRY is never inside «انسحب» — it enters the hands, and is counted apart', () => {
    const f = tally({ claims: [claim('t1', 'a', 'CLAIMED', 'MANUAL_ENTRY', 50), claim('t2', 'a', 'CLAIMED', 'MANUAL_ENTRY', 40)] });
    expect(f.entered.pulled).toBe(0);
    expect(f.entered.typed).toBe(2);
    expect(f.entered.total).toBe(2);
    expect(f.net).toBe(2);
    // …and it is not a pull for the speed or the bounce either.
    expect(f.speed).toEqual({ judged: 0, withAttempt: 0, fast: 0, medianMinutes: null });
    expect(f.bounced).toEqual({ orders: 0, of: 0 });
  });

  it('an order pulled twice by two agents is TWO pulls, one order that bounced — and the sums close', () => {
    const f = tally({
      claims: [pull('o1', 'a', 120), release('o1', 'a', 'AUTO_RELEASE_90_BUSINESS_MINUTES', 60), pull('o1', 'b', 50)],
    });
    expect(f.entered.pulled).toBe(2);
    expect(f.exits.returned).toBe(1);
    expect(f.net).toBe(1); // one hand holds it now: the pile grew by exactly one
    expect(f.bounced).toEqual({ orders: 1, of: 1 });
  });

  it('pulled twice by the SAME agent is two pulls and no bounce', () => {
    const f = tally({ claims: [pull('o1', 'a', 120), release('o1', 'a', 'NO_ANSWER_RETURNED', 100), pull('o1', 'a', 50)] });
    expect(f.entered.pulled).toBe(2);
    expect(f.bounced).toEqual({ orders: 0, of: 1 });
  });

  it('three agents on one order is still one bounced order; two bounced orders among five pulled', () => {
    const f = tally({
      claims: [
        pull('o1', 'a', 300),
        pull('o1', 'b', 250),
        pull('o1', 'c', 200),
        pull('o2', 'a', 150),
        pull('o2', 'b', 140),
        pull('o3', 'a', 130),
        pull('o4', 'b', 120),
        pull('o5', 'c', 110),
      ],
    });
    expect(f.bounced).toEqual({ orders: 2, of: 5 });
  });

  it('an order claimed BEFORE the window and confirmed inside it is an exit and not a pull', () => {
    const f = tally({ decisions: [decided('o9', 'CONFIRMED', 30)] });
    expect(f.entered.total).toBe(0);
    expect(f.exits).toEqual({ confirmed: 1, returned: 0, cancelled: 0, total: 1 });
    expect(f.net).toBe(-1);
    expect(f.speed).toEqual({ judged: 0, withAttempt: 0, fast: 0, medianMinutes: null });
  });

  it('rejected and cancelled are one exit, «انلغى»; a decision to a word nobody writes is «غير ذلك», not an exit', () => {
    const f = tally({ decisions: [decided('a', 'REJECTED', 5), decided('b', 'CANCELLED', 4), decided('c', 'CONFIRMED', 3), decided('d', 'SHIPPED', 2)] });
    expect(f.exits).toEqual({ confirmed: 1, returned: 0, cancelled: 2, total: 3 });
    expect(f.unknown).toBe(1);
  });

  it('a reason this table does not know is counted in «غير ذلك», said, and is in no sum', () => {
    const f = tally({
      claims: [
        claim('o1', 'a', 'CLAIMED', 'استلام يدوي', 30),
        claim('o2', 'a', 'CLAIMED', null, 29),
        claim('o3', 'a', 'UNLOCKED', null, 28),
        claim('o4', 'a', 'SOMETHING_NEW', 'X', 27),
        pull('o5', 'a', 26),
      ],
    });
    expect(f.unknown).toBe(4);
    expect(f.entered).toEqual({ pulled: 1, typed: 0, onTheLine: 0, total: 1 });
    expect(f.exits.total).toBe(0);
    expect(f.net).toBe(1);
  });

  it('a RELEASED line with a person’s words, or none, is an exit — the release button writes whatever she typed', () => {
    const f = tally({ claims: [release('o1', 'a', 'ما بقدر أكمل', 30), release('o2', 'a', 'cancelled by customer', 29), release('o3', 'a', null, 28)] });
    expect(f.exits.returned).toBe(3);
    expect(f.unknown).toBe(0);
  });

  it('a RELEASED line written like a code this table never learned is «غير ذلك»: said, in no sum — not folded into «رجع للطابور»', () => {
    const f = tally({ claims: [release('o1', 'a', 'FUTURE_AUTO_RULE', 30), release('o2', 'a', 'LOCK_EXPIRED', 29), release('o3', 'a', 'AUTO_RELEASE_90_BUSINESS_MINUTES', 28)] });
    expect(f.unknown).toBe(2);
    expect(f.exits).toEqual({ confirmed: 0, returned: 1, cancelled: 0, total: 1 });
    expect(f.net).toBe(-1);
  });

  it('«الزبون على الخط» from a colleague is two lines and no movement; from the pool it is one entry', () => {
    const fromColleague = tally({
      claims: [release('o1', 'a', 'TAKEN_ON_THE_LINE', 30), claim('o1', 'b', 'CLAIMED', 'CUSTOMER_CALLED_BACK', 30)],
    });
    expect(fromColleague.entered.onTheLine).toBe(0);
    expect(fromColleague.exits.returned).toBe(0);
    expect(fromColleague.net).toBe(0);

    const fromPool = tally({ claims: [claim('o1', 'b', 'CLAIMED', 'CUSTOMER_CALLED_BACK', 30)] });
    expect(fromPool.entered.onTheLine).toBe(1);
    expect(fromPool.net).toBe(1);

    // Two takes, one from a colleague and one from the pool: exactly one entered.
    const mixed = tally({
      claims: [
        release('o1', 'a', 'TAKEN_ON_THE_LINE', 30),
        claim('o1', 'b', 'CLAIMED', 'CUSTOMER_CALLED_BACK', 30),
        claim('o2', 'b', 'CLAIMED', 'CUSTOMER_CALLED_BACK', 20),
      ],
    });
    expect(mixed.entered.onTheLine).toBe(1);
    expect(mixed.net).toBe(1);
  });

  it('a hand-over line without its pair never makes the entry negative', () => {
    const f = tally({ claims: [release('o1', 'a', 'TAKEN_ON_THE_LINE', 30)] });
    expect(f.entered.onTheLine).toBe(0);
    expect(f.exits.returned).toBe(0);
    expect(f.net).toBe(0);
  });

  it('a transfer or a takeover keeps the order in a hand: counted apart, in no sum', () => {
    const f = tally({
      claims: [claim('o1', 'boss', 'TRANSFERRED', 'حوّلتو', 30), claim('o2', 'owner', 'OVERRIDDEN', 'استلمو المالك', 20), pull('o3', 'a', 10)],
    });
    expect(f.moved).toBe(2);
    expect(f.entered.total).toBe(1);
    expect(f.exits.total).toBe(0);
    expect(f.net).toBe(1);
  });

  it('the orders created are passed through untouched', () => {
    expect(tally({ created: 17 }).created).toBe(17);
  });
});

// ───────────────────────── how long they sit ─────────────────────────

describe('how long they sit — the four buckets, wall clock', () => {
  const HOUR = 3_600_000;
  const held = (ms: number | null) => ({ claimedAt: ms === null ? null : new Date(NOW.getTime() - ms) });

  it('each boundary is the comparison its label is written with', () => {
    const b = bucketHeld(
      [
        held(0),
        held(6 * HOUR - 1), // under 6 hours: strictly
        held(6 * HOUR), // «من 6 لـ 24»: starts AT six
        held(24 * HOUR - 1),
        held(24 * HOUR), // «من يوم لـ 3 أيام»: starts AT a day
        held(72 * HOUR), // …and takes exactly three days
        held(72 * HOUR + 1), // «أكتر من 3 أيام»: strictly more
        held(30 * 24 * HOUR),
      ],
      NOW
    );
    expect(b).toEqual({ total: 8, under6h: 2, from6hTo24h: 2, from1dTo3d: 2, over3d: 2, unknownAge: 0, oldestMs: 30 * 24 * HOUR });
  });

  it('a claim with no time is said (unknownAge), is in the total, and is in no bucket and no «oldest»', () => {
    const b = bucketHeld([held(null), held(null), held(HOUR)], NOW);
    expect(b).toEqual({ total: 3, under6h: 1, from6hTo24h: 0, from1dTo3d: 0, over3d: 0, unknownAge: 2, oldestMs: HOUR });
    expect(bucketHeld([held(null)], NOW).oldestMs).toBeNull();
  });

  it('a claim in the future (a drifted clock) is age zero, not a negative bucket', () => {
    const b = bucketHeld([{ claimedAt: new Date(NOW.getTime() + 5 * HOUR) }], NOW);
    expect(b.under6h).toBe(1);
    expect(b.oldestMs).toBe(0);
  });

  it('the buckets and the unknown ones always add up to the total', () => {
    const rows = Array.from({ length: 200 }, (_, i) => held(i % 7 === 0 ? null : (i * 37 * 60_000) % (9 * 24 * HOUR)));
    const b = bucketHeld(rows, NOW);
    expect(b.under6h + b.from6hTo24h + b.from1dTo3d + b.over3d + b.unknownAge).toBe(b.total);
    expect(b.total).toBe(200);
  });

  it('the figures carry the same buckets', () => {
    const f = tally({ held: [held(HOUR), held(80 * HOUR)] });
    expect(f.held).toMatchObject({ total: 2, under6h: 1, over3d: 1, oldestMs: 80 * HOUR });
  });
});

// ───────────────────────── how smooth ─────────────────────────

describe('how smooth — pull to first attempt', () => {
  it('the first attempt BY THE PULLER, after the pull: minutes, a median and a share beside their bases', () => {
    const f = tally({
      claims: [pull('o1', 'a', 100), pull('o2', 'a', 100), pull('o3', 'b', 100)],
      attempts: [attempt('o1', 'a', 95), attempt('o2', 'a', 60), attempt('o3', 'b', 90), attempt('o3', 'b', 10)],
    });
    // 5 minutes, 40 minutes, 10 minutes (the first attempt on o3, not the later one).
    expect(f.speed).toEqual({ judged: 3, withAttempt: 3, fast: 2, medianMinutes: 10 });
  });

  it('an attempt of somebody else is not hers, and one BEFORE the pull is not this pull’s', () => {
    const f = tally({
      claims: [pull('o1', 'a', 100)],
      attempts: [attempt('o1', 'b', 95), attempt('o1', 'a', 130)],
    });
    // Nobody tried it after she pulled it, and her 30 minutes are long over: one judged miss.
    expect(f.speed).toEqual({ judged: 1, withAttempt: 0, fast: 0, medianMinutes: null });
  });

  it('an attempt after the order had moved on (a release, then a re-pull) belongs to the pull it followed', () => {
    const f = tally({
      claims: [pull('o1', 'a', 200), release('o1', 'a', 'AUTO_RELEASE_90_BUSINESS_MINUTES', 100), pull('o1', 'a', 60)],
      attempts: [attempt('o1', 'a', 55)],
    });
    // The first pull got nothing before it was released (a judged miss); the second was attempted in 5 minutes.
    expect(f.speed).toEqual({ judged: 2, withAttempt: 1, fast: 1, medianMinutes: 5 });
  });

  it('an attempt at the very instant of the next line is not the span’s: the line ended it first', () => {
    const f = tally({
      claims: [pull('o1', 'a', 100), release('o1', 'a', null, 60)],
      attempts: [attempt('o1', 'a', 60)],
    });
    expect(f.speed).toEqual({ judged: 1, withAttempt: 0, fast: 0, medianMinutes: null });
  });

  it('a pull and its attempt in the same instant is zero minutes, and fast', () => {
    const f = tally({ claims: [pull('o1', 'a', 100)], attempts: [attempt('o1', 'a', 100)] });
    expect(f.speed).toEqual({ judged: 1, withAttempt: 1, fast: 1, medianMinutes: 0 });
  });

  it('the thirty-minute edge: exactly 30 is fast, 31 is not', () => {
    const f = tally({
      claims: [pull('o1', 'a', 200), pull('o2', 'a', 200)],
      attempts: [attempt('o1', 'a', 200 - FAST_MINUTES), attempt('o2', 'a', 200 - FAST_MINUTES - 1)],
    });
    expect(f.speed).toEqual({ judged: 2, withAttempt: 2, fast: 1, medianMinutes: 31 });
  });

  it('a pull nobody has attempted is a MISS only after 31 minutes — a younger one is in no base, an older one is', () => {
    const young = tally({ claims: [pull('o1', 'a', FAST_MINUTES)] });
    expect(young.speed).toEqual({ judged: 0, withAttempt: 0, fast: 0, medianMinutes: null });
    const edge = tally({ claims: [pull('o1', 'a', FAST_MINUTES + 1)] });
    expect(edge.speed).toEqual({ judged: 1, withAttempt: 0, fast: 0, medianMinutes: null });
  });

  it('the median is the middle, rounded the way the team table rounds it; an even count averages the two middles', () => {
    const f = tally({
      claims: [pull('o1', 'a', 300), pull('o2', 'a', 300), pull('o3', 'a', 300), pull('o4', 'a', 300)],
      attempts: [attempt('o1', 'a', 299), attempt('o2', 'a', 297), attempt('o3', 'a', 290), attempt('o4', 'a', 250)],
    });
    // 1, 3, 10, 50 → (3 + 10) / 2 = 6.5 → 7
    expect(f.speed?.medianMinutes).toBe(7);
  });

  it('the minutes are the clock it is handed — working minutes, not the wall', () => {
    const f = tally({
      claims: [pull('o1', 'a', 100)],
      attempts: [attempt('o1', 'a', 40)],
      minutesBetween: (from, to) => Math.round(wall(from, to) / 10), // a calendar that counts one minute in ten
    });
    expect(f.speed?.medianMinutes).toBe(6);
    expect(f.speed?.fast).toBe(1);
  });

  it('a cut ledger or a cut attempts list draws NO speed at all — a share over half a window is not a number', () => {
    const base = { claims: [pull('o1', 'a', 100)], attempts: [attempt('o1', 'a', 90)] };
    expect(tally({ ...base, truncated: { ...NOT_CUT, ledger: true } }).speed).toBeNull();
    expect(tally({ ...base, truncated: { ...NOT_CUT, attempts: true } }).speed).toBeNull();
    // The decisions and the held list do not touch it.
    expect(tally({ ...base, truncated: { ...NOT_CUT, decisions: true, held: true } }).speed).not.toBeNull();
  });
});

describe('the small words', () => {
  it('days, hours, minutes and orders agree with their number', () => {
    expect([1, 2, 3, 10, 11, 25].map(daysWords)).toEqual(['يوم', 'يومين', '3 أيام', '10 أيام', '11 يوم', '25 يوم']);
    expect([1, 2, 3, 10, 11, 23].map(hoursWords)).toEqual(['ساعة', 'ساعتين', '3 ساعات', '10 ساعات', '11 ساعة', '23 ساعة']);
    expect([0, 1, 2, 3, 10, 11, 90].map(minutesWords)).toEqual(['أقل من دقيقة', 'دقيقة', 'دقيقتين', '3 دقائق', '10 دقائق', '11 دقيقة', '90 دقيقة']);
    expect([1, 2, 5, 10, 11, 842].map(ordersWords)).toEqual(['طلب واحد', 'طلبين', '5 طلبات', '10 طلبات', '11 طلب', '842 طلب']);
  });

  it('an age is said in the biggest honest unit', () => {
    const HOUR = 3_600_000;
    expect(ageWords(10 * 60_000)).toBe('أقل من ساعة');
    expect(ageWords(HOUR)).toBe('ساعة');
    expect(ageWords(5 * HOUR + 59 * 60_000)).toBe('5 ساعات');
    expect(ageWords(23 * HOUR)).toBe('23 ساعة');
    expect(ageWords(24 * HOUR)).toBe('يوم');
    expect(ageWords(9.9 * 24 * HOUR)).toBe('9 أيام');
  });

  it('a percentage has a base — a base of zero has none', () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(0, 5)).toBe(0);
    expect(percentOf(0, 0)).toBeNull();
    expect(percentOf(5, 0)).toBeNull();
  });

  it('`middle` is the team table’s `median`, on every shape', () => {
    const shapes = [[], [4], [4, 9], [9, 4, 7], [1, 2, 3, 4], [5, 5, 5, 6], [0, 0, 0, 1], [10, 1, 2.5, 7.25, 3]];
    for (const values of shapes) expect(middle(values), JSON.stringify(values)).toBe(median(values));
  });
});

// ───────────────────────── the sentence ─────────────────────────

interface Fig {
  pulled?: number;
  typed?: number;
  onTheLine?: number;
  confirmed?: number;
  returned?: number;
  cancelled?: number;
  held?: Partial<HeldFlowFigures['held']>;
  speed?: HeldFlowFigures['speed'];
  bounced?: HeldFlowFigures['bounced'];
  workMinutes?: number;
  truncated?: Partial<Truncated>;
}
const DAY = 86_400_000;
function fig(o: Fig = {}): HeldFlowFigures {
  const entered = (o.pulled ?? 0) + (o.typed ?? 0) + (o.onTheLine ?? 0);
  const exits = (o.confirmed ?? 0) + (o.returned ?? 0) + (o.cancelled ?? 0);
  const held = { total: 100, under6h: 100, from6hTo24h: 0, from1dTo3d: 0, over3d: 0, unknownAge: 0, oldestMs: 2 * 3_600_000, ...o.held };
  return {
    created: 0,
    entered: { pulled: o.pulled ?? 0, typed: o.typed ?? 0, onTheLine: o.onTheLine ?? 0, total: entered },
    exits: { confirmed: o.confirmed ?? 0, returned: o.returned ?? 0, cancelled: o.cancelled ?? 0, total: exits },
    net: entered - exits,
    moved: 0,
    unknown: 0,
    held,
    speed: o.speed === undefined ? { judged: 0, withAttempt: 0, fast: 0, medianMinutes: null } : o.speed,
    bounced: o.bounced ?? { orders: 0, of: 0 },
    workMinutes: o.workMinutes ?? 480,
    truncated: { ...NOT_CUT, ...o.truncated },
  };
}
/** A flow with `entered` pulls and `exits` confirmations, the rest quiet. */
const flowOf = (entered: number, exits: number, more: Fig = {}) => readFlow(fig({ pulled: entered, confirmed: exits, ...more }));

describe('the sentence — the flow', () => {
  it('a store with nothing in it says so calmly, and does not lie about work', () => {
    const r = readFlow(fig({ held: { total: 0, under6h: 0, oldestMs: null } }));
    expect(r).toEqual({ tone: 'CALM', label: 'ماشية', sentences: ['ما في حركة بهالمدة، ولا في طلبات محجوزة عند الموظفات.'] });
  });

  it('nothing moved but there are held orders: a night is calm, a working window is a standstill', () => {
    const night = readFlow(fig({ workMinutes: QUIET_WORK_MINUTES - 1 }));
    expect(night.tone).toBe('CALM');
    expect(night.sentences).toEqual(['ما في حركة بهالمدة — وما كان فيها دوام تقريباً.']);
    const day = readFlow(fig({ workMinutes: QUIET_WORK_MINUTES }));
    expect(day.tone).toBe('PROBLEM');
    expect(day.label).toBe('مشكلة');
    expect(day.sentences).toEqual(['ما تحرّك شي بهالمدة رغم الدوام — وفي 100 طلب محجوز عند الموظفات.']);
  });

  it('few events: said, and nothing is judged on them', () => {
    expect(flowOf(29, 0).sentences).toEqual(['حركة قليلة: سحبوا 29 وطلع من أيديهم 0.']);
    expect(flowOf(29, 0).tone).toBe('CALM');
    expect(flowOf(0, 29).sentences).toEqual(['حركة قليلة: سحبوا 0 وطلع من أيديهم 29.']);
  });

  it('PILE, at its boundary: under 60% of the entries leaving is a problem, 60% is a watch', () => {
    const problem = flowOf(100, PILE_PROBLEM_EXIT_PERCENT - 1);
    expect(problem.tone).toBe('PROBLEM');
    expect(problem.sentences[0]).toBe('في تكدّس: سحبوا 100 وطلع من أيديهم 59 بس — المحجوز بيزيد.');
    const watch = flowOf(100, PILE_PROBLEM_EXIT_PERCENT);
    expect(watch.tone).toBe('WATCH');
    expect(watch.label).toBe('انتباه');
    expect(watch.sentences[0]).toBe('المحجوز عم يزيد: سحبوا 100 وطلع من أيديهم 60.');
  });

  it('PILE WATCH, at its boundary: 84 of 100 is a watch, 85 of 100 is calm', () => {
    expect(flowOf(100, PILE_WATCH_EXIT_PERCENT - 1).tone).toBe('WATCH');
    const calm = flowOf(100, PILE_WATCH_EXIT_PERCENT);
    expect(calm.tone).toBe('CALM');
    expect(calm.sentences[0]).toBe('الحركة ماشية: سحبوا 100 وطلع من أيديهم 85.');
  });

  it('the pile rules need enough entries: 30 pulls can be a pile, 29 cannot', () => {
    expect(flowOf(FLOW_MIN_EVENTS, 5).tone).toBe('PROBLEM');
    const few = flowOf(FLOW_MIN_EVENTS - 1, 5);
    expect(few.tone).toBe('CALM');
    expect(few.sentences[0]).toBe('حركة قليلة: سحبوا 29 وطلع من أيديهم 5.');
  });

  it('DRAIN, at its boundary: more than 115% of the entries leaving (and enough of them) is said, exactly 115% is not', () => {
    const drain = flowOf(100, DRAIN_EXIT_PERCENT + 1);
    expect(drain.tone).toBe('CALM');
    expect(drain.sentences[0]).toBe('المحجوز عم بنزل: سحبوا 100 وطلع من أيديهم 116.');
    expect(flowOf(100, DRAIN_EXIT_PERCENT).sentences[0]).toBe('الحركة ماشية: سحبوا 100 وطلع من أيديهم 115.');
    // Enough exits: 30 can say it, 29 cannot.
    expect(flowOf(10, FLOW_MIN_EVENTS).sentences[0]).toBe('المحجوز عم بنزل: سحبوا 10 وطلع من أيديهم 30.');
    expect(flowOf(10, FLOW_MIN_EVENTS - 1).sentences[0]).toBe('حركة قليلة: سحبوا 10 وطلع من أيديهم 29.');
  });

  it('the calm sentence the owner wrote: «الحركة ماشية: سحبوا 312 وطلع من أيديهم 305»', () => {
    const r = flowOf(312, 305);
    expect(r).toEqual({ tone: 'CALM', label: 'ماشية', sentences: ['الحركة ماشية: سحبوا 312 وطلع من أيديهم 305.'] });
  });

  it('the pile sentence the owner wrote: «في تكدّس: سحبوا 340 وطلع 190 بس»', () => {
    expect(flowOf(340, 190).sentences[0]).toBe('في تكدّس: سحبوا 340 وطلع من أيديهم 190 بس — المحجوز بيزيد.');
  });

  it('orders taken another way are SAID beside the pulls — never folded into them — and they count toward the pile', () => {
    const r = readFlow(fig({ pulled: 60, typed: 30, onTheLine: 10, confirmed: 40 }));
    // 100 entered, 40 left: a pile, and the words keep the pulls apart from the rest.
    expect(r.tone).toBe('PROBLEM');
    expect(r.sentences[0]).toBe('في تكدّس: سحبوا 60 وأخدوا 40 بغير السحب وطلع من أيديهم 40 بس — المحجوز بيزيد.');
  });

  it('a cut ledger or cut decisions: the numbers are a floor, so no pile is judged — «حد أدنى» is said, the tone is a watch', () => {
    for (const cut of [{ ledger: true }, { decisions: true }]) {
      const r = readFlow(fig({ pulled: 20000, confirmed: 10, truncated: cut }));
      expect(r.tone).toBe('WATCH');
      expect(r.sentences[0]).toContain('حد أدنى');
      expect(r.sentences[0]).toContain('سحبوا 20000');
      expect(r.sentences[0]).not.toContain('في تكدّس');
    }
  });

  it('a cut ATTEMPTS list or HELD list does not stop the flow from being judged', () => {
    expect(readFlow(fig({ pulled: 100, confirmed: 10, truncated: { attempts: true } })).tone).toBe('PROBLEM');
    expect(readFlow(fig({ pulled: 100, confirmed: 10, truncated: { held: true } })).tone).toBe('PROBLEM');
  });
});

describe('the sentence — the second finding', () => {
  const held = (over: number, total: number, oldestDays = 9): Fig['held'] => ({
    total,
    under6h: total - over,
    over3d: over,
    oldestMs: oldestDays * DAY,
  });

  it('OLD, at its boundaries: ten orders and a tenth of the pile', () => {
    expect(flowOf(100, 100, { held: held(OLD_HELD_MIN - 1, 20) }).sentences).toHaveLength(1);
    // ten old, and ten of a hundred: a watch.
    const watch = flowOf(100, 100, { held: held(OLD_HELD_MIN, 100) });
    expect(watch.tone).toBe('WATCH');
    expect(watch.sentences).toEqual(['الحركة ماشية: سحبوا 100 وطلع من أيديهم 100.', '10 طلبات محجوز من أكتر من 3 أيام — أقدمهم من 9 أيام.']);
    // ten of a hundred and one is under a tenth: nothing to say.
    expect(flowOf(100, 100, { held: held(OLD_HELD_MIN, 101) }).sentences).toHaveLength(1);
    expect(OLD_WATCH_PERCENT).toBe(10);
  });

  it('OLD, a problem from three-tenths: 30 of 100 is a problem, 29 of 100 is a watch', () => {
    expect(flowOf(100, 100, { held: held(30, 100) }).tone).toBe('PROBLEM');
    expect(flowOf(100, 100, { held: held(29, 100) }).tone).toBe('WATCH');
    expect(OLD_PROBLEM_PERCENT).toBe(30);
  });

  it('OLD says the count in its own grammar and the oldest in days', () => {
    const r = flowOf(100, 100, { held: held(842, 1342, 41) });
    expect(r.sentences[1]).toBe('842 طلب محجوز من أكتر من 3 أيام — أقدمهم من 41 يوم.');
    expect(r.tone).toBe('PROBLEM');
  });

  it('OLD from a cut held list is a floor, said', () => {
    const r = flowOf(100, 100, { held: held(30, 100), truncated: { held: true } });
    expect(r.sentences[1]).toContain('(حد أدنى)');
  });

  it('SLOW, at its boundaries: 80% of 20 is calm, one fewer is a watch; half is a watch, under half a problem', () => {
    const speed = (judged: number, fast: number) => ({ judged, withAttempt: judged, fast, medianMinutes: 12 });
    expect(flowOf(100, 100, { speed: speed(SPEED_MIN_PULLS - 1, 0) }).sentences).toHaveLength(1); // too few to judge
    expect(flowOf(100, 100, { speed: speed(20, 16) }).sentences).toHaveLength(1); // exactly 80%
    const watch = flowOf(100, 100, { speed: speed(20, 15) });
    expect(watch.tone).toBe('WATCH');
    expect(watch.sentences[1]).toBe('بس 15 من 20 سحبة وصلها اتصال خلال 30 دقيقة دوام.');
    expect(flowOf(100, 100, { speed: speed(20, 10) }).tone).toBe('WATCH'); // exactly half
    expect(flowOf(100, 100, { speed: speed(20, 9) }).tone).toBe('PROBLEM');
    expect([FAST_WATCH_PERCENT, FAST_PROBLEM_PERCENT]).toEqual([80, 50]);
  });

  it('a null speed (a cut read) never writes a sentence about speed', () => {
    expect(flowOf(100, 100, { speed: null }).sentences).toHaveLength(1);
  });

  it('BOUNCE, at its boundaries: five orders and a tenth of the pulled; a quarter is a problem', () => {
    expect(flowOf(100, 100, { bounced: { orders: BOUNCE_MIN_ORDERS - 1, of: 5 } }).sentences).toHaveLength(1);
    const watch = flowOf(100, 100, { bounced: { orders: 5, of: 50 } });
    expect(watch.tone).toBe('WATCH');
    expect(watch.sentences[1]).toBe('5 طلبات انسحب من موظفتين أو أكتر — بينتقل بين الأيدي.');
    expect(flowOf(100, 100, { bounced: { orders: 5, of: 51 } }).sentences).toHaveLength(1);
    expect(flowOf(100, 100, { bounced: { orders: 5, of: 20 } }).tone).toBe('PROBLEM');
    expect(flowOf(100, 100, { bounced: { orders: 5, of: 21 } }).tone).toBe('WATCH');
    expect([BOUNCE_WATCH_PERCENT, BOUNCE_PROBLEM_PERCENT]).toEqual([10, 25]);
    expect(flowOf(100, 100, { bounced: { orders: 12, of: 40 } }).sentences[1]).toBe('12 طلب انسحب من موظفتين أو أكتر — بينتقل بين الأيدي.');
  });

  it('only ONE second sentence: the worst finding, and the first listed wins a tie', () => {
    const all: Fig = {
      held: held(10, 100), // watch
      speed: { judged: 20, withAttempt: 20, fast: 9, medianMinutes: 40 }, // problem
      bounced: { orders: 5, of: 20 }, // problem
    };
    const r = flowOf(100, 100, all);
    expect(r.tone).toBe('PROBLEM');
    expect(r.sentences).toHaveLength(2);
    // speed and bounce tie as problems: the speed one is listed first.
    expect(r.sentences[1]).toContain('سحبة وصلها اتصال');
    // …and a problem beats an earlier watch.
    const watchOld = flowOf(100, 100, { held: held(10, 100), bounced: { orders: 5, of: 20 } });
    expect(watchOld.sentences[1]).toContain('بينتقل بين الأيدي');
  });

  it('the tone is the worse of the two: a calm flow with a problem finding is a problem; a problem flow stays one', () => {
    expect(flowOf(100, 100, { held: held(40, 100) }).tone).toBe('PROBLEM');
    expect(flowOf(100, 50, { held: held(10, 100) }).tone).toBe('PROBLEM');
    expect(flowOf(100, 80, { held: held(10, 100) }).tone).toBe('WATCH');
  });

  it('the old-orders example the owner gave, in his shape', () => {
    const r = flowOf(100, 100, { held: held(12, 40, 9) });
    expect(r.sentences[1]).toBe('12 طلب محجوز من أكتر من 3 أيام — أقدمهم من 9 أيام.');
  });
});

describe('every sentence is Arabic and built from numbers', () => {
  it('no Latin letter, no NaN, no undefined, whatever the figures are', () => {
    const shapes: Fig[] = [
      {},
      { pulled: 5 },
      { pulled: 500, confirmed: 5 },
      { pulled: 100, typed: 10, onTheLine: 3, confirmed: 400, returned: 3 },
      { held: { total: 1342, under6h: 100, over3d: 842, oldestMs: 41 * DAY } },
      { pulled: 100, confirmed: 100, speed: { judged: 50, withAttempt: 40, fast: 5, medianMinutes: 55 }, bounced: { orders: 30, of: 100 } },
      { pulled: 99999, confirmed: 1, truncated: { ledger: true } },
      { workMinutes: 0, held: { total: 0, oldestMs: null } },
    ];
    for (const s of shapes) {
      const r = readFlow(fig(s));
      for (const text of [...r.sentences, r.label]) {
        expect(text).not.toMatch(/[A-Za-z]/);
        expect(text).not.toMatch(/NaN|undefined|null|Infinity/);
      }
      expect(r.sentences.length).toBeGreaterThanOrEqual(1);
      expect(r.sentences.length).toBeLessThanOrEqual(2);
    }
  });
});

// ───────────────────────── the rules, as written ─────────────────────────

describe('the thresholds are the numbers the owner was told', () => {
  /*
   * The boundary tests above are written against the constants, so they hold wherever a constant sits. This one pins WHERE they sit:
   * the table in the pull request names each number, and moving one is a decision that must come with a new table — not a one-line
   * change that every other test follows without a sound.
   */
  it('thirty events, 85 / 60 / 115 percent, ten old orders at 10 / 30 percent, twenty pulls at 80 / 50 percent in 30 minutes, five bounced at 10 / 25 percent, thirty quiet minutes', () => {
    expect({
      FLOW_MIN_EVENTS,
      PILE_WATCH_EXIT_PERCENT,
      PILE_PROBLEM_EXIT_PERCENT,
      DRAIN_EXIT_PERCENT,
      OLD_HELD_MIN,
      OLD_WATCH_PERCENT,
      OLD_PROBLEM_PERCENT,
      SPEED_MIN_PULLS,
      FAST_MINUTES,
      FAST_WATCH_PERCENT,
      FAST_PROBLEM_PERCENT,
      BOUNCE_MIN_ORDERS,
      BOUNCE_WATCH_PERCENT,
      BOUNCE_PROBLEM_PERCENT,
      QUIET_WORK_MINUTES,
    }).toEqual({
      FLOW_MIN_EVENTS: 30,
      PILE_WATCH_EXIT_PERCENT: 85,
      PILE_PROBLEM_EXIT_PERCENT: 60,
      DRAIN_EXIT_PERCENT: 115,
      OLD_HELD_MIN: 10,
      OLD_WATCH_PERCENT: 10,
      OLD_PROBLEM_PERCENT: 30,
      SPEED_MIN_PULLS: 20,
      FAST_MINUTES: 30,
      FAST_WATCH_PERCENT: 80,
      FAST_PROBLEM_PERCENT: 50,
      BOUNCE_MIN_ORDERS: 5,
      BOUNCE_WATCH_PERCENT: 10,
      BOUNCE_PROBLEM_PERCENT: 25,
      QUIET_WORK_MINUTES: 30,
    });
  });
});

describe('the file itself', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/held-flow.ts'), 'utf8');

  it('is pure: it imports nothing, reads no clock, and the screen may import it', () => {
    const code = stripComments(src);
    expect(code).not.toMatch(/^import\s/m);
    expect(code).not.toMatch(/Date\.now\(|new Date\(\)|require\(|process\.env|@prisma|from ['"]\.\/db['"]|\$queryRaw/);
  });

  it('every named threshold says why it sits where it does', () => {
    const lines = src.split(/\r?\n/);
    const names = [
      'FLOW_MIN_EVENTS',
      'PILE_WATCH_EXIT_PERCENT',
      'PILE_PROBLEM_EXIT_PERCENT',
      'DRAIN_EXIT_PERCENT',
      'OLD_HELD_MIN',
      'OLD_WATCH_PERCENT',
      'OLD_PROBLEM_PERCENT',
      'SPEED_MIN_PULLS',
      'FAST_WATCH_PERCENT',
      'FAST_PROBLEM_PERCENT',
      'BOUNCE_MIN_ORDERS',
      'BOUNCE_WATCH_PERCENT',
      'BOUNCE_PROBLEM_PERCENT',
      'QUIET_WORK_MINUTES',
      'FAST_MINUTES',
    ];
    for (const name of names) {
      const at = lines.findIndex((l) => l.startsWith(`export const ${name} =`));
      expect(at, `${name} is declared`).toBeGreaterThan(0);
      let before = at - 1;
      while (before > 0 && lines[before].trim() === '') before--;
      expect(lines[before].trim().endsWith('*/') || lines[before].trim().startsWith('//'), `${name} has a comment above it`).toBe(true);
    }
  });

  it('documents every reason in the header table, by its own word', () => {
    for (const word of [
      'PULL_NEXT',
      'MANUAL_ENTRY',
      'CUSTOMER_CALLED_BACK',
      'TAKEN_ON_THE_LINE',
      'AUTO_RELEASE_*',
      'NO_ANSWER_RETURNED',
      'DATE_RETURNED',
      'MANAGER_RETURNED',
      'TRANSFERRED',
      'OVERRIDDEN',
      'UNLOCKED',
    ]) {
      expect(src, word).toContain(word);
    }
  });
});

// ───────────────────────── against a reference ─────────────────────────

/** A small seeded generator, so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'pull' | 'typed' | 'line' | 'handover' | 'return' | 'moved' | 'unknown';
const REFERENCE_TABLE: Record<string, Kind> = {
  'CLAIMED|PULL_NEXT': 'pull',
  'CLAIMED|MANUAL_ENTRY': 'typed',
  'CLAIMED|CUSTOMER_CALLED_BACK': 'line',
  'RELEASED|TAKEN_ON_THE_LINE': 'handover',
};

/** The same figures, found the slow way: every «next line» and every «first attempt» is a scan of ALL rows. */
function reference(input: FlowInput) {
  const kind = (l: ClaimLine): Kind => {
    const exact = REFERENCE_TABLE[`${l.action}|${l.reason}`];
    if (exact) return exact;
    if (l.action === 'RELEASED') {
      const r = l.reason;
      if (r === null || r.trim() === '') return 'return';
      if (r.startsWith('AUTO_RELEASE') || ['NO_ANSWER_RETURNED', 'DATE_RETURNED', 'MANAGER_RETURNED'].includes(r)) return 'return';
      // Capital letters, digits and underscores only, starting with a letter: a machine's word.
      return /^[A-Z][A-Z0-9_]*$/.test(r) ? 'unknown' : 'return';
    }
    if (l.action === 'TRANSFERRED' || l.action === 'OVERRIDDEN') return 'moved';
    return 'unknown';
  };
  const count = (k: Kind) => input.claims.filter((l) => kind(l) === k).length;
  const pulls = input.claims.filter((l) => kind(l) === 'pull');
  const typed = count('typed');
  const onTheLine = Math.max(0, count('line') - count('handover'));
  const returned = count('return');
  let unknown = count('unknown');
  let confirmed = 0;
  let cancelled = 0;
  for (const d of input.decisions) {
    if (d.to === 'CONFIRMED') confirmed++;
    else if (d.to === 'REJECTED' || d.to === 'CANCELLED') cancelled++;
    else unknown++;
  }

  let judged = 0;
  let fast = 0;
  const minutes: number[] = [];
  for (const p of pulls) {
    let next = Infinity;
    for (const l of input.claims) {
      if (l.orderId === p.orderId && l.at.getTime() > p.at.getTime() && l.at.getTime() < next) next = l.at.getTime();
    }
    let first = Infinity;
    for (const a of input.attempts) {
      const t = a.at.getTime();
      if (a.orderId === p.orderId && a.userId === p.userId && t >= p.at.getTime() && t < next && t < first) first = t;
    }
    if (first !== Infinity) {
      const m = input.minutesBetween(p.at, new Date(first));
      minutes.push(m);
      judged++;
      if (m <= FAST_MINUTES) fast++;
    } else if (input.minutesBetween(p.at, input.now) > FAST_MINUTES) judged++;
  }
  minutes.sort((a, b) => a - b);
  const medianMinutes = minutes.length === 0 ? null : minutes.length % 2 ? minutes[(minutes.length - 1) / 2] : Math.round((minutes[minutes.length / 2 - 1] + minutes[minutes.length / 2]) / 2);

  const orders = [...new Set(pulls.map((p) => p.orderId))];
  const bouncedOrders = orders.filter((o) => new Set(pulls.filter((p) => p.orderId === o).map((p) => p.userId)).size >= 2).length;

  const HOUR = 3_600_000;
  const aged = input.held.filter((h) => h.claimedAt).map((h) => Math.max(0, input.now.getTime() - h.claimedAt!.getTime()));
  const held = {
    total: input.held.length,
    under6h: aged.filter((a) => a < 6 * HOUR).length,
    from6hTo24h: aged.filter((a) => a >= 6 * HOUR && a < 24 * HOUR).length,
    from1dTo3d: aged.filter((a) => a >= 24 * HOUR && a <= 72 * HOUR).length,
    over3d: aged.filter((a) => a > 72 * HOUR).length,
    unknownAge: input.held.filter((h) => !h.claimedAt).length,
    oldestMs: aged.length ? Math.max(...aged) : null,
  };

  const enteredTotal = pulls.length + typed + onTheLine;
  const exitsTotal = confirmed + returned + cancelled;
  return {
    created: input.created,
    entered: { pulled: pulls.length, typed, onTheLine, total: enteredTotal },
    exits: { confirmed, returned, cancelled, total: exitsTotal },
    net: enteredTotal - exitsTotal,
    moved: count('moved'),
    unknown,
    held,
    speed: input.truncated.ledger || input.truncated.attempts ? null : { judged, withAttempt: minutes.length, fast, medianMinutes },
    bounced: { orders: bouncedOrders, of: orders.length },
    workMinutes: input.workMinutes,
    truncated: input.truncated,
  };
}

describe('against a reference that walks the events one by one', () => {
  const ACTIONS: [string, string | null][] = [
    ['CLAIMED', 'PULL_NEXT'],
    ['CLAIMED', 'PULL_NEXT'],
    ['CLAIMED', 'PULL_NEXT'],
    ['CLAIMED', 'MANUAL_ENTRY'],
    ['CLAIMED', 'CUSTOMER_CALLED_BACK'],
    ['CLAIMED', null],
    ['CLAIMED', 'حرّ'],
    ['RELEASED', 'AUTO_RELEASE_90_BUSINESS_MINUTES'],
    ['RELEASED', 'NO_ANSWER_RETURNED'],
    ['RELEASED', 'TAKEN_ON_THE_LINE'],
    ['RELEASED', null],
    ['RELEASED', 'تعبت'],
    ['RELEASED', 'FUTURE_CODE'],
    ['RELEASED', 'AUTO_RELEASE_NEW_RULE'],
    ['TRANSFERRED', 'x'],
    ['OVERRIDDEN', 'y'],
    ['UNLOCKED', null],
  ];

  function randomInput(seed: number): FlowInput {
    const r = rng(seed);
    const int = (n: number) => Math.floor(r() * n);
    const pick = <T,>(xs: T[]) => xs[int(xs.length)];
    const orders = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
    const users = ['a', 'b', 'c', 'd'];
    // Minutes are coarse on purpose, so ties — a pull and an attempt in one instant, two lines at once — are common.
    const minute = () => int(400);
    const claims: ClaimLine[] = Array.from({ length: int(36) }, () => {
      const [action, reason] = pick(ACTIONS);
      return claim(pick(orders), pick(users), action, reason, minute());
    });
    return {
      created: int(50),
      claims,
      decisions: Array.from({ length: int(10) }, () => decided(pick(orders), pick(['CONFIRMED', 'REJECTED', 'CANCELLED', 'CONFIRMED', 'ODD']), minute())),
      attempts: Array.from({ length: int(50) }, () => attempt(pick(orders), pick(users), minute())),
      held: Array.from({ length: int(16) }, () => ({
        claimedAt: r() < 0.15 ? null : new Date(NOW.getTime() - int(10 * 24 * 60) * 60_000),
      })),
      now: NOW,
      minutesBetween: r() < 0.5 ? wall : (from, to) => Math.floor(wall(from, to) * 0.4),
      workMinutes: int(500),
      truncated: { ledger: r() < 0.1, decisions: r() < 0.1, attempts: r() < 0.1, held: r() < 0.1 },
    };
  }

  it('agrees on 600 random ledgers — every field of the figures', () => {
    for (let seed = 1; seed <= 600; seed++) {
      const input = randomInput(seed);
      expect(tallyFlow(input), `seed ${seed}`).toEqual(reference(input));
    }
  });

  it('and the reading never throws, and never leaves its two-sentence bound, on any of them', () => {
    for (let seed = 1; seed <= 600; seed++) {
      const r = readFlow(tallyFlow(randomInput(seed)));
      expect(r.sentences.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      expect(r.sentences.length).toBeLessThanOrEqual(2);
      expect(['CALM', 'WATCH', 'PROBLEM']).toContain(r.tone);
    }
  });

  it('the order of the rows is nobody’s business: shuffled ledgers give the same figures', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const input = randomInput(seed);
      const r = rng(seed + 9000);
      const shuffle = <T,>(xs: T[]) => [...xs].sort(() => r() - 0.5);
      const shuffled = { ...input, claims: shuffle(input.claims), attempts: shuffle(input.attempts), decisions: shuffle(input.decisions), held: shuffle(input.held) };
      expect(tallyFlow(shuffled), `seed ${seed}`).toEqual(tallyFlow(input));
    }
  });
});

// ───────────────────────── the sums, as an invariant ─────────────────────────

describe('the sums close, whatever the ledger says', () => {
  it('net is entered minus exited; exits are the three parts; entered are the three parts', () => {
    const r = rng(42);
    for (let i = 0; i < 200; i++) {
      const claims: ClaimLine[] = Array.from({ length: Math.floor(r() * 25) }, () => {
        const kinds: [string, string | null][] = [
          ['CLAIMED', 'PULL_NEXT'],
          ['CLAIMED', 'MANUAL_ENTRY'],
          ['CLAIMED', 'CUSTOMER_CALLED_BACK'],
          ['RELEASED', 'TAKEN_ON_THE_LINE'],
          ['RELEASED', null],
          ['TRANSFERRED', null],
        ];
        const [action, reason] = kinds[Math.floor(r() * kinds.length)];
        return claim(`o${Math.floor(r() * 5)}`, `u${Math.floor(r() * 3)}`, action, reason, Math.floor(r() * 300));
      });
      const decisions = Array.from({ length: Math.floor(r() * 6) }, () => decided(`o${Math.floor(r() * 5)}`, ['CONFIRMED', 'REJECTED', 'CANCELLED'][Math.floor(r() * 3)], Math.floor(r() * 300)));
      const f = tally({ claims, decisions });
      expect(f.entered.total).toBe(f.entered.pulled + f.entered.typed + f.entered.onTheLine);
      expect(f.exits.total).toBe(f.exits.confirmed + f.exits.returned + f.exits.cancelled);
      expect(f.net).toBe(f.entered.total - f.exits.total);
      expect(f.exits.confirmed + f.exits.cancelled).toBe(decisions.length);
    }
  });
});
