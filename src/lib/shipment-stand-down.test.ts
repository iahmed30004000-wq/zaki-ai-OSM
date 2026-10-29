import { describe, expect, it } from 'vitest';
import { CONFIRMATION_TRANSITIONS, REJECTION_REASONS } from './confirmation-workflow';
import { repoFile, stripComments } from './guard-source';

/**
 * A CONFIRMED ORDER THAT IS NOT GOING OUT.
 *
 * Somebody at the packing table decides a parcel is not shipping. Either the
 * customer needs talking to again, or it is over — and until now the screen
 * offered neither. It had a HOLD, which keeps the order confirmed with its
 * stock reserved and sets `shipHoldUntil`: a field read by exactly two files,
 * defaulting to FOREVER, so a held order was invisible to everyone except
 * whoever opened the held view on that one screen.
 *
 * THE STATE MACHINE SAID THIS COULD NOT HAPPEN. `CONFIRMED: []` — terminal.
 * And the invariants say the opposite in as many words: «reservation is
 * released in the same transaction on CANCELLED, VOIDED, UNCONFIRM». The
 * concept was in the contract and the transition map had no room for it. That
 * is reported, not quietly widened: this one door does it, with its own
 * guards, rather than opening `CONFIRMED` to every screen in the product.
 */

const route = () => stripComments(repoFile('src/app/api/ops/shipments/stand-down/route.ts'));
const screen = () => stripComments(repoFile('src/components/screens/ShipmentsNewScreen.tsx'));

