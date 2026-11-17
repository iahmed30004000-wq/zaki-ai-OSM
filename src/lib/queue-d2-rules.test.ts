import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { healthAlerts, QUEUE_HEALTH, type QueueHealth } from './queue-health-words';
import { arrivalCurve, hourlyRates, recalibrationNote, RECAL_MIN_SAMPLES, type WindowReading } from './queue-recalibration';
import { modesInMinutes, parseQueueModes, QUEUE_MODES_DEFAULTS, validateQueueModes } from './queue-modes-settings';
import { queueModeAt, QUEUE_PRIORITY_LIMITS } from './queue-priority';
import { RETURNS_MODE, returnsLimits } from './confirmation-queue';
import { forgetQueuePrioritySwitch } from './queue-priority-switch';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — QUEUE PRIORITY v2, STEP D2: THE LIMITS, THE HEALTH BOARD, THE HOURS, THE RECALIBRATION
 *
 *  1. With the key ON the hand limit is 3 and the idle release is 20 working minutes; OFF (or a read that fails) it is `RETURNS_MODE`'s 5 and 30, line for line.
 *  2. The four alerts fire at their edges and only there: backlog > 150, oldest due > 24 h, no pull > 20 min inside shift hours with new orders waiting, a new order unclaimed > 30 min inside shift hours.
 *     Outside shift hours the two coverage alerts are silent.
 *  3. The modes' hours are whole hours, non-empty, never overlapping; the defaults are the study's 09–11 and 21–24; `queueModeAt` honours the owner's hours.
 *  4. The weekly note says what moved and how every figure is counted; an hour with fewer than 20 attempts has no rate.
 * ═════════════════════════════════════════════════════════════════
 */
const CO = 'co-d2';
const on = (enabled: boolean) => ({ company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify(enabled ? { queuePriority: { enabled: true, enabledAt: '2026-11-17T00:00:00.000Z' } } : {}) })) } });

describe('the returns mode numbers (rule 1)', () => {
  beforeEach(() => forgetQueuePrioritySwitch());

  it('key ON: 3 and 20', async () => {
    expect(QUEUE_PRIORITY_LIMITS).toEqual({ handLimit: 3, idleBusinessMinutes: 20 });
    expect(await returnsLimits(on(true) as never, CO)).toEqual({ handLimit: 3, idleBusinessMinutes: 20 });
  });

  it('key OFF, or a read that fails: the mode\'s own 5 and 30', async () => {
    expect(await returnsLimits(on(false) as never, CO)).toEqual({ handLimit: RETURNS_MODE.handLimit, idleBusinessMinutes: RETURNS_MODE.idleBusinessMinutes });
    forgetQueuePrioritySwitch();
    const broken = { company: { findUnique: vi.fn(async () => { throw new Error('db down'); }) } };
    expect(await returnsLimits(broken as never, CO)).toEqual({ handLimit: 5, idleBusinessMinutes: 30 });
  });
});

const calm: QueueHealth = { backlog: 10, dueNow: 2, oldestDueHours: 1, enteredToday: 5, closedToday: 6, newWaiting: 3, oldestNewMinutes: 5, noPullMinutes: 2, inShift: true };
const kinds = (h: Partial<QueueHealth>) => healthAlerts({ ...calm, ...h }).map((a) => a.kind);

describe('the four alerts (rule 2)', () => {
  it('a calm queue raises none', () => expect(kinds({})).toEqual([]));

  it('backlog: 150 is fine, 151 is not', () => {
    expect(kinds({ backlog: QUEUE_HEALTH.backlogAlert })).toEqual([]);
    expect(kinds({ backlog: QUEUE_HEALTH.backlogAlert + 1 })).toEqual(['BACKLOG_HIGH']);
  });

  it('oldest due: 24 hours exactly is fine, a minute more is not; none due is fine', () => {
    expect(kinds({ oldestDueHours: 24 })).toEqual([]);
    expect(kinds({ oldestDueHours: 24.02 })).toEqual(['OLDEST_DUE_STALE']);
    expect(kinds({ oldestDueHours: null })).toEqual([]);
  });

  it('no pulls: needs shift hours, new orders waiting and MORE than 20 minutes', () => {
    expect(kinds({ noPullMinutes: 20 })).toEqual([]);
    expect(kinds({ noPullMinutes: 21 })).toEqual(['NO_PULLS']);
    expect(kinds({ noPullMinutes: 60, newWaiting: 0 })).toEqual([]);
    expect(kinds({ noPullMinutes: null, inShift: false })).toEqual([]);
  });

  it('a new order unclaimed: more than 30 minutes inside shift hours', () => {
    expect(kinds({ oldestNewMinutes: 30 })).toEqual([]);
    expect(kinds({ oldestNewMinutes: 31 })).toEqual(['NEW_UNCLAIMED']);
    expect(kinds({ oldestNewMinutes: 90, inShift: false })).toEqual([]);
  });

  it('says its number in the sentence, with no customer field', () => {
    const [a] = healthAlerts({ ...calm, backlog: 200 });
    expect(a.message).toContain('200');
    expect(JSON.stringify(a)).not.toMatch(/phone|name|address/i);
  });
});

