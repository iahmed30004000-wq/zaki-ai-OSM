import { describe, expect, it } from 'vitest';
import { PARKED, PARKED_AR, RESOLUTIONS, RESOLUTION_AR } from '../settlement-difference';
import * as words from './difference-words';
import {
  ANSWERED_AR,
  COMPANY_LINE_AR,
  DIFFERENCE_MARK,
  MATCHING_NOTE_AR,
  NEEDS_REVIEW_KEY_AR,
  OURS_AR,
  OVER_AR,
  SHORT_AR,
  THEIRS_AR,
  answerWord,
  differenceDoneMessage,
  gapWord,
  markHead,
  markTitle,
  markTone,
} from './difference-words';

/**
 * «فيه فرق» — THE WORDS AND THE TONES, ONE PLACE (13/11).
 *
 * The mark and the dialog say the gap as a WORD (نقص / زيادة) and never as a sign: the matching's own `difference` is
 * `statement − expected`, `shortfall` flips it so that a positive figure is what the company kept back, and two screens
 * flipping it twice is the defect that file exists to prevent. The answer's word is the matching screen's own (never a
 * second vocabulary). Everything said here is Arabic.
 */

describe('the gap is a word, from the settlement rule’s own sign', () => {
  it('positive is what the company kept back — a shortage; negative is more than we expected', () => {
    expect(gapWord(3)).toBe(SHORT_AR);
    expect(gapWord(0.001)).toBe(SHORT_AR);
    expect(gapWord(-2.5)).toBe(OVER_AR);
    expect([SHORT_AR, OVER_AR]).toEqual(['نقص', 'زيادة']);
  });

  it('says nothing when the figures agree, when one is missing, or when the number is not one', () => {
    for (const v of [0, null, undefined, NaN, Infinity, -Infinity]) expect(gapWord(v as number | null | undefined), String(v)).toBeNull();
  });
});

describe('the answer’s word is the matching screen’s own', () => {
  it('each saying has the word it has there — read from the same table, not copied', () => {
    for (const r of RESOLUTIONS) expect(answerWord(r)).toBe(RESOLUTION_AR[r]);
    expect(answerWord(PARKED)).toBe(PARKED_AR);
    expect(RESOLUTIONS.map((r) => answerWord(r))).toEqual(['اعتُمد رقم الشركة', 'رقمنا هو المعتمد']);
    expect(answerWord('UNDER_REVIEW')).toBe('قيد المراجعة');
  });

  it('nobody has answered: no word', () => {
    for (const v of [null, undefined, '']) expect(answerWord(v), String(v)).toBeNull();
  });

  it('a saying this screen has no word for is «انبتّ فيه» — never the code', () => {
    expect(answerWord('SOMETHING_NEW')).toBe(ANSWERED_AR);
    expect(ANSWERED_AR).toBe('انبتّ فيه');
  });
});

describe('the mark’s head and colour', () => {
  it('is the red «فيه فرق» until somebody answers, and then the answer’s own word', () => {
    expect(markHead({ resolution: null })).toBe(DIFFERENCE_MARK);
    expect(DIFFERENCE_MARK).toBe('فيه فرق');
    expect(markHead({ resolution: 'ACCEPTED_COURIER' })).toBe('اعتُمد رقم الشركة');
    expect(markHead({ resolution: 'OURS_STANDS' })).toBe('رقمنا هو المعتمد');
    expect(markHead({ resolution: 'UNDER_REVIEW' })).toBe('قيد المراجعة');
  });

  it('red while it waits; the two money answers are settled news; a parked look is a postponed one', () => {
    expect(markTone({ resolution: null })).toBe('bad');
    expect(markTone({ resolution: 'ACCEPTED_COURIER' })).toBe('good');
    expect(markTone({ resolution: 'OURS_STANDS' })).toBe('good');
    expect(markTone({ resolution: 'UNDER_REVIEW' })).toBe('ok');
    expect(markTone({ resolution: 'SOMETHING_NEW' })).toBe('ok');
  });
});

describe('the tooltip says what it is and what pressing it does for THIS person', () => {
  it('open: «اضغط تشوف الرقمين وتبتّ فيه» for whoever may decide; only the first half for whoever may not', () => {
    const open = { resolution: null, closed: false };
    expect(markTitle(open, true)).toBe('سطر الشركة بالكشف بيختلف عن رقمنا — اضغط تشوف الرقمين وتبتّ فيه');
    expect(markTitle(open, false)).toBe('سطر الشركة بالكشف بيختلف عن رقمنا — اضغط تشوف الرقمين');
  });

  it('answered: says what it was answered with', () => {
    expect(markTitle({ resolution: 'OURS_STANDS', closed: false }, true)).toBe('انبتّ فيه: رقمنا هو المعتمد — اضغط تشوف الرقمين وتبتّ فيه');
  });

  it('closed: says the statement is closed, and never promises a decision — even to a person who may decide', () => {
    const t = markTitle({ resolution: 'ACCEPTED_COURIER', closed: true }, true);
    expect(t).toBe('انبتّ فيه: اعتُمد رقم الشركة — الكشف مغلق، فما بيتغيّر — اضغط تشوف الرقمين');
    expect(t).not.toContain('وتبتّ فيه');
  });
});

describe('what is said after an answer, and what is said instead of the answers', () => {
  it('names the order and says it stays marked', () => {
    expect(differenceDoneMessage('ORD-7')).toBe('انبتّ بفرق ORD-7 — بيضل الطلب معلَّماً');
  });

  it('the person who may see but not decide is told which key does, by its name on the permissions screen', () => {
    expect(NEEDS_REVIEW_KEY_AR).toBe('البتّ بالفرق من صلاحية «مراجعة المطابقات» — اطلبه ممن يملكها.');
  });

  it('the figures’ labels are the answers’ own words: «رقمنا» and «رقم الشركة»', () => {
    expect([OURS_AR, THEIRS_AR]).toEqual(['رقمنا', 'رقم الشركة']);
    expect(RESOLUTION_AR.OURS_STANDS).toContain(OURS_AR);
    expect(RESOLUTION_AR.ACCEPTED_COURIER).toContain(THEIRS_AR);
    expect(COMPANY_LINE_AR).toBe('ما كتبته الشركة عن السطر');
    expect(MATCHING_NOTE_AR).toBe('ملاحظة المطابقة');
  });
});

describe('every word it says is Arabic', () => {
  it('no Latin letter in any sentence the module exports (the order number a person passes in apart)', () => {
    const sentences = Object.values(words).filter((v): v is string => typeof v === 'string');
    expect(sentences.length).toBeGreaterThanOrEqual(8);
    for (const s of sentences) expect(s, s).not.toMatch(/[A-Za-z]/);
    for (const s of [
      markTitle({ resolution: null, closed: false }, true),
      markTitle({ resolution: 'UNDER_REVIEW', closed: true }, false),
      differenceDoneMessage('٧'),
      markHead({ resolution: 'WHATEVER' }),
    ]) {
      expect(s, s).not.toMatch(/[A-Za-z]/);
    }
  });
});
