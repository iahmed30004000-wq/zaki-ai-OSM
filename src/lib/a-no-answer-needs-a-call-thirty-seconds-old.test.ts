import { describe, expect, it } from 'vitest';
import { callProofState, callProofVerdict, pairedLineVerdict } from './call-proof';
import { CLIENT_MARGIN_MS, MIN_CALL_MS, PAIRED_PRESS_GRACE_MS, secondsLeft } from './call-proof-words';
import { RETURNED_PRESS_GRACE_MS } from './confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «إثبات المكالمات», THE RULE (Confirmation Center v2, step A; the owner: «Releasing as NO_ANSWER requires a logged attempt and ≥ 30 seconds
 * since the attempt started»)
 *
 *  1. A «didn't answer» (NO_ANSWER, BUSY, UNREACHABLE) is accepted only with a press of «اتصال» (OPENED) of the SAME person on the order: no press → refused
 *     `NO_OPENED`; a press 29.999 s old → refused `TOO_SOON` (and says how long to wait); 30.000 s → accepted, and says how long it was.
 *  2. A colleague's press never licenses her; a press from before her claim does not count; an outcome line (hers or anybody's) consumes the press, so the same
 *     press is never spent twice; with two presses the LATEST is the attempt.
 *  3. «رقم غلط», «ردّ», «اتصل لاحقاً» and the lines that claim no outcome are not guarded at all.
 *  4. The status door's pair: her own newest outcome line must be the same result, no older than two minutes — presses and messages are walked past; «رقم غلط»,
 *     which also lands on «لا يرد» there, additionally needs a press before its line.
 *  5. The screens are told the same answer by the same function (`callProofState`).
 *
 * Pure: nothing here reads a database or a clock. Blockers: none of money, order creation, or a migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const T0 = new Date('2026-11-15T10:00:00.000Z').getTime();
const at = (ms: number) => new Date(T0 + ms);
const line = (result: string, ms: number, employeeId = 'u1', n = 1) => ({ createdAt: at(ms), result, employeeId, attemptNumber: n });
const verdict = (attempts: ReturnType<typeof line>[], nowMs: number, over: Partial<Parameters<typeof callProofVerdict>[0]> = {}) =>
  callProofVerdict({ attempts, employeeId: 'u1', claimedAt: null, result: 'NO_ANSWER', now: at(nowMs), ...over });

describe('the thirty seconds', () => {
  it('no press at all is refused NO_OPENED', () => {
    expect(verdict([], 60_000)).toEqual({ ok: false, code: 'NO_OPENED' });
  });

  it('29.999 s after the press is refused, and says how long to wait and when it opens', () => {
    expect(verdict([line('OPENED', 0)], 29_999)).toEqual({ ok: false, code: 'TOO_SOON', waitSeconds: 1, unlocksAtMs: T0 + 30_000 });
    expect(verdict([line('OPENED', 0)], 10_000)).toMatchObject({ ok: false, code: 'TOO_SOON', waitSeconds: 20 });
  });

  it('exactly 30.000 s is accepted, and the verdict carries the measured seconds', () => {
    expect(verdict([line('OPENED', 0)], 30_000)).toEqual({ ok: true, guarded: true, openedAt: at(0), elapsedSeconds: 30 });
    expect(verdict([line('OPENED', 0)], 95_500)).toMatchObject({ ok: true, elapsedSeconds: 95 });
  });

  it('the three results of the class are held to the same thirty seconds', () => {
    for (const result of ['NO_ANSWER', 'BUSY', 'UNREACHABLE']) {
      expect(verdict([line('OPENED', 0)], 29_999, { result }).ok).toBe(false);
      expect(verdict([line('OPENED', 0)], 30_000, { result }).ok).toBe(true);
    }
    expect(MIN_CALL_MS).toEqual({ NO_ANSWER: 30_000, BUSY: 30_000, UNREACHABLE: 30_000 });
  });

  it('a result outside the class is never guarded, press or no press', () => {
    for (const result of ['WRONG_NUMBER', 'ANSWERED', 'CALLBACK_REQUESTED', 'OTHER', 'OPENED', 'MESSAGE_SENT', 'CONFIRMED']) {
      expect(verdict([], 0, { result })).toEqual({ ok: true, guarded: false, openedAt: null, elapsedSeconds: null });
    }
  });
});

