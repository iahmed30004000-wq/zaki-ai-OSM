/**
 * ORDER STATE — one core state machine over the three stored status fields.
 *
 * The repository stores confirmationStatus, shippingStatus and
 * settlementStatus separately (delivery, settlement and collection must stay
 * three separate fields). The CORE state is DERIVED from them, exactly like
 * the zone: deriving keeps one source of truth instead of a fourth column
 * that can drift.
 *
 * Zone is derived from the state — `getZone(state)` — and is never stored.
 */

/**
 * THE CLOSED LIST. Fourteen states, and TWO WERE REMOVED ON 2026-10-02 —
 * written here because an absence explains nothing to the next reader, and
 * because this enum is the contract's own list and a removal from it has to
 * carry its reason.
 *
 * `IN_TRANSFER` — the courier-to-courier move. It EXISTS: `POST
 * /api/ops/tracking/transfer`, rules in `courier-transfer.ts`. It is not a
 * state, and must not be: the original parcel is physically at the first
 * company UNDER THEIR BARCODE and will appear in THEIR statement. Writing
 * `IN_TRANSFER` onto the order means overwriting its provider, which detaches
 * the order from the shipment still holding it — and the statement never
 * matches. The move raises a REPLACEMENT order instead, so each parcel keeps
 * the courier whose statement will settle it. The code also confessed the
 * state had nothing of its own to say: its customer sentence was byte-
 * identical to SHIPPED's.
 *
 * (28/10, «قبل التسليم: نفس الطلب»: that holds only AFTER the company has the
 * parcel. Before the press of «إغلاق الشحنة — سُلّمت للشركة» there is no
 * shipment holding it and no statement to match, so the move is `REBATCH`: the
 * SAME order, the same number, the same reservation, on the new company's
 * trolley. `moveBeforeHandover` in order-cancel.ts.)
 *
 * A TRANSITION REMOVED, and marked here as well as where it was: SHIPPING
 * `READY_FOR_PICKUP → RETURN_REQUESTED` (shipping-workflow.ts). A parcel on our
 * own floor has nothing to return; the transition only made fake returns. The
 * three doors that fit before the handover are cancel, hold and move.
 *
 * `NEEDS_REVIEW` — the review EXISTS, one door earlier and better. A doubtful
 * intake is held as a MESSAGE (`telegram/inbound.ts`, `processingStatus:
 * 'NEEDS_REVIEW'` with a `reviewReason`, its own screen, filters and a retry)
 * and never becomes an order: no order number, no reserved stock, no queue to
 * pollute. That is why `return_to_state` was never built — there is no state
 * to return to, because nothing moved. A second review model inside the order
 * lifecycle would be the same idea twice.
 *
 * Zero orders and zero status-log rows ever held either value; the removal
 * broke no stored data. Guarded in `the-state-invariants.test.ts`.
 */
export const CORE_STATES = [
  'NEW', 'CLAIMED', 'CONFIRMED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED',
  'DELIVERED', 'PARTIALLY_DELIVERED', 'WAITING_RETURN',
  'NO_ANSWER', 'POSTPONED', 'RETURNED', 'CANCELLED', 'VOIDED',
] as const;
export type CoreState = (typeof CORE_STATES)[number];

/** Work zones. Derived from the state, never stored (contract invariant 1). */
export type Zone = 'INTAKE' | 'CONFIRMATION' | 'WAREHOUSE' | 'TRANSIT' | 'CLOSED';

const ZONES: Record<CoreState, Zone> = {
  NEW: 'INTAKE',
  CLAIMED: 'CONFIRMATION',
  NO_ANSWER: 'CONFIRMATION',
  POSTPONED: 'CONFIRMATION',
  CONFIRMED: 'WAREHOUSE',
  PREPARING: 'WAREHOUSE',
  READY_TO_SHIP: 'WAREHOUSE',
  SHIPPED: 'TRANSIT',
  WAITING_RETURN: 'TRANSIT',
  DELIVERED: 'CLOSED',
  PARTIALLY_DELIVERED: 'CLOSED',
  RETURNED: 'CLOSED',
  CANCELLED: 'CLOSED',
  VOIDED: 'CLOSED',
};

