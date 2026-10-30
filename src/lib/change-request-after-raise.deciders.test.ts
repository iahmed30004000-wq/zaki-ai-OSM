import { describe, expect, it, vi } from 'vitest';

vi.mock('./authorization', () => ({ can: vi.fn() }));

import { answerAfterRaise, waitingFor } from './change-request-after-raise';
import { deciderFor } from './change-request-routing';

/**
 * WHO DECIDES, NAMED BY WHAT THE SCREEN KNOWS OF THE ORDER — the three inputs of `deciderFor`.
 *
 * The status alone said «الموظف المسؤول أو المشرف» for an order nobody holds and «المشرف أو مسؤول المخزن» for a parcel the
 * courier has (where only the supervisor decides). Each case below is held against the server's own rule.
 */

const rule = (order: { confirmationStatus: string; claimedById: string | null; handedToCourier?: boolean }) => deciderFor(order).kind;

describe('Ⅰ · the sentence follows deciderFor', () => {
  it('the courier has the parcel: the supervisor alone — whatever the status says and whatever the screen can open', () => {
    expect(rule({ confirmationStatus: 'CONFIRMED', claimedById: 'u', handedToCourier: true })).toBe('SUPERVISOR');
    expect(waitingFor('CONFIRMED', true, { handed: true })).toBe('المشرف');
    expect(waitingFor('CONFIRMED', false, { handed: true })).toBe('المشرف');
  });

  it('confirmed and still ours: the packing table or a supervisor', () => {
    expect(rule({ confirmationStatus: 'CONFIRMED', claimedById: null, handedToCourier: false })).toBe('WAREHOUSE');
    expect(waitingFor('CONFIRMED', true, { handed: false })).toBe('المشرف أو مسؤول المخزن');
    expect(waitingFor('CONFIRMED', true)).toBe('المشرف أو مسؤول المخزن');
  });

  it('before confirmation: the agent HOLDING it — and only a supervisor when nobody does', () => {
    expect(rule({ confirmationStatus: 'IN_PROGRESS', claimedById: 'u' })).toBe('HOLDING_AGENT');
    expect(waitingFor('IN_PROGRESS', true, { held: true })).toBe('الموظف الماسك الطلب أو المشرف');
    expect(waitingFor('IN_PROGRESS', true)).toBe('الموظف الماسك الطلب أو المشرف');

    expect(rule({ confirmationStatus: 'NEW', claimedById: null })).toBe('SUPERVISOR');
    expect(waitingFor('NEW', true, { held: false })).toBe('المشرف');
  });

  it('for every status and every combination, the named side agrees with the server’s rule', () => {
    const named = (kind: string) => (kind === 'SUPERVISOR' ? 'المشرف' : kind === 'WAREHOUSE' ? 'المشرف أو مسؤول المخزن' : 'الموظف الماسك الطلب أو المشرف');
    for (const confirmationStatus of ['NEW', 'IN_PROGRESS', 'POSTPONED', 'CONFIRMED']) {
      for (const held of [true, false]) {
        for (const handed of [true, false]) {
          const kind = rule({ confirmationStatus, claimedById: held ? 'u' : null, handedToCourier: handed });
          expect(waitingFor(confirmationStatus, true, { held, handed }), `${confirmationStatus} held=${held} handed=${handed}`).toBe(named(kind));
        }
      }
    }
  });

  it('the sentence itself carries the corrected name', () => {
    const a = answerAfterRaise({ intent: 'EDIT', readyToApply: false, orderStatus: 'CONFIRMED', canOpenQueue: true, order: { handed: true } });
    expect(a.message).toBe('رُفع طلبك وبانتظار قرار المشرف — تجده في طلبات التعديل ← بانتظار القرار.');
  });
});

describe('Ⅱ · a second press', () => {
  it('«طُبّق مسبقاً» is carried out, not «waiting»: nothing is in «بانتظار التطبيق»', () => {
    const a = answerAfterRaise({ intent: 'EDIT', readyToApply: true, alreadyApplied: true, canOpenQueue: true });
    expect(a.outcome).toBe('APPLIED');
    expect(a.message).toContain('طُبِّق مسبقاً');
    expect(a.message).not.toContain('بانتظار التطبيق —');
    expect(a.message).not.toContain('افتح');
  });
});