describe('standing a shipment down', () => {
  it('is one door with two outcomes, not two doors', () => {
    expect(route()).toContain("z.enum(['POSTPONE', 'CANCEL'])");
    expect(screen()).toContain("'/api/ops/shipments/stand-down'");
  });

  /**
   * BOTH OUTCOMES RELEASE THE STOCK, IN THE SAME TRANSACTION.
   *
   * The contract's rule, and the reason for it is plain: stock held by an
   * order that is not going anywhere is stock the next customer is told we do
   * not have.
   */
  /*
   * (old → new, M6 28/10) The route released the reservation itself, in its own
   * transaction. Every door that ends an order now goes through ONE helper,
   * `endOrder` (src/lib/order-cancel.ts), which releases in the transaction it
   * writes the ending in — see the-state-invariants.test.ts and
   * order-cancel.test.ts. What this holds is that the route hands BOTH outcomes
   * to it, from one call that cannot drift, and releases nothing on its own.
   */
  it('hands the order to the one helper, which releases the reservation in the transaction that stops it', () => {
    const src = route();
    expect(src, 'الحجز يبقى على طلبٍ لا يذهب إلى أحد').toMatch(/await endOrder\(\{/);
    // One call, covering both outcomes — not one per branch that can drift.
    expect((src.match(/endOrder\(/g) ?? []).length).toBe(1);
    // And no second, private release: the route's own would free packed goods without anybody's word.
    expect(src).not.toMatch(/releaseOrderLines/);
    expect(stripComments(repoFile('src/lib/order-cancel.ts'))).toMatch(/releaseOrderLines\(tx, o\.id\)/);
  });

  it('and does it for the postpone as much as the cancel', () => {
    const src = route();
    // Both outcomes reach the same call: the kind is chosen from the outcome, not by two code paths.
    expect(src).toMatch(/kind: outcome === 'POSTPONE' \? 'FOLLOW_UP' : 'CANCEL'/);
    expect(src.indexOf('await endOrder(')).toBeGreaterThan(src.indexOf("auditAction = 'SHIPMENT_STOOD_DOWN_CANCELLED'"));
  });

  /** Once it is with the courier this is a return, not a decision. */
  it('refuses after the courier has taken the parcel', () => {
    // The SHAPE, not the presence: a disabled `if (false)` leaves every one
    // of these strings in the file, and a first version of this test passed
    // against exactly that.
    //
    // (old → new, M6) «after the parcel has left the warehouse» was the printed
    // waybill; it is the press of «إغلاق الشحنة — سُلّمت للشركة» now, asked of
    // `cancelVerdict` with the trolley's status read (`batchStatusOf`).
    expect(route(), 'حارس الشحنة الخارجة معطَّل').toMatch(/if \(!gate\.allowed\) \{/);
    expect(route(), 'الحارس لا يقرأ حالة العربة').toMatch(/batchStatus: await batchStatusOf\(db, order\.shippingBatchId\)/);
    expect(route(), 'حارس «مؤكَّد فقط» معطَّل').toMatch(
      /if \(order\.confirmationStatus !== 'CONFIRMED'\) \{/
    );
    expect(route(), 'بلا حماية من تعديل متزامن').toContain('expectedVersion: order.version');
  });

  /**
   * THE POSTPONE UNDOES THE CONFIRMATION AND LETS GO OF THE ORDER.
   *
   * It has to be pullable by whoever is free when its date comes: the pool
   * only takes unclaimed orders, and «back to the new orders» is the whole
   * request.
   */
  it('hands the postponed order to nobody, with a date', () => {
    const src = route();
    // From the branch to ITS else, not to the first `} else {` anywhere in
    // the file: the authority check above grew one, and slicing from zero
    // handed this an empty string that contained every rule vacuously.
    const start = src.indexOf("outcome === 'POSTPONE'");
    const branch = src.slice(start, src.indexOf('} else {', start));
    expect(branch.length, 'الفرعُ فارغ — القصُّ أخطأ موضعه').toBeGreaterThan(200);
    expect(branch).toContain("confirmationStatus: 'POSTPONED'");
    expect(branch).toContain('postponedUntil: due');
    expect(branch).toContain('claimedById: null');
    expect(branch, 'يبقى مؤكَّداً في الورق').toContain('confirmedAt: null');
    expect(src, 'يقبل موعداً في الماضي').toContain('due.getTime() < Date.now()');
  });

  /** A cancellation with no reason is one nothing can be learned from. */
  it('demands a structured reason to cancel, and a sentence for «other»', () => {
    const src = route();
    expect(src, 'الإلغاء بلا سبب مُهيكل').toMatch(
      /if \(!reason \|\| !\(REJECTION_REASONS as readonly string\[\]\)\.includes\(reason\)\) \{/
    );
    expect(src).toContain('سبب الإلغاء مطلوب');
    expect(src).toMatch(/if \(reason === 'OTHER' &&/);
    expect(REJECTION_REASONS).toContain('OTHER');
  });

  /** One picker. Two lists is how a report compares different questions. */
  it('and the screen reuses the reason dialog, never its own', () => {
    const src = screen();
    expect(src).toContain('<RejectDialog');
    // Wired to the row being cancelled, not rendered and never opened.
    expect(src, 'الحوار مرسومٌ ولا يُفتح').toContain('open={!!cancelling}');
    const spelled = REJECTION_REASONS.filter((r) => src.includes(`'${r}'`)).length;
    expect(spelled, 'نسخة محليّة من قائمة الأسباب في شاشة الشحن').toBeLessThan(3);
  });

  /**
   * AND THE TRANSITION MAP IS UNTOUCHED.
   *
   * Opening `CONFIRMED` in `CONFIRMATION_TRANSITIONS` would let any screen
   * un-confirm an order. This door carries its own guards and leaves the map
   * closed — the divergence between it and the invariants is reported, not
   * papered over.
   */
  it('without opening CONFIRMED to everything else', () => {
    expect(CONFIRMATION_TRANSITIONS.CONFIRMED, 'فُتحت الحالة النهائيّة للجميع').toEqual([]);
  });

  it('is written down — a status log, a note and an audit row', () => {
    const src = route();
    // The log and the note are the helper's writes (one transaction, one place); the route
    // names what they say, and the audit row stays here.
    expect(src).toMatch(/logNote: noteBody/);
    expect(src).toMatch(/noteBody: viaRequest \?/);
    expect(src).toMatch(/action: auditAction/);
    const helper = stripComments(repoFile('src/lib/order-cancel.ts'));
    expect(helper).toContain('orderStatusLog.create');
    expect(helper).toContain('orderNote.create');
  });
});
