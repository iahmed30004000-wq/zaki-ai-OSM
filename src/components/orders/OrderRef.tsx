'use client';

import { OrderLink } from '@/components/orders/OrderLink';
import { CopyValue } from '@/components/orders/CopyValue';
import { barcodeToCopy, orderNumberToCopy, phoneToCopy } from '@/lib/copy-values';

/**
 * AN ORDER NUMBER, AND THE THREE THINGS SOMEONE WANTS TO TAKE AWAY FROM IT.
 *
 * «Next to the order number, everywhere, a button to copy the number, a
 * button to copy the order number, and a button to copy the courier's
 * barcode» — the owner's words. People paste these into the courier's
 * portal, a chat, a spreadsheet. The number was text or a link; the phone
 * and the barcode sat in other cells, with nothing to copy them by.
 *
 * It WRAPS `OrderLink` and does not replace it: the number is still the
 * link that opens the order (or text, for whoever may not open it), with the
 * same promise and the same reasons — see that file.
 *
 *   · [icon] beside the number    → the order number, as printed
 *   · «هاتف»                      → the customer's phone, Latin digits
 *   · «باركود»                    → the courier's barcode / reference
 *
 * COPY WHAT IS ON THE SCREEN AND NOTHING ELSE.
 *
 * `phone` and `barcode` are passed ONLY by a screen that already DRAWS them
 * in that row, and a button is drawn ONLY when there is a value:
 *   · the warehouse is given no phone (`redactCustomerForWarehouse`) → no
 *     phone button, no message, nothing to explain;
 *   · before the order reaches the courier there is no barcode → no
 *     barcode button (a greyed one would read as a fault);
 *   · a phone the API carries but the screen does not show is NOT passed:
 *     an «invisible» number is not made copyable by a button.
 *
 * COPYING RECORDS NOTHING. Not an audit line, not a «contact attempt»: the
 * confirmation desk unlocks confirm/postpone/cancel once an attempt exists,
 * and a copied number is not a call. The customer-handout count is taken
 * when the row is READ by the server — the row is already counted — so
 * there is no second door here. This file has no request in it, and a test
 * says so.
 *
 * IT NEEDS A `ToastProvider` ABOVE IT (the app shell has one). Without it the
 * failure notice of `CopyValue` goes nowhere: a copy that is refused fails
 * SILENTLY — no message, no value to select by hand. A screen drawn outside
 * the shell (a test, a standalone page) must wrap it.
 */
export function OrderRef({
  id,
  number,
  phone,
  barcode,
  onOpen,
  opensOnHerDesk,
  className = '',
}: {
  /** The order's id — NOT its number. */
  id: string;
  /** What the screen prints: the number, or the merchant reference where it shows that. */
  number: string;
  /** The customer's phone as the row holds it — only if the screen draws it. */
  phone?: string | null;
  /** The courier's barcode — only if the screen draws it. */
  barcode?: string | null;
  /**
   * For a screen whose row opens the order's panel itself (a button, not an
   * address): the number is drawn as a button that calls this.
   */
  onOpen?: () => void;
  /** Passed straight to `OrderLink` — see there. */
  opensOnHerDesk?: boolean;
  className?: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="inline-flex items-center gap-1">
        {onOpen ? (
          <button type="button" onClick={onOpen} className={`${className} underline`} dir="ltr">
            {number}
          </button>
        ) : (
          <OrderLink id={id} number={number} className={className} opensOnHerDesk={opensOnHerDesk} />
        )}
        <CopyValue text={orderNumberToCopy(number)} noun="رقم الطلب" shown={number} />
      </span>
      <CopyValue text={phoneToCopy(phone)} noun="رقم هاتف الزبون" label="هاتف" />
      <CopyValue text={barcodeToCopy(barcode)} noun="باركود الشحنة" label="باركود" />
    </span>
  );
}
