'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { RiPhoneLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { OrderRef } from '@/components/orders/OrderRef';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

/**
 * «الزبون على الخط» — THE CUSTOMER RANG BACK; SHE FINDS HIS ORDER BY HIS NUMBER AND TAKES IT (`customer-on-the-line.ts`).
 *
 * Closed until she opens it: one button beside the pull, so the desk is as it was. Open, it is one box for the number and the
 * orders it found — the order number, the product, the governorate, the status and who holds it, nothing of the customer's. The
 * button «خده — الزبون على الخط» is drawn only where the server said she may take it; everywhere else the server's own sentence
 * says why (a colleague holds it and has started on it, it was never rung, it is past the desk). The door asks everything again
 * when she presses.
 *
 * A card she may take FROM A COLLEAGUE (who pulled it and has logged nothing on it, 7/11) says so above the button — «عند <name> ولسا
 * ما سجّلت عليه شي — بتنسحب منها» — so the take is never a surprise to the one pressing it; the colleague is told too, by the server.
 * The words say what the system knows (nothing is logged), never that she did not call. A refused card keeps the holder's name in
 * its row and the server's sentence under it.
 */

export interface OnTheLineCard {
  id: string;
  orderNumber: string;
  product: string | null;
  governorate: string | null;
  status: string;
  holder: string;
  takeable: boolean;
  /** The colleague she would take it from — set only on a takeable card that a colleague holds. */
  fromColleague?: string | null;
  code: string | null;
  message: string | null;
}

export function CustomerOnTheLine({ onTaken }: { onTaken: (orderId: string) => void | Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [found, setFound] = useState<OnTheLineCard[] | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy('search');
    setSaid(null);
    try {
      const r = await apiJson<{ orders: OnTheLineCard[] }>('/api/confirmation/callback-take/search', {
        method: 'POST',
        body: JSON.stringify({ phone: typed.trim() }),
      });
      setFound(r.orders);
      if (r.orders.length === 0) setSaid('ما في طلبات على هالرقم بمتجرك');
    } catch (err) {
      setFound(null);
      setSaid(err instanceof Error ? err.message : 'تعذر البحث');
    } finally {
      setBusy(null);
    }
  };

  const take = async (card: OnTheLineCard) => {
    setBusy(card.id);
    try {
      await apiJson('/api/confirmation/callback-take', { method: 'POST', body: JSON.stringify({ orderId: card.id }) });
      toast.done(`صار الطلب ${card.orderNumber} معك`);
      setOpen(false);
      setFound(null);
      setTyped('');
      await onTaken(card.id);
    } catch (err) {
      setSaid(err instanceof Error ? err.message : 'تعذر أخد الطلب');
    } finally {
      setBusy(null);
    }
  };

  /*
    ON THE KIT (R8b, 18/11): `Button` and `Card`. Every kit button inside the form names its `type` — the kit sets none, and an
    unnamed one inside a form submits it («سكّري» would search instead of closing). The presses keep their own `busy` flag: `take`
    is `void`ed, so the kit button does not hold a second busy state over the same request.
  */
  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        <RiPhoneLine className="w-4 h-4 text-[var(--sys-primary)]" />
        الزبون على الخط
      </Button>
    );
  }

  return (
    <section aria-label="الزبون على الخط">
      <Card padding="md">
        <form onSubmit={search} className="flex flex-wrap items-center gap-2">
          <input
            type="tel"
            inputMode="tel"
            dir="ltr"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="رقم الزبون اللي عم يحكي"
            aria-label="رقم الزبون اللي عم يحكي"
            className="h-11 md:h-10 w-56 px-2.5 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm text-[var(--sys-foreground)] focus:outline-none focus:border-[var(--sys-primary)]"
          />
          <Button type="submit" variant="primary" disabled={!typed.trim() || busy !== null}>
            {busy === 'search' ? 'عم دوّر…' : 'دوّري'}
          </Button>
          <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
            سكّري
          </Button>
        </form>
        <p className="mt-3 text-note text-[var(--sys-muted)]">
          بتاخدي على الخط طلب رجع للطابور بعد «لا يرد»، أو طلب سحبته زميلتك وما سجّلت عليه شي. الطلب الجديد اللي ما حدا اتصل فيه بيوصل
          بالسحب، واللي زميلتك سجّلت عليه شي بيضل معها.
        </p>
        {said && (
          <p className="mt-3 text-sm rounded-lg p-3 text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)]">{said}</p>
        )}
        {found && found.length > 0 && (
          <ul className="mt-3 space-y-2">
            {found.map((card) => (
              <li key={card.id}>
                <Card plain padding="sm">
                  {card.takeable && card.fromColleague && (
                    <p className="mb-1 text-note text-[var(--sys-warning)]">عند {card.fromColleague} ولسا ما سجّلت عليه شي — بتنسحب منها</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <OrderRef id={card.id} number={card.orderNumber} className="font-semibold text-[var(--sys-heading)] tabular-nums" />
                    {card.product && <span className="text-[var(--sys-foreground)]">{card.product}</span>}
                    {card.governorate && <span className="text-note text-[var(--sys-muted-foreground)]">{card.governorate}</span>}
                    <span className="text-note text-[var(--sys-muted-foreground)]">{card.status}</span>
                    <span className="text-note text-[var(--sys-muted-foreground)]">{card.holder}</span>
                    {card.takeable && (
                      <Button type="button" variant="primary" onClick={() => void take(card)} disabled={busy !== null} className="ms-auto">
                        {busy === card.id ? 'عم ياخده…' : 'خده — الزبون على الخط'}
                      </Button>
                    )}
                    {card.code === 'ALREADY_YOURS' && (
                      <Button type="button" variant="secondary" onClick={() => void onTaken(card.id)} className="ms-auto">
                        افتحه
                      </Button>
                    )}
                  </div>
                  {!card.takeable && card.message && <p className="mt-1 text-note text-[var(--sys-muted)]">{card.message}</p>}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
