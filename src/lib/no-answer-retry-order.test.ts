import { describe, expect, it } from 'vitest';
import { NO_ANSWER_RESULTS } from './confirmation-workflow';
import { cadenceDueLineWhere, cadenceReadyWhere, firstRetryByDue, retryDueOf, type RetryLine, type RetryRow } from './no-answer-returns';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE RETRIES COME BY THEIR DUE: the pure part (the planner's ruling 2, step B)
 *
 *  1. An order's retry due is the due of its LAST counted «لا يرد»-class line after the floor: the latest due on those lines.
 *     A line with no due (an early press, the fifth), a line at or before the floor, and any other result never rank it.
 *  2. Among retries the oldest due is first; equal due → the older order; equal both → the smaller id; no due → not a retry.
 *  3. The lines read from the database (`cadenceDueLineWhere`) are the lines the readiness clause holds an order by.
 *
 * No database here: the in-memory pull is `the-retries-come-by-their-due.test.ts`.
 * Blockers: no money, no order creation, no migration, no contract.
 * ═══════════════════════════════════════════════════════════════════════
 */

const SINCE = new Date('2026-11-10T08:00:00.000Z');
const at = (min: number) => new Date(SINCE.getTime() + min * 60_000);
const line = (createdMin: number, result: string, dueMin: number | null): RetryLine => ({
  result,
  createdAt: at(createdMin),
  nextFollowUpAt: dueMin === null ? null : at(dueMin),
});

describe('retryDueOf — the due of the last counted press', () => {
  it('the LAST counted line’s due wins over the earlier ones — the latest due, not the first and not the smallest', () => {
    const d1 = 60;
    const d2 = 300;
    expect(retryDueOf([line(10, 'NO_ANSWER', d1), line(70, 'NO_ANSWER', d2)], SINCE)).toBe(at(d2).getTime());
    // …whatever order the lines arrive in.
    expect(retryDueOf([line(70, 'NO_ANSWER', d2), line(10, 'NO_ANSWER', d1)], SINCE)).toBe(at(d2).getTime());
    expect(retryDueOf([line(10, 'NO_ANSWER', d1), line(70, 'BUSY', d2), line(400, 'UNREACHABLE', 900)], SINCE)).toBe(at(900).getTime());
  });

  it('a line with NO due after a line with one (an early press, the fifth) changes nothing', () => {
    expect(retryDueOf([line(10, 'NO_ANSWER', 60), line(20, 'NO_ANSWER', null)], SINCE)).toBe(at(60).getTime());
    expect(retryDueOf([line(10, 'NO_ANSWER', 60), line(70, 'BUSY', 300), line(80, 'NO_ANSWER', null), line(500, 'UNREACHABLE', null)], SINCE)).toBe(at(300).getTime());
    // Only null-due lines: not a retry at all.
    expect(retryDueOf([line(10, 'NO_ANSWER', null), line(20, 'BUSY', null)], SINCE)).toBeNull();
    // `undefined` is as good as null (a select that left the column out).
    expect(retryDueOf([{ result: 'NO_ANSWER', createdAt: at(10) }], SINCE)).toBeNull();
  });

  it('a line AT the floor or before is ignored; one millisecond after counts (`gt`, as the readiness clause reads it)', () => {
    const due = at(500);
    expect(retryDueOf([{ result: 'NO_ANSWER', createdAt: SINCE, nextFollowUpAt: due }], SINCE)).toBeNull();
    expect(retryDueOf([{ result: 'NO_ANSWER', createdAt: new Date(SINCE.getTime() - 1), nextFollowUpAt: due }], SINCE)).toBeNull();
    expect(retryDueOf([{ result: 'NO_ANSWER', createdAt: new Date(SINCE.getTime() + 1), nextFollowUpAt: due }], SINCE)).toBe(due.getTime());
    // A pre-floor line never lifts a post-floor one, and never hides it.
    expect(retryDueOf([{ result: 'BUSY', createdAt: at(-30), nextFollowUpAt: at(9999) }, line(5, 'BUSY', 40)], SINCE)).toBe(at(40).getTime());
  });

  it('only the three «لا يرد» results rank: a callback, an answer, an opened line or a message with a date are ignored', () => {
    for (const result of ['CALLBACK_REQUESTED', 'ANSWERED', 'OPENED', 'MESSAGE_SENT', 'CONFIRMED', 'REJECTED', 'WRONG_NUMBER', 'POSTPONED', 'FOLLOW_UP_REQUIRED']) {
      expect(retryDueOf([line(10, result, 5000)], SINCE), result).toBeNull();
    }
    // …even beside a real retry: the odd result neither wins nor changes the answer.
    expect(retryDueOf([line(10, 'NO_ANSWER', 60), line(20, 'CALLBACK_REQUESTED', 5000)], SINCE)).toBe(at(60).getTime());
    for (const result of NO_ANSWER_RESULTS) expect(retryDueOf([line(10, result, 60)], SINCE), result).toBe(at(60).getTime());
  });

  it('Date and ISO-string inputs read the same; an invalid date string is ignored; no lines → null', () => {
    const asString: RetryLine = { result: 'NO_ANSWER', createdAt: at(10).toISOString(), nextFollowUpAt: at(60).toISOString() };
    expect(retryDueOf([asString], SINCE)).toBe(at(60).getTime());
    expect(retryDueOf([{ result: 'NO_ANSWER', createdAt: at(10), nextFollowUpAt: 'not a date' }], SINCE)).toBeNull();
    expect(retryDueOf([{ result: 'NO_ANSWER', createdAt: at(10), nextFollowUpAt: 'not a date' }, line(20, 'BUSY', 90)], SINCE)).toBe(at(90).getTime());
    // A line whose own createdAt is not a date is never after the floor.
    expect(retryDueOf([{ result: 'NO_ANSWER', createdAt: 'nope', nextFollowUpAt: at(60) }], SINCE)).toBeNull();
    expect(retryDueOf([], SINCE)).toBeNull();
  });
});

describe('firstRetryByDue — who the pull gives first among the retries', () => {
  const row = (id: string, createdMin: number, lines: RetryLine[]): RetryRow => ({ id, createdAt: at(createdMin), contactAttempts: lines });

  it('the oldest due wins even when its order is the younger one', () => {
    const older = row('a', -500, [line(10, 'NO_ANSWER', 400)]);
    const younger = row('b', -10, [line(10, 'NO_ANSWER', 100)]);
    expect(firstRetryByDue([older, younger], SINCE)).toBe('b');
    expect(firstRetryByDue([younger, older], SINCE)).toBe('b');
  });

  it('equal due → the older order; equal due and equal age → the smaller id', () => {
    const lines = [line(10, 'NO_ANSWER', 200)];
    expect(firstRetryByDue([row('z', -50, lines), row('y', -90, lines), row('x', -10, lines)], SINCE)).toBe('y');
    expect(firstRetryByDue([row('c', -50, lines), row('a', -50, lines), row('b', -50, lines)], SINCE)).toBe('a');
    expect(firstRetryByDue([row('b', -50, lines), row('c', -50, lines), row('a', -50, lines)], SINCE)).toBe('a');
  });

  it('rows with no due are skipped; when every row is skipped (or there are none) the answer is null', () => {
    const none = row('n', -999, [line(10, 'NO_ANSWER', null)]);
    const odd = row('o', -998, [line(10, 'CALLBACK_REQUESTED', 20)]);
    const preFloor = row('p', -997, [line(-5, 'NO_ANSWER', 20)]);
    const real = row('r', -1, [line(10, 'BUSY', 300)]);
    expect(firstRetryByDue([none, odd, preFloor, real], SINCE)).toBe('r');
    expect(firstRetryByDue([none, odd, preFloor], SINCE)).toBeNull();
    expect(firstRetryByDue([], SINCE)).toBeNull();
  });

  it('an order is ranked by its LAST due, not its first: one with an in-between due goes before it', () => {
    // `x` was due at 100, pressed again and now due at 900; `y` has one line due at 500.
    const x = row('x', -300, [line(10, 'NO_ANSWER', 100), line(120, 'NO_ANSWER', 900)]);
    const y = row('y', -10, [line(10, 'NO_ANSWER', 500)]);
    expect(firstRetryByDue([x, y], SINCE)).toBe('y');
  });
});

describe('cadenceDueLineWhere — the lines are the ones that hold an order', () => {
  it('is exactly «a لا يرد-class line, after the floor, carrying a due» — `not: null`, never `gt`', () => {
    expect(cadenceDueLineWhere(SINCE)).toEqual({
      result: { in: ['NO_ANSWER', 'BUSY', 'UNREACHABLE'] },
      createdAt: { gt: SINCE },
      nextFollowUpAt: { not: null },
    });
  });

  it('is built from the same results and the same floor as `cadenceReadyWhere`', () => {
    const now = new Date('2026-11-11T09:00:00.000Z');
    const holds = cadenceReadyWhere({ now, cadence: { since: SINCE } }).contactAttempts.none;
    const ranks = cadenceDueLineWhere(SINCE);
    expect(ranks.result).toEqual(holds.result);
    expect(ranks.createdAt).toEqual(holds.createdAt);
    // …and the list is a copy of the shared constant: nobody can change that constant through it.
    expect(ranks.result.in).not.toBe(NO_ANSWER_RESULTS);
    expect(ranks.result.in).toEqual([...NO_ANSWER_RESULTS]);
  });
});

describe('the rank, against an oracle written the other way round (seeded worlds)', () => {
  // A tiny seeded generator, so a red run can be replayed.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }
  const RESULTS = ['NO_ANSWER', 'BUSY', 'UNREACHABLE', 'OPENED', 'ANSWERED', 'CALLBACK_REQUESTED', 'MESSAGE_SENT'];

  it('sorting by (due, createdAt, id) with Math.max equals `firstRetryByDue` in thousands of worlds', () => {
    const next = rng(20261110);
    let compared = 0;
    for (let world = 0; world < 3000; world++) {
      const rows: RetryRow[] = [];
      const n = Math.floor(next() * 7);
      for (let i = 0; i < n; i++) {
        const lines: RetryLine[] = [];
        const k = Math.floor(next() * 5);
        for (let j = 0; j < k; j++) {
          // Coarse minutes on purpose, so equal dues, equal ages and lines on the floor are common.
          const createdMin = Math.floor(next() * 5) * 30 - 30;
          const dueMin = next() < 0.3 ? null : Math.floor(next() * 6) * 60;
          lines.push({ result: RESULTS[Math.floor(next() * RESULTS.length)], createdAt: at(createdMin), nextFollowUpAt: dueMin === null ? null : at(dueMin) });
        }
        rows.push({ id: `o${Math.floor(next() * 4)}-${i}`, createdAt: at(Math.floor(next() * 4) * 100 - 400), contactAttempts: lines });
      }
      // The oracle: keep the qualifying lines by their own text, take Math.max, sort by the key.
      const ranked = rows
        .map((r) => {
          const dues = r.contactAttempts
            .filter((l) => ['NO_ANSWER', 'BUSY', 'UNREACHABLE'].includes(l.result) && (l.createdAt as Date).getTime() > SINCE.getTime() && l.nextFollowUpAt)
            .map((l) => (l.nextFollowUpAt as Date).getTime());
          return { id: r.id, born: (r.createdAt as Date).getTime(), due: dues.length ? Math.max(...dues) : null };
        })
        .filter((r): r is { id: string; born: number; due: number } => r.due !== null)
        .sort((a, b) => a.due - b.due || a.born - b.born || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      expect(firstRetryByDue(rows, SINCE), `world ${world}`).toBe(ranked[0]?.id ?? null);
      compared++;
    }
    expect(compared).toBe(3000);
  });
});
