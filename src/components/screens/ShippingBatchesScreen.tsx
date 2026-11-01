'use client';

import { DispatchResult } from '@/components/ops/DispatchResult';
import { DispatchInterrupted, dispatchInChunks, type DispatchProgress } from '@/components/ops/dispatchInChunks';
import { OrderLink } from '@/components/orders/OrderLink';
import { PrepEditSheet, type PrepParcel } from '@/components/ops/PrepEditSheet';
import React, { useCallback, useState } from 'react';
import { apiFetch, apiJson } from '@/lib/api-client';
import type { DispatchSummary } from '@/lib/couriers/dispatch';
import { courierCityGapLine, type CourierCityGap } from '@/lib/couriers/city-gap-line';
import { amount, arDateShort, type Currency } from '@/lib/format';
import { LabelSizePicker, useLabelSize } from '@/components/labels/LabelSize';
import { BLOCKED_WAYBILLS, describeRefused, openWaybills, WaybillError } from '@/components/labels/openWaybills';
import { useAsk, useConfirm, useTell } from '@/components/ui/Confirm';
import { ScanSheet } from '@/components/scan/ScanButton';
import { RiBarcodeLine, RiDownload2Line, RiEBike2Line, RiFileExcel2Line, RiLoader4Line, RiLockLine, RiPencilLine, RiPrinterLine, RiQrScan2Line, RiSendPlaneLine, RiTruckLine } from '@remixicon/react';
import { EmptyState } from '@/components/ui/EmptyState';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { useIsPhone } from '@/hooks/useIsPhone';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useCan } from '@/hooks/useCan';
import { MissionDone, NextStepButton } from '@/components/ui/NextStep';

/**
 * /ops/batches — the handovers to the couriers.
 *
 * A batch is what actually changes hands: a courier arrives, takes these
 * twenty parcels, and signs for them. The API has always been here and no
 * screen showed it, so the handover existed in the database and nowhere a
 * person could see it.
 *
 * Nothing on this screen invents a state. A batch is READY while it is being
 * filled, SHIPPED the moment the courier takes it, and CLOSED when it is
 * settled — the same three the server knows.
 */

interface Batch {
  id: string;
  batchNumber: string;
  status: string;
  createdAt: string;
  shippedAt: string | null;
  notes: string | null;
  provider: {
    id: string; name: string; code: string; kind?: string;
    /** Whether they have a server to send to at all. */
    apiEnabled?: boolean;
  } | null;
  creator: { id: string; name: string } | null;
  _count: { orders: number };
  /** Parcels the courier has no city id for — said before the press, not after it. */
  courierCityGap?: CourierCityGap | null;
}

/**
 * One parcel on an open trolley — what a decision about it needs, and what the person at the trolley reads beside it:
 * who it goes to, where, what is in it and what is collected (30/10). The optional fields are the server's to send: a
 * trolley read without the address-book key carries no phone, and says nothing of one.
 */
interface Parcel extends Partial<Omit<PrepParcel, 'customer'>> {
  id: string;
  orderNumber: string;
  trackingNumber: string | null;
  customer: { fullName?: string | null; phone?: string | null; altPhone?: string | null; address?: string | null; city?: string | null } | null;
  totalAmount?: number | string | null;
  region?: { id?: string; name: string } | null;
}

/** How a parcel leaves the open trolley. */
type Leave = 'CANCEL' | 'FOLLOW_UP' | 'HOLD';

/** A date a number of days ahead, as the doors read it. Outside the component: the clock is not part of how it draws. */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const STATUS: Record<string, { ar: string; cls: string }> = {
  READY: { ar: 'قيد التجميع', cls: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]' },
  SHIPPED: { ar: 'سُلّمت للشركة', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]' },
  CLOSED: { ar: 'مُنتهية', cls: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]' },
};

