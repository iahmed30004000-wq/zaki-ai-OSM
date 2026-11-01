import { deriveCoreState, getZone, type StateSource, type Zone } from './order-state';

/**
 * AN ORDER'S JOURNEY, AS FIVE STAGES.
 *
 * The stages are the contract's own work zones — intake, confirmation,
 * warehouse, transit, closed — not a sixth vocabulary invented for a screen.
 * A stage is reached when the order's own timestamps say it was reached, so
 * this is derived exactly like the state and the zone are: nothing here is
 * stored, and nothing can drift out of step with the order.
 *
 * A passed stage is a record of something that happened. It carries the
 * moment and the person, and it is never editable — correcting history by
 * overwriting it is how a system stops being able to answer "what happened".
 */

export type StageKey = 'INTAKE' | 'CONFIRMATION' | 'WAREHOUSE' | 'TRANSIT' | 'CLOSED';
export type StageStatus = 'DONE' | 'CURRENT' | 'PENDING' | 'SKIPPED';

export interface StageFact {
  label: string;
  value: string;
}

export interface Stage {
  key: StageKey;
  title: string;
  status: StageStatus;
  /** When this stage was entered, if it was. */
  at: Date | null;
  who: string | null;
  facts: StageFact[];
  /**
   * How long the order sat in this stage, in minutes.
   *
   * A finished stage is measured to the moment the next one began; the stage
   * an order is in NOW is measured to this moment, because "three days in
   * confirmation" is the number worth seeing while it is still three days
   * and not after it became a week.
   *
   * Null when the stage was never entered — a duration of zero would read as
   * "instant" for something that never happened.
   */
  minutes: number | null;
  /** True when `minutes` is still running. */
  ongoing: boolean;
}

/** The order of the journey. A stage is DONE once a later one has begun. */
const ORDER: StageKey[] = ['INTAKE', 'CONFIRMATION', 'WAREHOUSE', 'TRANSIT', 'CLOSED'];

const TITLES: Record<StageKey, string> = {
  INTAKE: 'الإدخال',
  CONFIRMATION: 'التأكيد',
  WAREHOUSE: 'التجهيز',
  TRANSIT: 'الشحن',
  CLOSED: 'الإغلاق',
};

/** A zone maps onto the stage of the same name; VOIDED closes the journey. */
function stageOfZone(zone: Zone): StageKey {
  return zone as StageKey;
}

export interface StageSource extends StateSource {
  createdAt: Date | string;
  claimedAt?: Date | string | null;
  confirmedAt?: Date | string | null;
  outForDeliveryAt?: Date | string | null;
  deliveredAt?: Date | string | null;
  returnedAt?: Date | string | null;
  failedAt?: Date | string | null;
  source?: string | null;
  moderator?: { name: string } | null;
  claimer?: { name: string } | null;
  /** Who gave the yes (`Order.confirmedById`) — an order can be confirmed without anybody having claimed it. */
  confirmer?: { name: string } | null;
  deliveryProvider?: { name: string } | null;
  trackingNumber?: string | null;
  quantity?: number;
  collectedAmount?: number | string | null;
}

const date = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The five stages for one order.
 *
 * `contactAttempts` and `deliveryAttempts` are counts the caller already has;
 * they are facts of their stage rather than a reason to query again here.
 */
/** Minutes between two moments, never negative — clocks and imports disagree. */
function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}

/**
 * "٣ أيام و٤ ساعات" — a duration a person reads, not a number they divide.
 *
 * Deliberately two units at most. "4 days, 3 hours, 12 minutes" is three
 * facts where one was asked for, and the minutes stop mattering the moment
 * the days appear.
 */
