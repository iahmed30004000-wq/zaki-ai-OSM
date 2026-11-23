import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import {
  USE_HANDOVER_SENTENCE, courierOrdersRefusal, currencyTable, handoverReference, handoverStanding, walletCountryRefusal,
} from './handover';
import { judgeLine } from './settlement';
import { statementNamingRefusal } from './settlement-gates';
import { manualAddRefusal } from './manual-statement-rules';
import { findPossibleDoubles } from './possible-double';

/**
 * «تسليم المندوب» — THE RULES WITHOUT A DATABASE, AND THE COURIER'S OWN STATEMENT ARRIVING AFTERWARDS (F9, 23/11).
 *
 * The handover is a manual statement: once approved, its orders are SETTLED and its line names them. A file from the same
 * courier that arrives later for the same orders must not pay them again — and the three existing guards already see to it:
 *
 *   · the matcher's integrity: an order SETTLED by an approved statement makes the courier's line MISMATCHED, never MATCHED
 *     (`judgeLine` → «الطلب مذكور بكشف آخر»), so its approval settles nothing again;
 *   · the naming rule: an order an approved statement names is refused at the hand door and at the manual door;
 *   · the possible double: a hand entry of the same money in the same wallet stops the approval.
 */

describe('the courier’s statement arrives later for the same orders', () => {
  const settled = {
    shippingStatus: 'DELIVERED', totalAmount: 20, deliveryFee: 3, collectedAmount: 20, priceIncludesDelivery: false,
    items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, lineTotal: 20, discountShare: 0, deliveredQty: null }],
    addOns: [], returnReceipt: null, settlementStatus: 'SETTLED',
  };

  it('its line is MISMATCHED, not MATCHED: the order was settled by the approved handover', () => {
    const verdict = judgeLine({
      order: settled as never,
      line: { amount: 17, fee: 3 },
      minorUnit: 2,
      integrity: { claimedByAnotherLine: false, otherStatements: [{ reference: 'تسليم أبو علي 2026-11-23', approved: true }], openRequests: [] },
    });
    expect(verdict.difference).toBe(0); // the figures agree to the cent …
    expect(verdict.result).toBe('MISMATCHED'); // … and it is still a person's call, never a second payment
    expect(verdict.note).toContain('تسليم أبو علي 2026-11-23');
  });

  it('NEGATIVE (the mutation the guard exists for): the same line with no other statement and an unsettled order WOULD match', () => {
    const verdict = judgeLine({
      order: { ...settled, settlementStatus: 'PENDING_COLLECTION' } as never,
      line: { amount: 17, fee: 3 },
      minorUnit: 2,
      integrity: { claimedByAnotherLine: false, otherStatements: [], openRequests: [] },
    });
    expect(verdict.result).toBe('MATCHED');
  });

  it('an order the approved handover names is refused by the naming rule — «دخلت مع كشف»', () => {
    const order = { id: 'o1', orderNumber: 'SY-1', merchantRef: 'SY-1', trackingNumber: null, deliveryProviderId: 'p1' };
    const line = { merchantRef: 'SY-1', barcode: null, statement: { reference: 'تسليم أبو علي 2026-11-23', status: 'APPROVED', approvedAt: new Date(), deliveryProviderId: 'p1' }, matches: [{ result: 'MATCHED' }] };
    const refused = statementNamingRefusal([order], [line as never]);
    expect(refused?.code).toBe('IN_APPROVED_STATEMENT');
  });

  it('and a second handover cannot take it in: it is ALREADY_SETTLED', () => {
    const refused = manualAddRefusal(
      [{ orderNumber: 'SY-1', merchantRef: 'SY-1', currency: 'SYP', shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED', deliveryProviderId: 'p1' }],
      'SYP'
    );
    expect(refused?.code).toBe('ALREADY_SETTLED');
  });

  it('a hand entry of the same amount in the same wallet is found as a possible double', () => {
    const now = new Date('2026-11-23T12:00:00Z');
    const hand = { id: 'h1', walletId: 'w', amount: 800_000, minorUnit: 2, party: '', note: '', createdAt: new Date('2026-11-22T12:00:00Z'), createdById: 'u' };
    expect(findPossibleDoubles([{ walletId: 'w', amount: 800_000 }], [hand], now).map((m) => m.id)).toEqual(['h1']);
    expect(findPossibleDoubles([{ walletId: 'w', amount: 800_001 }], [hand], now)).toEqual([]);
  });
});