export function getZone(state: CoreState): Zone {
  return ZONES[state];
}

/** Shape needed to derive the state — any order row satisfies it. */
export interface StateSource {
  confirmationStatus: string;
  shippingStatus: string;
  claimedById?: string | null;
  shippedAt?: Date | string | null;
  /** When the waybill was printed — the moment the parcel is committed. */
  labelPrintedAt?: Date | string | null;
}

const SHIPPING_TO_CORE: Record<string, CoreState> = {
  PACKING: 'PREPARING',
  READY_FOR_SHIPPING: 'READY_TO_SHIP',
  READY_FOR_PICKUP: 'READY_TO_SHIP',
  SHIPPED: 'SHIPPED',
  OUT_FOR_DELIVERY: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  // A door where some lines were taken and some refused. Without this line it
  // fell through to the confirmation mapping and read as CONFIRMED — a closed,
  // partly-collected order sitting in the warehouse zone waiting to be packed.
  PARTIALLY_DELIVERED: 'PARTIALLY_DELIVERED',
  FAILED_DELIVERY: 'WAITING_RETURN',
  RETURN_REQUESTED: 'WAITING_RETURN',
  RETURNED: 'RETURNED',
  CANCELLED: 'CANCELLED',
};

const CONFIRMATION_TO_CORE: Record<string, CoreState> = {
  NEW: 'NEW',
  IN_PROGRESS: 'CLAIMED',
  NO_ANSWER: 'NO_ANSWER',
  FOLLOW_UP_REQUIRED: 'NO_ANSWER',
  POSTPONED: 'POSTPONED',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'CANCELLED',
  CANCELLED: 'CANCELLED',
};

/** The single core state of an order. Shipping wins once it has started. */
export function deriveCoreState(order: StateSource): CoreState {
  const shipping = SHIPPING_TO_CORE[order.shippingStatus];
  if (shipping && order.shippingStatus !== 'NOT_READY' && order.shippingStatus !== 'CANCELLED') {
    return shipping;
  }
  if (order.shippingStatus === 'CANCELLED') return 'CANCELLED';

  const confirmation = CONFIRMATION_TO_CORE[order.confirmationStatus];
  if (confirmation === 'NEW' && order.claimedById) return 'CLAIMED';
  return confirmation ?? 'NEW';
}

/** Age is time in the CURRENT state; created_at is for reporting only. */
export function stateAgeMinutes(enteredAt: Date | string | null | undefined, now: Date = new Date()): number | null {
  if (!enteredAt) return null;
  const entered = new Date(enteredAt).getTime();
  if (Number.isNaN(entered)) return null;
  return Math.max(0, Math.floor((now.getTime() - entered) / 60_000));
}

// ─────────────────────────────────────────────────────
// Guards — every one of them has a negative test
// ─────────────────────────────────────────────────────

export interface GuardResult {
  allowed: boolean;
  /** Stable code for the API response; never a raw message. */
  code?: 'ALREADY_SHIPPED' | 'CANCEL_AFTER_SHIPPED' | 'UNRESERVED_LINES' | 'NOT_CONFIRMED' | 'IN_BATCH';
  message?: string;
}

/**
 * Shipping states in which the parcel is out of our hands.
 *
 * PARTIALLY_DELIVERED was missing, and it is the state of an order a customer
 * has ALREADY taken part of: the guards below therefore let it be cancelled
 * and voided, which puts goods back on the shelf that are in the customer's
 * hands. The two facts that were supposed to catch it do not: the courier
 * feed writes a status without ever setting shippedAt, and the door-side
 * recorder writes PARTIALLY_DELIVERED directly.
 *
 * Exported because order-seal.ts held its own copy of the same list — the
 * correct one — and two lists for one idea is how this drift happened.
 */
export const SHIPPING_GONE = [
  'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED',
  'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED',
] as const;

const SHIPPED_ONWARDS = new Set<string>(SHIPPING_GONE);

