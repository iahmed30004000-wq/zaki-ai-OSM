'use client';

import React, { useCallback, useState } from 'react';
import { PageShell } from '@/components/ui/PageShell';
import { Card, CardContent } from '@/components/ui/Card';
import { Rows } from '@/components/ui/Rows';
import { Segmented } from '@/components/ui/Segmented';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { OrderRef } from '@/components/orders/OrderRef';
import { useToast } from '@/components/ui/Toast';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { apiJson } from '@/lib/api-client';
import { routeLabel } from '@/lib/route-registry';
import { Button } from '@/components/ui/Button';
import { RejectDialog } from '@/components/screens/confirmation/ActionDialogs';
import { sendContactLine } from '@/lib/contact-line';
import { markOnCall } from '@/lib/exposure';
import { RiPhoneLine, RiWhatsappLine } from '@remixicon/react';

/**
 * «قايمة الاسترجاع» — HER private win-back list (F12, the owner's ruling 25/11).
 *
 * The win-back orders a manager handed to her: never pulled, outside her hand limit, worked in idle time — NEW orders come first, from
 * «طلباتي». Each row opens its order (she holds it, so every door she works an order through opens). The option is 1 or 3 pieces at the
 * owner's two prices — switched here, never typed; the cancelled order's quantity is shown for information only. A row nobody touches
 * leaves her list on the day it says. Every word and number comes from the server's answer.
 */
interface Row {
  id: string;
  orderNumber: string;
  product: string | null;
  pieces: number;
  total: number;
  currency: string;
  touched: boolean;
  oldOrderNumber: string | null;
  oldPieces: number | null;
  options: { one: number; three: number } | null;
  leavesAt: string | null;
  /** The customer's number, for «اتصال» (absent from an older answer). */
  phone?: string | null;
  /** Contact attempts on the order: without one, the reasons that need a word with him are shut in «إلغاء نهائي». */
  attempts?: number;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

/**
 * The four presses of a card (the owner, 26/11): «اتصال» (the dialler, and the contact line every call leaves), «تأكيد» (the
 * confirmation door), «إلغاء نهائي» (the customer is closed for good — `winback/list/[id]/never` — then the order is ended
 * through the confirmation door), «واتساب» (the company's Business API number, as a template — the customer's reply lands in the
 * WhatsApp inbox, where the order is confirmed).
 */
export function WinbackListScreen() {
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ending, setEnding] = useState<Row | null>(null);

  const load = useCallback(async () => {
    try {
      const a = await apiJson<{ rows: Row[] }>('/api/confirmation/winback/list');
      setRows(Array.isArray(a?.rows) ? a.rows : []);
    } catch (e) {
      setRows([]);
      toast.failed(e instanceof Error ? e.message : 'تعذّر جلب القايمة');
    }
  }, [toast]);
  useLiveRefresh(load);