describe('which press is the attempt', () => {
  it('a colleague’s press never licenses her', () => {
    expect(verdict([line('OPENED', 0, 'u2')], 60_000)).toEqual({ ok: false, code: 'NO_OPENED' });
  });

  it('a press from before her claim does not count (a re-pull is a new claim)', () => {
    const claimedAt = at(5_000);
    expect(verdict([line('OPENED', 0)], 60_000, { claimedAt })).toEqual({ ok: false, code: 'NO_OPENED' });
    expect(verdict([line('OPENED', 5_000)], 60_000, { claimedAt }).ok).toBe(true);
  });

  it('an outcome line consumes the press: the same press is never spent twice', () => {
    const lines = [line('OPENED', 0, 'u1', 1), line('NO_ANSWER', 31_000, 'u1', 2)];
    expect(verdict(lines, 120_000)).toEqual({ ok: false, code: 'NO_OPENED' });
    // …and so does anybody's outcome line, even a colleague's.
    expect(verdict([line('OPENED', 0, 'u1', 1), line('ANSWERED', 5_000, 'u2', 2)], 120_000)).toEqual({ ok: false, code: 'NO_OPENED' });
  });

  it('a press AFTER the outcome is a new attempt, and its thirty seconds start there', () => {
    const lines = [line('OPENED', 0, 'u1', 1), line('NO_ANSWER', 31_000, 'u1', 2), line('OPENED', 100_000, 'u1', 3)];
    expect(verdict(lines, 110_000)).toMatchObject({ ok: false, code: 'TOO_SOON', waitSeconds: 20 });
    expect(verdict(lines, 130_000).ok).toBe(true);
  });

  it('with two presses the LATEST is the attempt: an early accidental press does not license a quick «لا يرد»', () => {
    const lines = [line('OPENED', 0, 'u1', 1), line('OPENED', 40_000, 'u1', 2)];
    expect(verdict(lines, 45_000)).toMatchObject({ ok: false, code: 'TOO_SOON' });
    expect(verdict(lines, 70_000).ok).toBe(true);
  });

  it('a sent message is neither a press nor an outcome: it neither starts nor consumes the attempt', () => {
    const lines = [line('OPENED', 0, 'u1', 1), line('MESSAGE_SENT', 20_000, 'u1', 2)];
    expect(verdict(lines, 30_000).ok).toBe(true);
  });

  it('the lines are walked in time order whatever order they arrive in (the attempt number breaks a tie)', () => {
    const lines = [line('NO_ANSWER', 40_000, 'u1', 3), line('OPENED', 0, 'u1', 1), line('OPENED', 41_000, 'u1', 4)];
    // The newest press (41 s) is the attempt — the older outcome at 40 s came BEFORE it, so it consumed nothing of it.
    expect(verdict(lines, 60_000)).toMatchObject({ ok: false, code: 'TOO_SOON', waitSeconds: 11 });
    expect(verdict(lines, 71_000).ok).toBe(true);
  });
});