/** Has this order ever left the warehouse? (shippedAt is authoritative) */
/**
 * A cancellation before the goods ever left, told apart from one after.
 *
 * NOT a new state — the contract keeps the core list closed and this is
 * derived from two columns we already have. But the difference is the whole
 * story of the order: cancelled before shipping costs nothing and the units
 * go straight back on the shelf; cancelled after shipping means a parcel is
 * out there, a courier will be paid, and the stock only returns when it is
 * received back through the returns door.
 *
 * A screen that shows both as "ملغى" is hiding the only part anybody needs.
 */
export function cancelledBeforeShipping(order: StateSource): boolean {
  return deriveCoreState(order) === 'CANCELLED' && !hasEverShipped(order);
}

export function hasEverShipped(order: StateSource): boolean {
  return !!order.shippedAt || SHIPPED_ONWARDS.has(order.shippingStatus);
}

/**
 * Is the parcel still ours to take back off the shelf?
 *
 * `hasEverShipped` starts at SHIPPED, but a parcel is packed, labelled and
 * handed to the courier a stage earlier. In that window the order could be
 * cancelled, its reservation dropped, and the units counted as available
 * again — while they were sitting in a van. Once the waybill is printed the
 * goods are committed: they come back through the returns door, counted,
 * or they do not come back at all.
 */
export function hasLeftWarehouse(order: StateSource): boolean {
  return (
    hasEverShipped(order) ||
    !!order.labelPrintedAt ||
    order.shippingStatus === 'READY_FOR_PICKUP'
  );
}

/**
 * THE SAME RULING, ASKED OF THE DATABASE.
 *
 * `hasLeftWarehouse` answers about a row already in hand. A query that
 * needs to FIND the committed orders cannot call it — so the same three
 * facts are rendered as a `where`, here, beside the predicate.
 *
 * Two renderings of one rule is normally the defect this repository keeps
 * finding. It is acceptable only because they are kept together and
 * `a-statement-line-is-a-parcel-that-left.test.ts` proves they agree over
 * EVERY combination of the three inputs — generated, not sampled. The
 * alternative was a hand-written `shippingStatus: { in: [...] }` at the
 * call site, which is a fourth copy of the list and the thing the comment
 * above `SHIPPING_GONE` says caused the original drift.
 *
 * The owner's words, and they settled this line deliberately: «لحظةَ طباعة
 * البوليصة». A labelled parcel on the out-tray is committed.
 *
 * (M6, 28/10: that line is still THE line for stock, VOID, the matcher and
 * printing. It is no longer the line for CANCELLING and POSTPONING, which the
 * owner moved to the press of «إغلاق الشحنة — سُلّمت للشركة» — see
 * `assertCancellable` and `shipment-cancel.ts`.)
 */
/*
 * A FUNCTION, NOT A CONSTANT, AND FOR TWO REASONS.
 *
 * `as const` makes the `OR` array readonly and Prisma's `where` wants a
 * mutable one — so a constant either needs a cast or loses its type. And a
 * module-level object spread into a query is shared mutable state: one
 * caller pushing a condition onto that `OR` changes the rule for every
 * other caller, silently, for the life of the process. A fresh object each
 * call cannot be edited from a distance.
 */
export function leftWarehouseWhere(): {
  OR: ({ shippedAt: { not: null } } | { shippingStatus: { in: string[] } } | { labelPrintedAt: { not: null } } | { shippingStatus: string })[];
} {
  return {
    OR: [
      { shippedAt: { not: null } },
      { shippingStatus: { in: [...SHIPPING_GONE] } },
      { labelPrintedAt: { not: null } },
      { shippingStatus: 'READY_FOR_PICKUP' },
    ],
  };
}

