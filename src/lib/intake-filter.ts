import type { Prisma } from '@prisma/client';
import { db } from './db';
import { sameProductWhere } from './confirmed-twin';
import { INTAKE_DUPLICATE_ACTION, INTAKE_SUSPECT_ACTION, INTAKE_WINDOW_MS } from './intake-flags';
import { intakeFilterSwitch } from './intake-filter-switch';
import { CONFIRMATION_REFUSED } from './order-state';
import { canonicalPhone, isValidPhoneFor, phoneKeys, ruleFor } from './phone-rules';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «فلتر الاستقبال» (Confirmation Center v2, step C1) — TWO FLAGS ON A NEW ORDER, WRITTEN AFTER IT EXISTS.
 *
 *   • `INTAKE_DUPLICATE`      — the same customer (the same number in any spelling) asked for the same product within the last day, and that earlier order was not refused.
 *   • `INTAKE_SUSPECT_NUMBER` — the number does not have the shape of a number of the store's country (`isValidPhoneFor`).
 *
 * A FLAG, NEVER A REFUSAL AND NEVER A CLOSE. The order stays exactly where it is — in the queue, unclaimed, NEW — and the only write is one `OrderActivity` row
 * (`userId` null) that the order window and the timeline read back. Nothing is rejected, merged, held, messaged or counted: a customer who really orders the same
 * product twice is an ordinary customer, a rejection would add to `cancelledOrders` and be blamed on data entry (RV491/RV492), and there is no system user for the
 * status log. Taking the order out of the pool, and a message to the customer, are C2 (`docs/confirmation-v2/step-c-changelog.md`).
 *
 * ── WHY NOT IN THE CREATION DOORS ──
 *
 * The same reason as `reserve-returning-customers.ts`: five doors write an order and each would carry a copy; creating an order is a fixed blocker. One step AFTER
 * the order exists is one copy and touches no creation. It runs every two minutes from the scheduler and right before «اسحب التالي» (best-effort: a failed sweep
 * never stops a pull), and it asks the company's own switch (`intake-filter-switch.ts`) first — OFF is no query and no write.
 *
 * ── SAME NUMBER, ANY SPELLING ──
 *
 * The customer row already holds one person across `0933…`, `+963 933…` and `00963933…` (one stored key, `canonicalPhone`). The one spelling it does not unify is the dial
 * code written without `+` or `00` (`963933620102`, stored whole beside `933620102`). `intakePhoneKeys` matches both ways for the comparison and never changes what is stored.
 * ═══════════════════════════════════════════════════════════════════════
 */


/** How many new orders one pass looks at, oldest first — the same bound as the hold of a returning customer. */
const BATCH = 200;

/**
 * Every stored key the same person's number may sit under in this country: the canonical one, the older forms (`phoneKeys`), and the dial code written bare.
 * Pure. An unknown country adds only what the canonical form gives.
 */
export function intakePhoneKeys(phone: string, countryCode: string | null | undefined): string[] {
  const canonical = canonicalPhone(phone, countryCode);
  if (!canonical) return [];
  const keys = new Set<string>([canonical, ...phoneKeys(canonical)]);
  const rule = ruleFor(countryCode);
  if (rule) {
    // `963933620102` → `933620102`: only when what is left is a national number of this country (a mobile may itself start with a dial code's digits).
    if (canonical.startsWith(rule.dialCode)) {
      const rest = canonical.slice(rule.dialCode.length).replace(/^0+/, '');
      if (rule.national.test(rest)) keys.add(rest);
    }
    // and the other way round: `933620102` also sits stored as `963933620102`.
    if (rule.national.test(canonical)) keys.add(`${rule.dialCode}${canonical}`);
  }
  return [...keys];
}

export interface IntakeScope {
  companyId: string;
  storeId: string;
  /** The store's country (`Country.code`) — the number's shape is judged by it, never by the number. */
  countryCode: string | null | undefined;
}

/**
 * THE PULL'S SWEEP LOOKS AT EACH NEW ORDER ONCE (perf, 17/11).
 *
 * «اسحب التالي» sweeps before the pick, so a flag is written BEFORE the order is dealt — the promise of this filter, and it stays. What it did on top was look at the SAME orders again
 * on every press: up to 200 orders with their history and two questions for each one without a flag, and an order that is no repeat never gets a flag, so it was asked about again and
 * again for a day. Here the store's sweep for the pull remembers the orders it has already looked at (in this process) and goes straight to the ones it has not: a new order is looked
 * at by the very next press, never later than the press that could deal it. An order is remembered when its look BEGINS, so two presses at once do not write its flag twice. The job's
 * own sweep (every two minutes, in the worker) remembers nothing and is untouched, and so is `sweepIntake` for any caller that gives it no memory.
 */
