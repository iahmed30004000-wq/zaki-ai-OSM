'use client';

import { useEffect, useState } from 'react';
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
 */

/** No form block here, so the card as it always was. */
const DEFAULT_LOOK = { upsell: 'card', banner: 'none' } as const;

/**
 * A figure as the server sent it. The server has already rounded it in the order's own currency; this only never
 * drops a digit it came with — a dinar has three, and «10.125» must not print as «10.13».
 */
const figure = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });

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
  return (
    // The landing form's own column, and the room the shop's page leaves under itself.
    <section aria-label="العرض بعد الطلب" className="mx-auto w-full max-w-md px-5" style={{ paddingBottom: 48 }}>
      <ThankYouOfferCard
        postOrder={{ offer: entry.offer, windowMinutes: entry.windowMinutes }}
        answer={answer}
        look={DEFAULT_LOOK}
        currency={entry.currency}
        fmt={figure}
      />
      {newTotal !== null && (
        // The server's total after the add — the only number this page prints as one.
        <p role="status" className="text-center text-sm font-bold" style={{ marginTop: 12 }}>
          تم تحديث الإجمالي بعد الإضافة: <bdi dir="ltr">{figure(newTotal)} {entry.currency}</bdi> — تدفعه عند الاستلام
        </p>
      )}
    </section>
  );
}