/**
 * THE STRICT, 28/09 READING OF «MAY IT BE CANCELLED» — and no cancel door asks it any more.
 *
 * ── M6 (28/10): THE OWNER MOVED THE LINE FOR CANCEL AND POSTPONE ──
 *
 * The 28/09 ruling was «لحظةَ طباعة البوليصة»: a labelled parcel is committed,
 * and cancelling it was refused. On 28/10 the owner overturned that FOR
 * CANCELLING AND POSTPONING ONLY: «الغاء و التأجيل لغاية ما اضغط اغلاق الشحنة» —
 * both stay possible until the press of «إغلاق الشحنة — سُلّمت للشركة», and
 * after it a cancel is a change request that tells the company.
 *
 * The 28/09 STOCK reason still stands and is kept, as its own question: a
 * labelled parcel, or one on the pickup shelf, is packed under this order's
 * name, so its units go back on the shelf only on a person's word that the box
 * was opened («الطرد بين يديّ — فككتُه وأعدتُ قطعه للرف وأتلفتُ بوليصته»),
 * recorded with their name. That question, and the new line, live in
 * `shipment-cancel.ts` (`cancelVerdict`) and are asked through ONE helper
 * (`order-cancel.ts`, `endOrder`) by every door that cancels. `hasLeftWarehouse`
 * stays the line for stock, VOID, the statement matcher and printing.
 *
 * This function is the old strict reading, kept for readers that mean it. It
 * FAILS CLOSED on a parcel that sits on a trolley: a batched order is refused
 * here whatever its status, because answering «yes» without knowing the
 * trolley's status is exactly how a parcel in a van was once cancelled.
 *
 * (Originally: cancellation after SHIPPED is refused — it becomes a cancel
 * request and ends as RETURNED with a reason, contract invariant 4.)
 */
export function assertCancellable(order: StateSource & { shippingBatchId?: string | null }): GuardResult {
  if (order.shippingBatchId) {
    return {
      allowed: false,
      code: 'IN_BATCH',
      message: 'الطرد داخل دفعة شحن — يُلغى أو يُؤجَّل من شاشة الدفعة قبل «إغلاق الشحنة — سُلّمت للشركة»',
    };
  }
  if (hasLeftWarehouse(order)) {
    return {
      allowed: false,
      code: 'CANCEL_AFTER_SHIPPED',
      message:
        'الطرد سُلّم لشركة الشحن وطُبعت بوليصته — يُسجَّل كطلب إلغاء وتعود بضاعته للمخزون عند استلام المرتجع وعدّه',
    };
  }
  return { allowed: true };
}

/** VOID is refused for any order that has ever reached SHIPPED (invariant 9). */
export function assertVoidable(order: StateSource): GuardResult {
  if (hasLeftWarehouse(order)) {
    return { allowed: false, code: 'ALREADY_SHIPPED', message: 'لا يمكن إبطال طلب سُلّم لشركة الشحن' };
  }
  return { allowed: true };
}

export interface LineReservation {
  quantity: number;
  freeQuantity?: number;
  reservedQty: number;
  /** An add-on the customer took after ordering, not a line — the refusal names it as such. */
  addOn?: boolean;
}

/**
 * READY_TO_SHIP requires every line reserved in full, gift units included:
 * one unreserved line blocks the whole order (contract, inventory section).
 */
export function assertReadyToShip(order: StateSource, lines: LineReservation[]): GuardResult {
  if (order.confirmationStatus !== 'CONFIRMED') {
    return { allowed: false, code: 'NOT_CONFIRMED', message: 'الشحن يتطلب طلباً مؤكداً' };
  }
  if (lines.length === 0) {
    return { allowed: false, code: 'UNRESERVED_LINES', message: 'الطلب بلا أسطر — لا يمكن تجهيزه' };
  }
  const short = lines.filter((l) => l.reservedQty < l.quantity + (l.freeQuantity ?? 0));
  if (short.length > 0) {
    // «سطر» for a line and «إضافة» for what the customer added after ordering — they are two things to the packer.
    const addOns = short.filter((l) => l.addOn).length;
    const lines2 = short.length - addOns;
    const said = [
      ...(lines2 > 0 ? [`${lines2} سطر غير محجوز بالكامل`] : []),
      ...(addOns > 0 ? [`${addOns} إضافة غير محجوزة بالكامل`] : []),
    ].join('، و');
    return {
      allowed: false,
      code: 'UNRESERVED_LINES',
      message: `لا يمكن التجهيز: ${said}`,
    };
  }
  return { allowed: true };
}

// ─────────────────────────────────────────────────────
// Filtering by the state the screens actually show
// ─────────────────────────────────────────────────────