describe('the country of the wallet', () => {
  it('passes a wallet of the session’s country', () => {
    expect(walletCountryRefusal({ name: 'صندوق', countryId: 'sy' }, 'sy')).toBeNull();
  });
  it('NEGATIVE: refuses another country’s, naming the wallet and its country', () => {
    const r = walletCountryRefusal({ name: 'صندوق عمّان', countryId: 'jo', country: { name: 'الأردن' } }, 'sy');
    expect(r?.code).toBe('WALLET_OTHER_COUNTRY');
    expect(r?.error).toContain('صندوق عمّان');
    expect(r?.error).toContain('الأردن');
  });
  it('NEGATIVE: refuses a wallet whose country was not read (fails closed against a real session)', () => {
    expect(walletCountryRefusal({ name: 'صندوق' }, 'sy')?.code).toBe('WALLET_OTHER_COUNTRY');
    expect(walletCountryRefusal({ name: 'صندوق', countryId: null }, 'sy')?.code).toBe('WALLET_OTHER_COUNTRY');
  });
});

describe('the old hand door takes only orders with no courier', () => {
  it('NEGATIVE: any order with a courier is USE_HANDOVER, naming those orders', () => {
    const r = courierOrdersRefusal([
      { orderNumber: 'A', deliveryProviderId: 'p1' },
      { orderNumber: 'B', deliveryProviderId: null },
    ]);
    expect(r).toEqual({ code: 'USE_HANDOVER', error: USE_HANDOVER_SENTENCE, orders: ['A'] });
  });
  it('orders with no courier pass', () => {
    expect(courierOrdersRefusal([{ orderNumber: 'B', deliveryProviderId: null }])).toBeNull();
  });
  it('the door asks it, after the wallet and before the settled check, and keeps its old money writer', () => {
    const src = stripComments(repoFile('src/app/api/ops/tracking/collect/route.ts'));
    const asked = src.indexOf('courierOrdersRefusal(orders)');
    expect(asked).toBeGreaterThan(src.indexOf('walletCountryRefusal(wallet, country.id)'));
    expect(asked).toBeLessThan(src.indexOf("code: 'ALREADY_SETTLED'"));
    expect(src).toContain("referenceType: 'MANUAL_COLLECTION'");
  });
});

describe('what the panel reads', () => {
  it('«باقي» and «زيادة» are the gap’s sign said in words', () => {
    expect(handoverStanding({ claimed: 100, received: 60, gap: -40 })).toEqual({ claimed: 100, received: 60, remaining: 40, over: 0 });
    expect(handoverStanding({ claimed: 100, received: 130, gap: 30 })).toEqual({ claimed: 100, received: 130, remaining: 0, over: 30 });
    expect(handoverStanding({ claimed: 100, received: 100, gap: 0 })).toEqual({ claimed: 100, received: 100, remaining: 0, over: 0 });
  });

  it('the table is one row per currency, the orders’ own first, each converted by the receipts’ rule', () => {
    const rows = currencyTable(
      [
        { amount: 30, currencyCode: 'USD', exchangeRate: 0.0001 },
        { amount: 20, currencyCode: 'USD', exchangeRate: 0.0001 },
        { amount: 800_000, currencyCode: 'SYP', exchangeRate: null },
        { amount: 10, currencyCode: 'EUR', exchangeRate: null },
      ],
      'SYP',
      2
    );
    expect(rows).toEqual([
      { currencyCode: 'SYP', amount: 800_000, rates: [], equivalent: 800_000 },
      { currencyCode: 'EUR', amount: 10, rates: [], equivalent: null },
      { currencyCode: 'USD', amount: 50, rates: [0.0001], equivalent: 500_000 },
    ]);
  });

  it('the reference is «تسليم {المندوب} {التاريخ}»', () => {
    expect(handoverReference('أبو علي', new Date(2026, 10, 3))).toBe('تسليم أبو علي 2026-11-03');
  });
});
