import type { Prisma } from '@prisma/client';
import { db } from './db';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * What an order number looks like: `<PREFIX>-<YEAR>-<SEQ>`, where the prefix
 * is the store's own — "SY-2026-0148", "JO-2026-0007".
 *
 * It lives here, beside the generator that produces it, because it did not:
 * a public route carried its own copy demanding a literal "ORD-", a prefix
 * nothing has generated since numbering became per-store, and it silently
 * rejected every request it guarded.
 */
export const ORDER_NUMBER_RE = /^[A-Z0-9]{2,10}-[0-9]{4}-[0-9]{4,8}$/;

/**
 * ORDER REFERENCE — one generator for every intake path (manual, AI, Telegram,
 * landing page). Before Stage 3 each path built its own string, which is how
 * two orders end up with the same number.
 *
 * The merchant reference IS the order number: one identifier, generated for
 * every order, read-only afterwards, and the value sent in the courier's
 * dedicated reference field (never in notes). Two separate identifiers would
 * be two things to reconcile.
 */
export async function nextOrderNumber(
  tx: Tx,
  companyId: string,
  orderPrefix: string,
  attempt = 0,
  now: Date = new Date()
): Promise<string> {
  // Counting rows is wrong: delete or void one and the count drops back onto
  // a number already in use, the insert hits the unique index, and on
  // Postgres that poisons the whole transaction — so the retry that was
  // supposed to recover cannot even run. Continue from the HIGHEST number
  // issued for this prefix and year instead; a gap is harmless, a collision
  // is not.
  //
  // THE HIGHEST AS A NUMBER, NOT AS TEXT. This sorted the strings and took the
  // last one, and as text «9999» is later than «10000»: after the ten-thousandth
  // order of a year every new order asked for 10000 again, and the retry only
  // stepped five numbers forward before the door gave up for the rest of the
  // year. The suffix is read as an integer, and only rows whose suffix IS digits
  // are looked at, so a malformed number in the table is skipped, not tripped on.
  const year = now.getFullYear();
  const stem = `${orderPrefix}-${year}-`;

  const rows = await tx.$queryRaw<{ highest: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("orderNumber" FROM ${stem.length + 1}::int) AS INTEGER)) AS highest
    FROM "orders"
    WHERE "companyId" = ${companyId}
      AND starts_with("orderNumber", ${stem})
      AND SUBSTRING("orderNumber" FROM ${stem.length + 1}::int) ~ '^[0-9]{1,8}$'
  `;
  const highest = Number(rows[0]?.highest ?? 0);
  const next = (Number.isFinite(highest) ? highest : 0) + 1 + attempt;
  return `${stem}${String(next).padStart(4, '0')}`;
}

/** Fields every order carries at creation: the number and its merchant ref. */
export async function orderRefFields(
  tx: Tx,
  companyId: string,
  orderPrefix: string,
  attempt = 0,
  now: Date = new Date()
): Promise<{ orderNumber: string; merchantRef: string }> {
  const orderNumber = await nextOrderNumber(tx, companyId, orderPrefix, attempt, now);
  return { orderNumber, merchantRef: orderNumber };
}
