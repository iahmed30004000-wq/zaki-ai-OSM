import { describe, expect, it } from 'vitest';
import { carryOut, missingFor, refusalFor, CHANGE_INTENTS } from './change-request-intent';
import { authorises, expandApproved } from './change-request-apply';
import { repoFile, stripComments } from './guard-source';

/**
 * THREE ASKS, ONE DOOR.
 *
 * The agent's «ألغِ» and «تأجيل» buttons live on the queue screen and are
 * gone the moment she presses «تأكيد». After that, cancelling needs
 * `orders.unlock` and holding a shipment back needs `ops.ship`, and she has
 * neither — measured on this company: `control.change_requests` is held by
 * MANAGER, COMPANY_ADMIN, DELIVERY_MANAGER and CONFIRMATION_SUPERVISOR,
 * `orders.unlock` by only the first two plus SUPER_ADMIN.
 *
 * So two of the four people the queue addresses could approve a
 * cancellation and then not carry it out. That is what `authorises` is for,
 * and these are the four ways it must still refuse.
 */

/*
 * (old → new, M6 28/10) These two constants said `hasLeftWarehouse` — the printed
 * waybill. The owner moved the line for cancelling and postponing to the press
 * of «إغلاق الشحنة — سُلّمت للشركة», so the parcel's position is now whether
 * the courier has TAKEN it. `packedButOurs` is the case the move exists for.
 */
const ours = { handedToCourier: false };
const gone = { handedToCourier: true };
const packedButOurs = ours; // labelled, on the pickup shelf, on a trolley not yet pressed: still ours

describe('what an approved ask becomes', () => {
  it('an edit is the edit path, wherever the parcel is', () => {
    expect(carryOut('EDIT', ours)).toEqual({ kind: 'EDIT_ORDER' });
    expect(carryOut('EDIT', gone)).toEqual({ kind: 'EDIT_ORDER' });
  });

  it('a cancellation before the handover cancels; after it, the courier is told', () => {
    expect(carryOut('CANCEL', ours)).toEqual({ kind: 'CANCEL_ORDER' });
    expect(carryOut('CANCEL', gone)).toEqual({ kind: 'CANCEL_VIA_COURIER' });
  });

  it('a labelled parcel still on our open trolley is cancelled and held, never sent to the courier message', () => {
    // The waybill is not the line any more — the press is.
    expect(carryOut('CANCEL', packedButOurs)).toEqual({ kind: 'CANCEL_ORDER' });
    expect(carryOut('POSTPONE', packedButOurs)).toEqual({ kind: 'HOLD_SHIPMENT' });
  });

  /**
   * The one ask that can never be carried out. Answering «مؤجَّل» while the
   * driver knocks tomorrow is a date on a screen and nothing else, so it is
   * refused at the door rather than two hours later in a queue.
   */
  it('and a parcel the courier has taken cannot be postponed', () => {
    expect(carryOut('POSTPONE', ours)).toEqual({ kind: 'HOLD_SHIPMENT' });
    const out = carryOut('POSTPONE', gone);
    expect(out.kind).toBe('REFUSED');
    // The refusal names the door that IS open — she is asking for a
    // cancellation whether or not she used the word.
    expect(out.kind === 'REFUSED' && out.reason).toMatch(/الإلغاء/);
    expect(refusalFor('POSTPONE', gone)).toBeTruthy();
    expect(refusalFor('POSTPONE', ours)).toBeNull();
    expect(refusalFor('CANCEL', gone)).toBeNull();
  });
});

describe('what each ask must carry', () => {
  it('an edit needs a field, and an empty change set is not one', () => {
    expect(missingFor('EDIT', { changes: {} })).toBeTruthy();
    expect(missingFor('EDIT', {})).toBeTruthy();
    expect(missingFor('EDIT', { changes: { quantity: { to: 3 } } })).toBeNull();
  });

  it('a postponement needs its date', () => {
    expect(missingFor('POSTPONE', {})).toBeTruthy();
    expect(missingFor('POSTPONE', { postponeUntil: '2026-10-05T10:00:00.000Z' })).toBeNull();
  });

  /** A cancellation is its reason, and the reason is demanded of all three. */
  it('and a cancellation needs neither', () => {
    expect(missingFor('CANCEL', {})).toBeNull();
  });
});

