'use client';

import React, { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { arDateShort } from '@/lib/format';
import { RiArrowLeftRightLine, RiLoader4Line, RiUserFollowLine, RiUserUnfollowLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { OPEN_CONFIRMATION } from '@/lib/confirmation-queue';

/**
 * Whose hands the order is in.
 *
 * This box used to list six fields — current owner, assigned to, claimed by,
 * claimed at, formally signed, signed at — of which five read "—" on almost
 * every order, and it offered nothing to do about any of them. The one fact
 * anybody opens it for is who is holding the order right now, and the two
 * things they want are to take it back or to hand it to a colleague.
 *
 * The colleague list comes from the server and holds only people of the same
 * role, because that is exactly what the transfer endpoint will accept: a
 * name can never appear here and then be refused on save.
 */

interface Props {
  order: {
    id: string;
    claimedById: string | null;
    claimedAt: string | null;
    claimer?: { id: string; name: string } | null;
    owner?: { id: string; name: string } | null;
    /** Held for the agent who worked this customer last, while the hold stands (order-reservation.ts). */
    reservedFor?: { id: string; name: string; hoursLeft?: number } | null;
    /** Where the confirmation stands, and who gave the yes — an order can be decided with no holder at all. */
    confirmationStatus?: string;
    confirmer?: { id: string; name: string } | null;
  };
  currentUserId?: string;
  onChanged: () => void;
}

interface Candidate { id: string; name: string; email?: string }

export function OrderResponsibility({ order, currentUserId, onChanged }: Props) {
  const toast = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [mayTransfer, setMayTransfer] = useState(false);
  /* Who the list holds: every employee who can work the order (for whoever assigns), or only the holder's own role (an agent giving it up). */
  const [anyAgent, setAnyAgent] = useState(false);
  const [open, setOpen] = useState<'transfer' | 'release' | 'take' | null>(null);
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const holder = order.claimer ?? order.owner ?? null;
  const heldByMe = holder?.id === currentUserId;
  /*
   * «متاح في الطابور» IS TRUE ONLY OF AN ORDER STILL WAITING TO BE DECIDED (the owner, 1/11).
   * ORD-2026-1896 was confirmed with nobody holding it — a confirmation agent pressed «تأكيد» from the orders list — and this box read
   * «لم يستلمه أحد بعد — متاح في الطابور» beside a confirmed status. A decided order is in no queue; say what happened instead.
   */
  const decided = !!order.confirmationStatus && !OPEN_CONFIRMATION.includes(order.confirmationStatus);
  /*
   * GIVING BACK WHAT SHE HOLDS FOLLOWS ITS OWN KEY.
   *
   * Both buttons rode on `mayTransfer`, which the transfer door answers — and
   * that door still asks «عرض الطلبات». An agent working without it holds an
   * order the release door now admits her to (`DELETE …/claim`, the work
   * door), and the button to do it was not drawn.
   */
  const { currentUser } = useApp();
  /*
   * OWNER AND SUPERVISOR: PULL ANY ORDER BACK, OR TAKE IT.
   *
   * `orders.unlock` is the key the server asks for both («سحبه منه» from someone
   * else, and taking the order over); only the owner, the company admin and the
   * manager hold it. Without it the button for another person's order is not
   * drawn — it used to be, and the door refused it.
   */
  const mayOverride = !heldByMe && userCan(currentUser, 'orders.unlock');
  // The door asks `orders.release` as well, so the button is drawn only for whoever it will accept.
  const mayRelease = heldByMe ? mayTransfer || userCan(currentUser, 'orders.release') : mayOverride && userCan(currentUser, 'orders.release');

  useEffect(() => {
    setOpen(null);
    apiJson<{ mayTransfer: boolean; scope?: 'ANY_AGENT' | 'SAME_RANK'; candidates: Candidate[] }>(`/api/orders/${order.id}/transfer`)
      .then((d) => {
        setMayTransfer(d.mayTransfer);
        setAnyAgent(d.scope === 'ANY_AGENT');
        setCandidates(d.candidates ?? []);
      })
      .catch(() => {
        setMayTransfer(false);
        setAnyAgent(false);
        setCandidates([]);
      });
  }, [order.id, order.claimedById]);

  async function run(action: 'transfer' | 'release' | 'take') {
    // Taking the order over is the override door: it wants five characters.
    const shortest = action === 'take' ? 5 : 3;
    if (reason.trim().length < shortest) {
      toast.failed(action === 'take' ? 'اكتب سبب استلامك للطلب (5 أحرف على الأقل) — يُسجَّل في سجل الطلب.' : 'اكتب السبب — يُسجَّل في سجل الطلب.');
      return;
    }
    if (action === 'transfer' && !targetId) {
      toast.failed('اختر الزميل الذي سيستلم الطلب.');
      return;
    }
    setBusy(true);
    try {
      if (action === 'transfer') {
        await apiJson(`/api/orders/${order.id}/transfer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUserId: targetId, reason: reason.trim() }),
        });
      } else if (action === 'take') {
        await apiJson(`/api/orders/${order.id}/claim?mode=override`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() }),
        });
      } else {
        await apiJson(`/api/orders/${order.id}/claim?reason=${encodeURIComponent(reason.trim())}`, {
          method: 'DELETE',
        });
      }
      setOpen(null);
      setReason('');
      setTargetId('');
      onChanged();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر تنفيذ الإجراء');
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    'w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-sm focus:outline-none focus:border-[var(--sys-primary)]';

  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 shadow-raised space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <RiUserFollowLine className="w-4 h-4 text-[var(--sys-primary)] shrink-0" />
          {holder ? (
            <p className="text-sm text-[var(--sys-heading)]">
              <span className="text-[var(--sys-muted-foreground)] text-xs">بين يدي </span>
              <span className="font-bold">{holder.name}</span>
              {heldByMe && <span className="text-xs text-[var(--sys-success)]"> (أنت)</span>}
              {order.claimedAt && (
                <span className="text-xs text-[var(--sys-muted)]"> · منذ {arDateShort(order.claimedAt)}</span>
              )}
            </p>
          ) : (
            order.reservedFor ? (
              <p className="text-sm text-[var(--sys-muted-foreground)]">
                لم يستلمه أحد بعد — <span className="font-bold text-[var(--sys-heading)]">تابع لـ{order.reservedFor.name}</span>
                {order.reservedFor.hoursLeft !== undefined && (
                  <span className="text-xs text-[var(--sys-muted)]">
                    {' '}· هي اللي تسحبه، وبيصير عاماً بعد {order.reservedFor.hoursLeft} ساعة
                  </span>
                )}
              </p>
            ) : decided ? (
              <p className="text-sm text-[var(--sys-muted-foreground)]">
                {order.confirmationStatus === 'CONFIRMED' ? 'انأكّد من غير ما حدا يستلمه' : 'انحسم من غير ما حدا يستلمه'}
                {order.confirmationStatus === 'CONFIRMED' && order.confirmer && (
                  <span className="font-bold text-[var(--sys-heading)]"> — أكّده {order.confirmer.name}</span>
                )}
              </p>
            ) : (
              <p className="text-sm text-[var(--sys-muted-foreground)]">
                لم يستلمه أحد بعد — <span className="text-[var(--sys-foreground)]">متاح في الطابور</span>
              </p>
            )
          )}
        </div>

        {((holder && (mayRelease || mayTransfer)) || mayOverride) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {mayOverride && (
              <button
                onClick={() => { setOpen(open === 'take' ? null : 'take'); }}
                className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5"
              >
                <RiUserFollowLine className="w-4 h-4" />
                استلمه أنا
              </button>
            )}
            {holder && mayRelease && (
            <button
              onClick={() => { setOpen(open === 'release' ? null : 'release'); }}
              className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)] inline-flex items-center gap-1.5"
            >
              <RiUserUnfollowLine className="w-4 h-4" />
              سحبه منه
            </button>
            )}
            {holder && mayTransfer && (
            <button
              onClick={() => { setOpen(open === 'transfer' ? null : 'transfer'); }}
              disabled={candidates.length === 0}
              title={candidates.length === 0 ? (anyAgent ? 'لا يوجد موظف تأكيد يقدر يشتغل على الطلب' : 'لا يوجد زميل بنفس الرتبة') : undefined}
              className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5 disabled:opacity-40"
            >
              <RiArrowLeftRightLine className="icon-mirror w-4 h-4" />
              تحويل لزميل
            </button>
            )}
          </div>
        )}
      </div>

      {open && (
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 space-y-2">
          {open === 'transfer' && (
            <label className="block">
              <span className="block text-xs font-medium text-[var(--sys-muted-foreground)] mb-1">
                {anyAgent ? 'يُحوَّل إلى (موظفو التأكيد)' : 'يُحوَّل إلى (زملاء بنفس الرتبة فقط)'}
              </span>
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className={inputClass}>
                <option value="">— اختر الزميل —</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            <span className="block text-xs font-medium text-[var(--sys-muted-foreground)] mb-1">
              السبب {open === 'release' ? '(لماذا يُسحب منه)' : open === 'take' ? '(لماذا تستلمه أنت)' : ''}
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
              placeholder={open === 'release' ? 'انتهى دوامه، لم يتابعه…' : open === 'take' ? 'أعدّله بنفسي، متابعة خاصة…' : 'إجازة، توزيع الحمل…'}
              className={inputClass}
            />
          </label>


          <div className="flex gap-2">
            <button
              onClick={() => run(open)}
              disabled={busy}
              className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {busy && <RiLoader4Line className="w-4 h-4 animate-spin" />}
              {open === 'release' ? 'أعِده للطابور' : open === 'take' ? 'استلمه' : 'حوّل الطلب'}
            </button>
            <button
              onClick={() => { setOpen(null); }}
              className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]"
            >
              إلغاء
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
