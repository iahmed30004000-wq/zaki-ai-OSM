import { describe, expect, it } from 'vitest';
import { correctedLedger, planOldStock, type OldStockFacts } from './old-stock-home';
import { shownPlaces, placesOf } from './stock-places';
import { figureOf } from './warehouse-figures';

/**
 * «كل إشي قديم من قدسيا» (the owner, 27/11) — the TABLE the press shows and carries out, on the shop's own six figures of
 * that day: what each warehouse held on the screen, what it must say after.
 *
 * Qudsaya is `q`, Ain Tarma `t`. Ain Tarma received a transfer; the sales of old parcels (naming no warehouse) then took 2
 * of «أذن» and 15 of «ماء» off its rows, and none of the others.
 */

const Q = 'q';
const T = 't';

/** product: [shelf q, shelf t, no place, held by old orders, held by today's Ain Tarma shipment, ledger of t, loose sales] */
const SHOP: Record<string, [number, number, number, number, number, number, number]> = {
  ندبات: [653, 396, 262, 220, 130, 396, 42],
  حرير: [4, 74, 44, 44, 74, 74, 2],
  أذن: [0, 155, 288, 270, 98, 157, 42],
  ماء: [177, 380, 663, 504, 134, 395, 159],
  فطريات: [5, 20, 9, 9, 14, 20, 11],
  طواقي: [0, 8, 3, 3, 0, 8, 0],
};

function facts(over: Partial<OldStockFacts> = {}): OldStockFacts {
  const names = Object.keys(SHOP);
  return {
    warehouses: [{ id: Q, name: 'قدسيا' }, { id: T, name: 'عين ترما' }],
    products: names.map((n) => ({ id: n, name: n, sku: null })),
    rows: names.flatMap((n) => {
      const [q, t, none] = SHOP[n];
      return [
        { productId: n, quantityRemaining: q, warehouseId: Q, inTransitTransferId: null },
        { productId: n, quantityRemaining: t, warehouseId: T, inTransitTransferId: null },
        { productId: n, quantityRemaining: none, warehouseId: null, inTransitTransferId: null },
      ];
    }),
    holds: new Map([[T, new Map(names.map((n) => [n, { reserved: SHOP[n][4], pending: 0 }]))]]),
    oldHeld: new Map(names.map((n) => [n, SHOP[n][3]])),
    ledger: new Map(names.map((n) => [`${T}|${n}`, SHOP[n][5]])),
    looseSales: new Map(names.map((n) => [n, SHOP[n][6]])),
    combined: new Set(),
    orders: 5,
    ...over,
  };
}

const shown = (rows: ReturnType<typeof planOldStock>, product: string, warehouse: string) => {
  const w = rows.find((r) => r.productId === product)!.warehouses.find((x) => x.id === warehouse)!;
  return [w.after.onHand, w.after.held, w.after.free];
};

describe('the old stock’s table on the shop’s six products', () => {
  const plan = planOldStock(facts(), Q);

  it.each([
    ['ندبات', [915, 220, 695], [396, 130, 266]],
    ['حرير', [48, 44, 4], [74, 74, 0]],
    ['أذن', [286, 270, 16], [157, 98, 59]],
    ['ماء', [825, 504, 321], [395, 134, 261]],
    ['فطريات', [14, 9, 5], [20, 14, 6]],
    ['طواقي', [3, 3, 0], [8, 0, 8]],
  ])('%s: Qudsaya and Ain Tarma, on the shelf · reserved · available', (product, q, t) => {
    expect(shown(plan, product, Q)).toEqual(q);
    expect(shown(plan, product, T)).toEqual(t);
  });

  it('suggests back exactly what was taken off Ain Tarma, and nothing else', () => {
    const restores = plan.flatMap((r) => r.warehouses.filter((w) => w.restore > 0).map((w) => [r.productId, w.id, w.restore]));
    expect(restores).toEqual([['أذن', T, 2], ['ماء', T, 15]]);
  });

  it('the store’s own figures do not move: the two warehouses add up to the shelf and the holds before', () => {
    for (const r of plan) {
      const [q, t, none, old, today] = SHOP[r.productId];
      const total = (k: 'onHand' | 'held') => r.warehouses.reduce((s, w) => s + w.after[k], 0);
      expect(total('onHand')).toBe(q + t + none);
      expect(total('held')).toBe(old + today);
    }
  });

  it('NEGATIVE: never suggests more than the sales naming no warehouse took', () => {
    const none = planOldStock(facts({ looseSales: new Map() }), Q);
    expect(none.every((r) => r.warehouses.every((w) => w.restore === 0))).toBe(true);
  });

  it('NEGATIVE: never suggests more than the home warehouse has free after the old stock', () => {
    const f = facts({ oldHeld: new Map([['ماء', 840]]) });
    const row = planOldStock(f, Q).find((r) => r.productId === 'ماء')!;
    // 177 + 663 − 840 = 0 free: nothing can go back out of it.
    expect(row.warehouses.find((w) => w.id === T)!.restore).toBe(0);
  });

  it('what the person types replaces the suggestions, all of them', () => {
    const typed = planOldStock(facts(), Q, [{ productId: 'ندبات', warehouseId: T, quantity: 4 }]);
    expect(shown(typed, 'ندبات', T)).toEqual([400, 130, 270]);
    expect(shown(typed, 'ماء', T)).toEqual([380, 134, 246]);
  });

  it('NEGATIVE: a product with combinations gets no suggestion', () => {
    const row = planOldStock(facts({ combined: new Set(['ماء']) }), Q).find((r) => r.productId === 'ماء')!;
    expect(row.warehouses.every((w) => w.restore === 0)).toBe(true);
  });
});

