import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * تشطيب ١ — STAGE 1: THE COMMITMENTS LEDGER, the money section.
 *
 * «Violating any line here is a defect, not a design choice. If existing
 * code contradicts one, report it and stop.» — the invariants reference of
 * the crm-oms-guard skill, which is the formal contract this system was
 * built against.
 *
 * Every line of that section is pinned here against the code, with the
 * evidence the brief demands — «a test, a route, a query result or a screen
 * — never "looks implemented"». The one line the code contradicts is pinned
 * as it IS, not as it was promised, and reported rather than resolved.
 */

describe('COD = price − discount + delivery fee, from ONE function', () => {
  it('and the formula lives in `computeCod` and nowhere else', () => {
    const money = stripComments(repoFile('src/lib/money.ts'));
    const fn = money.slice(money.indexOf('export function computeCod('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('subtotal - discount + addOns');
    expect(body).toContain('net + deliveryFee');
  });

  it('and `price_includes_delivery` takes the fee out of revenue instead', () => {
    const money = stripComments(repoFile('src/lib/money.ts'));
    expect(money).toContain('const cod = includesDelivery ? net : roundMinor(net + deliveryFee, minorUnit);');
    expect(money).toContain('const revenue = includesDelivery ? roundMinor(net - deliveryFee, minorUnit) : net;');
  });
});

describe('the merchant reference', () => {
  const DOORS = [
    'src/lib/public-order.ts',
    'src/lib/telegram/order-creation.ts',
    'src/lib/replacement-order.ts',
    'src/app/api/orders/route.ts',
    'src/app/api/orders/ai-intake/route.ts',
    'src/app/api/confirmation/winback/route.ts',
  ];

  it.each(DOORS)('%s generates one — including the landing page and the POS', (door) => {
    expect(stripComments(repoFile(door))).toMatch(/orderRefFields\(/);
  });

  it('reaches the courier in its own field, never inside a note', () => {
    const dispatch = stripComments(repoFile('src/lib/couriers/dispatch.ts'));
    /*
     * IN THE CALL TO THE COURIER, not merely somewhere in the file.
     *
     * `merchantRef: order.merchantRef || order.orderNumber` appears twice —
     * once in `adapter.createShipment({…})`, which is the courier's own
     * reference field, and once in an audit log's metadata. A match against
     * the whole file was satisfied by the audit line while the courier got
     * nothing at all, so the window is the dispatch call itself.
     */
    const call = dispatch.indexOf('adapter.createShipment({');
    expect(call).toBeGreaterThan(-1);
    const payload = dispatch.slice(call, dispatch.indexOf('});', call));
    expect(payload).toMatch(/merchantRef: order\.merchantRef \|\| order\.orderNumber/);
    // And it is a field of its own, never folded into a note.
    expect(payload).not.toMatch(/note[s]?:[^\n]*merchantRef/);
  });
});

describe('delivery status, settlement and collection are three fields', () => {
  it('and the schema keeps them apart', () => {
    const schema = repoFile('prisma/schema.prisma');
    const model = schema.slice(schema.indexOf('model Order {'));
    const body = model.slice(0, model.indexOf('\n}'));
    expect(body).toMatch(/shippingStatus\s+String/);
    expect(body).toMatch(/settlementStatus\s+String/);
    expect(body).toMatch(/collectedAmount/);
  });
});

describe('decimal precision comes from the currency’s minor unit', () => {
  it('and never from a single global rule', () => {
    const money = stripComments(repoFile('src/lib/money.ts'));
    const fn = money.slice(money.indexOf('export function roundMinor('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('Math.trunc(minorUnit)');
    // No constant 100 standing in for a currency.
    expect(body).not.toMatch(/\*\s*100\b/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * «If ANY line includes delivery, the whole order does.» — WAS DIVERGED,
 * NOW HELD.
 *
 * The code used to ignore every offer's `deliveryIncluded` the moment a
 * basket had two lines, and fall back to the shop's policy. A bundle
 * advertised as «السعر شامل التوصيل» therefore had the fee added as soon as
 * the customer put a second thing in the basket — a promise printed on the
 * offer and broken at the door.
 *
 * The owner ruled for the contract. What that costs is written into the
 * code beside the rule rather than left to be discovered: one cheap
 * delivery-included bundle now makes a whole basket delivery-included. The
 * lever against that is the OFFER, not a second rule in the engine.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('«if ANY line includes delivery, the whole order does»', () => {
  const src = stripComments(repoFile('src/lib/public-order.ts'));

  it('is read across every line, not off the first one', () => {
    expect(src).toMatch(/lines\.some\(\(l\) => l\.offer\?\.deliveryIncluded === true\)/);
  });

  it('and the single-line special case is gone, because it was the divergence', () => {
    expect(src).not.toMatch(/lines\.length === 1 \? \(head\.offer\?\.deliveryIncluded/);
  });

  it('and the shop’s policy is the fallback when no line says anything', () => {
    // `undefined`, not `false`: passing false would override a shop that
    // prices delivery in, which is the opposite mistake.
    expect(src).toMatch(/anyLineIncludesDelivery \? true : undefined/);
    const fees = stripComments(repoFile('src/lib/delivery-fees.ts'));
    const fn = fees.slice(fees.indexOf('export async function priceIncludesDeliveryFor('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('offerDeliveryIncluded === true');
    expect(body).toContain('store?.priceIncludesDelivery === true');
  });

  it('and the cost of the rule is written down where the rule is', () => {
    // A rule with a known abuse path and no note is a rule somebody will
    // «fix» by hand the first time it is abused.
    const withComments = repoFile('src/lib/public-order.ts');
    expect(withComments).toMatch(/ship free|شامل التوصيل/);
    expect(withComments).toMatch(/the OFFER/);
  });
});
