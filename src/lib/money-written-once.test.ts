import { describe, expect, it } from 'vitest';
import { roundMinor } from './money';
import { absorbDamaged } from './stock-consumption';
import { repoFile, stripComments } from './guard-source';

/**
 * تشطيب ٢ — PASS 2: «If the same figure is computed in two different places
 * in the code, that is a defect even when the two agree today.»
 *
 * The audit traces one order's number: order detail COD → preparation →
 * manifest → label → tracking → statement → receipt → matching → wallet →
 * closing → profit → commission. Every stop must show the same figure.
 *
 * This file guards the part of that chain which is decided by CODE rather
 * than by data: that there is one rounding rule, and that the money WRITTEN
 * onto an order goes through it.
 *
 * WHAT WAS FOUND. `add-product` — the post-order upsell, the one door that
 * changes an order's money after the order exists — rounded with
 * `.toFixed(2)`. The figure it produced was written three times: the add-on
 * row, the order's `totalAmount` (which is what the courier is told to
 * collect) and the landing page's `upsellRevenue`. On the Jordanian store in
 * this database the currency is JOD, **minorUnit 3**, so 1.234 was stored as
 * 1.23 — a fils lost, and three rows disagreeing with the product they came
 * from and with the courier's manifest.
 */

describe('one rounding rule, and the money that is written goes through it', () => {
  it('rounds to the CURRENCY’s minor unit, which is not always two', () => {
    // The three currencies this database actually holds: JOD is 3.
    // Half away from zero, so .2345 at three places is .235 — not .234, which
    // is what this line first claimed and what banker's rounding would give.
    expect(roundMinor(1.2345, 3)).toBe(1.235);
    expect(roundMinor(1.2345, 2)).toBe(1.23);
    // And the figure `.toFixed(2)` would have produced for a JOD add-on.
    expect(Number((1.234).toFixed(2))).toBe(1.23);
    expect(roundMinor(1.234, 3)).toBe(1.234);
    expect(roundMinor(1.234, 3)).not.toBe(Number((1.234).toFixed(2)));
  });

  it('the post-order add-on rounds by the order’s currency, not by two', () => {
    const src = stripComments(
      repoFile('src/app/api/public/landing-pages/[slug]/orders/[orderNumber]/add-product/route.ts')
    );
    expect(src).toContain('roundMinor(');
    // The figure is written to three rows; none of them may be the guess.
    expect(src).not.toContain('toFixed(2)');
    // And it must READ the minor unit rather than assume one.
    expect(src).toContain('minorUnit');
    expect(src).toContain('country: { select: { minorUnit: true } }');
  });

  it('and nothing else writes a money figure onto an order with a guessed rounding', () => {
    /*
     * SCOPED TO WRITES, AND THAT SCOPE IS THE POINT.
     *
     * `toFixed(2)` appears about twenty-five times in this repository, and
     * most are report aggregates — a revenue total, an average order value, a
     * commission sum — which are READ. They are a separate finding (a JOD
     * report loses a fils per row) and a separate decision, because rounding
     * a report is a presentation choice while rounding money onto an ORDER
     * changes what a courier collects.
     *
     * So this sweep reads only the routes that write an order's own money.
     */
    const WRITERS = [
      'src/app/api/public/landing-pages/[slug]/orders/[orderNumber]/add-product/route.ts',
      'src/lib/public-order.ts',
      'src/lib/replacement-order.ts',
      'src/lib/telegram/order-creation.ts',
      'src/app/api/orders/ai-intake/route.ts',
      'src/app/api/ops/shipments/route.ts',
      // Found only after this guard had already passed once: it writes
      // `estimatedCostOfGoods` onto the order when the goods leave the shelf.
      'src/lib/stock-consumption.ts',
      // And this one raises a whole new order, which is not obvious from its
      // name — «استرجاع الملغي» reads like a screen, not like a money path.
      'src/app/api/confirmation/winback/route.ts',
    ];

    /*
     * TWO SPELLINGS OF ONE MISTAKE.
     *
     * This looked for `toFixed(2)` alone, and `stock-consumption.ts` wrote the
     * same wrong figure as `Math.round(cost * 100) / 100` — arithmetic the
     * guard walked straight past while reporting that the rule held. A
     * detector that recognises one spelling of a defect is a detector that
     * teaches people the other one.
     */
    const TWO_DECIMALS = /toFixed\(2\)|Math\.round\([^)]*\*\s*100\s*\)\s*\/\s*100/;
    const offenders: string[] = [];
    for (const file of WRITERS) {
      const src = stripComments(repoFile(file));
      // A file that writes an order's own money and rounds with a fixed two
      // decimals is rounding it wrong. `estimatedCostOfGoods` counts: the
      // profit report subtracts it from a total rounded the other way.
      // The three money figures these files WRITE: what the courier collects,
      // what the goods cost the order, and what a unit costs the batch it is
      // put back into. `costPerUnit` was missing, and the two mutations that
      // broke it passed.
      const writes =
        /totalAmount[^:]*:/.test(src) ||
        /estimatedCostOfGoods:/.test(src) ||
        /costPerUnit: /.test(src);
      if (writes && TWO_DECIMALS.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);

    // AND THE DETECTOR STILL RECOGNISES WHAT IT WAS WRITTEN FOR. A sweep that
    // passes because its regex stopped matching anything is the failure this
    // repository has recorded before.
    expect(TWO_DECIMALS.test('Number(v.toFixed(2))')).toBe(true);
    expect(TWO_DECIMALS.test('Math.round(cost * 100) / 100')).toBe(true);
    expect(TWO_DECIMALS.test('roundMinor(cost, minorUnit)')).toBe(false);

    /*
     * AND THE UNIT IS READ FROM THE ORDER, NOT ASSUMED.
     *
     * `roundMinor(cost, 2)` is not either spelling above and is the same
     * mistake — a mutation replacing the lookup with a literal passed every
     * check in this file. Both functions in `stock-consumption` write money,
     * and both must take the currency from the order they are writing about.
     */
    const stock = stripComments(repoFile('src/lib/stock-consumption.ts'));
    const derived = stock.match(/const \w*[Uu]nit = order\.store\?\.country\?\.minorUnit \?\? 2;/g) ?? [];
    expect(derived, 'وحدةٌ مفترضةٌ بدل مقروءة').toHaveLength(2);
  });

  it('and the damaged units’ cost lands on the survivors at the currency’s precision', () => {
    /*
     * ASSERTED BY BEHAVIOUR, NOT BY SPELLING.
     *
     * Every other check in this file reads source text, and that is how the
     * `Math.round(x * 100) / 100` form slipped past a sweep looking for
     * `.toFixed(2)`. This one runs the arithmetic: twelve survivors of a run
     * of sixteen carry a sixteenth each, and on a three-decimal currency the
     * third decimal has to survive.
     */
    const jod = absorbDamaged({ sound: 3, damaged: 1, costPerUnit: 1, minorUnit: 3 });
    expect(jod.costPerUnit).toBe(1.333);
    expect(jod.totalCost).toBe(4);

    // The same numbers on a two-decimal currency, so the parameter is seen
    // to do something rather than merely be passed.
    expect(absorbDamaged({ sound: 3, damaged: 1, costPerUnit: 1, minorUnit: 2 }).costPerUnit).toBe(1.33);
  });

  it('the winback raises its order through the one money function', () => {
    /*
     * «استرجاع الملغي» makes a NEW order from a cancelled one, and it
     * computed the total by hand: `Math.max(0, unit * quantity -
     * totalDiscount)`. Three things that got wrong which `computeCod` does
     * not — it rounded nowhere, it ignored `priceIncludesDelivery` (which the
     * row beside it faithfully copies), and it clamped the TOTAL to zero
     * instead of clamping the discount to the subtotal.
     *
     * Nothing caught it: a route named for a screen is not a route anybody
     * reads looking for arithmetic.
     */
    const src = stripComments(repoFile('src/app/api/confirmation/winback/route.ts'));
    expect(src).toContain('computeCod({');
    expect(src).toContain('const totalAmount = money.cod;');
    /*
     * AND THE POLICY IS IN BOTH PLACES, AND THEY AGREE.
     *
     * `priceIncludesDelivery: order.priceIncludesDelivery` appears twice —
     * once as an argument to `computeCod` and once on the row that is
     * written — so asking the file whether it contains that line was
     * satisfied by the row while the computation had been handed a literal
     * `false`. The figure must be computed under the SAME policy the row
     * records, or the order says one thing and its total means another.
     */
    const call = src.slice(src.indexOf('computeCod({'));
    expect(call.slice(0, call.indexOf('});'))).toMatch(/priceIncludesDelivery: order\.priceIncludesDelivery/);
    const row = src.slice(src.indexOf('tx.order.create('));
    expect(row.slice(0, 900)).toMatch(/priceIncludesDelivery: order\.priceIncludesDelivery/);
    // The hand arithmetic is gone, not merely unused.
    expect(src).not.toMatch(/Math\.max\(0, unit \* quantity/);
  });

  it('the COD is computed in one function, and the wrappers call it', () => {
    // `codForOrder` reads like a second formula and is not one — it maps an
    // order's lines onto `computeCod`. Asserted so it cannot quietly become
    // one.
    const fees = stripComments(repoFile('src/lib/delivery-fees.ts'));
    const at = fees.indexOf('export function codForOrder(');
    expect(at).toBeGreaterThan(-1);
    // To the NEXT top-level declaration, not to the first `\n}` — the body
    // closes several braces of its own before the function ends, and the
    // first of them cut the slice short of `computeCod` entirely.
    const after = fees.indexOf('\nexport ', at + 10);
    const body = fees.slice(at, after > -1 ? after : fees.length);
    expect(body).toContain('computeCod(');
    // And no arithmetic of its own on the figures that make a COD.
    expect(body).not.toMatch(/deliveryFee\s*[+*/-]\s*\w/);
  });

  it('and what the courier is told to collect is the order’s stored total', () => {
    /*
     * ONE NUMBER, NOT A RECOMPUTATION AT DISPATCH.
     *
     * `public-order.ts` writes `totalAmount = money.cod` when the order is
     * created, and the manifest sends that stored figure. Recomputing it at
     * dispatch instead would be the second place the audit forbids — and it
     * would silently change what a courier collects whenever a fee table was
     * edited between the order and the parcel.
     *
     * (old → new, 1/11, the «شامل التوصيل» door's review) STILL THE STORED FIGURE — read in the very statement that claims
     * the order instead of in the early read of the whole batch, because an order on the trolley can have its flag flipped
     * (its stored total moves with it) between that read and its send. Still no arithmetic here.
     */
    const order = stripComments(repoFile('src/lib/public-order.ts'));
    expect(order).toContain('const totalAmount = money.cod;');
    const dispatch = stripComments(repoFile('src/lib/couriers/dispatch.ts'));
    expect(dispatch).toContain('codAmount: claim.totalAmount');
    expect(dispatch).toContain('RETURNING "id", "totalAmount"');
    expect(dispatch).not.toContain('computeCod(');
  });
});