describe('a refused parcel received since the placement moves units with no ledger line', () => {
  const written = new Map([[`${T}|أذن`, 157]]);

  it('received INTO Ain Tarma: the suggestion still says what the old sales took, on top of the parcel’s units', () => {
    const ledger = correctedLedger(written, [{ into: T, from: null, moved: 2, lines: [{ productId: 'أذن', units: 2 }] }], []);
    const f = facts({ ledger, rows: facts().rows.map((r) => (r.productId === 'أذن' && r.warehouseId === T ? { ...r, quantityRemaining: 157 } : r)) });
    // 155 + the 2 received = 157 on the shelf; the books should say 159.
    expect(planOldStock(f, Q).find((r) => r.productId === 'أذن')!.warehouses.find((w) => w.id === T)!.restore).toBe(2);
  });

  it('an Ain Tarma parcel received in Qudsaya is taken off Ain Tarma’s figure: nothing is suggested back for it', () => {
    const ledger = correctedLedger(written, [{ into: Q, from: T, moved: 3, lines: [{ productId: 'أذن', units: 3 }] }], []);
    expect(ledger.get(`${T}|أذن`)).toBe(154);
    expect(ledger.get(`${Q}|أذن`)).toBe(3);
  });

  it('the moved units are laid over the lines in order, and broken-line returns count where they came back', () => {
    const ledger = correctedLedger(
      new Map(),
      [{ into: T, from: null, moved: 3, lines: [{ productId: 'a', units: 2 }, { productId: 'b', units: 5 }] }],
      [{ warehouseId: T, from: null, productId: 'b', quantity: 4 }]
    );
    expect([ledger.get(`${T}|a`), ledger.get(`${T}|b`)]).toEqual([2, 5]);
  });

  it('broken-line returns: from Ain Tarma into Qudsaya moves the sound units between the two figures', () => {
    const ledger = correctedLedger(written, [], [{ warehouseId: Q, from: T, productId: 'أذن', quantity: 2 }]);
    expect([ledger.get(`${Q}|أذن`), ledger.get(`${T}|أذن`)]).toEqual([2, 155]);
  });

  it('NEGATIVE: broken-line returns received where they came from change nothing', () => {
    expect(correctedLedger(written, [], [{ warehouseId: T, from: T, productId: 'أذن', quantity: 2 }])).toEqual(written);
  });

  it('NEGATIVE: received into the warehouse it named moves nothing', () => {
    expect(correctedLedger(written, [{ into: T, from: T, moved: 2, lines: [{ productId: 'أذن', units: 2 }] }], [])).toEqual(written);
  });
});

describe('the card’s figures', () => {
  it('on the shelf = reserved + available, and the confirmed order in no shipment is said apart', () => {
    const places = placesOf(
      [
        { quantityRemaining: 74, warehouseId: T, inTransitTransferId: null },
        { quantityRemaining: 48, warehouseId: Q, inTransitTransferId: null },
      ],
      [Q, T]
    );
    const card = shownPlaces(places, 118, {
      order: [Q, T],
      holds: new Map([[T, new Map([['p', { reserved: 74, pending: 0 }]])], [Q, new Map([['p', { reserved: 44, pending: 1 }]])]]),
      productId: 'p',
      reserved: 120,
      unsourced: 0,
    });
    expect(card.warehouses).toEqual([
      { id: Q, onHand: 48, held: 45, free: 3, pending: 1 },
      { id: T, onHand: 74, held: 74, free: 0, pending: 0 },
    ]);
    expect(card.unassigned).toBe(2);
    for (const w of card.warehouses) expect(w.held! + w.free!).toBe(w.onHand);
  });

  it('a hold with no pending exit', () => {
    expect(figureOf(10, { reserved: 4, pending: 0 })).toEqual({ onHand: 10, held: 4, free: 6, pending: 0 });
    expect(figureOf(0, undefined)).toEqual({ onHand: 0, held: 0, free: 0, pending: 0 });
  });
});
