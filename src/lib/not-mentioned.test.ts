import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import {
  NOT_MENTIONED_ACTIONS,
  NOT_MENTIONED_ACTIVITY,
  NOT_MENTIONED_ACTIVITY_AR,
  NOT_MENTIONED_AR,
  NOT_MENTIONED_MEANING,
  actionOfActivity,
  mayCorrectStatus,
} from './not-mentioned';

/**
 * THE THREE ANSWERS ABOUT A PARCEL NO STATEMENT NAMES — one table for the door, the screen and the timeline.
 */

describe('the table', () => {
  it('has the three answers the owner asked for, in his words', () => {
    expect(NOT_MENTIONED_ACTIONS.map((a) => NOT_MENTIONED_AR[a])).toEqual([
      'انتظر كشفاً لاحقاً',
      'طالِب الشركة به',
      'لم يُسلَّم — صحّح الحالة',
    ]);
  });

  it('gives each a meaning and its own stored code, and every code reads in Arabic on the order’s timeline', () => {
    for (const a of NOT_MENTIONED_ACTIONS) {
      expect(NOT_MENTIONED_MEANING[a].length, a).toBeGreaterThan(20);
      expect(NOT_MENTIONED_ACTIVITY_AR[NOT_MENTIONED_ACTIVITY[a]], a).toBeTruthy();
    }
    expect(Object.keys(NOT_MENTIONED_ACTIVITY_AR).sort()).toEqual(Object.values(NOT_MENTIONED_ACTIVITY).sort());
  });

  it('and the timeline really spreads that table, so a stored answer is not shown as a raw code', () => {
    expect(stripComments(repoFile('src/lib/order-timeline.ts'))).toContain('...NOT_MENTIONED_ACTIVITY_AR');
  });

  it('a stored code gives its answer back; anything else gives nothing', () => {
    for (const a of NOT_MENTIONED_ACTIONS) expect(actionOfActivity(NOT_MENTIONED_ACTIVITY[a])).toBe(a);
    expect(actionOfActivity('DELIVERED_BY_STATEMENT')).toBeNull();
    expect(actionOfActivity(null)).toBeNull();
  });
});

describe('«لم يُسلَّم — صحّح الحالة» is offered only where a door exists', () => {
  it('a delivered or partly delivered order, and somebody who holds orders.unlock', () => {
    expect(mayCorrectStatus({ holdsUnlock: true, shippingStatus: 'DELIVERED' })).toBe(true);
    expect(mayCorrectStatus({ holdsUnlock: true, shippingStatus: 'PARTIALLY_DELIVERED' })).toBe(true);
  });

  it.each(['SHIPPED', 'OUT_FOR_DELIVERY', 'RETURNED', 'CANCELLED', 'FAILED_DELIVERY'])(
    'not for an order that is %s: there is nothing to correct it from',
    (shippingStatus) => {
      expect(mayCorrectStatus({ holdsUnlock: true, shippingStatus })).toBe(false);
    }
  );

  it('and never for somebody without the permission', () => {
    expect(mayCorrectStatus({ holdsUnlock: false, shippingStatus: 'DELIVERED' })).toBe(false);
  });
});

describe('the answers move nothing', () => {
  it('the table and the door write no status, no figure, no wallet and no settlement', () => {
    const door = stripComments(repoFile('src/app/api/finance/statements/[id]/matches/[matchId]/order-action/route.ts'));
    expect(door.length).toBeGreaterThan(1000);
    for (const forbidden of ['walletMovement', 'recordMovement', 'settlementStatus', 'collectedAmount', '.update(', '.updateMany(', 'transition']) {
      expect(door, forbidden).not.toContain(forbidden);
    }
    expect(door).toMatch(/orderActivity\.create/);
  });
});
