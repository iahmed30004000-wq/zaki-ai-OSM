import { describe, expect, it } from 'vitest';
import {
  WORK_HOURS_FORMAT_MESSAGE,
  WORK_HOURS_ORDER_MESSAGE,
  effectiveWorkHours,
  hhmmToMinutes,
  workHoursError,
} from './work-hours';
import { countryCreateSchema, countryUpdateSchema } from './geo-schemas';

/**
 * DEFINITION OF DONE — country working hours (planner ruling 18, settings half)
 *
 * What must work
 *   • There is no night shift. A country's workHoursStart must be strictly
 *     before its workHoursEnd; equal is refused too.
 *   • A corrupt value (not HH:mm, out of range, 24:00, empty, not a string) is
 *     refused with its own Arabic message.
 *   • One validator (`workHoursError`) serves every write door — create (POST)
 *     and update (PATCH); the screen asks it too, before the request.
 *   • A patch of one half is judged against the STORED value of the other.
 *   • A save that carries neither half is never judged on hours, even on a
 *     stored night-shift row (editing the name or the weekend must still work).
 *
 * The tests
 *   • here: the validator against an independent oracle (minutes computed
 *     by hand over a grid), and the schema layer;
 *   • the-work-hours-are-refused-at-every-door.test.ts: POST and PATCH;
 *   • the-geo-screen-refuses-bad-hours.test.tsx: the screen message + revert.
 *
 * Edge cases that matter: 00:00-23:59 passes; 23:59-00:00 fails; 09:00-09:00
 * fails; 22:00-06:00 (the old night row) fails; single-half patch vs stored.
 *
 * Blockers (fixed): none touched — no schema change, no money, no orders, no
 * customer data, no deferred contract; the server-side fallback for a corrupt
 * stored value lives in no-answer-cadence.ts and is not this task.
 */

describe('hhmmToMinutes', () => {
  it('reads valid times as minutes since midnight', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('09:30')).toBe(570);
    expect(hhmmToMinutes('23:59')).toBe(1439);
  });
  it('refuses everything that is not HH:mm', () => {
    for (const bad of ['24:00', '9:00', '09:60', '09-00', '09:0', '', ' 09:00', '09:00 ', '٠٩:٠٠', null, undefined, 900, {}]) {
      expect(hhmmToMinutes(bad)).toBeNull();
    }
  });
});

describe('workHoursError — the order', () => {
  it('passes a day that starts before it ends', () => {
    expect(workHoursError('09:00', '17:00')).toBeNull();
    expect(workHoursError('10:00', '22:00')).toBeNull();
    expect(workHoursError('00:00', '23:59')).toBeNull();
    expect(workHoursError('08:59', '09:00')).toBeNull();
  });

  it('refuses equal times', () => {
    expect(workHoursError('09:00', '09:00')).toBe(WORK_HOURS_ORDER_MESSAGE);
    expect(workHoursError('00:00', '00:00')).toBe(WORK_HOURS_ORDER_MESSAGE);
  });

  it('refuses a reversed day — there is no night shift', () => {
    expect(workHoursError('22:00', '06:00')).toBe(WORK_HOURS_ORDER_MESSAGE);
    expect(workHoursError('23:59', '00:00')).toBe(WORK_HOURS_ORDER_MESSAGE);
    expect(workHoursError('17:00', '09:00')).toBe(WORK_HOURS_ORDER_MESSAGE);
  });

  it('agrees with an independent oracle over a grid of every half hour', () => {
    const t = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    for (let a = 0; a < 24 * 60; a += 30) {
      for (let b = 0; b < 24 * 60; b += 30) {
        const expected = a < b ? null : WORK_HOURS_ORDER_MESSAGE;
        expect(workHoursError(t(a), t(b))).toBe(expected);
      }
    }
  });
});

describe('workHoursError — a corrupt value', () => {
  it('says the format message, whichever half is corrupt', () => {
    for (const bad of ['24:00', '25:00', '09:60', '9:00', '', 'abc', '09:00:00']) {
      expect(workHoursError(bad, '17:00')).toBe(WORK_HOURS_FORMAT_MESSAGE);
      expect(workHoursError('09:00', bad)).toBe(WORK_HOURS_FORMAT_MESSAGE);
    }
    expect(workHoursError(null, '17:00')).toBe(WORK_HOURS_FORMAT_MESSAGE);
    expect(workHoursError('09:00', undefined)).toBe(WORK_HOURS_FORMAT_MESSAGE);
    expect(workHoursError(900, 1700)).toBe(WORK_HOURS_FORMAT_MESSAGE);
  });

  it('the two messages are Arabic and different', () => {
    expect(WORK_HOURS_FORMAT_MESSAGE).toMatch(/[؀-ۿ]/);
    expect(WORK_HOURS_ORDER_MESSAGE).toMatch(/[؀-ۿ]/);
    expect(WORK_HOURS_FORMAT_MESSAGE).not.toBe(WORK_HOURS_ORDER_MESSAGE);
  });
});

describe('effectiveWorkHours — the half that was not sent comes from the stored row', () => {
  const stored = { workHoursStart: '09:00', workHoursEnd: '17:00' };

  it('a patch of only the end is judged against the stored start', () => {
    const h = effectiveWorkHours({ workHoursEnd: '08:00' }, stored);
    expect(h).toEqual({ touches: true, start: '09:00', end: '08:00' });
    expect(workHoursError(h.start, h.end)).toBe(WORK_HOURS_ORDER_MESSAGE);
  });

  it('a patch of only the start is judged against the stored end', () => {
    const h = effectiveWorkHours({ workHoursStart: '18:00' }, stored);
    expect(h).toEqual({ touches: true, start: '18:00', end: '17:00' });
    expect(workHoursError(h.start, h.end)).toBe(WORK_HOURS_ORDER_MESSAGE);
    const fixed = effectiveWorkHours({ workHoursStart: '08:00' }, stored);
    expect(workHoursError(fixed.start, fixed.end)).toBeNull();
  });

  it('sending both uses both and ignores the stored row', () => {
    expect(effectiveWorkHours({ workHoursStart: '10:00', workHoursEnd: '22:00' }, { workHoursStart: '22:00', workHoursEnd: '06:00' })).toEqual({
      touches: true,
      start: '10:00',
      end: '22:00',
    });
  });

  it('a patch with neither half does not touch the hours', () => {
    expect(effectiveWorkHours({}, { workHoursStart: '22:00', workHoursEnd: '06:00' }).touches).toBe(false);
  });
});

describe('the schemas keep the format half', () => {
  const base = { code: 'SY', name: 'سوريا', currencyCode: 'SYP', minorUnit: 2 };

  it('create defaults to 09:00-17:00 and refuses a malformed hour with the Arabic format message', () => {
    const ok = countryCreateSchema.parse(base);
    expect([ok.workHoursStart, ok.workHoursEnd]).toEqual(['09:00', '17:00']);
    for (const bad of ['24:00', '9:00', 900, null]) {
      const r = countryCreateSchema.safeParse({ ...base, workHoursStart: bad });
      expect(r.success).toBe(false);
      expect(!r.success && r.error.issues[0].message).toBe(WORK_HOURS_FORMAT_MESSAGE);
    }
  });

  it('update accepts a lone valid half and refuses a malformed one', () => {
    expect(countryUpdateSchema.safeParse({ workHoursEnd: '23:59' }).success).toBe(true);
    const r = countryUpdateSchema.safeParse({ workHoursEnd: '24:00' });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0].message).toBe(WORK_HOURS_FORMAT_MESSAGE);
  });
});