describe('an approved request as authority', () => {
  const approved = {
    orderId: 'order-1',
    status: 'APPROVED',
    appliedAt: null,
    intent: 'CANCEL',
  };

  it('lets the decided ask through', () => {
    expect(authorises(approved, 'CANCEL', 'order-1')).toEqual({ ok: true });
  });

  it('refuses another order', () => {
    const v = authorises(approved, 'CANCEL', 'order-2');
    expect(v.ok).toBe(false);
    expect(!v.ok && v.code).toBe('WRONG_ORDER');
  });

  /**
   * The whole point. Without this, an approved CANCEL would authorise a
   * POSTPONE — «approved to cancel» becoming a way to hold an order for a
   * month with its stock reserved.
   */
  it('refuses a different ask than the one decided', () => {
    const v = authorises(approved, 'POSTPONE', 'order-1');
    expect(v.ok).toBe(false);
    expect(!v.ok && v.code).toBe('WRONG_INTENT');
  });

  it('refuses one nobody has decided', () => {
    const v = authorises({ ...approved, status: 'PENDING' }, 'CANCEL', 'order-1');
    expect(v.ok).toBe(false);
    expect(!v.ok && v.code).toBe('NOT_APPROVED');
  });

  it('and refuses a second carry-out of the same decision', () => {
    const v = authorises({ ...approved, appliedAt: new Date() }, 'CANCEL', 'order-1');
    expect(v.ok).toBe(false);
    expect(!v.ok && v.code).toBe('ALREADY_APPLIED');
  });

  /** A row written before the column existed is an edit, and says so. */
  it('and reads a request with no intent as an edit', () => {
    expect(authorises({ ...approved, intent: null }, 'EDIT', 'order-1')).toEqual({ ok: true });
    expect(authorises({ ...approved, intent: undefined }, 'CANCEL', 'order-1').ok).toBe(false);
  });
});

describe('the edit path stays the edit path', () => {
  /**
   * A cancellation carries no fields, so without an intent check it fell
   * out the far end as «لا حقول في طلب التعديل لتطبيقها» — true, and no
   * help at all to somebody looking for the button that does work.
   */
  it('refuses a cancellation with the reason, not with «no fields»', () => {
    const v = expandApproved({
      id: 'r1', orderId: 'o1', status: 'APPROVED', appliedAt: null,
      changes: {}, intent: 'CANCEL',
    });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.code).toBe('WRONG_INTENT');
  });

  it('and still applies an edit', () => {
    const v = expandApproved({
      id: 'r1', orderId: 'o1', status: 'APPROVED', appliedAt: null,
      changes: { quantity: { to: 3 } }, intent: 'EDIT',
    });
    expect(v.ok && v.fields).toEqual({ quantity: 3 });
  });
});

/**
 * THE WIRING, read from the files themselves.
 *
 * Each of these was a way for the feature to be present and useless: a
 * cancellation that silently took its reason from the browser, a second
 * copy of the raiser on the order screen, a stand-down that stopped asking
 * for `ops.ship`.
 */
