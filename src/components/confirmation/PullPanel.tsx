'use client';

import React, { useCallback, useRef, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { RiInboxLine, RiPhoneLockLine, RiTimerFlashLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useIsPhone } from '@/hooks/useIsPhone';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';

/**
 * «اسحب الطلب التالي» — THE PULL, WHERE THE AGENT WORKS.
 *
 * It was its own screen (`/confirmation/queue`): a counter and one button,
 * after which the agent was sent to «طلباتي» — and from the empty state of
 * «طلباتي» she was sent back. Queue → mine → queue was the whole day. The
 * panel now sits at the top of «طلباتي» (and on the supervisor's queue page,
 * where the same counter stands over the rows), so pulling does not move
 * her anywhere.
 *
 * ONE PULL, ONE SET OF REFUSALS. The server decides priority (postponed due
 * first, then oldest) and whether this agent may pull at all; the cap, the
 * empty pool and «not your desk» are all its words (`/api/confirmation/pull`
 * and `/api/confirmation/queue`). Nothing here re-decides any of it.
 */

export interface QueueResponse {
  waiting: number;
  /** `heldForHer`: held for her and not yet pulled — counted in the cap with what is in her hands (RV706). */
  owned: { total: number; withoutAttempt: number; heldForHer?: number };
  caps: { withoutAttempt: number; total: number };
  leadDays: number;
  waitingOnADate?: number;
  /** In the queue and held for a colleague who worked the customer: seen, not takeable. */
  reservedForColleagues?: number;
  canPull: boolean;
  refusal: {
    code: string;
    message: string;
    /** The untouched order the UNTOUCHED_ORDER refusal is about, if any. */
    orderId?: string | null;
    orderNumber?: string | null;
  } | null;
  autoReleased: number;
  orders:
    | {
        id: string;
        orderNumber: string;
        createdAt: string;
        confirmationStatus: string;
        postponedUntil: string | null;
        postponeCount: number;
        totalAmount: number;
        customer: { fullName: string; city: string };
        product: { name: string } | null;
        /** Whom it is held for, while the hold stands. */
        reservedFor?: { id: string; name: string } | null;
      }[]
    | null;
}

/**
 * What the server said no to on the pull she pressed: its code, and the order it is about when it is about one
 * (`UNTOUCHED_ORDER`, and `WORK_FIRST` — «الشغل أول»). The sentence was already said (the toast); this is what a screen acts on.
 */
export interface PullRefusalInfo {
  code: string;
  orderId: string | null;
}

/**
 * The pool's state and the pull itself.
 *
 * `enabled: false` reads nothing — «طلباتي» is also drawn for people who may
 * not pull, and the queue door answers them 403.
 *
 * A pull queue is where stale costs the most: two agents reading a list from
 * five minutes ago both reach for the same order. It polls, and it also
 * refreshes when somebody comes BACK to it, which is how it is actually used.
 */
export function useQueue(enabled: boolean) {
  const toast = useToast();
  const [data, setData] = useState<QueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  /** The last pull's refusal — read by whoever pressed it, right after `pull()` answers false. Null after a pull that went through. */
  const lastRefusal = useRef<PullRefusalInfo | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      setData(await apiJson<QueueResponse>('/api/confirmation/queue'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تحميل الطابور');
    }
  }, [enabled]);

  useLiveRefresh(load, { everyMs: 30_000 });

  /** Resolves true when an order was pulled, so the caller can go on — or stay. */
  const pull = useCallback(async (): Promise<boolean> => {
    setPulling(true);
    lastRefusal.current = null;
    try {
      await apiJson('/api/confirmation/pull', { method: 'POST' });
      return true;
    } catch (e) {
      const body = (e as { data?: { code?: string; orderId?: string } } | null)?.data;
      lastRefusal.current = { code: body?.code ?? '', orderId: body?.orderId ?? null };
      toast.failed(e instanceof Error ? e.message : 'تعذر سحب طلب');
      void load();
      return false;
    } finally {
      setPulling(false);
    }
  }, [load, toast]);

  return { data, error, pulling, reload: load, pull, lastRefusal };
}