export function ShippingBatchesScreen() {
  const toast = useToast();
  const phone = useIsPhone();
  // The Excel file is names, phones and addresses: the door asks the batches key AND the address-book key, so the button
  // is drawn only for whoever it will answer.
  // Both asked on every render (a hook is never called behind `&&`).
  const mayBatches = useCan('ops.batches');
  const mayContacts = useCan('customers.view');
  const mayExport = mayBatches && mayContacts;
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<'all' | 'READY' | 'SHIPPED' | 'CLOSED'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const tell = useTell();
  const ask = useAsk();
  const confirm = useConfirm();
  const [result, setResult] = useState<{ batchId: string; summary: DispatchSummary } | null>(null);
  // How far a send has got: a big batch goes a few orders at a time, and the button says so instead of spinning.
  const [progress, setProgress] = useState<({ batchId: string } & DispatchProgress) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const labelSize = useLabelSize();
  // Somebody phoned and ordered. There is nothing to confirm — the call WAS
  // the confirmation — so the order goes straight to the packing line.
  // Checking parcels against a batch. Only the REFERENCES are held — the
  // endpoint also returns names and phones, and a verification screen has no
  // business keeping those anywhere, in memory or otherwise.
  const [verify, setVerify] = useState<{ batch: Batch; refs: Set<string>; seen: Set<string> } | null>(null);
  // The open trolley's parcels, shown only while somebody is deciding about them.
  const [parcels, setParcels] = useState<{ batchId: string; rows: Parcel[]; canEdit: boolean; currency: Currency | null } | null>(null);
  // The parcel whose «عدّل» form is open (only ever offered to the holder of `ops.edit_in_batch`, on an open trolley).
  const [editing, setEditing] = useState<{ batchId: string; parcel: Parcel } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ batches: Batch[]; pagination: { total: number } }>(
        '/api/shipping-batches?limit=100'
      );
      setBatches(res.batches);
      setTotal(res.pagination?.total ?? res.batches.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  /**
   * ON A PHONE THE HANDOVER ASKS FIRST.
   * «سُلّمت للشركة» cannot be taken back (from here a parcel can no longer be cancelled or held), and on a phone it
   * is a full-width press at the top of the card, one thumb-width from print. A desk keeps the press it has always
   * had; a phone gets the question, in the words the button's own tooltip already uses.
   */
  async function confirmShip(batch: Batch) {
    const ok = await confirm({
      title: `تسليم ${batch.batchNumber} للشركة؟`,
      body: 'بعد هالضغطة ما بيصير تلغي ولا تؤجّل طرداً من الدفعة — يصير طلب تغيير يُبلَّغ للشركة.',
      confirmLabel: 'سُلّمت للشركة',
      tone: 'danger',
    });
    if (ok) await setStatus(batch, 'SHIPPED');
  }

  /**
   * `acknowledgeUnsent` is the second press of a handover the server stopped: a courier connected by API was never sent
   * these parcels, and after «سُلّمت للشركة» they can never be sent from here (BATCH-2026-0004: 147 orders). The server
   * answers BATCH_UNSENT with the count and the sentence; this asks once, in those words, and only a yes sends it again.
   */
  async function setStatus(batch: Batch, status: 'SHIPPED' | 'CLOSED', acknowledgeUnsent = false) {
    setBusy(batch.id);
    try {
      await apiJson(`/api/shipping-batches/${batch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...(acknowledgeUnsent ? { acknowledgeUnsent: true } : {}) }),
      });
      await load();
    } catch (e) {
      const said = (e as { data?: { code?: string; unsent?: number; errorAr?: string } }).data;
      if (said?.code === 'BATCH_UNSENT') {
        const go = await confirm({
          title: `${said.unsent ?? ''} طلب ما انرحّل للشركة`.trim(),
          body: said.errorAr ?? '',
          confirmLabel: 'سلّم رغم ذلك',
          tone: 'danger',
        });
        if (go) await setStatus(batch, status, true);
        return;
      }
      toast.failed(e instanceof Error ? e.message : 'تعذر التحديث');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Hand this batch's orders to the courier and take back their barcodes.
   *
   * Reported per order, because twenty orders where three fail is seventeen
   * parcels that must still ship — and the three need the courier's own
   * words about why, not a single red line.
   */
  async function dispatch(batch: Batch) {
    setBusy(batch.id);
    setResult(null);
    setProgress({ batchId: batch.id, done: 0, total: 0 });
    try {
      // A few orders per request, with the count on the button: a hundred and sixty orders are minutes, and one request is not.
      const summary = await dispatchInChunks(batch.id, (p) => setProgress({ batchId: batch.id, ...p }));
      setResult({ batchId: batch.id, summary });
      await load();
    } catch (e) {
      if (e instanceof DispatchInterrupted) {
        // What was done is shown, the rest is listed as not sent, and the sentence says to refresh and press again.
        setResult({ batchId: batch.id, summary: e.summary });
        toast.failed(e.message);
        await load().catch(() => undefined);
      } else {
        toast.failed(e instanceof Error ? e.message : 'تعذر الترحيل');
      }
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  /**
   * «تحقّقتُ مع الشركة — لا طرد عندهم».
   *
   * A send that timed out keeps its claim on purpose — the parcel may exist —
   * and only a person who rang the company can say it does not. She writes
   * what they said (it is recorded with her name); if the order carries a
   * barcode she types it back, so a real parcel's number is never erased by
   * a click. The server refuses anything that could be a real parcel.
   */
  async function clearSend(o: { orderId: string; orderNumber: string }) {
    const said = await ask({
      title: `${o.orderNumber}: تحقّقتُ مع الشركة — لا طرد عندهم`,
      body: 'بعد هالخطوة بيصير يرجع يترحّل للشركة من جديد. إذا الشركة عندها طرد فعلاً بيطلع طرد مكرر.',
      confirmLabel: 'فكّ الإرسال',
      tone: 'danger',
      input: { label: 'شو قالت الشركة؟', required: true, multiline: true, maxLength: 300 },
    });
    if (!said) return;
    setBusy(o.orderId);
    try {
      let confirmBarcode: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await apiFetch('/api/ops/shipments/clear-send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: o.orderId, note: said, ...(confirmBarcode ? { confirmBarcode } : {}) }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          toast.done(`انفكّ إرسال ${o.orderNumber} — بيصير ترحّله من جديد`);
          setResult(null);
          await load();
          return;
        }
        if (body?.code === 'BARCODE_CONFIRM_REQUIRED' && body?.barcode && attempt === 0) {
          const typed = await ask({
            title: 'على الطلب باركود مسجّل',
            body: `الباركود: ${body.barcode}. اكتبه بنفسك لتأكيد إنو الشركة ما عندها طرد بهالرقم.`,
            confirmLabel: 'أكّد',
            input: { label: 'الباركود', required: true },
          });
          if (!typed) return;
          confirmBarcode = typed;
          continue;
        }
        throw new Error(body?.errorAr || body?.error || 'تعذّر فكّ الإرسال');
      }
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر فكّ الإرسال');
    } finally {
      setBusy(null);
    }
  }

  /**
   * THE PARCELS OF AN OPEN TROLLEY — AND THREE WAYS TO TAKE ONE OFF IT.
   *
   * Until «إغلاق الشحنة — سُلّمت للشركة» a parcel is still ours (M6): the
   * customer can still say «ألغِ» or «مش هالأسبوع», and the person standing
   * at the trolley is the one who can act. These are the doors that already
   * exist — the stand-down for cancelling and for sending back to the
   * confirmation desk, the hold for «not this week» — pressed from where the
   * parcel is, instead of a screen the packing table never opens.
   */
  async function loadParcels(batchId: string) {
    setBusy(batchId);
    try {
      const data = await apiJson<{ batch: { orders: Parcel[] }; canEditInBatch?: boolean; currency?: Currency | null }>(
        `/api/shipping-batches/${batchId}`
      );
      setParcels({ batchId, rows: data.batch.orders, canEdit: data.canEditInBatch === true, currency: data.currency ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر قراءة طرود الدفعة');
    } finally {
      setBusy(null);
    }
  }

  async function toggleParcels(batch: Batch) {
    if (parcels?.batchId === batch.id) {
      setParcels(null);
      return;
    }
    await loadParcels(batch.id);
  }

  async function leave(batchId: string, o: Parcel, how: Leave, parcelInHand = false, typedBefore?: string) {
    const typed =
      typedBefore ??
      (await ask({
        title:
          how === 'CANCEL'
            ? `ألغِ ${o.orderNumber}؟`
            : how === 'FOLLOW_UP'
              ? `أعِد ${o.orderNumber} للمتابعة؟`
              : `أجّل شحن ${o.orderNumber}؟`,
        body:
          how === 'CANCEL'
            ? 'يخرج الطرد من الدفعة ويُلغى الطلب. وإن كانت بوليصته مطبوعة سنسألك إن كان الطرد بين يديك.'
            : how === 'FOLLOW_UP'
              ? 'يخرج الطرد من الدفعة ويعود الطلب لفريق التأكيد ليكلّموا الزبون من جديد.'
              : 'يخرج الطرد من الدفعة ويبقى الطلب مؤكَّداً، وتبقى بضاعته وبوليصته محفوظتين.',
        confirmLabel: 'نفِّذ',
        tone: how === 'CANCEL' ? 'danger' : undefined,
        input:
          how === 'CANCEL'
            ? { label: 'سبب الإلغاء', required: true, multiline: true, maxLength: 300 }
            : { label: 'بعد كم يوم؟ (من 1 إلى 30)', required: true, initial: '3', maxLength: 2 },
      }));
    if (typed === null) return;

    const days = Number(typed);
    if (how !== 'CANCEL' && !(Number.isInteger(days) && days >= 1 && days <= 30)) {
      toast.failed('اكتب عدد أيام من 1 إلى 30');
      return;
    }
    const until = how === 'CANCEL' ? '' : daysFromNow(days);

    setBusy(o.id);
    try {
      const res =
        how === 'HOLD'
          ? await apiFetch('/api/ops/shipments/hold', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orderId: o.id, until }),
            })
          : await apiFetch('/api/ops/shipments/stand-down', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                how === 'CANCEL'
                  ? { orderId: o.id, outcome: 'CANCEL', reason: 'OTHER', note: typed, ...(parcelInHand ? { parcelInHand: true } : {}) }
                  : { orderId: o.id, outcome: 'POSTPONE', until, ...(parcelInHand ? { parcelInHand: true } : {}) }
              ),
            });
      const body = await res.json().catch(() => ({}));
      // A packed parcel: the units come back on this person's word, by name.
      if (!res.ok && body?.code === 'ATTESTATION_REQUIRED') {
        setBusy(null);
        const said = await ask({
          title: `الطرد ${o.orderNumber} مطبوعة بوليصته`,
          body: `${body.attestation ?? ''}`,
          confirmLabel: 'أؤكد',
          tone: 'danger',
          input: { label: 'اكتب «أؤكد» بنفسك', required: true, maxLength: 20 },
        });
        if (said?.trim() === 'أؤكد') await leave(batchId, o, how, true, typed);
        return;
      }
      if (!res.ok) throw new Error(body?.errorAr || body?.error || 'تعذّر التنفيذ');
      toast.done(
        how === 'CANCEL'
          ? `أُلغي ${o.orderNumber} وخرج من الدفعة`
          : how === 'FOLLOW_UP'
            ? `${o.orderNumber} عاد للمتابعة وخرج من الدفعة`
            : `${o.orderNumber} مؤجَّل وخرج من الدفعة`
      );
      await load();
      await loadParcels(batchId);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر التنفيذ');
    } finally {
      setBusy(null);
    }
  }

  /**
   * THE PARCEL IN YOUR HAND, AND THE BATCH ON THE FLOOR.
   *
   * A courier takes twenty parcels and signs for twenty. The one that was
   * never in the batch — picked off the next pallet, or printed for a batch
   * that shipped yesterday — leaves with them, and is discovered a week
   * later as a delivery nobody can account for.
   *
   * The check is a lookup inside a batch the SERVER has already decided this
   * account may read. The camera adds no reach: somebody who cannot open the
   * batch cannot scan against it either, because there is nothing loaded to
   * scan against.
   */
  async function openVerify(batch: Batch) {
    setBusy(batch.id);
    setError(null);
    try {
      const data = await apiJson<{
        batch: { orders: { orderNumber: string; merchantRef: string | null; trackingNumber: string | null }[] };
      }>(`/api/shipping-batches/${batch.id}`);
      const refs = new Set<string>();
      for (const o of data.batch.orders) {
        // Our QR carries the merchant reference; the courier's barcode is
        // printed beside it. Either one identifies the same parcel.
        for (const value of [o.orderNumber, o.merchantRef, o.trackingNumber]) {
          if (value) refs.add(value.trim().toUpperCase());
        }
      }
      setVerify({ batch, refs, seen: new Set() });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر قراءة محتوى الدفعة');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Every waybill in the batch, on one print run, on this device's paper —
   * or the same batch as the CSV some couriers take as a bulk upload
   * instead of paper. The CSV used to live on a separate labels screen; it
   * moved here with the printing rather than being lost with it.
   */
  async function printBatch(batch: Batch, mode: 'print' | 'pdf' | 'csv' = 'print') {
    setBusy(batch.id);
    setError(null);
    try {
      // The batch by id: its token no longer carries a list of order ids,
      // so a batch past two hundred orders prints like any other.
      const out = await openWaybills({ batchId: batch.id, ...labelSize.dims }, mode);
      if (!out.opened && mode !== 'csv') setError(BLOCKED_WAYBILLS);
      if (out.refused.length) {
        void tell({
          title: `جُهِّزت ${out.count} بوليصة، ولم تُجهَّز ${out.refused.length}`,
          body: describeRefused(out.refused),
        });
      }
    } catch (e) {
      if (e instanceof WaybillError && e.refused.length) {
        void tell({ title: e.message, body: describeRefused(e.refused), tone: 'danger' });
      } else {
        setError(e instanceof Error ? e.message : 'تعذر الطباعة');
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * THE BATCH'S ORDERS AS AN EXCEL FILE — for the parcels that have to be made at the courier by hand.
   *
   * The waybill CSV beside it refuses an order with no courier barcode, which is every order of a batch that was handed
   * over before it was sent. This one lists them all. It is fetched, not linked: a refusal (a missing key, a batch of
   * another store) must be said on this screen, not saved as a file named after the address.
   */
  async function exportBatch(batch: Batch) {
    setBusy(batch.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/shipping-batches/${batch.id}/export`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { errorAr?: string; error?: string };
        throw new Error(data.errorAr || data.error || 'تعذر تجهيز ملف الإكسل');
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${batch.batchNumber}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تجهيز ملف الإكسل');
    } finally {
      setBusy(null);
    }
  }

  if (!batches) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  const shown = filter === 'all' ? batches : batches.filter((b) => b.status === filter);
  const counts = {
    READY: batches.filter((b) => b.status === 'READY').length,
    SHIPPED: batches.filter((b) => b.status === 'SHIPPED').length,
    CLOSED: batches.filter((b) => b.status === 'CLOSED').length,
  };

  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title="دفعات الشحن"
          description="ما يتسلّمه المندوب دفعةً واحدة — تُجمَّع، تُسلَّم، ثم تنتهي بعد التسوية."
        />

      {/* A phone: the four states are one strip that slides sideways, as every other tab strip does, and the paper
          has a row of its own with its name on it — it was a fifth chip that read like a filter. */}
      <div className={phone ? 'flex items-center gap-1.5 overflow-x-auto' : 'flex flex-wrap items-center gap-1.5'}>
        {([
          ['all', `الكل (${total})`],
          ['READY', `قيد التجميع (${counts.READY})`],
          ['SHIPPED', `سُلّمت (${counts.SHIPPED})`],
          ['CLOSED', `مُنتهية (${counts.CLOSED})`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key as typeof filter)}
            className={`min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors${phone ? ' shrink-0 whitespace-nowrap' : ''} ${
              filter === key
                ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] border-[var(--sys-primary)]'
                : 'bg-[var(--sys-card)] text-[var(--sys-foreground)] border-[var(--sys-border)] hover:border-[var(--sys-primary)]/40'
            }`}
          >
            {label}
          </button>
        ))}
        {/* The paper every «طباعة بوالص الدفعة» below will use. */}
        {!phone && <LabelSizePicker compact className="ms-auto flex items-center" />}
      </div>
      {phone && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--sys-muted-foreground)]">مقاس البوليصة</span>
          <LabelSizePicker compact className="flex flex-wrap items-center gap-2" />
        </div>
      )}

      {error && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>
      )}

      {shown.length === 0 ? (
        /* «تمّت المهمة!» says the whole screen is clear. A tab that is empty
           while other tabs hold batches is not that — it only says this tab
           is empty, and a tick over «قيد التجميع» with thirty handed-over
           batches beside it would be a false «you are done». */
        filter === 'all' ? (
          <MissionDone why="لا دفعات هنا. تُنشأ الدفعة من شاشة «إنشاء شحنة» عند تسليم الطلبات لشركة." />
        ) : (
          <EmptyState
            icon={RiTruckLine}
            title="لا دفعات بهذه الحالة"
            why="جرّب تبويباً ثانياً، أو «الكل» لترى كل الدفعات."
            action={{ label: 'عرض الكل', onClick: () => setFilter('all') }}
          />
        )
      ) : (
        <ul className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg divide-y divide-[var(--sys-border)]">
          {shown.map((b) => {
            const tone = STATUS[b.status] ?? STATUS.CLOSED;
            /*
              THE EIGHT PRESSES OF ONE BATCH, drawn once. A desk lays them in one wrapping row, in this order; a phone
              lays them out by weight (see below). The words, the doors, the titles and the disabled rules are the same.
            */
            const wide = phone ? ' w-full justify-center' : '';
            const BTN = `min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5 disabled:opacity-40${wide}`;
            const printBtn = (
              <button
                onClick={() => printBatch(b)}
                disabled={busy === b.id || b._count.orders === 0}
                className={BTN}
              >
                {busy === b.id ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiPrinterLine className="w-4 h-4" />}
                طباعة بوالص الدفعة
              </button>
            );
            const verifyBtn = (
              <button
                onClick={() => void openVerify(b)}
                disabled={busy === b.id || b._count.orders === 0}
                title="امسح كل طرد قبل تسليمه — يقول لك إن كان من هذه الدفعة"
                className={BTN}
              >
                <RiQrScan2Line className="w-4 h-4" />
                تحقّق من الطرود
              </button>
            );
            const pdfBtn = (
              <button
                onClick={() => printBatch(b, 'pdf')}
                disabled={busy === b.id || b._count.orders === 0}
                title="نفس البوالص كملف PDF — الحفظ لا يعلّم الطلبات مطبوعة"
                className={BTN}
              >
                <RiDownload2Line className="w-4 h-4" />
                PDF
              </button>
            );
            const csvBtn = (
              <button
                onClick={() => printBatch(b, 'csv')}
                disabled={busy === b.id || b._count.orders === 0}
                title="ملف للرفع الجماعي عند شركات الشحن التي تقبله بدل الورق"
                className={BTN}
              >
                <RiDownload2Line className="w-4 h-4" />
                CSV
              </button>
            );
            /* Every order of the batch, barcode or not: the sheet for making the parcels at the courier's portal. */
            const xlsxBtn = mayExport ? (
              <button
                onClick={() => void exportBatch(b)}
                disabled={busy === b.id || b._count.orders === 0}
                title="كل طلبات الدفعة في ملف إكسل، بباركود الشركة أو بدونه — لإنشاء الطرود عند الشركة يدوياً"
                className={BTN}
              >
                {busy === b.id ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiFileExcel2Line className="w-4 h-4" />}
                إكسل
              </button>
            ) : null;
            /* RiSendPlaneLine the orders to the courier and take their barcodes.
               Separate from marking the batch handed over: one is a
               call to their server, the other is our own record, and
               a courier's API being down must not stop a warehouse
               from closing a batch. */
            /* Only for a courier that HAS a server. A manual one was
               offered this button too: it called out, every order came
               back "skipped — not automated", and nothing happened.
               The parcels are real, the waybills are ours to print,
               and the barcode is typed in when they hand one over. */
            const dispatchBtn =
              b.status === 'READY' && b.provider?.apiEnabled ? (
                <button
                  onClick={() => dispatch(b)}
                  disabled={busy === b.id || b._count.orders === 0}
                  className={`min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-primary)] text-[var(--sys-primary)] font-medium inline-flex items-center gap-1.5 disabled:opacity-40${wide}`}
                >
                  {busy === b.id ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiBarcodeLine className="w-4 h-4" />}
                  {progress?.batchId === b.id && progress.total > 0
                    ? `جارٍ الترحيل… ${progress.done} من ${progress.total}`
                    : 'رحّل إلى الشركة واجلب الباركود'}
                </button>
              ) : null;
            const manualTitle = 'هذه الشركة غير مربوطة بنظامها — البوليصة تُطبع من عندنا والباركود يُدخَل يدوياً عند استلامه.';
            const manualNote =
              b.status === 'READY' && b.provider && !b.provider.apiEnabled ? (
                phone ? (
                  <p title={manualTitle} className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
                    <RiBarcodeLine className="h-4 w-4" />
                    يدوية — اطبع البوالص
                  </p>
                ) : (
                  <span
                    title={manualTitle}
                    className="inline-flex items-center gap-1 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-2.5 py-1.5 text-xs text-[var(--sys-muted-foreground)]"
                  >
                    <RiBarcodeLine className="h-4 w-4" />
                    يدوية — اطبع البوالص
                  </span>
                )
              ) : null;
            const shipBtn =
              b.status === 'READY' ? (
                <button
                  onClick={() => (phone ? void confirmShip(b) : setStatus(b, 'SHIPPED'))}
                  disabled={busy === b.id || b._count.orders === 0}
                  title={b._count.orders === 0 ? 'الدفعة فاضية — ما في طرد يتسلّم للشركة' : 'بعد هالضغطة ما بيصير تلغي ولا تؤجّل طرداً من الدفعة — يصير طلب تغيير يُبلَّغ للشركة'}
                  className={`min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] font-medium inline-flex items-center gap-1.5 disabled:opacity-50${wide}`}
                >
                  <RiSendPlaneLine className="icon-mirror w-4 h-4" />
                  إغلاق الشحنة — سُلّمت للشركة
                </button>
              ) : null;
            const closeBtn =
              b.status === 'SHIPPED' ? (
                <button
                  onClick={() => setStatus(b, 'CLOSED')}
                  disabled={busy === b.id}
                  className={`min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)] inline-flex items-center gap-1.5 disabled:opacity-50${wide}`}
                >
                  <RiLockLine className="w-4 h-4" />
                  أنهِ الدفعة بعد التسوية
                </button>
              ) : null;
            return (
              <li key={b.id} className="p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-[var(--sys-heading)] text-sm" dir="ltr">{b.batchNumber}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-md border ${tone.cls}`}>{tone.ar}</span>

                  {b.provider && (
                    <span className="inline-flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
                      {b.provider.kind === 'AGENT' ? (
                        <RiEBike2Line className="w-4 h-4 text-[var(--sys-primary)]" />
                      ) : (
                        <RiTruckLine className="w-4 h-4 text-[var(--sys-muted)]" />
                      )}
                      {b.provider.name}
                    </span>
                  )}

                  <span className="text-xs text-[var(--sys-muted)] tabular-nums">
                    {b._count.orders} طلب
                  </span>

                  <span className="ms-auto text-xs text-[var(--sys-muted)]">
                    {b.shippedAt ? `سُلّمت ${arDateShort(b.shippedAt)}` : `أُنشئت ${arDateShort(b.createdAt)}`}
                    {b.creator?.name && ` · ${b.creator.name}`}
                  </span>
                </div>

                {b.notes && <p className="text-xs text-[var(--sys-muted-foreground)]">{b.notes}</p>}

                {b.status === 'READY' && b._count.orders > 0 && (
                  <button
                    onClick={() => void toggleParcels(b)}
                    disabled={busy === b.id}
                    className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5 disabled:opacity-40"
                  >
                    {parcels?.batchId === b.id ? 'أخفِ الطرود' : 'طرود الدفعة وتفاصيلها — ألغِ أو أجّل قبل التسليم'}
                  </button>
                )}

                {parcels?.batchId === b.id && (
                  <ul className="divide-y divide-[var(--sys-border)] rounded-lg border border-[var(--sys-border)]">
                    {parcels.rows.map((o) => (
                      <li key={o.id} className="flex flex-wrap items-center gap-2 p-2">
                        <OrderLink id={o.id} number={o.orderNumber} className="font-bold text-[var(--sys-heading)] text-xs" />
                        {o.customer?.fullName && (
                          <span className="text-xs text-[var(--sys-muted-foreground)]">{o.customer.fullName}</span>
                        )}
                        {o.trackingNumber && (
                          <span className="text-xs text-[var(--sys-muted)]" dir="ltr">{o.trackingNumber}</span>
                        )}
                        {/*
                          WHO IT GOES TO, WHERE, WHAT IS IN IT, WHAT IS COLLECTED — beside the parcel, so the person at
                          the trolley does not open the order to know which box is in her hand (30/10). The phone is
                          there only when the server sent one (the address-book key, or the packing table's pen).
                        */}
                        {(o.customer?.phone || o.region?.name || o.customer?.city) && (
                          <p className="w-full text-xs text-[var(--sys-muted-foreground)]">
                            {o.customer?.phone && <span dir="ltr">{o.customer.phone}</span>}
                            {o.customer?.phone && (o.region?.name || o.customer?.city) && ' · '}
                            {o.region?.name ?? o.customer?.city}
                          </p>
                        )}
                        {((o.items?.length ?? 0) > 0 || o.totalAmount != null) && (
                          <p className="w-full text-xs text-[var(--sys-muted-foreground)]">
                            {(o.items ?? [])
                              .map((l) => `${l.productName} × ${l.quantity}${l.freeQuantity ? ` + ${l.freeQuantity} هدية` : ''}`)
                              .join('، ')}
                            {(o.items?.length ?? 0) > 0 && o.totalAmount != null && ' · '}
                            {o.totalAmount != null && <span dir="ltr">{amount(o.totalAmount, parcels.currency)}</span>}
                          </p>
                        )}
                        {parcels.canEdit && o.version != null && (
                          <button
                            onClick={() => setEditing({ batchId: b.id, parcel: o })}
                            disabled={busy === o.id}
                            className={`min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5 disabled:opacity-40${phone ? ' w-full justify-center' : ''}`}
                          >
                            <RiPencilLine className="w-4 h-4" />
                            عدّل
                          </button>
                        )}
                        <span className={phone ? 'grid w-full grid-cols-3 gap-2' : 'ms-auto flex flex-wrap gap-1.5'}>
                          {([['CANCEL', 'ألغِ'], ['FOLLOW_UP', 'أعِده للمتابعة'], ['HOLD', 'أجّل الشحن']] as const).map(([how, label]) => (
                            <button
                              key={how}
                              onClick={() => void leave(b.id, o, how)}
                              disabled={busy === o.id}
                              className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] disabled:opacity-40"
                            >
                              {label}
                            </button>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {result?.batchId === b.id && (
                  <DispatchResult
                    onClearSend={(o) => void clearSend(o)}
                    summary={result.summary}
                    savedNote="الباركودات محفوظة على الطلبات — تظهر على البوليصة وتُتابَع بها الحالة."
                  />
                )}

                {b.status === 'READY' && b.courierCityGap && (
                  <p className="text-xs font-bold text-[var(--sys-warning)]">{courierCityGapLine(b.courierCityGap)}</p>
                )}

                {phone ? (
                  /*
                    A PHONE: THE STAGE'S OWN PRESS FIRST AND AS WIDE AS THE CARD.
                    Eight buttons of one weight in one wrapping row were three rows of 44px pills six pixels apart,
                    with the press that hands the batch over LAST. Here the presses that move the batch on come first,
                    one per line; print and verify side by side; the two files folded behind a row that names them;
                    and the line that says the courier is manual is a sentence, not a pill that looks pressable.
                  */
                  <div className="space-y-2 pt-1">
                    {(dispatchBtn || shipBtn || closeBtn) && (
                      <div className="flex flex-col gap-2">
                        {dispatchBtn}
                        {shipBtn}
                        {closeBtn}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      {printBtn}
                      {verifyBtn}
                    </div>
                    <AdvancedGroup holds={xlsxBtn ? 'PDF · CSV · إكسل' : 'PDF · CSV'}>
                      {pdfBtn}
                      {csvBtn}
                      {xlsxBtn}
                    </AdvancedGroup>
                    {manualNote}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {printBtn}
                    {verifyBtn}
                    {pdfBtn}
                    {csvBtn}
                    {xlsxBtn}
                    {dispatchBtn}
                    {manualNote}
                    {shipBtn}
                    {closeBtn}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <NextStepButton />

      {editing && editing.parcel.version != null && (
        <PrepEditSheet
          order={{
            id: editing.parcel.id,
            orderNumber: editing.parcel.orderNumber,
            version: editing.parcel.version,
            regionId: editing.parcel.regionId ?? null,
            customer: editing.parcel.customer,
            items: editing.parcel.items ?? [],
          }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            const at = editing;
            setEditing(null);
            toast.done(`عُدِّل ${at.parcel.orderNumber} وانكتب على الطلب`);
            void load();
            void loadParcels(at.batchId);
          }}
          onStale={() => {
            void load();
            void loadParcels(editing.batchId);
          }}
        />
      )}

      {verify && (
        <ScanSheet
          title={`تحقّق من طرود ${verify.batch.batchNumber}`}
          continuous
          onClose={() => setVerify(null)}
          onScan={(code) => {
            if (!verify.refs.has(code)) {
              return { text: `${code} ليس من هذه الدفعة — لا تسلّمه معها.`, ok: false };
            }
            // Counting is what turns twenty checks into a handover: the
            // twentieth scan should say twenty, not just "yes" again.
            verify.seen.add(code);
            return { text: `${code} — ${verify.seen.size} من ${verify.batch._count.orders}`, ok: true };
          }}
        />
      )}
    </div>
  );
}
