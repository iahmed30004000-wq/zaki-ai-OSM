import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { customerRisk } from '@/lib/customer-risk';
import { mayReadInsights } from '@/lib/insights-key';
import { POSTPONE_LEAD_DAYS } from '@/lib/confirmation-queue';
import { deriveCoreState, type StateSource } from '@/lib/order-state';
import { NO_ANSWER_LIMIT , NO_ANSWER_RESULTS } from '@/lib/confirmation-workflow';
import { firstActionTimes } from '@/lib/response-clock';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { endOfLocalDay, localDayKey, startOfLocalDay } from '@/lib/local-day';
import { readPage } from '@/lib/numeric-input';
import { typed } from '@/lib/text-search';

/**
 * GET /api/confirmation/mine — the agent's own desk, in THREE groups.
 *
 * It was two: everything workable in one list, and the last hundred she
 * ever confirmed under it. Both halves had the same fault — they mixed
 * things she must act on with things she must not.
 *
 * ── «للشغل» AND «لا يرد» ARE DIFFERENT WORK ──
 *
 * An order nobody has reached is a call. An order rung twice with nothing
 * is a decision — ring once more and it closes itself. Mixed together, the
 * second kind is invisible until the counter says «2/3», and the three
 * she could still save sit under eleven she cannot.
 *
 * The split is BY COUNT and nothing else, so a postponed order that is due
 * and has one no-answer appears where its count puts it: «لا يرد». The
 * date moved it off her desk; the count is about the phone.
 *
 * ── AND «أكّدتها» IS A SEARCH, NOT A FEED ──
 *
 * `take: 100` by `confirmedAt desc` is the last hundred of her career. The
 * agent who confirmed a thousand orders cannot reach the one from Tuesday
 * — and «اليوم» is the only question she actually asks of this list, so
 * today is the default and the rest is a day, a search and pages of 25.
 *
 * Every number — the risk tier, the attempt counter, the page count — is
 * computed here. The screen renders and sends; it never decides.
 */

/** «أكّدتها» — one page, so a thousand confirmations are reachable. */
const CONFIRMED_PAGE_SIZE = 25;

/** On her desk right now. */
const WORKABLE = ['NEW', 'IN_PROGRESS', 'NO_ANSWER'];
/** Waiting on a date — hers, but not today's work until the date arrives. */
const WAITING = ['FOLLOW_UP_REQUIRED', 'POSTPONED'];

const ORDER_SELECT = {
  id: true, orderNumber: true, merchantRef: true, createdAt: true, confirmedAt: true, version: true,
  // When she pulled it — the moment the response clock starts.
  claimedAt: true,
  confirmationStatus: true, shippingStatus: true, totalAmount: true, currency: true,
  postponedUntil: true, postponePreferredTime: true, postponeCount: true,
  nextFollowUpAt: true, followUpReason: true, discountAmount: true,
  /*
   * WHERE THE ORDER CAME FROM — four fields, because it takes four.
   *
   * The card never said. And «إدخال إشكال» only accepts an order a
   * MODERATOR entered (`moderatorId`): a store order — a landing page,
   * Telegram, the POS — is refused with «لا يمكن فتح إشكال إدخال على طلب
   * من مصدر خارجي», which the agent learns only after pressing it. A
   * button that exists in order to refuse is a button that teaches nothing
   * the first four times.
   *
   * `source` and `channel` name the door, `moderator` and `createdBy` name
   * the person — and the screen reads them together, because «يدوي» from a
   * moderator and «يدوي» from a supervisor are different sentences.
   */
  source: true,
  moderatorId: true,
  moderator: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  channel: { select: { id: true, name: true } },
  // The street THIS order goes to, when the visitor typed one other than the customer row's — shown before it.
  deliveryAddress: true,
  customer: { select: { id: true, fullName: true, phone: true, rawPhone: true, city: true, address: true, totalOrders: true } },
  items: { select: { id: true, productName: true, quantity: true, freeQuantity: true, lineTotal: true, reservedQty: true } },
  // What the customer added on the thank-you screen. The total on the card already carries it, so a card that
  // listed only the lines read as a total that does not add up — and the agent on the phone read the wrong goods.
  addOns: { select: { id: true, productName: true, quantity: true, total: true } },
  _count: { select: { contactAttempts: true, notes: true } },
} as const;

