/**
 * WHICH ORDERS A SYSTEM KEY MAY READ OR WRITE A NOTE ON (perm-plan PR-13, V1-1, D1).
 *
 * `GET /api/v1/orders/{id}` and `POST /api/v1/orders/{id}/notes` accepted ANY order of the company: a key that leaked could
 * poll the status of every order and write notes on the ones it had nothing to do with. They now answer only for the orders
 * that SYSTEM raised through this door — the ones `POST /api/v1/orders` created for it. Anything else is the same 404 an
 * unknown id has always got («No such order»), so the door tells a stranger nothing about what exists.
 *
 * THE SYSTEM, NOT THE KEY. A key lives 90 days; the replies system makes a new one and stops the old one, and an order it
 * raised last month must not become unreadable to it the day it rotates. So the order is matched by the `system` the creating
 * key belonged to — which `createSystemOrder` already writes into the order's first activity row, beside `via: api/v1` — and
 * not by the key's id. That also means no column is added and `order-intake.ts` is untouched: what System 7 sent and what it
 * got back are exactly as before; only the WHERE on its reads narrows.
 *
 * Written as a filter fragment, so the status read stays ONE query on ONE row.
 *
 * The two substrings are matched on the JSON the intake wrote (`JSON.stringify`, no spaces). A customer-written string that
 * merely contains the words cannot match: inside a JSON string its quotes are escaped, and `"system":"x"` with a bare quote
 * after `system` only occurs as a key.
 */
export function raisedBySystem(system: string) {
  return {
    activities: {
      some: {
        action: 'ORDER_CREATED',
        userId: null,
        AND: [
          { metadata: { contains: '"via":"api/v1"' } },
          { metadata: { contains: `"system":${JSON.stringify(system)}` } },
        ],
      },
    },
  };
}
