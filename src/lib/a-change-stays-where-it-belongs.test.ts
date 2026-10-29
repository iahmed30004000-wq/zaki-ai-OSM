import { describe, expect, it } from 'vitest';
import { assertCancellable, hasEverShipped } from './order-state';
import { repoFile, stripComments } from './guard-source';

/**
 * تشطيب ٢ — PASS 3: «Pay particular attention to cascades that should NOT
 * happen. A change that leaks into an unrelated record is worse than one
 * that fails.»
 *
 * Two of the brief's twenty-five, held here because nothing held them:
 *
 *   «cancel after shipment → refused?»
 *   «change delivery fee → future orders only, existing orders frozen?»
 */

describe('once the parcel has left, cancelling is a request — not a status', () => {
  const shipped = {
    shippingStatus: 'IN_TRANSIT',
    shippedAt: new Date(),
    confirmationStatus: 'CONFIRMED',
    status: 'PROCESSING',
  } as never;
  const onTheShelf = {
    shippingStatus: 'NOT_READY',
    shippedAt: null,
    confirmationStatus: 'NEW',
    status: 'NEW',
  } as never;

  it('refuses, and says what happens instead', () => {
    const verdict = assertCancellable(shipped);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('CANCEL_AFTER_SHIPPED');
    // The brief calls this state `cancel_requested`. This product has no such
    // state and should not grow one — the core list is closed, and the thing
    // it describes is a change REQUEST plus a return received and counted.
    // The refusal says so, which is the part a person needs.
    expect(verdict.message).toMatch(/طلب إلغاء/);
    expect(verdict.message).toMatch(/المرتجع/);
  });

  it('and allows it while the goods are still ours', () => {
    expect(assertCancellable(onTheShelf).allowed).toBe(true);
    expect(hasEverShipped(onTheShelf)).toBe(false);
  });

  /**
   * THE DOOR THAT CANCELS WITHOUT ANYBODY PRESSING CANCEL.
   *
   * Three unanswered calls close an order. That door did not ask the rule —
   * and could not reach a shipped parcel anyway, because shipping requires
   * `confirmationStatus === 'CONFIRMED'` and CONFIRMED is in the «already
   * decided» list it checks. Two unrelated lists overlapping is not a rule;
   * it is a rule's shadow, and it goes away the day either list is edited.
   *
   * (old → new, M6 28/10) It used to call `assertCancellable`. Every cancel
   * door now asks the ONE helper, `endOrder`, and this door asks it only for
   * an order that never entered the shipment: a counter does not get to take a
   * parcel off a trolley.
   */
  it('the automatic close asks the one helper, and only for an order that never entered the shipment', () => {
    const src = stripComments(repoFile('src/app/api/orders/[id]/contact-attempts/route.ts'));
    expect(src).toMatch(/endOrder\(\{/);
    // And the answer is USED — a `neverShipped` whose verdict is not in the
    // condition is a variable that reassures a reader and stops nothing.
    expect(src).toMatch(/noAnswers >= NO_ANSWER_LIMIT[^)]*neverShipped/);
    // The four facts that make an order «never shipped».
    for (const fact of ['shippingBatchId', 'trackingNumber', 'labelPrintedAt', "shippingStatus === 'NOT_READY'"]) {
      expect(src, `neverShipped لا يسأل عن ${fact}`).toContain(fact);
    }
  });

  it('and every door that writes CANCELLED on an order asks it', () => {
    /*
     * Swept, because the question is not «does this door ask» but «is there a
     * door that does not». Change-request rows are exempt by shape: that
     * `status: 'CANCELLED'` is the REQUEST's own status, not an order's.
     *
     * (old → new, M6) The list is the same three plus the three doors that
     * ended an order without being on it (stand-down, the shipping screen, the
     * PATCH), and the question is `endOrder` — the helper — or, for the void,
     * `assertVoidable`.
     */
    const DOORS = [
      'src/app/api/confirmation/issues/[id]/route.ts',
      'src/app/api/orders/[id]/contact-attempts/route.ts',
      'src/app/api/orders/[id]/confirmation/route.ts',
      'src/app/api/ops/shipments/stand-down/route.ts',
      'src/app/api/orders/[id]/shipping/route.ts',
      'src/app/api/orders/[id]/route.ts',
    ];
    const deaf: string[] = [];
    for (const door of DOORS) {
      const src = stripComments(repoFile(door));
      /*
       * THE CALL, NOT THE NAME.
       *
       * This matched the bare identifier, and every one of these files
       * imports it — so replacing `assertVoidable(issue.order)` with
       * `{ allowed: true }` left the import behind and the sweep saw nothing.
       * It is the same mistake this repository has now recorded several
       * times: a guard that asks whether a name is PRESENT rather than
       * whether it is USED.
       */
      const called = /(endOrder|assertVoidable)\s*\(\s*[A-Za-z{]/.test(src);
      if (!called) deaf.push(door);
    }
    expect(deaf, 'بابٌ يُلغي بلا سؤال').toEqual([]);
  });
});

describe('a fee table change reaches tomorrow’s orders and no others', () => {
  const dispatch = stripComments(repoFile('src/app/api/ops/shipments/route.ts'));

  it('the fee is written onto the order when the parcel is handed over', () => {
    // Not read back from the table whenever a screen draws the order: a fee
    // edited next month would then rewrite what a courier already collected.
    expect(dispatch).toContain('deliveryFee: fee.fee');
    expect(dispatch).toContain('totalAmount: money.cod');
  });

  it('and the COD is written with it, from the one money function', () => {
    // The pair has to move together. A fee snapshot beside a COD that is
    // recomputed later is two figures that disagree about the same parcel.
    // `deliveryFee: fee.fee` appears twice — once as an ARGUMENT to
    // `codForOrder`, once as the column written. The one that matters is the
    // write, so the slice starts at the update rather than at the first hit.
    const write = dispatch.indexOf('shippingBatchId: created.id');
    expect(write).toBeGreaterThan(-1);
    const block = dispatch.slice(write, write + 500);
    expect(block).toContain('deliveryFee: fee.fee');
    expect(block).toContain('totalAmount: money.cod');
    /*
     * THE COD THIS BLOCK WRITES IS COMPUTED IN THIS BLOCK.
     *
     * `codForOrder(` on its own is satisfied by the import line AND by a
     * second caller higher up in the same file — so both a bare `toContain`
     * and a match against everything-before-the-write passed while the
     * dispatch call was replaced by a literal. The window is the loop that
     * does the dispatching, and nothing else.
     */
    const loop = dispatch.lastIndexOf('for (const order of shippable)');
    expect(loop).toBeGreaterThan(-1);
    expect(loop).toBeLessThan(write);
    expect(dispatch.slice(loop, write)).toMatch(/const money = codForOrder\(\{/);
  });

  it('the label reads the snapshot once the order is in a batch', () => {
    /*
     * THE RULE IS NOT «THE LABEL NEVER COMPUTES».
     *
     * This asserted that `waybill.ts` does not mention `resolveDeliveryFee`,
     * and it does — which looked like the defect and is not. A label printed
     * BEFORE dispatch has no snapshot to read: a public order is stored with
     * no fee at all, so printing the stored total would print an amount the
     * courier will not collect. So the waybill computes exactly as shipment
     * creation will, and the moment the order joins a batch it stops
     * computing and reads what was written.
     *
     * That early return is the whole guarantee, so that is what is asserted —
     * and it has to come FIRST, before the fee lookup, or the lookup happens
     * anyway and a table edited in between decides the label.
     */
    const waybill = stripComments(repoFile('src/lib/waybill.ts'));
    const fn = waybill.slice(waybill.indexOf('export async function waybillCod('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/if \(order\.shippingBatchId[^)]*\) return Number\(order\.totalAmount/);
    expect(body.indexOf('shippingBatchId')).toBeLessThan(body.indexOf('resolveDeliveryFee'));
  });
});