/** No-answer attempts logged so far — drives the 1/2/3 counter in the UI. */
async function noAnswerCounts(orderIds: string[]) {
  if (orderIds.length === 0) return new Map<string, number>();
  const rows = await db.orderContactAttempt.groupBy({
    by: ['orderId'],
    where: { orderId: { in: orderIds }, result: { in: [...NO_ANSWER_RESULTS] } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.orderId, r._count._all]));
}

export async function GET(request: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.work');

    const scope = { companyId, storeId, claimedById: user.id };
    const now = new Date();

    /*
     * ── WHAT «أكّدتها» IS ASKING ──
     *
     * A day, a search and a page — all three read here and all three
     * answered by the database, because a page of 25 drawn out of a
     * hundred rows the server already cut is not paging, it is the same
     * hundred rows with 75 of them hidden.
     *
     * A day that is not `yyyy-MM-dd` falls back to today rather than
     * refusing: the one thing this list must never do is come back empty
     * because a query string was mistyped.
     */
    const params = new URL(request.url).searchParams;
    const dayAsked = params.get('day') ?? '';
    const dayStart = startOfLocalDay(dayAsked);
    const dayEnd = endOfLocalDay(dayAsked);
    const day = dayStart && dayEnd ? dayAsked : localDayKey(now);
    const from = dayStart ?? startOfLocalDay(day)!;
    const to = dayEnd ?? endOfLocalDay(day)!;
    const q = (params.get('q') ?? '').trim().slice(0, 60);
    // The shared reader, so `?page=abc` and `?page=1e400` fall to page one
    // here exactly as they do on every other paged door.
    const page = readPage(params);

    /*
     * The search runs on the ORDER NUMBER, the NAME and the PHONE, which is
     * the three things a customer on the line can read out. The phone is
     * matched on its digits: `rawPhone` holds what was typed and `phone`
     * the normalised form, and she knows neither — she knows what he said.
     */
    const digits = q.replace(/\D/g, '');
    const search = q
      ? {
          OR: [
            { orderNumber: typed(q) },
            { customer: { fullName: typed(q) } },
            ...(digits
              ? [{ customer: { rawPhone: typed(digits) } }, { customer: { phone: typed(digits) } }]
              : []),
          ],
        }
      : {};

    /*
     * ── AND WHAT THE THIRD NO-ANSWER LEFT BEHIND ──
     *
     * The close writes `CANCELLED` + `NO_ANSWER_3_ATTEMPTS` and leaves the
     * order claimed by her, so it would otherwise vanish from every list
     * on this screen — she rings, the card disappears, and nothing says it
     * closed. Today's are shown, read-only, at the bottom of «لا يرد».
     *
     * Found through the status log and not `updatedAt`: `updatedAt` moves
     * with any later write, so a note added tomorrow would make a Tuesday
     * closure look like today's. The log entry is the moment it happened.
     */
    const closedScope = {
      ...scope,
      confirmationStatus: 'CANCELLED',
      rejectionReason: 'NO_ANSWER_3_ATTEMPTS',
      statusLogs: {
        some: { note: 'AUTO_CLOSE_NO_ANSWER_3_ATTEMPTS', createdAt: { gte: startOfLocalDay(localDayKey(now))! } },
      },
    };

    const [inConfirmation, closedToday, confirmed, confirmedTotal] = await Promise.all([
      db.order.findMany({
        where: {
          ...scope,
          OR: [
            { confirmationStatus: { in: WORKABLE } },
            // A postponed order leaves her list and comes back by itself on
            // the day it is due. Leaving it there all week buries the three
            // orders she can actually do something about today; taking it
            // away for good would lose it.
            {
              confirmationStatus: { in: WAITING },
              OR: [
                { postponedUntil: { lte: now } },
                { AND: [{ postponedUntil: null }, { nextFollowUpAt: { lte: now } }] },
                { AND: [{ postponedUntil: null }, { nextFollowUpAt: null }] },
              ],
            },
          ],
        },
        orderBy: [{ nextFollowUpAt: 'asc' }, { claimedAt: 'asc' }],
        take: 200,
        select: ORDER_SELECT,
      }),
      db.order.findMany({
        where: closedScope,
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: ORDER_SELECT,
      }),
      db.order.findMany({
        where: { ...scope, confirmationStatus: 'CONFIRMED', confirmedAt: { gte: from, lte: to }, ...search },
        orderBy: { confirmedAt: 'desc' },
        skip: (page - 1) * CONFIRMED_PAGE_SIZE,
        take: CONFIRMED_PAGE_SIZE,
        select: { ...ORDER_SELECT, changeRequests: { where: { status: 'PENDING' }, select: { id: true, createdAt: true } } },
      }),
      db.order.count({
        where: { ...scope, confirmationStatus: 'CONFIRMED', confirmedAt: { gte: from, lte: to }, ...search },
      }),
    ]);

    // Risk is per customer, company-wide — one lookup per distinct customer.
    // Both lists that go through `decorate`, so the one function never
    // returns a risk tier for some rows and null for others.
    const customerIds = [...new Set([...inConfirmation, ...closedToday].map((o) => o.customer.id))];
    // The return-risk tier is a smart card (PR-10): `null` without `insights.view`, which the screen already draws as no chip
    // (a customer with no history has no tier either) — and the lookups are not made.
    const risks = mayReadInsights(user) ? await Promise.all(customerIds.map((id) => customerRisk(db, companyId, id))) : customerIds.map(() => null);
    const riskByCustomer = new Map(customerIds.map((id, i) => [id, risks[i]]));
    const noAnswer = await noAnswerCounts([...inConfirmation, ...closedToday].map((o) => o.id));

    // The response clock: how long each order has been waiting on her.
    // "How long since I took anything new" is the header chip's question,
    // answered once there rather than twice.
    const firstAction = await firstActionTimes([...inConfirmation, ...closedToday].map((o) => o.id));
    const waitingLater = await db.order.count({
      where: { ...scope, confirmationStatus: { in: WAITING }, postponedUntil: { gt: now } },
    });

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'طلباتي', rows: [...inConfirmation, ...closedToday, ...confirmed] });

    /*
     * ── THE SPLIT ──
     *
     * One pass over the rows she holds, decided by the count the row
     * already carries. Done here and not in the browser for the reason
     * every other number on this screen is: two places that each decide
     * which tab an order belongs in eventually disagree, and the tab
     * headings would then count differently from the lists under them.
     */
    const decorate = (o: (typeof inConfirmation)[number]) => ({
      ...o,
      state: deriveCoreState(o as unknown as StateSource),
      previousOrders: Math.max(0, (o.customer.totalOrders ?? 1) - 1),
      risk: riskByCustomer.get(o.customer.id) ?? null,
      noAnswerCount: noAnswer.get(o.id) ?? 0,
      firstActionAt: firstAction.get(o.id) ?? null,
    });
    const held = inConfirmation.map(decorate);

    return NextResponse.json({
      leadDays: POSTPONE_LEAD_DAYS,
      /** Postponed to a later day — off her desk, not gone. */
      waitingLater,
      noAnswerLimit: NO_ANSWER_LIMIT,
      // The server's own clock, so a wrong clock on her machine cannot make
      // an order look answered or overdue.
      serverNow: new Date().toISOString(),
      /** «للشغل» — nobody has failed to reach this customer yet. */
      work: held.filter((o) => o.noAnswerCount === 0),
      /**
       * «لا يرد» — one or two. Not three: the third is not work, it is a
       * closed order, and it is below.
       */
      noAnswer: held.filter((o) => o.noAnswerCount > 0 && o.noAnswerCount < NO_ANSWER_LIMIT),
      /** Closed by the third no-answer today — read-only, so it is not a surprise tomorrow. */
      closedToday: closedToday.map(decorate),
      /** «أكّدتها» — a day, a search, a page, and the size of what is behind them. */
      confirmed: {
        day,
        q,
        page,
        pageSize: CONFIRMED_PAGE_SIZE,
        total: confirmedTotal,
        pages: Math.max(1, Math.ceil(confirmedTotal / CONFIRMED_PAGE_SIZE)),
        rows: confirmed.map((o) => ({
          ...o,
          state: deriveCoreState(o as unknown as StateSource),
          previousOrders: Math.max(0, (o.customer.totalOrders ?? 1) - 1),
          noAnswerCount: 0,
        })),
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
