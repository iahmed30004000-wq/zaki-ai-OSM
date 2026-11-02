import { describe, expect, it } from 'vitest';
import {
  CLAIM_CAPS, ENTRY_CAP_FULL_MESSAGE, MAY_NOT_CONFIRM_NOW_MESSAGE, REGION_REQUIRED_MESSAGE,
  claimsOwnEntry, confirmNowReadiness, entryOwnership, keepsOwnEntry, mayConfirmNow,
} from './confirmation-queue';

/**
 * «الزبون على الخط — أكّده الآن» AT THE CREATION DOOR (T-06) — the pure rules, case by case. The door itself, through the real
 * permission engine, is `src/app/api/orders/an-agent-types-and-confirms-in-one-go.test.ts`.
 */

const keys = (...ks: string[]) => (k: string) => ks.includes(k);
/** The live agent's keys that matter here: work AND supervise, bound by the hold rule. */
const LIVE_AGENT = keys('confirmation.work', 'confirmation.supervise', 'confirmation.pull', 'orders.confirm', 'orders.contact_log');
/** An agent without supervise: keeps every entry already. */
const PLAIN_AGENT = keys('confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.contact_log');
/** Not bound: takes or hands out any order. */
const MANAGER = keys('confirmation.work', 'confirmation.supervise', 'orders.unlock', 'orders.assign', 'orders.confirm', 'orders.contact_log');
const MODERATOR = keys('orders.confirm', 'orders.contact_log');

const now = new Date('2026-11-02T10:00:00Z');
const own = (holds: (k: string) => boolean, confirmNow: boolean, heldTotal = 0) =>
  entryOwnership({ userId: 'u', holds, heldTotal, now, confirmNow });

describe('who keeps what she types', () => {
  it('the live agent: the pool without the box (unchanged), hers with it', () => {
    expect(keepsOwnEntry(LIVE_AGENT)).toBe(false);
    expect(claimsOwnEntry(LIVE_AGENT, false)).toBe(false);
    expect(own(LIVE_AGENT, false).claimedById).toBeNull();
    expect(claimsOwnEntry(LIVE_AGENT, true)).toBe(true);
    expect(own(LIVE_AGENT, true)).toEqual({ claimedById: 'u', claimedAt: now, currentOwnerId: 'u', capFull: false });
  });

  it('an agent without supervise keeps it either way, as before', () => {
    expect(own(PLAIN_AGENT, false).claimedById).toBe('u');
    expect(own(PLAIN_AGENT, true).claimedById).toBe('u');
  });

  it('NEGATIVE: whoever is not bound is not given a claim she does not need', () => {
    expect(own(MANAGER, true).claimedById).toBeNull();
    expect(own(MODERATOR, true).claimedById).toBeNull();
  });

  it('absent means false — the AI-intake door, which never sends it, is unchanged', () => {
    expect(entryOwnership({ userId: 'u', holds: LIVE_AGENT, heldTotal: 0, now }).claimedById).toBeNull();
  });

  it('NEGATIVE: the cap still binds — 299 hers, 300 the pool', () => {
    expect(own(LIVE_AGENT, true, CLAIM_CAPS.total - 1).claimedById).toBe('u');
    expect(own(LIVE_AGENT, true, CLAIM_CAPS.total)).toEqual({ claimedById: null, claimedAt: null, currentOwnerId: null, capFull: true });
  });
});

describe('whose box is honoured', () => {
  it('both keys: confirm and record the call', () => {
    expect(mayConfirmNow(LIVE_AGENT, false)).toBe(true);
  });
  it('NEGATIVE: either key missing', () => {
    expect(mayConfirmNow(keys('orders.confirm'), false)).toBe(false);
    expect(mayConfirmNow(keys('orders.contact_log'), false)).toBe(false);
  });
  it('NEGATIVE: a file never confirms', () => {
    expect(mayConfirmNow(LIVE_AGENT, true)).toBe(false);
  });
});

describe('will the confirmation door say yes', () => {
  const ask = (over: Partial<Parameters<typeof confirmNowReadiness>[0]> = {}) =>
    confirmNowReadiness({ wanted: true, holds: LIVE_AGENT, userId: 'u', entry: own(LIVE_AGENT, true), regionId: 'r1', ...over });

  it('hers, with a governorate: yes', () => {
    expect(ask()).toEqual({ ready: true });
  });
  it('NEGATIVE: not honoured', () => {
    expect(ask({ wanted: false })).toEqual({ ready: false, code: 'MAY_NOT_CONFIRM', reason: MAY_NOT_CONFIRM_NOW_MESSAGE });
  });
  it('NEGATIVE: the cap sent it to the pool', () => {
    expect(ask({ entry: own(LIVE_AGENT, true, 300) })).toEqual({ ready: false, code: 'CAP_FULL', reason: ENTRY_CAP_FULL_MESSAGE });
  });
  it('NEGATIVE: no governorate', () => {
    expect(ask({ regionId: null })).toEqual({ ready: false, code: 'REGION_REQUIRED', reason: REGION_REQUIRED_MESSAGE });
  });
  it('somebody unbound needs no hold to hear yes', () => {
    expect(ask({ holds: MANAGER, entry: own(MANAGER, true) })).toEqual({ ready: true });
  });
});
