import { describe, expect, it } from 'vitest';
import { SHIPPING_STATUS_AR } from './shipping-workflow';
import { canCollect } from './parcel-tracking/priority';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE DOOR THAT COLLECTS WITHOUT A STATEMENT WAS BEHIND A FILTER.
 *
 * The owner, 21/10: «التحصيل لازم اقدر اعمل تحصيل… افرض ما عندي كشف،
 * لازمني آلية للمطابقة واغلاق الطلب وتحصيله».
 *
 * That mechanism was already built, whole: `POST
 * /api/ops/tracking/collect` settles named orders against a named wallet
 * «for both there is no statement to import», writes the movement, makes
 * the commission payable, and refuses a parcel that is not delivered or
 * is already settled. The tracking screen's «استلمت منه» button calls
 * it. Its own task list declares the condition COLLECT — «بانتظار
 * التحصيل: سُلّمت ولم تُسوَّ» — and `canCollect` is the exact predicate
 * the button and the checkbox both ask.
 *
 * Nobody could find it, for one reason: the screen's default load asked
 * the door for IN_FLIGHT only, and a DELIVERED parcel is not in flight.
 * So the chip's rows were never fetched, the chip never drew, the
 * checkbox column never appeared, and the whole door sat behind a filter
 * nobody knew to change.
 *
 * ── AND THE SECOND HALF OF THE SAME COMPLAINT ──
 *
 * Collecting by hand sets `settlementStatus = SETTLED` with no statement
 * anywhere. The settlement sweep then flagged every such order as «طلب
 * مسلَّم لم يرد في كشف الشركة» — true, and useless: nothing is owed and
 * the operator cannot clear the row, because there is no statement for
 * the parcel to appear on. Same false alarm the sweep was rewritten once
 * to stop making, arriving by a second road.
 * ═══════════════════════════════════════════════════════════════════════
 */

const door = () => stripComments(repoFile('src/app/api/ops/tracking/route.ts'));

/**
 * The status list the door's default actually carries, read out of the
 * source rather than restated here — so editing the route re-runs the
 * real predicate below against the NEW list.
 */
function awaitingCollectionInDoor(): string[] {
  const src = door();
  /*
   * The list AND its use. A declared constant the `where` does not read is
   * exactly the state this branch found the route in: the statuses were
   * right in the file and the query asked for IN_FLIGHT only.
   */
  if (!/shippingStatus: \{ in: AWAITING_COLLECTION \}/.test(src)) {
    throw new Error('AWAITING_COLLECTION معرَّفة والاستعلام ما بيقراها');
  }
  const m = src.match(/const AWAITING_COLLECTION = \[([^\]]*)\]/);
  if (!m) throw new Error('الباب ما فيه AWAITING_COLLECTION');
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
}

describe('the default load fetches what the collect chip is made of', () => {
  it('— the door carries the awaiting-collection statuses, not in-flight alone', () => {
    const src = door();
    expect(src, 'الباب لسّا بيسأل عن المتحرّك بس').toMatch(/AWAITING_COLLECTION/);
    expect(src).toMatch(/shippingStatus: \{ in: AWAITING_COLLECTION \}/);
  });

  it('and every status `canCollect` accepts is in that list', () => {
    /*
     * THE CLAIM THAT WOULD HAVE CAUGHT THE BUG.
     *
     * Asked of the real predicate, over every shipping status the product
     * has: if `canCollect` can be true of a status, the default load must
     * ask for it — otherwise the chip counts rows that were never sent.
     * Before this branch the list was IN_FLIGHT only, and DELIVERED and
     * PARTIALLY_DELIVERED both failed here.
     */
    const asked = new Set(awaitingCollectionInDoor());
    const collectable = Object.keys(SHIPPING_STATUS_AR).filter((s) =>
      canCollect({ shippingStatus: s, settlementStatus: 'PENDING', daysInTransit: null, late: false })
    );
    expect(collectable.length, 'ولا حالة بتقبل التحصيل').toBeGreaterThan(0);
    for (const s of collectable) {
      expect(asked.has(s), `${s} بيقبل التحصيل والباب ما بيجيبه`).toBe(true);
    }
  });

  it('and nothing in that list is a status `canCollect` refuses', () => {
    // The other direction: the default is the screen's job description,
    // not a wider net that drags closed parcels back onto the desk.
    for (const s of awaitingCollectionInDoor()) {
      expect(
        canCollect({ shippingStatus: s, settlementStatus: 'PENDING', daysInTransit: null, late: false }),
        `${s} بالباب و\`canCollect\` بيرفضه`
      ).toBe(true);
    }
  });

  it('and a settled order is not fetched for ever', () => {
    /*
     * `canCollect` wants «سُلّمت ولم تُسوَّ». Without the second half the
     * default would carry every delivered order the shop has ever had, so
     * the list would grow without bound and the 200-row cap would start
     * hiding the parcels that are actually moving.
     */
    expect(door()).toMatch(/settlementStatus: \{ not: 'SETTLED' \}/);
    expect(
      canCollect({ shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED', daysInTransit: null, late: false }),
      'مسوّى ولسّا بيقبل التحصيل'
    ).toBe(false);
  });

  it('and «الكل» still means all', () => {
    // 21/10: the screen sends `every` — `all` is «no filter» to the list hook, which would have dropped it — and the old
    // word `all` still means exactly that, read one level down. Either way the door asks for no state at all.
    expect(door()).toMatch(/status === 'every'\s*\?\s*null/);
    expect(stripComments(repoFile('src/lib/parcel-tracking/filters.ts'))).toMatch(/status === 'all' \? EVERY_STATUS : status/);
  });

  it('and the filter says what it fetches', () => {
    const screen = stripComments(repoFile('src/components/screens/TrackingScreen.tsx'));
    expect(screen, 'الخيار الافتراضي لسّا بيقول «قيد الشحن» بس').toContain(
      'قيد الشحن وبانتظار التحصيل'
    );
  });
});

describe('and a parcel paid for by hand is not «missing from the statement»', () => {
  it('— the sweep skips what is already settled', () => {
    const src = stripComments(repoFile('src/lib/settlement.ts'));
    /*
     * Read inside the sweep's own query, not anywhere in the file: the
     * word SETTLED appears in this module for other reasons.
     */
    const sweep = src.slice(src.indexOf('const delivered = await tx.order.findMany'));
    const query = sweep.slice(0, sweep.indexOf('select:'));
    expect(query, 'الجرد لسّا بيعدّ المحصَّل يدويّاً ناقصاً').toMatch(
      /settlementStatus: \{ not: 'SETTLED' \}/
    );
  });

  it('and the hand-collect door is the thing that makes them SETTLED', () => {
    // The two halves are one fix: this is why the exclusion above is not
    // hiding a real alarm.
    const collect = stripComments(repoFile('src/app/api/ops/tracking/collect/route.ts'));
    expect(collect).toMatch(/data: \{ settlementStatus: 'SETTLED' \}/);
  });
});