/**
 * The stored rows that derive to a given core state.
 *
 * The orders list showed the derived state in one column and filtered on the
 * legacy `status` column, which the API's own comment admits "drifts from
 * confirmation/shipping status" — so picking CONFIRMED could return orders
 * the same screen was labelling SHIPPED, and miss ones it labelled CONFIRMED.
 *
 * This is deriveCoreState() read backwards, and the test holds the two to
 * each other: every row a clause matches must derive to that state, and no
 * row of that state may be missed.
 */
export function whereForState(state: CoreState): Record<string, unknown> | null {
  // Shipping decides once it has started — anything but NOT_READY/CANCELLED.
  const shippingKeys = Object.entries(SHIPPING_TO_CORE)
    .filter(([key, core]) => core === state && key !== 'CANCELLED')
    .map(([key]) => key);

  const confirmationKeys = Object.entries(CONFIRMATION_TO_CORE)
    .filter(([, core]) => core === state)
    .map(([key]) => key);

  // Shipping has not taken over: NOT_READY, or a value the map never knew.
  const shippingIdle = { shippingStatus: { notIn: Object.keys(SHIPPING_TO_CORE) } };

  const branches: Record<string, unknown>[] = [];

  if (shippingKeys.length) branches.push({ shippingStatus: { in: shippingKeys } });

  if (confirmationKeys.length) {
    // NEW splits on ownership: claimed by someone, it is CLAIMED instead.
    if (state === 'NEW') {
      branches.push({ ...shippingIdle, confirmationStatus: 'NEW', claimedById: null });
    } else if (state === 'CLAIMED') {
      branches.push({
        ...shippingIdle,
        OR: [
          { confirmationStatus: 'IN_PROGRESS' },
          { confirmationStatus: 'NEW', claimedById: { not: null } },
        ],
      });
    } else {
      branches.push({ ...shippingIdle, confirmationStatus: { in: confirmationKeys } });
    }
  }

  if (state === 'CANCELLED') {
    // A cancelled shipment is cancelled whatever the confirmation says.
    branches.push({ shippingStatus: 'CANCELLED' });
  }

  if (state === 'NEW') {
    // An unrecognised confirmation value falls back to NEW in the derivation,
    // so it has to fall back to NEW here too or those orders filter to nothing.
    branches.push({
      ...shippingIdle,
      confirmationStatus: { notIn: Object.keys(CONFIRMATION_TO_CORE) },
      claimedById: null,
    });
  }

  if (!branches.length) return null; // a state nothing can currently be in
  return branches.length === 1 ? branches[0] : { OR: branches };
}

/**
 * WHAT "DELIVERED" AND "CONFIRMED" MEAN IN A NUMBER.
 *
 * whereForState() answers "which orders are in this state NOW", which is
 * what a LIST wants. A rate wants something else, and confusing the two is
 * why the dashboard's delivery rate could pass 100%:
 *
 *   delivered  — the goods reached the customer. A partial delivery counts:
 *                part of the parcel was handed over and paid for. Read from
 *                shippingStatus, never from the legacy merged column, which
 *                neither the courier feed nor the door-side recorder writes.
 *   everConfirmed — the order was confirmed at some point. It stays true
 *                after the warehouse packs it and after the courier delivers
 *                it, so it is the only honest denominator for a delivery
 *                rate. whereForState('CONFIRMED') CANNOT serve this: it
 *                means "confirmed and not yet shipped", which empties as
 *                soon as work progresses.
 *   decided    — confirmed or refused. The denominator of a confirmation
 *                rate: an order still being worked is neither a success nor
 *                a failure, and dividing by every order measures the size of
 *                the queue instead of the quality of the work.
 *
 * A refusal here is a CONFIRMATION refusal only. A delivery that failed or
 * came back is not a moderator refusing to confirm, and counting it as one
 * blames the wrong step.
 */
export const DELIVERED_SHIPPING = ['DELIVERED', 'PARTIALLY_DELIVERED'] as const;
export const CONFIRMATION_REFUSED = ['REJECTED', 'CANCELLED'] as const;

