import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptWords, nextAttempt, nextAttemptWords, noAnswerHint } from './attempt-words';
import { cadenceCardWords, cadencePressWords, CADENCE_LIMIT } from './no-answer-cadence';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE COUNTER — «محاولة N من 5» (C1, 18/11)
 *
 *  · `attemptWords` is the one spelling; `nextAttempt` the one meaning: the attempt the next press will be, never past the limit.
 *  · The cadence's two sentence-makers (the card's tag, the line after a press) go through it — so the tag and the press say the same words for the same number.
 *  · The file imports nothing (the desk's bundle is a few hundred bytes under its ceiling) and holds no limit of its own: 5 comes from the server.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('the words', () => {
  it('«محاولة 2 من 5», and the same after a verb', () => {
    expect(attemptWords(2, 5)).toBe('محاولة 2 من 5');
    expect(attemptWords(2, 5, true)).toBe('المحاولة 2 من 5');
  });

  it('the next attempt is one after the counted ones, floored at 1 and capped at the limit', () => {
    expect(nextAttempt(0, 5)).toBe(1);
    expect(nextAttempt(1, 5)).toBe(2);
    expect(nextAttempt(4, 5)).toBe(5);
    expect(nextAttempt(5, 5)).toBe(5);
    expect(nextAttempt(9, 5)).toBe(5);
    expect(nextAttempt(-3, 5)).toBe(1);
    expect(nextAttemptWords(1, 5)).toBe('محاولة 2 من 5');
  });
});

describe('the cadence says the same words', () => {
  const now = new Date('2026-11-18T10:00:00Z');
  const due = new Date('2026-11-18T10:30:00Z');

  it('the card tag, waiting and due, is `nextAttemptWords` of the counted number', () => {
    for (const counted of [1, 2, 3, 4]) {
      const words = nextAttemptWords(counted, CADENCE_LIMIT);
      expect(cadenceCardWords({ counted, due: false, waiting: true, dueAt: due }, now, 'Asia/Amman')).toContain(words);
      expect(cadenceCardWords({ counted, due: true, waiting: false, dueAt: null }, now, 'Asia/Amman')).toBe(`لا يرد راجع — ${words}`);
    }
  });

  it('the sentence after a counted press says the attempt that press WAS, with the article, from `attemptWords`', () => {
    const text = cadencePressWords({ counted: true, closed: false, released: true, attempt: 2, dueAt: due, now, timeZone: 'Asia/Amman' });
    expect(text).toContain(`انحسبت ${attemptWords(2, CADENCE_LIMIT, true)}`);
  });

  it('and the tag of attempt N+1 and the sentence of press N name the SAME number (the owner saw «لا يرد 1/5» beside «محاولة 2 من 5»)', () => {
    const tag = cadenceCardWords({ counted: 1, due: false, waiting: true, dueAt: due }, now, 'Asia/Amman')!;
    const press = cadencePressWords({ counted: false, closed: false, released: false, attempt: 1, dueAt: due, now, timeZone: 'Asia/Amman' });
    expect(tag).toContain('2 من 5');
    expect(press).toContain('2 من 5');
  });
});

describe('the file', () => {
  const code = readFileSync(join(process.cwd(), 'src/lib/attempt-words.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('imports nothing and types no limit', () => {
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\b5\b/);
    expect(code).not.toMatch(/\b3\b/);
  });
});

describe('the hint beside «لا يرد» says only what is true for the rule in force (finding #11; the server writes it since 18/11)', () => {
  const NEXT = 'المحاولة القادمة تُغلق الطلب تلقائياً';
  it('the plan: «تُغلق» only when the server’s clock says a press now closes it — never from the count', () => {
    expect(noAnswerHint({ planned: true, rounds: false, closesOnNext: true, count: 1, limit: 5 })).toBe(NEXT);
    expect(noAnswerHint({ planned: true, rounds: false, closesOnNext: false, count: 4, limit: 5 })).toBeUndefined();
    expect(noAnswerHint({ planned: true, rounds: false, count: 4, limit: 5 })).toBeUndefined();
    expect(noAnswerHint({ planned: true, rounds: true, closesOnNext: false, count: 5, limit: 5 })).toBeUndefined();
  });
  it('the rounds: nothing at any count — presses are not rounds', () => {
    for (const count of [0, 1, 2, 3, 4]) expect(noAnswerHint({ planned: false, rounds: true, count, limit: 3 }), String(count)).toBeUndefined();
  });
  it('the base rule: the old countdown, word for word', () => {
    expect(noAnswerHint({ planned: false, rounds: false, count: 0, limit: 3 })).toBe('متبقٍ 3 محاولات قبل الإغلاق التلقائي');
    expect(noAnswerHint({ planned: false, rounds: false, count: 1, limit: 3 })).toBe('متبقٍ 2 محاولات قبل الإغلاق التلقائي');
    expect(noAnswerHint({ planned: false, rounds: false, count: 2, limit: 3 })).toBe(NEXT);
    expect(noAnswerHint({ planned: false, rounds: false, count: 3, limit: 3 })).toBe('بلغ الحد');
    expect(noAnswerHint({ planned: false, rounds: false, count: 7, limit: 3 })).toBe('بلغ الحد');
  });
});
