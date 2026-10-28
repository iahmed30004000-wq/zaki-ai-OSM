'use client';

import { useEffect, useState } from 'react';
import { moneyText } from '@/lib/money';
import { ThankYouOfferCard, usePostOrderOffer } from '@/components/landing/ThankYouOfferCard';
import { forgetAfterOrder, readAfterOrder, type AfterOrderEntry } from './after-order-handoff';

/**
 * «العرض بعد الطلب» ON THE BASKET'S THANK-YOU PAGE — the same card every other door shows.
 *
 * The page around it is a server component that prints the reference it was handed and looks nothing up. This
 * part reads only what the checkout left in THIS tab (`after-order-handoff`), and only the entry that names the
 * page's own reference. Nothing kept, nothing readable, another order's entry, a window that has passed: it draws
 * nothing, and the page is exactly the page it always was.
 *
 * Drawn, it is `ThankYouOfferCard` — the same request to the same door, with the same token, once, inside the
 * window, and the same single Purchase for the ADDED amount. The basket has no form block, so the card wears its
 * default look. Once the customer has answered — added, refused by the server, «لا شكراً» — the entry is
 * forgotten, so a refresh does not ask again.
 *
 * Below the shop's own page, not inside it: `.sf-page` styles every paragraph in it as reading text, and the
 * card's price and its refusal would lose their colour and size.
 *
 * EVERY FIGURE GOES THROUGH THE ONE DOOR MONEY IS PRINTED BY — `moneyText`, in the shop's own decimals, which the
 * checkout kept beside the currency. It is how the checkout printed «المطلوب عند الاستلام» a moment earlier, so a
 * dinar shop reads «14.000 JOD» there and «10.000 JOD» here, and «10.125» stays «10.125». The first version printed
 * the new total by hand beside the code — «24 JOD» — and `money-goes-through-one-door.test.ts` said so.
 */

/** No form block here, so the card as it always was. */
const DEFAULT_LOOK = { upsell: 'card', banner: 'none' } as const;

export function CartThankYouOffer({ reference }: { reference: string }) {
  const [entry, setEntry] = useState<AfterOrderEntry | null>(null);
  const [newTotal, setNewTotal] = useState<number | null>(null);
  // After the first paint, never during it: the server drew this page without the tab's storage.
  useEffect(() => {
    setEntry(readAfterOrder(reference));
  }, [reference]);

  const answer = usePostOrderOffer({
    orderNumber: entry?.orderNumber ?? null,
    addonToken: entry?.addonToken ?? null,
    offer: entry?.offer ?? null,
    currency: entry?.currency ?? '',
    onTotal: setNewTotal,
  });
  const { postOrderState, postOrderRefused } = answer;
  const answered = postOrderRefused || postOrderState === 'added' || postOrderState === 'gone';
  useEffect(() => {
    if (entry && answered) forgetAfterOrder(entry.orderNumber);
  }, [entry, answered]);

  if (!entry || postOrderRefused) return null;
  // The card writes the code after each figure itself, so its figures come bare.
  const fmt = (n: number) => moneyText(n, null, entry.minorUnit);
  return (
    // The landing form's own column, and the room the shop's page leaves under itself.
    <section aria-label="العرض بعد الطلب" className="mx-auto w-full max-w-md px-5" style={{ paddingBottom: 48 }}>
      <ThankYouOfferCard
        postOrder={{ offer: entry.offer, windowMinutes: entry.windowMinutes }}
        answer={answer}
        look={DEFAULT_LOOK}
        currency={entry.currency}
        fmt={fmt}
      />
      {newTotal !== null && (
        // The server's total after the add — the only number this page prints as one.
        <p role="status" className="text-center text-sm font-bold" style={{ marginTop: 12 }}>
          تم تحديث الإجمالي بعد الإضافة: <bdi dir="ltr">{moneyText(newTotal, entry.currency, entry.minorUnit)}</bdi> — تدفعه عند الاستلام
        </p>
      )}
    </section>
  );
}