/**
 * THE COURIER GAVE IT BACK.
 *
 * Named here because two files had each written this list by hand and they
 * did not agree: `attribution-performance` counts `RETURNED` and
 * `RETURN_REQUESTED`, and `customer-risk` adds `FAILED_DELIVERY` to them.
 * Both are right for their own question and the difference is deliberate —
 * a person who fails at the door IS the risk even while the parcel is still
 * out with the courier, whereas a shop's return RATE must not count a
 * parcel twice, once as failed and again as returned.
 *
 * So this is the narrow one: the parcel came back. A reader that means the
 * other thing says so in its own words rather than editing this.
 */
export const RETURNED_SHIPPING = ['RETURNED', 'RETURN_REQUESTED'] as const;

/** Prisma clause: the goods reached the customer. */
export const whereDelivered = () => ({ shippingStatus: { in: [...DELIVERED_SHIPPING] } });

/** Prisma clause: the parcel came back. */
export const whereReturned = () => ({ shippingStatus: { in: [...RETURNED_SHIPPING] } });

/** Prisma clause: this order was confirmed, whatever happened to it after. */
export const whereEverConfirmed = () => ({ confirmationStatus: 'CONFIRMED' });

/** Prisma clause: confirmation refused it. */
export const whereConfirmationRefused = () => ({ confirmationStatus: { in: [...CONFIRMATION_REFUSED] } });

/**
 * A percentage, or null when nothing was decided yet.
 *
 * Null rather than zero on purpose: "no orders were decided" and "none of
 * the decided orders succeeded" are different facts, and a screen that
 * prints 0% for the first one is lying about a quiet day.
 */
export function rateOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** The core states an order can actually be in today, for a filter dropdown. */
export const FILTERABLE_STATES: CoreState[] = CORE_STATES.filter((s) => whereForState(s) !== null);

/**
 * ONE WORD PER STATE, AND IT LIVES HERE.
 *
 * There were three copies. This one, a second inside OrderStateBadge with
 * its own colours, and a third in ui/Badge keyed on the LEGACY `status`
 * column. Six of the sixteen states were spelled differently between the
 * first two, so the same order read «مسلَّم» on the orders list and «تم
 * التسليم» on its own detail view, and «قيد التحويل» in one place and «نقل
 * بين شركات» in another. Nobody chose that; each screen chose once.
 */
export const STATE_LABEL_AR: Record<CoreState, string> = {
  NEW: 'جديد',
  CLAIMED: 'قيد التأكيد',
  CONFIRMED: 'مؤكد',
  PREPARING: 'قيد التجهيز',
  READY_TO_SHIP: 'جاهز للشحن',
  SHIPPED: 'مشحون',
  DELIVERED: 'مسلَّم',
  PARTIALLY_DELIVERED: 'مسلَّم جزئياً',
  WAITING_RETURN: 'بانتظار الإرجاع',
  NO_ANSWER: 'لا يرد',
  POSTPONED: 'مؤجل',
  RETURNED: 'مرتجع',
  CANCELLED: 'ملغى',
  VOIDED: 'مُبطَل',
};

/**
 * WHAT EACH STATE MEANS, AS A COLOUR.
 *
 * Beside the word rather than inside a component, because it is the same
 * kind of fact: DELIVERED is good and RETURNED is bad wherever they are
 * drawn, and a screen that decides that for itself is how the orders list
 * came to paint «مشحون» in one colour and the detail view in another.
 *
 * Four tones and no more. There is no informational blue — the action
 * colour is already in the blue family, and a chip painted the same family
 * as a button is a chip people try to press.
 */
export type StateTone = 'neutral' | 'good' | 'warn' | 'bad';

export const STATE_TONE: Record<CoreState, StateTone> = {
  NEW: 'neutral',
  CLAIMED: 'neutral',
  CONFIRMED: 'good',
  PREPARING: 'neutral',
  READY_TO_SHIP: 'neutral',
  SHIPPED: 'neutral',
  DELIVERED: 'good',
  // Some of it came back. That is not a failure and not a success.
  PARTIALLY_DELIVERED: 'warn',
  WAITING_RETURN: 'warn',
  NO_ANSWER: 'warn',
  POSTPONED: 'warn',
  RETURNED: 'bad',
  CANCELLED: 'bad',
  VOIDED: 'bad',
};
