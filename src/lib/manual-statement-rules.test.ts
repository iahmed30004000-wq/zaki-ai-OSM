import { describe, expect, it } from 'vitest';
import {
  DRAFT_REFERENCE,
  MANUAL_DRAFT_PREFIX,
  MANUAL_PREFIX,
  duplicateReferenceSentence,
  isManualDraftHash,
  isManualHash,
  manualAddRefusal,
  manualFileHash,
  newDraftHash,
  normalizeReference,
  type ManualOrderFacts,
} from './manual-statement-rules';

/**
 * THE MANUAL STATEMENT'S RULES, WITHOUT A DATABASE.
 *
 * Which statement is manual, how a reference becomes a hash that is unique PER COURIER, and which orders may
 * enter one. The door that reads and writes (`manual-statement.ts`) is tested in its own file.
 */

const order = (over: Partial<ManualOrderFacts> = {}): ManualOrderFacts => ({
  orderNumber: 'JO-2026-0001',
  merchantRef: 'JO-2026-0001',
  currency: 'JOD',
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING_COLLECTION',
  deliveryProviderId: 'courier-a',
  ...over,
});

describe('which statement is manual', () => {
  it('a hash that starts with «manual:» is manual, a file’s sha-256 never is', () => {
    expect(isManualHash('manual:abc')).toBe(true);
    expect(isManualHash(`${MANUAL_PREFIX}${'0'.repeat(64)}`)).toBe(true);
    expect(isManualHash('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(false);
    expect(isManualHash(undefined)).toBe(false);
    expect(isManualHash(null)).toBe(false);
    expect(isManualHash('')).toBe(false);
  });

  it('a draft is a manual hash with «draft:» after it — a gathered statement is not a draft', () => {
    const draft = newDraftHash();
    expect(draft.startsWith(MANUAL_DRAFT_PREFIX)).toBe(true);
    expect(isManualHash(draft)).toBe(true);
    expect(isManualDraftHash(draft)).toBe(true);
    const gathered = manualFileHash({ companyId: 'c1', courierId: 'courier-a', reference: 'كشف الأحد' });
    expect(isManualHash(gathered)).toBe(true);
    expect(isManualDraftHash(gathered)).toBe(false);
    expect(isManualDraftHash(undefined)).toBe(false);
  });

  it('two drafts never share a hash (the column is unique per company)', () => {
    expect(newDraftHash()).not.toBe(newDraftHash());
  });
});

describe('the reference is unique per company AND courier', () => {
  const hash = (courierId: string, reference: string, companyId = 'c1') => manualFileHash({ companyId, courierId, reference });

  it('the same reference for two couriers is two hashes — no conflict', () => {
    expect(hash('courier-a', 'كشف الأحد')).not.toBe(hash('courier-b', 'كشف الأحد'));
  });

  it('the same reference for the same courier is the same hash — so the unique column refuses the second', () => {
    expect(hash('courier-a', 'كشف الأحد')).toBe(hash('courier-a', 'كشف الأحد'));
  });

  it('spaces around it and between its words, and the case of Latin letters, do not make it another reference', () => {
    expect(hash('courier-a', '  ST  09 ')).toBe(hash('courier-a', 'st 09'));
    expect(normalizeReference('  ST   09 ')).toBe('st 09');
  });

  it('two different references of one courier are two hashes — the reference is part of what is hashed', () => {
    expect(hash('courier-a', 'كشف الأحد')).not.toBe(hash('courier-a', 'كشف الإثنين'));
  });

  it('another company never collides with this one', () => {
    expect(hash('courier-a', 'X1', 'c1')).not.toBe(hash('courier-a', 'X1', 'c2'));
  });

  it('no choice of reference can read as another courier’s id', () => {
    // A hash built by joining the three parts with a separator would let the courier «a|b» + reference «c» and the
    // courier «a» + reference «b|c» meet. The parts are encoded as an array, so they cannot.
    expect(hash('a|b', 'c')).not.toBe(hash('a', 'b|c'));
    expect(hash('a', 'b","c')).not.toBe(hash('a","b', 'c'));
  });

  it('is a plain hex digest after the prefix', () => {
    expect(hash('courier-a', 'x1')).toMatch(/^manual:[0-9a-f]{64}$/);
  });

  it('and the duplicate sentence names the reference', () => {
    expect(duplicateReferenceSentence('  كشف الأحد ')).toContain('«كشف الأحد»');
  });

  it('a draft’s own reference is a placeholder, not something a person typed', () => {
    expect(DRAFT_REFERENCE).toContain('مسوّدة');
  });
});

describe('which orders may enter a manual statement', () => {
  it('delivered orders of one courier, in the statement’s currency, with a reference, are accepted', () => {
    expect(manualAddRefusal([order(), order({ orderNumber: 'JO-2026-0002', merchantRef: 'JO-2026-0002' })], 'JOD')).toBeNull();
    expect(manualAddRefusal([order({ shippingStatus: 'PARTIALLY_DELIVERED' })], 'JOD')).toBeNull();
  });

  it('an order with no courier is refused BY NAME, and «استلمت منه» is pointed to', () => {
    const r = manualAddRefusal([order(), order({ orderNumber: 'JO-2026-0007', deliveryProviderId: null })], 'JOD');
    expect(r?.code).toBe('NO_COURIER');
    expect(r?.error).toContain('JO-2026-0007');
    expect(r?.error).not.toContain('JO-2026-0001');
    expect(r?.error).toContain('استلمت منه');
    expect(r?.orders).toEqual(['JO-2026-0007']);
  });

  it('two couriers in one press are refused — the money of one is never in the other’s statement', () => {
    const r = manualAddRefusal([order(), order({ orderNumber: 'JO-2026-0002', deliveryProviderId: 'courier-b' })], 'JOD');
    expect(r?.code).toBe('MIXED_COURIERS');
  });

  it('the courier-less order is named first: it is the thing a person can fix', () => {
    const r = manualAddRefusal(
      [order({ deliveryProviderId: 'courier-b' }), order({ orderNumber: 'JO-2026-0003', deliveryProviderId: null })],
      'JOD'
    );
    expect(r?.code).toBe('NO_COURIER');
  });

  it('an order not delivered is refused by name', () => {
    for (const shippingStatus of ['SHIPPED', 'OUT_FOR_DELIVERY', 'RETURNED', 'CANCELLED', 'PENDING']) {
      const r = manualAddRefusal([order({ orderNumber: 'JO-2026-0009', shippingStatus })], 'JOD');
      expect(r?.code, shippingStatus).toBe('NOT_DELIVERED');
      expect(r?.error).toContain('JO-2026-0009');
    }
  });

  it('an order already settled is refused — it was paid', () => {
    const r = manualAddRefusal([order({ orderNumber: 'JO-2026-0004', settlementStatus: 'SETTLED' })], 'JOD');
    expect(r?.code).toBe('ALREADY_SETTLED');
    expect(r?.error).toContain('JO-2026-0004');
  });

  it('an order in another currency than the statement’s is refused', () => {
    const r = manualAddRefusal([order({ currency: 'USD' })], 'JOD');
    expect(r?.code).toBe('CURRENCY_MISMATCH');
    expect(r?.error).toContain('JOD');
  });

  it('an order with no reference is refused: the line is tied to the order by it and by nothing else', () => {
    const r = manualAddRefusal([order({ merchantRef: null })], 'JOD');
    expect(r?.code).toBe('NO_REFERENCE');
  });
});