export function PullPanel({
  queue,
  onPulled,
  compact = false,
  onShowOrder,
  workFirst = null,
  onWorkFirst,
}: {
  queue: ReturnType<typeof useQueue>;
  /** After a successful pull. The queue is reloaded before this runs. */
  onPulled: () => void | Promise<void>;
  /** The slim bar for the top of «طلباتي»; the full card is the supervisor's page. */
  compact?: boolean;
  /**
   * «طلباتي» answers the refusal's link itself: it scrolls to the order's card
   * on her desk instead of reloading the page into the order window. Without
   * it (the supervisor's page) the link is an ordinary address.
   */
  onShowOrder?: (orderId: string) => void;
  /**
   * «الشغل أول»: she owes calls right now — how many, and the oldest (the desk's own answer, `due`). The button stays pressable
   * (a dead button teaches nothing; the server is the enforcement) but says so, and a press OPENS that order through
   * `onShowOrder` instead of asking the server for another. Absent = the pull is as it was.
   */
  workFirst?: { count: number; first: { id: string } | null; button?: string | null } | null;
  /** A pull the server refused with `WORK_FIRST` anyway (a stale tab): the order it names, to open — the desk reads itself again first. */
  onWorkFirst?: (orderId: string) => void | Promise<void>;
}) {
  const { data, error, pulling } = queue;
  /* The slim bar folds its numbers and its rule on a phone (ORD-07); the full card is a desk page. */
  const phone = useIsPhone();
  if (!data) return null;

  /** The server's word for «this account does not pull, it supervises». */
  const notMyDesk = data.refusal?.code === 'NOT_YOUR_DESK';

  /** She owes calls AND this screen can take her to one of them: the button is a way to it, not a pull. */
  const owes = !!workFirst?.count && !!workFirst.first && !!workFirst.button && !!onShowOrder;

  const doPull = async () => {
    if (owes && workFirst?.first) {
      onShowOrder?.(workFirst.first.id);
      return;
    }
    if (await queue.pull()) {
      await queue.reload();
      await onPulled();
      return;
    }
    // A stale tab: the server knew she owes calls and this screen had not heard. It names the order — go there, as for a fresh one.
    const refused = queue.lastRefusal?.current;
    if (refused?.code === 'WORK_FIRST' && refused.orderId) await onWorkFirst?.(refused.orderId);
  };

  const message = error ?? data.refusal?.message ?? null;

  const button = !notMyDesk && (
    <button
      onClick={doPull}
      disabled={owes ? pulling : !data.canPull || pulling || data.waiting === 0}
      className={
        compact
          ? 'min-h-11 md:min-h-0 px-5 py-2.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-semibold disabled:opacity-50'
          : 'mt-6 px-8 py-3 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-semibold disabled:opacity-50'
      }
    >
      {pulling ? 'جارٍ السحب…' : owes ? workFirst?.button : 'اسحب الطلب التالي'}
    </button>
  );

  /*
    NOT «NOT NOW» BUT «NOT YOURS».

    Every other refusal is temporary — finish the order in your hand,
    come back under the cap — so the button stays, greyed, and the
    sentence says what to do about it. `NOT_YOUR_DESK` is the server
    saying this account never holds `confirmation.pull`: a supervisor
    watching the pool. A button drawn for her could only ever answer
    403, so it is not drawn, and the sentence is a plain statement
    rather than a complaint about something she did.
  */
  const sentence = message && (
    <p
      className={`${compact ? 'mt-3' : 'mt-4'} text-sm rounded-lg p-3 ${
        notMyDesk && !error
          ? 'text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)]'
          : 'text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)]'
      }`}
    >
      {message}
      {/*
        AND A WAY TO THE ORDER IT MEANS.

        The refusal used to say «طلبك الحالي» and point nowhere. When
        that order is postponed it is hidden from «طلباتي» until its
        date, and the postponed list shows it with no contact buttons —
        so the agent was told to do something on an order she could not
        open, and the only exit was the ninety-business-minute release.
        This is the door.

        AND IT OPENS ON HER OWN DESK. It pointed at `/orders/<id>` — the
        «الطلبات» screen, which asks `orders.view` — so an agent kept off
        that list was sent to a page that refused her, about an order she
        holds. «طلباتي» opens the same order window from `?open=`, through
        the door that admits the order she holds (order-work-door.ts).
      */}
      {!error && data.refusal?.code === 'UNTOUCHED_ORDER' && data.refusal.orderId && (
        <a
          href={`/confirmation/mine?open=${encodeURIComponent(data.refusal.orderId)}`}
          onClick={(e) => {
            const id = data.refusal?.orderId;
            if (!onShowOrder || !id) return;
            e.preventDefault();
            onShowOrder(id);
          }}
          className="mt-2 inline-flex min-h-11 items-center font-bold underline"
        >
          افتح الطلب {data.refusal.orderNumber ?? ''} وسجّل محاولة
        </a>
      )}
    </p>
  );

  /** What the cap counts (RV706): in her hands, and — said apart — what is held for her. */
  const heldForHer = data.owned.heldForHer ?? 0;
  const capShown = heldForHer > 0 ? `${data.owned.total} + ${heldForHer} محجوز لك` : `${data.owned.total}`;

  /** The caps are what bounds HER pulling. They mean nothing on a desk that does not pull. */
  const caps = !notMyDesk && (
    <div className={`${compact ? 'mt-3 flex flex-wrap gap-3' : 'mt-6 grid grid-cols-2 gap-3 text-right'}`}>
      <Stat
        icon={<RiPhoneLockLine className="w-4 h-4" />}
        label="لديك بلا محاولة اتصال"
        value={`${data.owned.withoutAttempt} / ${data.caps.withoutAttempt}`}
      />
      <Stat
        icon={<RiTimerFlashLine className="w-4 h-4" />}
        label="إجمالي ما بيدك"
        value={`${capShown} / ${data.caps.total}`}
      />
    </div>
  );

  const rule = !notMyDesk && (
    <p className={`${compact ? 'mt-3' : 'mt-4'} text-xs text-[var(--sys-muted)]`}>
      طلب الزبون الراجع اللي تابع إلك بيجيك أول، وبعده الطلب الجديد اللي ما حدا اتصل فيه، وبعده المؤجّل اللي موعده خلال {data.leadDays} يوم، وبعده الأقدم. أي طلب بلا محاولة اتصال بيرجع للطابور بعد 90 دقيقة عمل.
    </p>
  );

  /*
    WAITING ON A DATE IS NOT WAITING FOR YOU.

    The big number used to include postponed orders whose day has not
    come. So a pool holding nothing but far-off promises showed «٣
    بانتظار التأكيد» above a live button that answered «لا توجد
    طلبات» every time — which is «ببطل أقدر أسحب أي طلب». They are
    counted, and said, separately.
  */
  const onADate = !!data.waitingOnADate && (
    <p className="mt-1 text-xs text-[var(--sys-muted)]">
      و{data.waitingOnADate} مؤجَّلة حتى موعدها — تُسحب في يومها وحدها
    </p>
  );

  /*
    HELD FOR A COLLEAGUE IS NOT WAITING FOR YOU EITHER — and it is said, not hidden.

    The orders of returning customers stay in the queue with the name of the agent who worked them. They are not in the big
    number (that is what she may take), and they are not silent: «و٣ تابعة لزميلاتك».
  */
  const heldForColleagues = !!data.reservedForColleagues && (
    <p className="mt-1 text-xs text-[var(--sys-muted)]">
      و{data.reservedForColleagues} تابعة لزميلاتك — زبائنهنّ السابقين، تشوفها بقائمة «الطلبات» وما بتسحبها
    </p>
  );

  if (compact) {
    return (
      <section
        aria-label="سحب طلب جديد"
        className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4"
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] flex items-center justify-center">
              <RiInboxLine className="w-5 h-5 text-[var(--sys-primary)]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--sys-heading)] tabular-nums leading-none">{data.waiting}</p>
              <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">طلب جاهز للسحب الآن</p>
            </div>
          </div>
          <div className="ms-auto">{button}</div>
        </div>
        {onADate}
        {heldForColleagues}
        {sentence}
        {/*
          A PHONE: THE COUNT AND THE BUTTON, THEN ONE LINE (ORD-07).

          The two caps and the rule paragraph took about 150px above the first order on every visit. They are
          still here — the fold's own line says the two figures that matter («بلا محاولة» and «بيدك»), and
          opening it shows the cards and the rule in full.
        */}
        {phone && !notMyDesk ? (
          <div className="mt-3">
            <AdvancedGroup
              label="التفاصيل"
              holds={`بلا محاولة ${data.owned.withoutAttempt}/${data.caps.withoutAttempt} · بيدك ${capShown}/${data.caps.total}`}
            >
              {caps}
              {rule}
            </AdvancedGroup>
          </div>
        ) : (
          <>
            {caps}
            {rule}
          </>
        )}
      </section>
    );
  }

  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-6 text-center">
      <div className="mx-auto w-14 h-14 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] flex items-center justify-center">
        <RiInboxLine className="w-6 h-6 text-[var(--sys-primary)]" />
      </div>
      <p className="mt-4 text-4xl font-bold text-[var(--sys-heading)] tabular-nums">{data.waiting}</p>
      <p className="mt-1 text-sm text-[var(--sys-muted-foreground)]">طلب جاهز للسحب الآن</p>
      {onADate}
      {heldForColleagues}
      {button}
      {sentence}
      {caps}
      {rule}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)]">
      <span className="text-[var(--sys-muted-foreground)]">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-[var(--sys-muted-foreground)] truncate">{label}</p>
        <p className="text-sm font-semibold text-[var(--sys-heading)] tabular-nums" dir="ltr">{value}</p>
      </div>
    </div>
  );
}