describe('the status door’s pair', () => {
  const pair = (attempts: ReturnType<typeof line>[], nowMs: number, result = 'NO_ANSWER', over: Partial<Parameters<typeof pairedLineVerdict>[0]> = {}) =>
    pairedLineVerdict({ attempts, employeeId: 'u1', claimedAt: null, result, now: at(nowMs), ...over });

  it('her own newest outcome line of the same result, within two minutes, passes', () => {
    const lines = [line('OPENED', 0, 'u1', 1), line('NO_ANSWER', 31_000, 'u1', 2)];
    expect(pair(lines, 32_000)).toEqual({ ok: true });
    expect(pair(lines, 31_000 + PAIRED_PRESS_GRACE_MS)).toEqual({ ok: true });
  });

  it('an order with no outcome line, or a line older than two minutes, or another result, or somebody else’s line, is refused', () => {
    expect(pair([], 1_000)).toEqual({ ok: false, code: 'NOT_LOGGED' });
    expect(pair([line('OPENED', 0)], 60_000)).toEqual({ ok: false, code: 'NOT_LOGGED' });
    const lines = [line('OPENED', 0, 'u1', 1), line('NO_ANSWER', 31_000, 'u1', 2)];
    expect(pair(lines, 31_000 + PAIRED_PRESS_GRACE_MS + 1)).toEqual({ ok: false, code: 'NOT_LOGGED' });
    expect(pair(lines, 32_000, 'BUSY')).toEqual({ ok: false, code: 'NOT_LOGGED' });
    expect(pair([line('OPENED', 0, 'u2', 1), line('NO_ANSWER', 31_000, 'u2', 2)], 32_000)).toEqual({ ok: false, code: 'NOT_LOGGED' });
  });

  it('presses and messages after the line are walked past — a press that lands between the two calls does not fail a correctly recorded one', () => {
    const lines = [line('OPENED', 0, 'u1', 1), line('NO_ANSWER', 31_000, 'u1', 2), line('OPENED', 32_000, 'u1', 3), line('MESSAGE_SENT', 33_000, 'u1', 4)];
    expect(pair(lines, 40_000)).toEqual({ ok: true });
  });

  it('«رقم غلط» also needs a press before its line — otherwise it is the back door onto «لا يرد» with no call', () => {
    expect(pair([line('WRONG_NUMBER', 1_000, 'u1', 1)], 2_000, 'WRONG_NUMBER')).toEqual({ ok: false, code: 'NO_OPENED' });
    expect(pair([line('OPENED', 0, 'u1', 1), line('WRONG_NUMBER', 3_000, 'u1', 2)], 4_000, 'WRONG_NUMBER')).toEqual({ ok: true });
    // A colleague's press, or one from before her claim, is not hers.
    expect(pair([line('OPENED', 0, 'u2', 1), line('WRONG_NUMBER', 3_000, 'u1', 2)], 4_000, 'WRONG_NUMBER')).toEqual({ ok: false, code: 'NO_OPENED' });
    expect(pair([line('OPENED', 0, 'u1', 1), line('WRONG_NUMBER', 3_000, 'u1', 2)], 4_000, 'WRONG_NUMBER', { claimedAt: at(1_000) })).toEqual({ ok: false, code: 'NO_OPENED' });
  });

  it('its two minutes are the very grace the returns mode gives the second half of her own press', () => {
    expect(PAIRED_PRESS_GRACE_MS).toBe(RETURNED_PRESS_GRACE_MS);
  });
});

describe('what the screens are told', () => {
  const state = (attempts: ReturnType<typeof line>[], nowMs: number) => callProofState({ attempts, employeeId: 'u1', claimedAt: null, now: at(nowMs) });

  it('NO_OPENED, WAIT with the server’s unlock instant, READY', () => {
    expect(state([], 0)).toEqual({ state: 'NO_OPENED', unlocksAtMs: null });
    expect(state([line('OPENED', 0)], 10_000)).toEqual({ state: 'WAIT', unlocksAtMs: T0 + 30_000 });
    expect(state([line('OPENED', 0)], 30_000)).toEqual({ state: 'READY', unlocksAtMs: null });
  });

  it('the countdown is rounded UP and never below zero', () => {
    expect(secondsLeft(T0 + 30_000, T0 + 29_001)).toBe(1);
    expect(secondsLeft(T0 + 30_000, T0)).toBe(30);
    expect(secondsLeft(T0 + 30_000, T0 + 31_000)).toBe(0);
    expect(CLIENT_MARGIN_MS).toBe(2_000);
  });
});