describe('the modes\' hours (rule 3)', () => {
  it('defaults are the study\'s', () => expect(QUEUE_MODES_DEFAULTS).toEqual({ nightFrom: 9, nightTo: 11, peakFrom: 21, peakTo: 24 }));

  it('accepts a valid document and refuses empty, overlapping, fractional, out-of-range and unknown ones', () => {
    expect(validateQueueModes({ nightFrom: 8, nightTo: 12, peakFrom: 20, peakTo: 24 }).ok).toBe(true);
    for (const bad of [
      { nightFrom: 11, nightTo: 9, peakFrom: 21, peakTo: 24 },
      { nightFrom: 9, nightTo: 9, peakFrom: 21, peakTo: 24 },
      { nightFrom: 9, nightTo: 22, peakFrom: 21, peakTo: 24 },
      { nightFrom: 9.5, nightTo: 11, peakFrom: 21, peakTo: 24 },
      { nightFrom: 9, nightTo: 11, peakFrom: 21, peakTo: 25 },
      { nightFrom: 9, nightTo: 11, peakFrom: 21, peakTo: 24, extra: 1 },
      null,
      'x',
    ]) expect(validateQueueModes(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it('anything that is not a valid document is the defaults', () => {
    expect(parseQueueModes({ nightFrom: 30 })).toEqual(QUEUE_MODES_DEFAULTS);
    expect(parseQueueModes(undefined)).toEqual(QUEUE_MODES_DEFAULTS);
  });

  it('queueModeAt honours the owner\'s hours, and the old call is the old answer', () => {
    const modes = modesInMinutes({ nightFrom: 8, nightTo: 10, peakFrom: 18, peakTo: 22 });
    expect(queueModeAt(8 * 60, modes)).toBe('NIGHT_FIRST');
    expect(queueModeAt(10 * 60, modes)).toBe('NORMAL');
    expect(queueModeAt(19 * 60, modes)).toBe('PEAK_NEW_FIRST');
    expect(queueModeAt(9 * 60 + 30)).toBe('NIGHT_FIRST');
    expect(queueModeAt(23 * 60)).toBe('PEAK_NEW_FIRST');
    expect(queueModeAt(15 * 60)).toBe('NORMAL');
  });
});

describe('the weekly recalibration (rule 4)', () => {
  const tz = 'UTC';
  const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h, 0, 0));

  it('an hour with too few attempts has no rate; with enough, the percent reached', () => {
    const many = [
      ...Array.from({ length: 15 }, () => ({ createdAt: at(12), result: 'ANSWERED' })),
      ...Array.from({ length: 5 }, () => ({ createdAt: at(12), result: 'NO_ANSWER' })),
      ...Array.from({ length: RECAL_MIN_SAMPLES - 1 }, () => ({ createdAt: at(18), result: 'ANSWERED' })),
    ];
    const rows = hourlyRates(many, tz);
    expect(rows[12]).toMatchObject({ reached: 15, noAnswer: 5, rate: 75 });
    expect(rows[18].rate).toBeNull();
  });

  it('counts the arrival curve by local hour', () => {
    const curve = arrivalCurve([at(1), at(1), at(23)], tz);
    expect(curve[1]).toBe(2);
    expect(curve[23]).toBe(1);
    expect(curve.reduce((s, n) => s + n, 0)).toBe(3);
  });

  it('the note says what moved, the best and worst hours, the peak, and the rule — and that it changes nothing', () => {
    const hours = (rates: Record<number, number>) => Array.from({ length: 24 }, (_, hour) => ({ hour, reached: 0, noAnswer: 0, rate: rates[hour] ?? null }));
    const arrivals = Array.from({ length: 24 }, (_, h) => (h === 22 ? 50 : 1));
    const win = (share: number, rates: Record<number, number>): WindowReading => ({ share, inputs: { newUnique: 1, backlogEntered: 1, staleStock: 0 }, hours: hours(rates), arrivals });
    const note = recalibrationNote(win(0.47, { 12: 80, 18: 65 }), win(0.37, {}));
    expect(note).toContain('47%');
    expect(note).toContain('زادت 10 نقطة');
    expect(note).toContain('12:00');
    expect(note).toContain('18:00');
    expect(note).toContain('22:00');
    expect(note).toContain('قاعدة الاحتساب');
    expect(note).toContain('ما بيغيّر أي رقم بالسحب');
  });
});