export function humanMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 1) return 'أقل من دقيقة';
  if (minutes < 60) return `${minutes} دقيقة`;

  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  if (hours < 24) return restMin ? `${hours} ساعة و${restMin} دقيقة` : `${hours} ساعة`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} يوم و${restHours} ساعة` : `${days} يوم`;
}

export function orderStages(
  order: StageSource,
  counts: { contactAttempts?: number; deliveryAttempts?: number } = {},
  now: Date = new Date()
): Stage[] {
  const state = deriveCoreState(order);
  const currentStage = state === 'VOIDED' ? 'CLOSED' : stageOfZone(getZone(state));
  const currentIndex = ORDER.indexOf(currentStage);

  const claimedAt = date(order.claimedAt);
  const confirmedAt = date(order.confirmedAt);
  const shippedAt = date(order.shippedAt as Date | string | null);
  const deliveredAt = date(order.deliveredAt);
  const returnedAt = date(order.returnedAt);

  /**
   * Was the order in somebody's hands when the yes was given? A claim AFTER the yes (a transfer, or the owner's «استلمه أنا» to repair an
   * order that was decided with nobody holding it) must not move the confirmation stage to after the stage that follows it: the first
   * version read `claimedAt ?? confirmedAt`, so the intake showed 76 minutes instead of 2 and the confirmation began after the warehouse
   * did (the independent review, 1/11).
   */
  const heldAtTheYes = Boolean(claimedAt && (!confirmedAt || claimedAt.getTime() <= confirmedAt.getTime()));

  /** When each stage began, as far as the order's own record shows. */
  const enteredAt: Record<StageKey, Date | null> = {
    INTAKE: date(order.createdAt),
    /*
     * The confirmation stage began when somebody CLAIMED the order — or, for an order that was decided with nobody holding it (an agent
     * pressed «تأكيد» from the orders list: ORD-2026-1896, the owner, 1/11), at the yes itself. It was `claimedAt` alone, so such an
     * order read «التأكيد: لم يمر بها» in the same card that said «محاولات التواصل: 1 · أُكِّد: نعم».
     */
    CONFIRMATION: heldAtTheYes ? claimedAt : (confirmedAt ?? claimedAt),
    // Confirmation is what releases an order to the warehouse.
    WAREHOUSE: confirmedAt,
    TRANSIT: shippedAt,
    CLOSED: deliveredAt ?? returnedAt ?? date(order.failedAt),
  };

  /**
   * When each stage ENDED: the moment the next stage that actually happened
   * began. A skipped stage in between must not swallow the time — an order
   * that went from confirmation straight to transit spent that time in the
   * warehouse stage whether or not anyone stamped it.
   */
  const endedAt = (index: number): Date | null => {
    for (let i = index + 1; i < ORDER.length; i++) {
      const next = enteredAt[ORDER[i]];
      if (next) return next;
    }
    return null;
  };

  return ORDER.map((key, index) => {
    let status: StageStatus;
    if (index < currentIndex) {
      // Passed. A stage the order went through without leaving a timestamp
      // was passed over rather than worked — say so instead of inventing one.
      status = enteredAt[key] ? 'DONE' : 'SKIPPED';
    } else if (index === currentIndex) {
      status = 'CURRENT';
    } else {
      status = 'PENDING';
    }

    const facts: StageFact[] = [];
    let who: string | null = null;

    switch (key) {
      case 'INTAKE':
        who = order.moderator?.name ?? null;
        if (order.source) facts.push({ label: 'القناة', value: order.source });
        if (order.quantity) facts.push({ label: 'الكمية', value: String(order.quantity) });
        break;

      case 'CONFIRMATION':
        // Held when the yes was given: the holder. Decided with nobody holding it, or taken only afterwards: the one who gave the yes.
        who = (heldAtTheYes ? (order.claimer?.name ?? order.confirmer?.name) : (order.confirmer?.name ?? order.claimer?.name)) ?? null;
        if (counts.contactAttempts) {
          facts.push({ label: 'محاولات التواصل', value: String(counts.contactAttempts) });
        }
        if (confirmedAt) facts.push({ label: 'أُكّد', value: 'نعم' });
        // Said plainly, not hidden: the yes was given with nobody holding the order.
        if (confirmedAt && !claimedAt) facts.push({ label: 'الاستلام', value: 'بلا استلام' });
        else if (confirmedAt && !heldAtTheYes) facts.push({ label: 'الاستلام', value: 'بعد التأكيد' });
        break;

      case 'WAREHOUSE':
        if (order.shippingStatus === 'PACKING') facts.push({ label: 'الحالة', value: 'قيد التغليف' });
        if (order.shippingStatus === 'READY_FOR_PICKUP') facts.push({ label: 'الحالة', value: 'بانتظار المندوب' });
        break;

      case 'TRANSIT':
        if (order.deliveryProvider?.name) facts.push({ label: 'الشركة', value: order.deliveryProvider.name });
        if (order.trackingNumber) facts.push({ label: 'التتبع', value: order.trackingNumber });
        if (counts.deliveryAttempts) {
          facts.push({ label: 'محاولات التوصيل', value: String(counts.deliveryAttempts) });
        }
        break;

      case 'CLOSED': {
        const ending =
          state === 'DELIVERED' ? 'مسلَّم'
          : state === 'PARTIALLY_DELIVERED' ? 'مسلَّم جزئياً'
          : state === 'RETURNED' ? 'مرتجع'
          : state === 'CANCELLED' ? 'ملغى'
          : state === 'VOIDED' ? 'مُبطَل'
          : null;
        if (ending) facts.push({ label: 'النتيجة', value: ending });
        const collected = Number(order.collectedAmount ?? 0);
        if (collected > 0) facts.push({ label: 'المحصَّل', value: String(collected) });
        break;
      }
    }

    // How long it took, or how long it is taking.
    const start = enteredAt[key];
    const end = endedAt(index);
    const ongoing = Boolean(start && !end && status === 'CURRENT');
    // A confirmation decided with nobody holding the order began and ended at the yes: there is no time «in» the stage to report, and a
    // zero would read as «instant» for something nobody measured — the same reason a stage never entered says nothing.
    const unmeasured = key === 'CONFIRMATION' && Boolean(confirmedAt) && !heldAtTheYes;
    const minutes = start && !unmeasured ? minutesBetween(start, end ?? now) : null;

    return { key, title: TITLES[key], status, at: start, who, facts, minutes, ongoing };
  });
}