describe('the wiring', () => {
  const standDown = () => stripComments(repoFile('src/app/api/ops/shipments/stand-down/route.ts'));

  it('takes the date and the reason from the approved request, not the body', () => {
    const src = standDown();
    // Anchored on the ASSIGNMENT, both of them: naming the fields loosely
    // passed while the body's own values were still the ones used.
    expect(src).toMatch(/if \(viaRequest\) \{[\s\S]{0,400}until = viaRequest\.postponeUntil/);
    expect(src).toMatch(/reason = viaRequest\.cancelReason/);
    // And the body's values are what the assignment overwrites — `until`
    // and `reason` are re-bindable for exactly this.
    expect(src).toMatch(/let \{ until, reason \} = parsed\.data/);
  });

  it('and without a request it still demands ops.ship', () => {
    const src = standDown();
    expect(src).toMatch(/\} else \{\s*await requirePermission\('ops\.ship'\);\s*\}/);
  });

  it('and the ask it authorises is the one being carried out', () => {
    // Not a bare `authorises(request, ...)` with a constant: the outcome
    // being performed is what must be checked, or an approved POSTPONE
    // would carry out a CANCEL.
    expect(standDown()).toMatch(/authorises\(request, outcome === 'CANCEL' \? 'CANCEL' : 'POSTPONE', orderId\)/);
  });

  it('and the raiser is written once, read by both screens', () => {
    for (const f of [
      'src/components/screens/ConfirmationMineScreen.tsx',
      'src/components/orders/OrderDetailModal.tsx',
    ]) {
      const src = stripComments(repoFile(f));
      expect(src, `${f} يرفع الطلب بنفسه`).toMatch(/raiseChangeRequest\(/);
      // The POST belongs to the raiser alone; a screen building its own body
      // is the copy that drifts.
      expect(src, `${f} يبني الطلب بنفسه`).not.toMatch(/\/change-requests`/);
    }
  });

  it('and the order screen is where a dispatched order can be reached at all', () => {
    const src = stripComments(repoFile('src/components/orders/OrderDetailModal.tsx'));
    // The card is drawn for a confirmed order, and it carries the dialog
    // with the parcel's position — not a link that opens an edit form the
    // seal will refuse.
    expect(src).toMatch(/order\.confirmationStatus === 'CONFIRMED' && \(/);
    // (old → new, M6) The dialog was told `hasLeftWarehouse` (the printed waybill);
    // it is told whether the courier has TAKEN the parcel.
    expect(src).toMatch(/handedToCourier=\{handedOver\}/);
    expect(src).toMatch(/const handedOver = handedToCourier\(\{/);
  });

  it('and the door offers every intent there is', () => {
    const src = stripComments(repoFile('src/components/screens/confirmation/ActionDialogs.tsx'));
    // Mapped over the list, so a fourth ask cannot be added to the type and
    // left out of the screen.
    expect(src).toMatch(/CHANGE_INTENTS\.map\(/);
    // And an impossible one is disabled with its sentence, not hidden.
    expect(src).toMatch(/disabled=\{!!blocked\}/);
    expect(src).toMatch(/title=\{blocked \?\? undefined\}/);
    expect(CHANGE_INTENTS).toEqual(['EDIT', 'CANCEL', 'POSTPONE']);
  });

  it('and the queue names the act on its button', () => {
    const src = stripComments(repoFile('src/components/screens/ChangeRequestsScreen.tsx'));
    // ON THE BUTTON, not merely somewhere in the file. The confirmation
    // dialog names the act too, and asserting the lookup loosely passed
    // while the button itself had gone back to «طبّق التعديل على الطلب»
    // above every cancellation in the queue.
    expect(src).toMatch(
      /\{applying === r\.id && <RiLoader4Line[^>]*\/>\}\s*\{CARRY_LABEL\[r\.carryOut\?\.kind\][^}]*\}\s*<\/button>/
    );
    // And in the question that is asked before it.
    expect(src).toMatch(/title: `\$\{CARRY_LABEL\[r\.carryOut\?\.kind\]/);
    for (const kind of ['EDIT_ORDER', 'CANCEL_ORDER', 'CANCEL_VIA_COURIER', 'HOLD_SHIPMENT']) {
      expect(src, `${kind} بلا عبارة على الزر`).toContain(kind);
    }
  });

  /**
   * ONE LINE, FOUR GATES.
   *
   * (old → new, M6 28/10) This held that the three asks read «the waybill, not
   * the handover» — `hasLeftWarehouse` — the 28/09 ruling. The owner overturned
   * it for CANCEL and POSTPONE only: «الغاء و التأجيل لغاية ما اضغط اغلاق
   * الشحنة». The line is now the press of «إغلاق الشحنة — سُلّمت للشركة», and the
   * 28/09 reason survives where it was always about STOCK (`shipment-cancel`,
   * `warehouse-custody.test.ts`).
   *
   * What this holds is unchanged in spirit: the asks all ASK THE SAME FUNCTION.
   * Four places decide it — the door that offers the buttons, the route that
   * accepts a request, the queue that names the act, and the card on the
   * order — and four copies of «has it gone?» is four places for the line to
   * drift, one at a time, until the door offers a postponement the route
   * refuses.
   */
  it('and every gate reads the same line, the handover one', () => {
    for (const f of [
      'src/app/api/orders/[id]/change-requests/route.ts',
      'src/app/api/control/change-requests/route.ts',
      'src/components/orders/OrderDetailModal.tsx',
    ]) {
      const src = stripComments(repoFile(f));
      expect(src, `${f} لا يسأل الخطَّ نفسه`).toMatch(/handedToCourier\(/);
      // Not the 28/09 line, and not the later one. `hasLeftWarehouse` starts at
      // the printed waybill and would refuse a cancel the owner allowed;
      // `hasEverShipped` starts at SHIPPED and would let a pressed trolley's
      // parcel be cancelled by a status.
      //
      // The NAME anywhere in the file, not a call site: an import under another
      // name moves the line while every call still reads correctly.
      expect(src, `${f} يستعمل خطَّ البوليصة لا خطَّ التسليم`).not.toMatch(/hasLeftWarehouse|hasEverShipped/);
    }
  });

  it('and the trolley’s status reaches each of them — a gate that cannot see the press cannot draw its line', () => {
    // The control queue reads the trolley with the order; the create door reads
    // it before it answers; the order window is handed it by the GET.
    expect(stripComments(repoFile('src/app/api/control/change-requests/route.ts'))).toMatch(/shippingBatch: \{ select: \{ status: true \} \}/);
    expect(stripComments(repoFile('src/app/api/orders/[id]/change-requests/route.ts'))).toMatch(/batchStatus: batch\?\.status \?\? null/);
    expect(stripComments(repoFile('src/app/api/orders/[id]/route.ts'))).toMatch(/shippingBatch: \{ select: \{ id: true, batchNumber: true, status: true \} \}/);
  });

  it('and the order screen is actually told the waybill was printed', () => {
    // The screen computes the line from the order it was handed. A GET
    // that did not return `labelPrintedAt` would make it read false in
    // silence, and the door would offer a postponement on a labelled
    // parcel for the route to refuse a moment later — the fail-late this
    // whole design is against. `include` returns every scalar; a `select`
    // added here later would not.
    const src = stripComments(repoFile('src/app/api/orders/[id]/route.ts'));
    const get = src.slice(src.indexOf('export async function GET'));
    // From 1, or indexOf finds the GET's own header and hands back an
    // empty string — on which the negative assertion below passes for
    // saying nothing at all.
    const end = get.indexOf('export async function', 1);
    const body = end > 0 ? get.slice(0, end) : get;
    expect(body.length, 'القصُّ أخطأ موضعه').toBeGreaterThan(200);
    // THE ORDER QUERY ITSELF, not any `include:` in the file — the nested
    // relations carry several of their own, and matching those passed
    // while the top-level query had been narrowed to a column list that
    // leaves out the waybill date.
    expect(body, 'GET يختار أعمدةً بعينها ولم يعد يشمل تاريخَ البوليصة').toMatch(
      /db\.order\.find(Unique|First)\(\{\s*where: \{ id \},\s*include: \{/
    );
  });

  it('and the queue sends a cancellation to the door that cancels', () => {
    const src = stripComments(repoFile('src/components/screens/ChangeRequestsScreen.tsx'));
    // The edit endpoint answers a cancellation with «لا حقول لتطبيقها».
    expect(src).toMatch(/if \(intent === 'EDIT'\) \{\s*await send\(r, false\);/);
    expect(src).toMatch(/await standDown\(r, intent\)/);
    expect(src).toMatch(/'\/api\/ops\/shipments\/stand-down'/);
  });
});
