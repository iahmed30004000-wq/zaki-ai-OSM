import type { Prisma } from '@prisma/client';

/**
 * ONE SALE, TWO ORDERS: WHICH ONE IS THE SALE?
 *
 * When a parcel is taken back from a courier company, or its goods are
 * changed after the waybill was printed, the customer is still buying the
 * same thing. What exists is two orders — the old one, which ends as a
 * return, and a replacement that carries the sale on. Every report that
 * counts orders, returns or refusals then has to decide which of the two
 * it is looking at, and until this file existed each one answered by
 * accident: the old order was a «return» (the customer's, as far as the risk
 * score could tell) and the new one was a fresh order with nobody's name on
 * it.
 *
 * SUPERSEDED means: this order was replaced, AND the replacement is the
 * sale carrying on. It is NOT «has a replacement». The win-back writes
 * `replacesOrderId` too, on orders that were LOST — a customer who said no,
 * called again with a lower price. That order is still a loss and must keep
 * counting as one; reading it as superseded would erase every won-back loss
 * from the loss report and the risk score.
 *
 * So the link alone proves nothing, and the reason the old order ended is
 * read from what happened to it, written on the order by the door that
 * ended it:
 *
 *   · COURIER_TRANSFERRED with mode REPLACE — the parcel was taken back from
 *     a company. (A transfer between two agents has the same action name and
 *     a different mode, and replaces nothing.)
 *   · CHANGE_REQUEST_REORDERED — the waybill was cancelled for a change to
 *     the goods.
 *   · SWAP_RECORDED — a statement line showed the courier gave this parcel's
 *     goods to another customer. Written by a door that is not built yet;
 *     named here so the day it lands, nothing else has to learn the word.
 *
 * THE REPLACEMENT'S OWN ACTIVITY IS THE SAME WORD. Both doors write the
 * activity on both orders so neither can be read without the other. The
 * replacement's copy carries `role: REPLACEMENT` and is not a reason: a
 * replacement that is later WON BACK has this word on it and a link to its
 * win-back order, and it is a loss, not a superseded order.
 *
 * ONE DEFINITION, TWO SPELLINGS. `supersededWhere` is the database's, for a
 * report that counts in SQL; `isSuperseded` is the same answer for a row
 * already in memory. `superseded.test.ts` runs the two against the same
 * orders, so they cannot drift — and refuses a report that writes the
 * question again in its own words.
 *
 * This lives here and not in order-state.ts on purpose: that file is the
 * state machine (what an order may do next). This is a reading of history.
 */

/** The activities that say «this order's sale carried on in another». */
export const SUPERSEDING_ACTIONS = [
  'COURIER_TRANSFERRED',
  'CHANGE_REQUEST_REORDERED',
  'SWAP_RECORDED',
] as const;

/** The mark on a transfer that took the parcel back from a company. */
const REPLACE_MODE = '"mode":"REPLACE"';

/** The mark on the replacement's own copy of the activity. */
const REPLACEMENT_SIDE = '"role":"REPLACEMENT"';

/** The two sides of one pair, as the doors write them into the activity. */
export const ACTIVITY_ROLE = {
  original: 'ORIGINAL',
  replacement: 'REPLACEMENT',
} as const;

export interface ActivityLike {
  action: string;
  metadata?: string | null;
}

export interface SupersededSource {
  /** The order that replaced this one, when there is one. */
  replacedBy?: { id?: string } | null;
  /** This order's own activities — only the three actions above are read. */
  activities?: readonly ActivityLike[];
}

/** Does this one activity, on the order it is written on, end that order's sale? */
export function endsTheSale(a: ActivityLike): boolean {
  if (!(SUPERSEDING_ACTIONS as readonly string[]).includes(a.action)) return false;
  const meta = a.metadata ?? '';
  if (meta.includes(REPLACEMENT_SIDE)) return false;
  // A transfer is only a replacement when the parcel was taken back.
  if (a.action === 'COURIER_TRANSFERRED') return meta.includes(REPLACE_MODE);
  return true;
}

/** In memory: replaced, AND by one of the three reasons. Never the link alone. */
export function isSuperseded(o: SupersededSource): boolean {
  if (!o.replacedBy) return false;
  return (o.activities ?? []).some(endsTheSale);
}

/** The side that is not a replacement's own copy: no marker at all, or no such marker. */
const notTheReplacementsCopy: Prisma.OrderActivityWhereInput = {
  OR: [{ metadata: null }, { NOT: { metadata: { contains: REPLACEMENT_SIDE } } }],
};

/** In SQL: the same question as `isSuperseded`, for a report that counts. */
export const supersededWhere: Prisma.OrderWhereInput = {
  replacedBy: { isNot: null },
  activities: {
    some: {
      OR: [
        {
          action: 'COURIER_TRANSFERRED',
          metadata: { contains: REPLACE_MODE },
          AND: [{ NOT: { metadata: { contains: REPLACEMENT_SIDE } } }],
        },
        { action: 'CHANGE_REQUEST_REORDERED', ...notTheReplacementsCopy },
        { action: 'SWAP_RECORDED', ...notTheReplacementsCopy },
      ],
    },
  },
};

/**
 * Spread this into a `where` to leave the superseded orders out:
 * `where: { companyId, ...notSuperseded }`.
 *
 * It is a `NOT` at the top of the clause, so a caller that already has one
 * must wrap both in an `AND` instead of spreading.
 */
export const notSuperseded: Prisma.OrderWhereInput = { NOT: supersededWhere };
