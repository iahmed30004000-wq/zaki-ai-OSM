'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { RiPhoneLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { OrderRef } from '@/components/orders/OrderRef';

/**
 * «الزبون على الخط» — THE CUSTOMER RANG BACK; SHE FINDS HIS ORDER BY HIS NUMBER AND TAKES IT (`customer-on-the-line.ts`).
 *
 * Closed until she opens it: one button beside the pull, so the desk is as it was. Open, it is one box for the number and the
 * orders it found — the order number, the product, the governorate, the status and who holds it, nothing of the customer's. The
 * button «خده — الزبون على الخط» is drawn only where the server said she may take it; everywhere else the server's own sentence
 * says why (a colleague holds it and has started on it, it was never rung, it is past the desk). The door asks everything again
 * when she presses.
 *
 * A card she may take FROM A COLLEAGUE (who pulled it and has done nothing on it, 7/11) says so above the button — «عند <name> ولسا
 * ما اتصلت فيه — بتنسحب منها» — so the take is never a surprise to the one pressing it; the colleague is told too, by the server.
 * A refused card keeps the holder's name in its row and the server's sentence under it.
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

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-11 md:min-h-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] text-sm font-semibold text-[var(--sys-heading)]"
      >
        <RiPhoneLine className="w-4 h-4 text-[var(--sys-primary)]" />
        الزبون على الخط
      </button>
    );
  }

  return (
    <section aria-label="الزبون على الخط" className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4">
      <form onSubmit={search} className="flex flex-wrap items-center gap-2">
        <input
          type="tel"
          inputMode="tel"
          dir="ltr"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="رقم الزبون اللي عم يحكي"
          aria-label="رقم الزبون اللي عم يحكي"
          className="h-11 md:h-8 w-56 px-2.5 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-xs text-[var(--sys-foreground)] focus:outline-none focus:border-[var(--sys-primary)]"
        />
        <button
          type="submit"
          disabled={!typed.trim() || busy !== null}
          className="min-h-11 md:min-h-0 px-5 py-2.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-semibold disabled:opacity-50"
        >
          {busy === 'search' ? 'عم دوّر…' : 'دوّري'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="min-h-11 md:min-h-0 px-3 text-sm text-[var(--sys-muted-foreground)]">
          سكّري
        </button>
      </form>
      <p className="mt-3 text-xs text-[var(--sys-muted)]">
        بتاخدي على الخط طلب رجع للطابور بعد «لا يرد»، أو طلب سحبته زميلتك وما بدأت عليه. الطلب الجديد اللي ما حدا اتصل فيه بيوصل بالسحب،
        واللي زميلتك بدأت عليه بيضل معها.
      </p>
      {said && (
        <p className="mt-3 text-sm rounded-lg p-3 text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)]">{said}</p>
      )}
      {found && found.length > 0 && (
        <ul className="mt-3 space-y-2">
          {found.map((card) => (
            <li key={card.id} className="p-3 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)]">
              {card.takeable && card.fromColleague && (
                <p className="mb-1 text-xs text-[var(--sys-warning)]">عند {card.fromColleague} ولسا ما اتصلت فيه — بتنسحب منها</p>
              )}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <OrderRef id={card.id} number={card.orderNumber} className="font-semibold text-[var(--sys-heading)] tabular-nums" />
                {card.product && <span className="text-[var(--sys-foreground)]">{card.product}</span>}
                {card.governorate && <span className="text-xs text-[var(--sys-muted-foreground)]">{card.governorate}</span>}
                <span className="text-xs text-[var(--sys-muted-foreground)]">{card.status}</span>
                <span className="text-xs text-[var(--sys-muted-foreground)]">{card.holder}</span>
                {card.takeable && (
                  <button
                    type="button"
                    onClick={() => void take(card)}
                    disabled={busy !== null}
                    className="ms-auto min-h-11 md:min-h-0 px-5 py-2.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-semibold disabled:opacity-50"
                  >
                    {busy === card.id ? 'عم ياخده…' : 'خده — الزبون على الخط'}
                  </button>
                )}
                {card.code === 'ALREADY_YOURS' && (
                  <button
                    type="button"
                    onClick={() => void onTaken(card.id)}
                    className="ms-auto min-h-11 md:min-h-0 px-4 py-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] text-sm font-semibold text-[var(--sys-heading)]"
                  >
                    افتحه
                  </button>
                )}
              </div>
              {!card.takeable && card.message && <p className="mt-1 text-xs text-[var(--sys-muted)]">{card.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