const PULL_SEEN_CAP = 5_000;
const pullSeen = new Map<string, Set<string>>();

export function sweepIntakeForPull(scope: IntakeScope): Promise<number> {
  const key = `${scope.companyId}:${scope.storeId}`;
  let seen = pullSeen.get(key);
  if (!seen) {
    seen = new Set<string>();
    pullSeen.set(key, seen);
  }
  return sweepIntake(scope, new Date(), db, seen);
}

/**
 * One pass for one store. Returns how many flags it wrote. Never throws: the callers are a job and a pull, and a flag that could not be written must stop neither.
 */
export async function sweepIntake(scope: IntakeScope, now: Date = new Date(), client: Tx = db, seen?: Set<string>): Promise<number> {
  try {
    const sw = await intakeFilterSwitch(client, scope.companyId, now.getTime());
    if (!sw.enabled || !sw.enabledAt) return 0;

    // Never before the owner turned it on, and never older than the window itself: an order older than a day has no first order to be a repeat of.
    const since = new Date(Math.max(sw.enabledAt.getTime(), now.getTime() - INTAKE_WINDOW_MS));
    const candidates = await client.order.findMany({
      where: {
        companyId: scope.companyId,
        storeId: scope.storeId,
        claimedById: null,
        confirmationStatus: 'NEW',
        shippingStatus: 'NOT_READY',
        createdAt: { gt: since },
        // A replacement or a win-back is a repeat on purpose.
        replacesOrderId: null,
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: {
        id: true,
        createdAt: true,
        customerId: true,
        productId: true,
        items: { select: { productId: true } },
        customer: { select: { phone: true, rawPhone: true } },
        activities: { where: { action: { in: [INTAKE_DUPLICATE_ACTION, INTAKE_SUSPECT_ACTION] } }, select: { action: true } },
      },
    });

    let written = 0;
    // The pull's memory is bounded: a day's orders of one store are far under the cap, and a cleared memory only means one more look.
    if (seen && seen.size > PULL_SEEN_CAP) seen.clear();
    for (const order of candidates) {
      if (seen) {
        if (seen.has(order.id)) continue;
        seen.add(order.id);
      }
      const done = new Set(order.activities.map((a) => a.action));

      if (!done.has(INTAKE_SUSPECT_ACTION) && !isValidPhoneFor(scope.countryCode, order.customer.rawPhone ?? '')) {
        await client.orderActivity.create({
          data: {
            companyId: scope.companyId,
            orderId: order.id,
            userId: null,
            action: INTAKE_SUSPECT_ACTION,
            metadata: JSON.stringify({ reason: 'SHAPE' }),
          },
        });
        written += 1;
      }

      if (!done.has(INTAKE_DUPLICATE_ACTION)) {
        const first = await findFirstOfTheSame(client, scope, order);
        if (first) {
          await client.orderActivity.create({
            data: {
              companyId: scope.companyId,
              orderId: order.id,
              userId: null,
              action: INTAKE_DUPLICATE_ACTION,
              metadata: JSON.stringify({ firstOrderId: first.id, firstOrderNumber: first.orderNumber, windowHours: INTAKE_WINDOW_MS / 3_600_000 }),
            },
          });
          written += 1;
        }
      }
    }
    return written;
  } catch (e) {
    // Say that something went wrong, never what the customer typed.
    console.error('[intake] sweep failed:', (e as Error)?.name || 'unknown');
    return 0;
  }
}

/** The OLDEST earlier order of the same person for the same product, within the window and not refused — or null. */
async function findFirstOfTheSame(
  client: Tx,
  scope: IntakeScope,
  order: { id: string; createdAt: Date; customerId: string; productId: string; items: { productId: string }[]; customer: { phone: string } }
): Promise<{ id: string; orderNumber: string } | null> {
  const product = sameProductWhere([order.productId, ...order.items.map((i) => i.productId)]);
  if (!product) return null;
  // The same person under every spelling of the number: this customer, and the store's other customer rows whose stored key is one of the spellings.
  const others = await client.customer.findMany({
    where: { companyId: scope.companyId, storeId: scope.storeId, phone: { in: intakePhoneKeys(order.customer.phone, scope.countryCode) } },
    select: { id: true },
  });
  const customerIds = [...new Set([order.customerId, ...others.map((c) => c.id)])];
  return client.order.findFirst({
    where: {
      companyId: scope.companyId,
      customerId: { in: customerIds },
      id: { not: order.id },
      createdAt: { gte: new Date(order.createdAt.getTime() - INTAKE_WINDOW_MS), lt: order.createdAt },
      confirmationStatus: { notIn: [...CONFIRMATION_REFUSED] },
      replacesOrderId: null,
      ...product,
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, orderNumber: true },
  });
}
