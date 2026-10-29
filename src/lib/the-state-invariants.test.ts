import { describe, expect, it } from 'vitest';
import {
  CORE_STATES, getZone, assertCancellable, assertVoidable,
  STATE_LABEL_AR, STATE_TONE,
} from './order-state';
import { CUSTOMER_STATE } from './order-tracking';
import { CLAIM_CAPS } from './confirmation-queue';
import { repoFile, stripComments } from './guard-source';

/**
 * تشطيب ١ — STAGE 1: THE COMMITMENTS LEDGER, the order state machine.
 *
 * The contract's nine numbered invariants, each verified against the code
 * with the evidence the brief demands. Seven hold. Two were delivered
 * differently from what was committed, and those are pinned AS THEY ARE and
 * reported — «A DIVERGED or CONFLICT item is reported, not resolved.»
 */

describe('1 · zone is derived, never stored', () => {
  it('no column in the schema carries it', () => {
    const schema = repoFile('prisma/schema.prisma');
    // `timezone` is the only thing in this file with those letters in it.
    const hits = [...schema.matchAll(/\bzone\b/gi)].filter((m) => {
      const around = schema.slice(Math.max(0, m.index! - 4), m.index! + 5);
      return !/timezone/i.test(around);
    });
    expect(hits, 'عمودٌ يخزّن المنطقة').toEqual([]);
  });

  it('and every core state maps to one', () => {
    for (const s of CORE_STATES) expect(getZone(s), s).toBeTruthy();
  });
});