  /** One press through a door; its Arabic refusal is said as it came. */
  const press = async (r: Row, url: string, body: Record<string, unknown>, said: string) => {
    setBusy(r.id);
    try {
      await apiJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast.done(said);
      await load();
      return true;
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'ما زبط');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const confirm = (r: Row) => void press(r, `/api/orders/${r.id}/confirmation`, { action: 'confirm' }, `انأكّد ${r.orderNumber}`);
  const whatsapp = (r: Row) =>
    void press(r, '/api/confirmation/whatsapp-template', { orderId: r.id, purpose: 'winback' }, 'انبعتت من رقم الشركة — ردّ الزبون بيوصل لصندوق الواتس');

  const endForGood = async (r: Row, value: { rejectionReason: string; note: string }) => {
    // The customer first: if the end is refused, the one she closed for good stays closed and she ends the order again.
    const marked = await press(r, `/api/confirmation/winback/list/${r.id}/never`, {}, 'الزبون ما رح ينعرض بالاسترجاع مرة تانية');
    if (!marked) return;
    const ended = await press(
      r,
      `/api/orders/${r.id}/confirmation`,
      { action: 'reject', rejectionReason: value.rejectionReason, note: value.note, rejectionNote: value.note },
      `انلغى ${r.orderNumber} نهائياً`
    );
    if (ended) setEnding(null);
  };

  // The line first (it outlives the page), then the dialler — as `ContactButtons` does on every other call.
  const call = (r: Row) => {
    if (!r.phone) return;
    void sendContactLine({ orderId: r.id, method: 'PHONE', result: 'OPENED' });
    markOnCall();
    window.location.href = `tel:${r.phone.replace(/[^\d+]/g, '')}`;
  };

  const actions = (r: Row) => (
    <div className="flex flex-wrap items-center gap-2">
      {r.phone ? (
        <Button size="sm" variant="secondary" onClick={() => call(r)}>
          <RiPhoneLine className="w-4 h-4 ml-1" /> اتصال
        </Button>
      ) : (
        <span className="text-note text-[var(--sys-muted)]">ما في رقم</span>
      )}
      <Button size="sm" disabled={busy !== null} onClick={() => confirm(r)}>
        تأكيد
      </Button>
      <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => setEnding(r)}>
        إلغاء نهائي
      </Button>
      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => whatsapp(r)}>
        <RiWhatsappLine className="w-4 h-4 ml-1" /> واتساب
      </Button>
    </div>
  );

  const switchTo = async (r: Row, pieces: number) => {
    if (pieces === r.pieces) return;
    setBusy(r.id);
    try {
      await apiJson(`/api/confirmation/winback/list/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pieces }) });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر التغيير');
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageShell
      title={routeLabel('/confirmation/winback-list')}
      description="طلبات استرجاع إلك لحالك، بتشتغلي عليها لما يخلص شغل الطلبات الجديدة. ما بتنحسب من حدّك وما حدا غيرك بيسحبها. اللي ما بتنلمس بترجع بعد 3 أيام."
    >
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-4" aria-busy>
              <SkeletonRows rows={4} />
            </div>
          ) : (
            <Rows
              rows={rows}
              keyOf={(r: Row) => r.id}
              empty="قايمتك فاضية."
              columns={[
                { key: 'n', label: 'الطلب', primary: true, render: (r: Row) => <OrderRef id={r.id} number={r.orderNumber} /> },
                { key: 'p', label: 'المنتج', render: (r: Row) => r.product ?? '—' },
                {
                  key: 'pieces',
                  label: 'العرض',
                  render: (r: Row) =>
                    r.options ? (
                      <Segmented
                        size="sm"
                        aria-label={`عدد القطع — ${r.orderNumber}`}
                        disabled={busy !== null}
                        value={String(r.pieces)}
                        onChange={(v) => void switchTo(r, Number(v))}
                        options={[
                          { value: '3', label: `3 قطع — ${r.options.three}` },
                          { value: '1', label: `قطعة — ${r.options.one}` },
                        ]}
                      />
                    ) : (
                      `${r.pieces} — ${r.total}`
                    ),
                },
                { key: 't', label: 'المجموع', render: (r: Row) => `${r.total} ${r.currency}` },
                { key: 'old', label: 'الطلب القديم', render: (r: Row) => (r.oldOrderNumber ? `${r.oldOrderNumber} — كان ${r.oldPieces ?? '—'} قطع` : '—') },
                { key: 'left', label: 'بترجع', render: (r: Row) => (r.touched ? 'اشتغلتي عليه' : day(r.leavesAt)) },
              ]}
              actions={actions}
            />
          )}
        </CardContent>
      </Card>
      {ending && (
        <RejectDialog
          open
          orderNumber={ending.orderNumber}
          busy={busy === ending.id}
          hasAttempt={(ending.attempts ?? 0) > 0}
          title="إلغاء نهائي"
          lead="بينلغى الطلب، والزبون ما بيرجع ينعرض بالاسترجاع مرة تانية أبداً. القرار بينسجّل باسمك."
          onClose={() => setEnding(null)}
          onSubmit={(v) => void endForGood(ending, v)}
        />
      )}
    </PageShell>
  );
}
