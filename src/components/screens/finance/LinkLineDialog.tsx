'use client';

import React, { useState } from 'react';
import { RiAlertLine, RiLink, RiLoader4Line, RiSearchLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Money } from '@/components/ui/Money';
import { useToast } from '@/components/ui/Toast';
import type { CandidateSearch, LinkCandidate } from '@/lib/hand-link';

/**
 * «اربطه بطلب» — A LINE THE MATCHER COULD NOT PLACE, PLACED BY A PERSON.
 *
 * The company wrote a line and nothing of ours carries its reference. A person who reads it can usually say whose
 * parcel it is — the customer's phone is in the company's notes, or our own order number is. So this asks for
 * exactly that, in a real field, and shows the orders it might be: the customer's, nearest to the line's amount
 * first, with how many of that number's orders are closed and how many are still open.
 *
 * It decides nothing. The server judges the link with the matcher's own rule and refuses an order that is
 * already settled, already matched, or named by another statement; those appear greyed here with the reason, so
 * nobody finds out by pressing. An order that is with another courier carries a warning and asks once more.
 */

interface Props {
  statementId: string;
  matchId: string;
  /** The line's own reference, shown at the top so the person knows which line this is. */
  reference: string | null;
  amount: number | null;
  currency: string;
  onLinked: () => void;
}

export function LinkLineDialog({ statementId, matchId, reference, amount, currency, onLinked }: Props) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<CandidateSearch | null>(null);
  // What was searched (not what is being typed now): the server checks an order of another courier against it.
  const [searched, setSearched] = useState('');
  const [picked, setPicked] = useState<LinkCandidate | null>(null);
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/finance/statements/${statementId}/matches/${matchId}/link`;

  const search = async () => {
    setSearching(true);
    setError(null);
    setPicked(null);
    try {
      setFound(await apiJson<CandidateSearch>(`${base}?q=${encodeURIComponent(query.trim())}`));
      setSearched(query.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر البحث');
    } finally {
      setSearching(false);
    }
  };

  const link = async () => {
    if (!picked) return;
    setLinking(true);
    setError(null);
    try {
      const res = await apiJson<{ message: string; linked: { result: string } }>(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: picked.id, acceptOtherCourier: picked.otherCourier, query: searched }),
      });
      if (res.linked.result === 'MATCHED') toast.done(res.message);
      else toast.warn(res.message);
      setOpen(false);
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الربط');
    } finally {
      setLinking(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-11 md:min-h-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-warning)] hover:text-[var(--sys-warning)]"
      >
        <RiLink className="h-4 w-4" />
        اربطه بطلب
      </button>

      {open && (
        <Modal isOpen onClose={() => setOpen(false)} title="اربط سطر الكشف بطلب">
          <div className="space-y-3">
            <p className="text-sm text-[var(--sys-foreground)]">
              السطر: <b dir="ltr">{reference ?? '—'}</b>
              {amount !== null && (
                <>
                  {' '}— المبلغ في الكشف <Money value={amount} currency={currency} />
                </>
              )}
              . اكتب هاتف الزبون أو رقم طلبنا أو رقم الشحنة.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
              className="flex gap-2"
            >
              <label className="flex-1">
                <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">البحث</span>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  dir="ltr"
                  className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
                  placeholder="هاتف أو رقم طلب"
                />
              </label>
              <button
                type="submit"
                disabled={searching || query.trim().length === 0}
                className="h-11 md:h-10 px-4 self-end rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
              >
                {searching ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiSearchLine className="w-4 h-4" />}
                ابحث
              </button>
            </form>

            {found && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-[var(--sys-heading)]">{found.header}</p>
                {found.hint && <p className="text-xs text-[var(--sys-muted-foreground)]">{found.hint}</p>}
                <ul className="space-y-2">
                  {found.candidates.map((c) => {
                    const blocked = c.blockedBy.length > 0;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          disabled={blocked}
                          onClick={() => setPicked(c)}
                          className={`w-full text-right rounded-lg border p-3 text-sm disabled:opacity-50 ${
                            picked?.id === c.id
                              ? 'border-[var(--sys-primary)] bg-[var(--sys-surface)]'
                              : 'border-[var(--sys-border)]'
                          }`}
                        >
                          <span className="flex flex-wrap items-center justify-between gap-2">
                            <span dir="ltr" className="font-medium">{c.orderNumber}</span>
                            <span className="text-xs text-[var(--sys-muted-foreground)]">
                              {c.closed ? 'مغلق' : 'مفتوح'}
                            </span>
                          </span>
                          <span className="block text-xs text-[var(--sys-muted-foreground)]">
                            {c.customer?.fullName ?? '—'} — <span dir="ltr">{c.customer?.phone ?? '—'}</span>
                          </span>
                          {c.expected !== null && (
                            <span className="block text-xs">
                              المتوقَّع <Money value={c.expected} currency={currency} />
                            </span>
                          )}
                          {c.otherCourier && (
                            <span className="flex items-center gap-1 text-xs text-[var(--sys-warning)]">
                              <RiAlertLine className="h-4 w-4" />
                              {found.otherCourierWarning}
                            </span>
                          )}
                          {blocked && (
                            <span className="block text-xs text-[var(--sys-destructive)]">{c.blockedBy.join(' · ')}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={!picked || linking}
                onClick={() => void link()}
                className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
              >
                {picked ? `اربطه بالطلب ${picked.orderNumber}` : 'اختر طلباً'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
