'use client';

import Link from 'next/link';
import { useMayOpen } from '@/hooks/useMayOpen';

/**
 * AN ORDER NUMBER THAT OPENS THE ORDER IT NAMES.
 *
 * Seven screens printed the number as plain text — custody, the postponed
 * list, win-back, the issues list, the Telegram inbox — so the person who
 * read «ORD-26-5011» and wanted to see it had to go to the orders screen and
 * search for what the first screen had just said.
 *
 * The address is the canonical one: `/orders/<id>` redirects to
 * `/orders?highlight=<id>` and opens that order's panel over the list (see
 * `an-order-link-opens-the-order-it-names.test.tsx`). Nothing here is a second
 * way to open an order.
 *
 * IT IS A PROMISE, SO IT IS ONLY MADE TO WHOEVER CAN KEEP IT. `useMayOpen` is
 * `canAccessRoute` — the question the sidebar and the page guard ask — so a
 * person who may not open `/orders` sees the number exactly as before, as
 * text, and never a link that ends in «لا تملك صلاحية». The door behind the
 * link still decides on its own; this only decides whether to draw it.
 *
 * ── AND THE ORDER SHE HOLDS OPENS ON HER OWN DESK ──
 *
 * An agent may work without «عرض الطلبات» now: the order she holds opens
 * through the work door (`order-work-door.ts`), from «طلباتي» (`?open=`).
 * Only the screen knows that a row IS the order she holds — her own postponed
 * list, her own customer's other orders — so it says so (`opensOnHerDesk`),
 * and the number opens there instead of being text. A plain anchor, not
 * next/link's: the desk reads the address once, as it is drawn. Anything
 * the screen does not vouch for stays text, as before.
 *
 * ── AND IT IS DRAWN AS SOMETHING TO PRESS ──
 *
 * A link was marked only on hover, which a phone does not have: the number
 * looked like the text it replaced, so nobody pressed it («انقر ع الطلب يدخلني»).
 * It is underlined at rest; text stays plain.
 */
export function OrderLink({
  id,
  number,
  className = '',
  opensOnHerDesk = false,
}: {
  /** The order's id — NOT its number. */
  id: string;
  /** What is printed: the order number (or the merchant reference, where a screen shows that). */
  number: string;
  className?: string;
  /**
   * The screen's word that this is the order the viewer holds, with the key
   * that works it (`confirmation.work`) — see «the order she holds» above.
   */
  opensOnHerDesk?: boolean;
}) {
  const mayOpen = useMayOpen();
  if (mayOpen('/orders')) {
    return (
      <Link href={`/orders/${id}`} className={`${className} underline`} dir="ltr">
        {number}
      </Link>
    );
  }
  if (opensOnHerDesk) {
    return (
      <a href={`/confirmation/mine?open=${encodeURIComponent(id)}`} className={`${className} underline`} dir="ltr">
        {number}
      </a>
    );
  }
  return (
    <span className={className} dir="ltr">
      {number}
    </span>
  );
}
