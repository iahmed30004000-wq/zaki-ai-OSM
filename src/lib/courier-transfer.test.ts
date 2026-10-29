import { describe, expect, it } from 'vitest';
import { planTransfer, TransferRefused, type TransferParty, requiresOpenBatch } from './courier-transfer';

/**
 * The transfer rules, exactly as the business states them: you may move a
 * parcel away from a مندوب directly, and away from a company only by taking
 * it back and raising a replacement.
 */

const agent: TransferParty = { id: 'ag1', name: 'أبو علي', kind: 'AGENT' };
const agent2: TransferParty = { id: 'ag2', name: 'سامر', kind: 'AGENT' };
const aramex: TransferParty = { id: 'co1', name: 'أرامكس', kind: 'COMPANY' };
const other: TransferParty = { id: 'co2', name: 'شركة أخرى', kind: 'COMPANY' };

const plan = (from: TransferParty | null, to: TransferParty, shippingStatus = 'SHIPPED') =>
  planTransfer({ from, to, shippingStatus });

describe('away from a مندوب — immediate, no replacement', () => {
  it('goes straight to a company, keeping the same order', () => {
    const result = plan(agent, aramex);
    expect(result.mode).toBe('DIRECT');
    expect(result.closeAs).toBe('RECEIVED_FROM_AGENT');
    expect(result.nextStatus).toBe('READY_FOR_PICKUP');
  });

  it('goes straight to another agent too', () => {
    expect(plan(agent, agent2).mode).toBe('DIRECT');
  });
});

describe('away from a company — take it back, raise a replacement', () => {
  it('refuses to simply swap one company for another', () => {
    const result = plan(aramex, other);
    expect(result.mode).toBe('REPLACE');
    expect(result.closeAs).toBe('TAKEN_BACK_FROM_COMPANY');
    expect(result.originalStatus).toBe('RETURN_REQUESTED');
  });

  it('is a replacement even when moving to a مندوب', () => {
    expect(plan(aramex, agent).mode).toBe('REPLACE');
  });

  it('starts the replacement in preparation, to be assigned from scratch', () => {
    expect(plan(aramex, other).nextStatus).toBe('READY_FOR_SHIPPING');
  });
});

describe('refusals', () => {
  it('refuses when no courier holds the parcel yet', () => {
    expect(() => plan(null, aramex)).toThrow(TransferRefused);
    try {
      plan(null, aramex);
    } catch (e) {
      expect((e as TransferRefused).code).toBe('NO_CURRENT_COURIER');
    }
  });

  it('refuses a transfer to the courier already holding it', () => {
    expect(() => plan(aramex, aramex)).toThrow(/مُسنَد لهذه الجهة/);
  });

  it('refuses once the journey is over', () => {
    for (const status of ['DELIVERED', 'RETURNED', 'CANCELLED']) {
      expect(() => plan(aramex, other, status), status).toThrow(/قبل انتهاء رحلة الطرد/);
    }
  });

  it('refuses before the parcel has been handed over at all', () => {
    for (const status of ['NOT_READY', 'READY_FOR_SHIPPING', 'PACKING']) {
      expect(() => plan(aramex, other, status), status).toThrow(TransferRefused);
    }
  });

  it('allows it while in transit or after a failed attempt', () => {
    for (const status of ['READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY']) {
      expect(() => plan(aramex, other, status), status).not.toThrow();
    }
  });
});

describe('needing a trolley to put it on', () => {
  it('requires an open batch when handing to a company', () => {
    // A company takes parcels by the trolley. Handing one to a company with
    // no batch open leaves it assigned to somebody who has not agreed to
    // carry anything today — invisible on every batch screen, nobody's job.
    expect(requiresOpenBatch({ id: 'c1', name: 'باشا', kind: 'COMPANY' })).toBe(true);
  });

  it('does not make an agent wait for one', () => {
    // He takes it by hand, now. Paperwork standing in front of a man at the
    // counter is not a rule worth having.
    expect(requiresOpenBatch({ id: 'a1', name: 'أبو علي', kind: 'AGENT' })).toBe(false);
  });
});
