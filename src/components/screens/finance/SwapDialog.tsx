'use client';

import React, { useState } from 'react';
import { RiArrowLeftRightLine, RiLoader4Line, RiSearchLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Money } from '@/components/ui/Money';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import type { SwapSearch, SwapCandidate } from '@/lib/parcel-swap';

/**
 * «كان من طرد طلب آخر» — THE COURIER HANDED THE CUSTOMER A BOX THAT WAS PACKED FOR SOMEONE ELSE.
 *
 * The line carries the money and the box's order. The person says three things, and the server does the rest in
 * one transaction (lib/parcel-swap): who took the goods, how many pieces, and whether the customer's own box
 * came back. Nothing here decides; a customer the rules would refuse is greyed with the sentence.
 */

interface Props {
  statementId: string;
  matchId: string;
  /** The line's own reference, shown at the top so the person knows which line this is. */
  reference: string | null;
  amount: number | null;
  currency: string;
  onDone: () => void;
}

export function SwapDialog({ statementId, matchId, reference, amount, currency, onDone }: Props) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<SwapSearch | null>(null);
  const [picked, setPicked] = useState<SwapCandidate | null>(null);
  const [pieces, setPieces] = useState('');
  const [boxBack, setBoxBack] = useState<'yes' | 'no'>('yes');
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/finance/statements/${statementId}/matches/${matchId}/swap`;
  const boxPieces = found?.box.pieces ?? 0;
  const count = Number(pieces || boxPieces);
  const countOk = Number.isInteger(count) && count >= 1 && count <= Math.max(1, boxPieces);

  const search = async () => {
    setSearching(true);
    setError(null);
    setPicked(null);
    try {
      const res = await apiJson<SwapSearch>(`${base}?q=${encodeURIComponent(query.trim())}`);
      setFound(res);
      if (!pieces) setPieces(String(res.box.pieces));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر البحث');
    } finally {
      setSearching(false);
    }
  };

  const save = async () => {
    if (!picked || !countOk) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiJson<{ message: string }>(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerOrderId: picked.id, pieces: count, ownerBoxBack: boxBack === 'yes' }),
      });
      toast.done(res.message);
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر تسجيل التبديل');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <RiArrowLeftRightLine className="icon-mirror h-4 w-4" />
        كان من طرد طلب آخر
      </Button>

      {open && (
        <Modal isOpen onClose={() => setOpen(false)} title="كان من طرد طلب آخر">
          <div className="space-y-3">
            <p className="text-sm text-[var(--sys-foreground)]">
              السطر: <b dir="ltr">{reference ?? '—'}</b>
              {amount !== null && (
                <>
                  {' '}— المبلغ في الكشف <Money value={amount} currency={currency} />
                </>
              )}
              . الشركة سلّمت هذا الطرد لزبون آخر وحصّلت ثمنه. اكتب هاتف الزبون أو رقم طلبه.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
              className="flex gap-2"
            >
              <label className="flex-1">
                <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">من أخذ البضاعة</span>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  dir="ltr"
                  className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
                  placeholder="هاتف أو رقم طلب"
                />
              </label>
              <Button type="submit" disabled={searching || query.trim().length === 0} className="self-end">
                {searching ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiSearchLine className="w-4 h-4" />}
                ابحث
              </Button>
            </form>

            {found && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-[var(--sys-heading)]">
                  الصندوق من الطلب <span dir="ltr">{found.box.orderNumber}</span> — {found.box.pieces} قطعة
                  {found.box.products.length > 0 ? `: ${found.box.products.join('، ')}` : ''}
                </p>
                {found.box.blockedBy.length > 0 && (
                  <p className="text-note text-[var(--sys-destructive)]">{found.box.blockedBy.join(' · ')}</p>
                )}
                {found.hint && <p className="text-note text-[var(--sys-muted-foreground)]">{found.hint}</p>}
                <ul className="space-y-2">
                  {found.candidates.map((c) => {
                    const blocked = c.blockedBy.length > 0 || found.box.blockedBy.length > 0;
                    return (
                      <li key={c.id}>
                        {/* A row press: picking one order of a list stays a raw button (R19's allowed list). */}
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
                          <span dir="ltr" className="block font-medium">{c.orderNumber}</span>
                          <span className="block text-note text-[var(--sys-muted-foreground)]">
                            {c.customer?.fullName ?? '—'} — <span dir="ltr">{c.customer?.phone ?? '—'}</span>
                          </span>
                          {c.expected !== null && (
                            <span className="block text-note">
                              المتوقَّع <Money value={c.expected} currency={currency} />
                            </span>
                          )}
                          {c.blockedBy.length > 0 && (
                            <span className="block text-note text-[var(--sys-destructive)]">{c.blockedBy.join(' · ')}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {picked && (
              <div className="space-y-3">
                <label className="block">
                  <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">كم قطعة أخذ من الصندوق</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={boxPieces}
                    value={pieces}
                    onChange={(e) => setPieces(e.target.value)}
                    className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
                  />
                </label>
                {!countOk && (
                  <p className="text-note text-[var(--sys-destructive)]">
                    {boxPieces === 1 ? 'الصندوق قطعة واحدة فقط' : `من 1 إلى ${boxPieces} — هذا ما في الصندوق`}
                  </p>
                )}
                <label className="block">
                  <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">هل رجع صندوق الزبون نفسه؟</span>
                  <select
                    value={boxBack}
                    onChange={(e) => setBoxBack(e.target.value === 'no' ? 'no' : 'yes')}
                    className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
                  >
                    <option value="yes">نعم، رجع</option>
                    <option value="no">لا، لم يرجع بعد</option>
                  </select>
                </label>
                <p className="text-note text-[var(--sys-muted-foreground)]">
                  سيصير ثمن الكشف بيعةً للزبون في طلب جديد مسلَّم، ويُغلق طلب الصندوق، ويصير طلب الزبون مرتجعاً. لا مال يتحرّك قبل اعتماد الكشف.
                </p>
              </div>
            )}

            {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

            <div className="flex gap-2 justify-end">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                إلغاء
              </Button>
              {/* The screen's own flag (`saving`): wrapped in `void`, the kit runs nothing of its own. */}
              <Button type="button" disabled={!picked || !countOk || saving} onClick={() => void save()}>
                {picked ? `سجّل التبديل مع الطلب ${picked.orderNumber}` : 'اختر الطلب'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
