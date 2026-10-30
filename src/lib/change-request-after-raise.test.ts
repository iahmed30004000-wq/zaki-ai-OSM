import { describe, expect, it, vi } from 'vitest';

vi.mock('./authorization', () => ({ can: vi.fn() }));

import { answerAfterRaise, BEFORE_CONFIRMATION, waitingFor, WHERE_APPROVED_AR } from './change-request-after-raise';
import { BEFORE_OPERATIONS } from './change-request-routing';

/**
 * WHERE THE REQUEST WENT, IN A SENTENCE — the three places a raised request can be.
 * «حتى لما رفعت طلب تعديل ما ظهر بطلبات التعديل»: each sentence names the tab to look in, and a person who cannot open
 * the screen of the requests is never pointed at it.
 */

const edit = { intent: 'EDIT' as const, canOpenQueue: true };

describe('Ⅰ · carried out', () => {
  it('says so, for each of the three asks', () => {
    expect(answerAfterRaise({ ...edit, readyToApply: true })).toEqual({ outcome: 'APPLIED', message: 'طُبِّق التعديل على الطلب.' });
    expect(answerAfterRaise({ intent: 'CANCEL', readyToApply: true, canOpenQueue: true }).message).toBe('نُفِّذ الإلغاء.');
    expect(answerAfterRaise({ intent: 'POSTPONE', readyToApply: true, canOpenQueue: false }).message).toBe('أُجّل الشحن.');
  });
});

describe('Ⅱ · approved on the spot, and the last step failed', () => {
  it('names «بانتظار التطبيق» as the place to look, with the reason it did not finish', () => {
    const a = answerAfterRaise({ ...edit, readyToApply: true, failure: 'المخزون ما بيكفي لـكريم.' });
    expect(a.outcome).toBe('APPROVED_WAITING');
    expect(a.message).toContain('اعتُمد مباشرة وهو بانتظار التطبيق — افتح طلبات التعديل ← بانتظار التطبيق');
    expect(a.message).toContain('المخزون ما بيكفي لـكريم.');
  });

  it('with no reason to give, gives none and does not print «null»', () => {
    const a = answerAfterRaise({ ...edit, readyToApply: true, failure: null });
    expect(a.outcome).toBe('APPROVED_WAITING');
    expect(a.message).not.toMatch(/null|undefined|\(\)/);
  });

  it('a person who cannot open the screen is told to ask the supervisor, not sent to a page she cannot see', () => {
    const a = answerAfterRaise({ intent: 'EDIT', readyToApply: true, failure: 'x', canOpenQueue: false });
    expect(a.message).toContain('بلّغ المشرف ليطبّقه');
    expect(a.message).not.toContain('طلبات التعديل');
    expect(a.message).not.toContain(WHERE_APPROVED_AR);
  });
});

describe('Ⅲ · waiting for a decision', () => {
  it('names the stage’s deciders, and the tab', () => {
    const before = answerAfterRaise({ ...edit, readyToApply: false, orderStatus: 'IN_PROGRESS' });
    expect(before.outcome).toBe('WAITING');
    expect(before.message).toBe('رُفع طلبك وبانتظار قرار الموظف المسؤول عن الطلب أو المشرف — تجده في طلبات التعديل ← بانتظار القرار.');

    const after = answerAfterRaise({ ...edit, readyToApply: false, orderStatus: 'CONFIRMED' });
    expect(after.message).toBe('رُفع طلبك وبانتظار قرار المشرف أو مسؤول المخزن — تجده في طلبات التعديل ← بانتظار القرار.');
  });

  it('for the one who has no such screen it is «المشرف», with no link', () => {
    for (const orderStatus of ['IN_PROGRESS', 'CONFIRMED', undefined]) {
      const a = answerAfterRaise({ intent: 'EDIT', readyToApply: false, orderStatus, canOpenQueue: false });
      expect(a.message).toBe('رُفع طلبك وبانتظار قرار المشرف.');
    }
  });

  it('an order whose status the answer did not carry is read as past confirmation, the wider list of deciders', () => {
    expect(waitingFor(undefined, true)).toBe('المشرف أو مسؤول المخزن');
    expect(waitingFor(null, true)).toBe('المشرف أو مسؤول المخزن');
  });
});

describe('Ⅳ · the words', () => {
  it('are Arabic only, with no digit of the other script', () => {
    const all = [
      answerAfterRaise({ ...edit, readyToApply: true }),
      answerAfterRaise({ ...edit, readyToApply: true, failure: 'سبب' }),
      answerAfterRaise({ ...edit, readyToApply: false, orderStatus: 'NEW' }),
      answerAfterRaise({ intent: 'EDIT', readyToApply: false, canOpenQueue: false }),
    ];
    for (const a of all) {
      expect(a.message).not.toMatch(/[A-Za-z]{2,}/);
      expect(a.message).not.toMatch(/[٠-٩]/);
    }
  });

  it('the client’s list of pre-confirmation statuses is the server routing rule’s own', () => {
    // `change-request-routing` is server-only; the browser keeps a copy, and this holds the two together.
    expect([...BEFORE_CONFIRMATION].sort()).toEqual([...BEFORE_OPERATIONS].sort());
  });
});
