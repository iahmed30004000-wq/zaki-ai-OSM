import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * WHO KNOWS WHAT, AND THEREFORE WHO WRITES WHAT.
 *
 * Recording a delivery at the tracking screen used to write
 * `collectedAmount` — and that is the one figure nobody on that screen can
 * know. A follow-up agent is repeating what a courier said on the phone; the
 * money is what the courier's own statement says arrived.
 *
 * It was worse than an approximation. The statement sweep only promotes
 * orders still in flight, so an order settled at the door left the set the
 * statement checks. Recording a delivery did not anticipate the
 * reconciliation — it CANCELLED it, and the typed figure was never once
 * compared with the courier's.
 *
 * The file that did the promoting even said so out loud: «an order already
 * marked delivered keeps its own date and amount, because whoever stood
 * there and recorded it knew more than a spreadsheet does». Half true. They
 * know WHAT HAPPENED — who took which line, what came back, why — and no
 * statement carries that. They do not know WHAT MONEY ARRIVED.
 *
 * So the line is drawn there: the door records the event, the statement
 * records the money, and the statement now reaches the orders the door
 * closed by hand — otherwise the amount would stay null for ever.
 */

const door = () => stripComments(repoFile('src/lib/partial-delivery.ts'));
const statement = () => stripComments(repoFile('src/app/api/finance/statements/[id]/route.ts'));
const dialog = () => stripComments(repoFile('src/components/screens/tracking/DeliverDialog.tsx'));

describe('the door records the event, not the money', () => {
  it('writes no amount onto the order', () => {
    const src = door();
    const write = src.slice(src.indexOf('await tx.order.update({'), src.indexOf('await appendDeliveryAttempt'));
    expect(write, 'الباب ما زال يكتب المبلغ').not.toMatch(/collectedAmount,/);
    expect(write, 'ولا حتى بقيمة محسوبة').not.toMatch(/collectedAmount:/);
    // What it does write is what it saw.
    expect(write).toContain('shippingStatus: status');
    expect(write).toContain('deliveredAt:');
  });

  /**
   * The figure is still computed — the screen shows what we expect to be paid.
   *
   * It is no longer computed HERE. Since 2026-10-02 the door calls
   * `doorMoney` in `settlement.ts`, the settlement matcher's own rule, so
   * what this screen shows and what the courier is later measured against
   * are one function rather than two that agreed. The division is unchanged:
   * the door RETURNS the figure and still writes no amount onto the order.
   */
  it('but still returns it, as an expectation', () => {
    const src = door();
    expect(src).toMatch(/const money = doorMoney\(/);
    expect(src).toMatch(/const collectedAmount = money\.collected;/);
    expect(src).toContain('expectedCollection: collectedAmount');
  });

  /**
   * `collectedAmount` was also the «already recorded» signal. It stopped
   * being one the moment the door stopped writing it, so the door's own
   * marks took over — one of the two dates is always set.
   */
  it('and refuses a second recording on the door’s own marks', () => {
    const src = door();
    expect(src, 'حارس التكرار معطَّل').toMatch(/if \(order\.deliveredAt \|\| order\.returnedAt\) \{/);
    expect(src, 'ما زال يعتمد على المبلغ').not.toMatch(/if \(order\.collectedAmount !== null\)/);
    expect(src).toContain('ALREADY_SETTLED');
    // Both columns must be loaded, or the guard reads undefined.
    expect(src).toContain('deliveredAt: true, returnedAt: true');
  });

  /**
   * `undefined !== null` is true. A strict comparison here would have
   * refused every delivery whose caller selected neither column — which is
   * exactly what it did to four existing tests.
   */
  it('by existence, not by a strict null comparison', () => {
    expect(door(), 'مقارنةٌ صارمة تَرفض كلّ تسليم').not.toMatch(
      /order\.deliveredAt !== null \|\| order\.returnedAt !== null/
    );
  });

  it('and the dialog calls the figure what it is', () => {
    const src = dialog();
    expect(src, 'ما زالت تسمّيه محصَّلاً').not.toContain('المحصَّل من العميل');
    expect(src).toContain('المتوقَّع تحصيله');
    expect(src).toContain('يُسجَّل من كشف شركة الشحن عند المطابقة');
  });
});

describe('and the statement is the only writer of it', () => {
  it('reaching the orders the door closed by hand', () => {
    const src = statement();
    expect(src, 'الكشف لا يدفع للمُسجَّل يدويّاً').toContain('const awaitingAmount = await tx.order.findMany({');
    expect(src).toMatch(/data: \{ collectedAmount: collected, version: \{ increment: 1 \} \}/);
  });

  /** One update per order, one version bump per statement. */
  it('without writing twice to one the promotion already wrote', () => {
    const src = statement();
    expect(src).toContain('const promoted = new Set(inFlight.map((o) => o.id));');
    expect(src).toMatch(/settledOrderIds\.filter\(\(oid\) => !promoted\.has\(oid\)\)/);
    // And it runs after the loop, so `promoted` is what the loop actually did.
    expect(src.indexOf('const promoted =')).toBeGreaterThan(src.indexOf('for (const order of inFlight)'));
  });

  /** A correction is deliberate, not a side effect of re-importing a file. */
  it('and never over an amount that is already there', () => {
    const src = statement();
    const block = src.slice(src.indexOf('const awaitingAmount'), src.indexOf('for (const order of awaitingAmount)'));
    expect(block, 'يدهس مبلغاً مُسجَّلاً').toContain('collectedAmount: null');
  });

  /** A matched row with no figure is not a figure of zero. */
  it('and skips a match that carries no amount', () => {
    expect(statement()).toMatch(/if \(collected == null\) continue;/);
  });

  /** Closing an order is still only for the ones still on their way. */
  it('while the status promotion stays in-flight only', () => {
    // 29/10: a FAILED_DELIVERY order the courier's statement paid for is delivered too; a returned one never is.
    expect(statement()).toContain("const IN_FLIGHT_PROMOTED_BY_STATEMENT = ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY'] as const;");
    expect(statement()).toContain('shippingStatus: { in: [...IN_FLIGHT_PROMOTED_BY_STATEMENT] }');
  });
});