describe('3 · the reservation is released in the SAME transaction', () => {
  /** Doors that release for themselves. */
  const OWN = [
    'src/app/api/confirmation/issues/[id]/route.ts',
    'src/app/api/ops/shipments/hold/route.ts',
  ];
  /**
   * Doors that END an order. They used to release for themselves, five different
   * ways (and the shipping screen's CANCELLED not at all). They go through ONE
   * helper now, `endOrder`, which releases inside its own transaction — so what
   * is asserted is that each of them calls it, and that the helper passes `tx`.
   */
  const THROUGH_THE_HELPER = [
    'src/app/api/orders/[id]/route.ts',
    'src/app/api/orders/[id]/confirmation/route.ts',
    'src/app/api/orders/[id]/contact-attempts/route.ts',
    'src/app/api/orders/[id]/shipping/route.ts',
    'src/app/api/ops/shipments/stand-down/route.ts',
  ];

  it.each(OWN)('%s releases, and passes a transaction', (door) => {
    const src = stripComments(repoFile(door));
    // `tx` and not `db`: a release outside the transaction that cancels the
    // order can commit while the cancel rolls back, and the stock is freed
    // for an order that still exists.
    expect(src).toMatch(/releaseOrderLines\(tx,/);
  });

  it.each(THROUGH_THE_HELPER)('%s ends an order through the one helper', (door) => {
    expect(stripComments(repoFile(door))).toMatch(/endOrder\(\{/);
  });

  it('and the helper releases inside the transaction it writes the ending in', () => {
    const src = stripComments(repoFile('src/lib/order-cancel.ts'));
    expect(src).toMatch(/releaseOrderLines\(tx,/);
  });

  it('and the owner says so in its own words', () => {
    const res = repoFile('src/lib/reservation.ts');
    expect(res).toMatch(/MUST run in the same transaction/);
  });
});

describe('4 · no cancellation after the parcel has left', () => {
  it('is refused, with the reason and what happens instead', () => {
    const shipped = { shippingStatus: 'IN_TRANSIT', shippedAt: new Date(), confirmationStatus: 'CONFIRMED', status: 'PROCESSING' } as never;
    const verdict = assertCancellable(shipped);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(verdict.message).toMatch(/طلب إلغاء/);
  });
});

describe('5 · a partial delivery carries the FULL delivery fee', () => {
  it('because the courier travelled', () => {
    const partial = repoFile('src/lib/partial-delivery.ts');
    expect(partial).toMatch(/the delivery fee is charged IN FULL/);
    // The arithmetic moved on 2026-10-02: the door calls `doorMoney` in
    // `settlement.ts`, which is the settlement matcher's own rule, so there
    // is no second copy of the fee rule to drift. Pinned where it lives.
    expect(stripComments(partial)).toMatch(/const money = doorMoney\(/);
    const src = stripComments(repoFile('src/lib/settlement.ts'));
    expect(src).toMatch(/roundMinor\(Number\(order\.deliveryFee \?\? 0\), minorUnit\)/);
    // In full whatever was taken, and zero only when nothing was.
    expect(src).toMatch(/deliveryFee: anythingTaken \? fee : 0,/);
  });
});

describe('8 · the claim caps', () => {
  it('are 40 without an attempt and 120 in all', () => {
    expect(CLAIM_CAPS.withoutAttempt).toBe(40);
    expect(CLAIM_CAPS.total).toBe(120);
  });
});

describe('9 · VOID is refused for anything that ever shipped', () => {
  it('and says which', () => {
    const shipped = { shippingStatus: 'DELIVERED', shippedAt: new Date(), confirmationStatus: 'CONFIRMED', status: 'PROCESSING' } as never;
    const v = assertVoidable(shipped);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('ALREADY_SHIPPED');
  });

  it('and allows it while the goods are still here', () => {
    const fresh = { shippingStatus: 'NOT_READY', shippedAt: null, confirmationStatus: 'NEW', status: 'NEW' } as never;
    expect(assertVoidable(fresh).allowed).toBe(true);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 2 and 6 — RESOLVED ON 2026-10-02. Both states left `CORE_STATES`.
 *
 * They were the same defect twice: a state declared in the contract's closed
 * list that no order could enter, carrying a zone, a label, a tone and a
 * sentence addressed to a customer. Each one's work is done elsewhere, and
 * done better:
 *
 *   · `NEEDS_REVIEW` — doubt is held at the INTAKE door as a MESSAGE, before
 *     an order exists. So there was never a state to return to, which is why
 *     `return_to_state` was never built.
 *   · `IN_TRANSFER` — the move raises a REPLACEMENT order, so each parcel
 *     keeps the courier whose statement will settle it.
 *
 * These guards keep them out. Re-adding either by reflex — because the
 * contract's old wording named it — fails here with the reason.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('2 and 6 · the two dead states stay out', () => {
  it.each(['NEEDS_REVIEW', 'IN_TRANSFER'])('%s is not a core state', (dead) => {
    expect(CORE_STATES as readonly string[]).not.toContain(dead);
  });

  it('and no map, label, tone or customer sentence mentions either', () => {
    for (const f of ['src/lib/order-state.ts', 'src/lib/order-tracking.ts']) {
      // The removal's REASON is written in `order-state.ts` and must stay
      // readable, so the sweep is over code with the comments taken out.
      expect(stripComments(repoFile(f)), f).not.toMatch(/NEEDS_REVIEW|IN_TRANSFER/);
    }
  });

  it('and every remaining state still has a zone, a label, a tone and a sentence', () => {
    // The real risk of deleting from a closed enum is an entry left behind in
    // one of the four exhaustive maps. The compiler catches a missing key;
    // this catches a stale one, which it does not.
    expect(CORE_STATES.length).toBe(14);
    for (const s of CORE_STATES) {
      expect(getZone(s), s).toBeTruthy();
      expect(STATE_LABEL_AR[s], s).toBeTruthy();
      expect(STATE_TONE[s], s).toBeTruthy();
      expect(CUSTOMER_STATE[s]?.ar, s).toBeTruthy();
    }
    // `ZONES` is private, and deliberately: `getZone` is the only way in.
    // Its staleness is covered by the sweep above, which refuses either dead
    // name anywhere in the file's code.
    for (const map of [STATE_LABEL_AR, STATE_TONE, CUSTOMER_STATE]) {
      expect(Object.keys(map).sort()).toEqual([...CORE_STATES].sort());
    }
  });

  it('and the review that replaced NEEDS_REVIEW is real, at the intake door', () => {
    const inbound = stripComments(repoFile('src/lib/telegram/inbound.ts'));
    expect(inbound).toMatch(/processingStatus: 'NEEDS_REVIEW', reviewReason: reason/);
  });

  it('and the move that replaced IN_TRANSFER is real, raising a replacement', () => {
    const route = repoFile('src/app/api/ops/tracking/transfer/route.ts');
    expect(route).toMatch(/a REPLACEMENT order/);
    expect(stripComments(route)).toMatch(/createReplacement\(/);
  });

  it('and `return_to_state` is still nowhere, because nothing needs it', () => {
    expect(repoFile('prisma/schema.prisma')).not.toMatch(/return_to_state|returnToState/);
  });

  it('and the REASON for the removal is written beside the enum', () => {
    // An absence explains nothing. Without this, the next reader finds two
    // states missing from the contract's list and puts them back.
    const src = repoFile('src/lib/order-state.ts');
    const head = src.slice(0, src.indexOf('export const CORE_STATES'));
    expect(head).toMatch(/REMOVED ON 2026-10-02/);
    expect(head).toMatch(/IN_TRANSFER/);
    expect(head).toMatch(/NEEDS_REVIEW/);
    // The two reasons that matter, each in its own words: the statement that
    // settles the parcel, and the door where doubt is held.
    expect(head).toMatch(/THEIR STATEMENT|THEIR statement/);
    expect(head).toMatch(/never becomes an order/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 7 · «A blocking change request stops OUR forward transitions only. Courier
 * webhook events are always recorded, and flag the pending request as
 * "changed during review".»
 *
 * This invariant had never been verified. Its first half was built; its
 * second half was a column — `changedDuringReview` — that nothing in `src`
 * wrote, so a reviewer decided on an order the courier had already carried
 * past her. Built on 2026-10-02 in the ONE door both feeds pass through.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('7 · a change request stops US, and the feed tells on itself', () => {
  it('our own forward transitions are refused while a blocking request is pending', () => {
    const src = stripComments(repoFile('src/app/api/orders/[id]/shipping/route.ts'));
    // The query, not merely the word: a guard that reads the request without
    // requiring `blocking: true` would stop the warehouse on an edit raised
    // for information.
    expect(src).toMatch(/status: 'PENDING', blocking: true/);
    expect(src).toMatch(/code: 'CHANGE_REQUEST_PENDING'/);
    // And only forward. A return or a cancellation must never be blocked by
    // a request asking to change the thing that is coming back.
    const list = src.slice(src.indexOf('const FORWARD = ['));
    const forward = list.slice(0, list.indexOf(']'));
    for (const back of ['RETURNED', 'FAILED_DELIVERY', 'CANCELLED', 'RETURN_REQUESTED']) {
      expect(forward, back).not.toContain(back);
    }
  });

  it('and a courier feed is never blocked by one — it flags it instead', () => {
    const apply = stripComments(repoFile('src/lib/couriers/apply-event.ts'));
    // No read of a change request as a GATE anywhere in the feed's path.
    expect(apply).not.toMatch(/orderChangeRequest\.find/);
    expect(apply).toMatch(/changedDuringReview: true/);
  });

  it('and the flag is written in the SAME transaction as the move', () => {
    // Outside it, a webhook that moved the parcel and then failed would
    // leave the request flagged about a move that never happened.
    const apply = stripComments(repoFile('src/lib/couriers/apply-event.ts'));
    const tx = apply.slice(apply.indexOf('db.$transaction'));
    const body = tx.slice(0, tx.indexOf('\n  });'));
    expect(body).toMatch(/order\.update/);
    expect(body).toMatch(/orderChangeRequest\.updateMany/);
  });

  it('and it reaches the person deciding, which is the whole point', () => {
    /*
     * A flag no human sees is the defect this same file deleted two states
     * for. The EVIDENCE is a render test — `ChangeRequestsScreen.test.tsx`
     * mounts the queue and reads the chip off the screen — because a source
     * match for `r.changedDuringReview` is satisfied by
     * `{false && r.changedDuringReview && …}`: the name present, the chip
     * gone. That mutation was MISSED here, and caught there.
     *
     * What is left here is the cheap half: the sentence, and the render test
     * still existing to do the real work.
     */
    const screen = repoFile('src/components/screens/ChangeRequestsScreen.tsx');
    expect(screen).toMatch(/تغيّرت حالة الطلب أثناء المراجعة/);
    const proof = repoFile('src/components/screens/ChangeRequestsScreen.test.tsx');
    expect(proof).toMatch(/findByText\(FLAG\)/);
  });
});
