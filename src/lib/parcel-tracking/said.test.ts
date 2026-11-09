import { describe, expect, it } from 'vitest';
import { SAID_STATUSES, type SaidStatus } from '../couriers/courier-said';
import { COMPANY_WORD_AR } from '../couriers/word-names';
import {
  NO_SAID_COUNTS,
  SAID_OPTION_AR,
  SAID_PARTIAL_HINT,
  SAID_PREFIX,
  SAID_TONE,
  saidAge,
  saidChipLabel,
  saidHint,
  saidTitle,
  saidWhen,
  type SaidOnTheRow,
} from './said';
import { repoFile, stripComments } from '../guard-source';

/**
 * «الشركة بتقول» — THE WORDS, THE TONES AND THE AGE THE FOLLOW-UP LIST DRAWS THE COMPANY'S WORD WITH.
 *
 * Pure, so each is a line here: what the chip says and in what tone, the one status that carries an extra act, how old
 * the word is in short spoken Arabic (counted in the right plural, floored), and that nothing the screen shows from here
 * is in English.
 */

const said = (over: Partial<SaidOnTheRow> = {}): SaidOnTheRow => ({
  status: 'DELIVERED',
  label: 'تم التوصيل',
  note: null,
  at: '2026-11-09T10:00:00.000Z',
  ageMinutes: 120,
  ...over,
});

describe('the chip', () => {
  it('— says «الشركة بتقول» and then the company’s own name for what it said', () => {
    expect(SAID_PREFIX).toBe('الشركة بتقول');
    expect(saidChipLabel(said())).toBe('الشركة بتقول: تم التوصيل');
    expect(saidChipLabel(said({ label: 'تم توصيلها بشكل جزئي' }))).toBe('الشركة بتقول: تم توصيلها بشكل جزئي');
  });

  it('and the tones: delivered is good, a return or a cancellation is bad, a part delivery and a postponement ask for a look', () => {
    expect(SAID_TONE).toEqual({
      DELIVERED: 'good',
      PARTIALLY_DELIVERED: 'ok',
      RETURNED: 'bad',
      CANCELLED: 'bad',
      FAILED_DELIVERY: 'ok',
    });
    expect(Object.keys(SAID_TONE).sort()).toEqual([...SAID_STATUSES].sort());
  });

  it('and ONLY a part delivery carries the act that cannot wait for the statement', () => {
    expect(SAID_PARTIAL_HINT).toBe('سجّلي «استلم جزءاً» بالبنود');
    for (const status of SAID_STATUSES) {
      expect(saidHint(said({ status })), status).toBe(status === 'PARTIALLY_DELIVERED' ? SAID_PARTIAL_HINT : null);
    }
  });
});

describe('how old the word is — short, spoken, in the right plural', () => {
  it.each([
    [0, 'قبل لحظات'],
    [0.9, 'قبل لحظات'],
    [1, 'قبل دقيقة'],
    [2, 'قبل دقيقتين'],
    [3, 'قبل 3 دقائق'],
    [10, 'قبل 10 دقائق'],
    [11, 'قبل 11 دقيقة'],
    [59, 'قبل 59 دقيقة'],
    [60, 'قبل ساعة'],
    [119, 'قبل ساعة'],
    [120, 'قبل ساعتين'],
    [179, 'قبل ساعتين'],
    [180, 'قبل 3 ساعات'],
    [600, 'قبل 10 ساعات'],
    [660, 'قبل 11 ساعة'],
    [23 * 60 + 59, 'قبل 23 ساعة'],
    [24 * 60, 'قبل يوم'],
    [47 * 60, 'قبل يوم'],
    [48 * 60, 'قبل يومين'],
    [3 * 24 * 60, 'قبل 3 أيام'],
    [10 * 24 * 60, 'قبل 10 أيام'],
    [11 * 24 * 60, 'قبل 11 يوماً'],
    [45 * 24 * 60, 'قبل 45 يوماً'],
  ])('— %s minutes is «%s»', (minutes, words) => {
    expect(saidAge(minutes)).toBe(words);
  });

  it('and a number that is not one — negative, not a number, infinite — is «قبل لحظات», never «قبل NaN»', () => {
    for (const bad of [-5, Number.NaN, Number.NEGATIVE_INFINITY]) expect(saidAge(bad), String(bad)).toBe('قبل لحظات');
  });

  it('and the line under the chip is the age, then the company’s own note in quotes when it wrote one', () => {
    expect(saidWhen(said({ ageMinutes: 120 }))).toBe('قبل ساعتين');
    expect(saidWhen(said({ ageMinutes: 120, note: 'العميل طلب التأجيل' }))).toBe('قبل ساعتين · «العميل طلب التأجيل»');
  });

  it('and the tooltip puts the note first, then says plainly that nothing about the order has changed because of it', () => {
    const plain = saidTitle(said({ ageMinutes: 5 }));
    expect(plain).toContain('قالتها الشركة قبل 5 دقائق');
    expect(plain).toContain('حالة الطلب عندنا ما تغيّرت');
    expect(plain).not.toContain('ملاحظة الشركة');
    const noted = saidTitle(said({ ageMinutes: 5, note: 'العميل طلب التأجيل' }));
    expect(noted.startsWith('ملاحظة الشركة: «العميل طلب التأجيل» — ')).toBe(true);
  });
});

describe('the filter’s five choices', () => {
  it('— are the company’s words as the matching screens name them: one vocabulary for «what does the company say»', () => {
    expect(SAID_OPTION_AR).toEqual({
      DELIVERED: COMPANY_WORD_AR.DELIVERED,
      PARTIALLY_DELIVERED: COMPANY_WORD_AR.PARTIAL,
      RETURNED: COMPANY_WORD_AR.RETURNED,
      CANCELLED: COMPANY_WORD_AR.CANCELLED,
      FAILED_DELIVERY: COMPANY_WORD_AR.POSTPONED,
    });
    expect(new Set(Object.values(SAID_OPTION_AR)).size).toBe(5);
  });

  it('and a screen that has no numbers yet reads five zeros', () => {
    expect(NO_SAID_COUNTS).toEqual({ DELIVERED: 0, PARTIALLY_DELIVERED: 0, RETURNED: 0, CANCELLED: 0, FAILED_DELIVERY: 0 });
  });
});

describe('Arabic only — no Latin letter in anything the screen shows from here', () => {
  const LATIN = /[A-Za-z]/;
  it('— the chip, the age, the hint, the tooltip and the five options, for every status and a spread of ages', () => {
    const shown: string[] = [SAID_PREFIX, SAID_PARTIAL_HINT, ...Object.values(SAID_OPTION_AR)];
    for (const status of SAID_STATUSES) {
      for (const ageMinutes of [0, 1, 2, 7, 45, 61, 125, 1500, 4000, 20000]) {
        const s = said({ status: status as SaidStatus, ageMinutes, note: 'ملاحظة' });
        shown.push(saidChipLabel(s), saidAge(ageMinutes), saidWhen(s), saidTitle(s), saidHint(s) ?? '');
      }
    }
    expect(shown.filter((t) => LATIN.test(t))).toEqual([]);
  });
});

describe('the module is safe for the screen to import', () => {
  it('— it reaches no server module, and no clock', () => {
    const src = stripComments(repoFile('src/lib/parcel-tracking/said.ts'));
    for (const forbidden of ["'../db'", "'@/lib/db'", 'next/server', 'next/headers', 'logestechs', 'geo-context', 'authorization', 'Date.now', 'new Date(']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
