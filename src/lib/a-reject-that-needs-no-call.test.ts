import { describe, expect, it } from 'vitest';
import { CONTACT_FIRST_ACTIONS, needsContactFirst } from './confirmation-queue';
import {
  NO_CONVERSATION_REJECTION_REASONS,
  PICKABLE_REJECTION_REASONS,
  rejectionNeedsConversation,
} from './confirmation-workflow';
import { repoFile, stripComments } from './guard-source';

/**
 * «ألغِ» for a reason that needs no word with the customer (30/10, the owner: «٥ تمام»): the rule `needsContactFirst`
 * keeps for every other action and every other reason — see `contact-first.test.ts`, which is unchanged.
 */

const held = { isHolder: true, hasAttempt: false } as const;

describe('needsContactFirst — the reason a reject carries', () => {
  it.each([...NO_CONVERSATION_REJECTION_REASONS])('reject for %s is not bound', (rejectionReason) => {
    expect(needsContactFirst({ ...held, action: 'reject', rejectionReason })).toBe(false);
  });

  it.each([
    'PRICE_TOO_HIGH', 'CUSTOMER_CHANGED_MIND', 'CUSTOMER_DOES_NOT_WANT_PRODUCT', 'FOUND_CHEAPER_ELSEWHERE',
    'FAKE_ORDER', 'OTHER', 'MODERATOR_DATA_ERROR', 'NO_ANSWER_3_ATTEMPTS', 'NOT_A_REASON', '',
  ])('reject for %s stays bound', (rejectionReason) => {
    expect(needsContactFirst({ ...held, action: 'reject', rejectionReason })).toBe(true);
  });

  it('reject with no reason at all stays bound (undefined and null)', () => {
    expect(needsContactFirst({ ...held, action: 'reject' })).toBe(true);
    expect(needsContactFirst({ ...held, action: 'reject', rejectionReason: null })).toBe(true);
  });

  it('no other action is freed by an exempt reason in the same request', () => {
    for (const action of CONTACT_FIRST_ACTIONS.filter((a) => a !== 'reject')) {
      expect(needsContactFirst({ ...held, action, rejectionReason: 'DUPLICATE_ORDER' }), action).toBe(true);
    }
  });

  it('a result with a date is still a postponement even with an exempt reason (RV5)', () => {
    expect(
      needsContactFirst({ ...held, action: 'contact_result', schedulesFollowUp: true, rejectionReason: 'FAKE_ORDER' })
    ).toBe(true);
  });

  it('a non-holder and an order with an attempt are as they were: never bound', () => {
    expect(needsContactFirst({ action: 'reject', isHolder: false, hasAttempt: false, rejectionReason: 'PRICE_TOO_HIGH' })).toBe(false);
    expect(needsContactFirst({ action: 'reject', isHolder: true, hasAttempt: true, rejectionReason: 'PRICE_TOO_HIGH' })).toBe(false);
  });
});

describe('the list of exempt reasons', () => {
  it('FAKE_ORDER is not exempt: it puts the customer on the blacklist, so it needs an attempt first', () => {
    expect(NO_CONVERSATION_REJECTION_REASONS).not.toContain('FAKE_ORDER');
    expect(rejectionNeedsConversation('FAKE_ORDER')).toBe(true);
  });

  it('only what the screen can offer — a reason nobody can pick is no exemption', () => {
    for (const r of NO_CONVERSATION_REJECTION_REASONS) expect(PICKABLE_REJECTION_REASONS).toContain(r);
    expect(rejectionNeedsConversation('MODERATOR_DATA_ERROR')).toBe(true);
  });

  it('unknown or empty needs the conversation', () => {
    expect(rejectionNeedsConversation(undefined)).toBe(true);
    expect(rejectionNeedsConversation(null)).toBe(true);
    expect(rejectionNeedsConversation('')).toBe(true);
  });

  it('and the server hands the reason to the rule, before the action switch', () => {
    const src = stripComments(repoFile('src/app/api/orders/[id]/confirmation/route.ts'));
    const call = src.slice(src.indexOf('needsContactFirst({'), src.indexOf("switch (action)"));
    expect(call).toMatch(/rejectionReason,/);
  });
});
