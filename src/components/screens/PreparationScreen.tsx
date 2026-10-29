'use client';

import React, { useCallback, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { ChangeRequestReview } from '@/components/orders/ChangeRequestReview';
import { OrderDetailModal } from '@/components/orders/OrderDetailModal';
import { RejectDialog } from '@/components/screens/confirmation/ActionDialogs';
import { useApp } from '@/context/AppContext';
import { PickingAssistant } from '@/components/screens/ops/PickingAssistant';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiArchiveDrawerLine, RiArrowDownSLine, RiArrowLeftSLine, RiCloseCircleLine, RiLoader4Line, RiPencilLine } from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { MissionDone, NextStepButton } from '@/components/ui/NextStep';
import { userCan } from '@/lib/can';
import { AI_ASSIST_KEY } from '@/lib/ai-assistants';

/**
 * /ops/preparation — grouped BY PRODUCT, collapsible. Orders, required,
 * available and shortage all come from the API; the screen adds nothing.
 */

interface Line {
  orderId: string;
  orderNumber: string;
  customerName: string;
  regionName: string | null;
  pendingChangeRequestId: string | null;
  quantity: number;
  freeQuantity: number;
  reservedQty: number;
  shippingStatus: string;
}

interface Group {
  productId: string;
  productName: string;
  orders: number;
  required: number;
  available: number;
  shortage: number;
  lines: Line[];
}

export function PreparationScreen() {
  const [data, setData] = useState<{ allowNegativeStock: boolean; totals: { products: number; orders: number; shortages: number }; groups: Group[] } | null>(null);
  // Groups start OPEN: the screen has no action of its own, so a group closed
  // by default was a click for nothing before the packer could read a line.
  // Only the ones the person closes are remembered.
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // A request waiting on an order is the one thing the packer must see
  // before the box is taped.
  const [reviewing, setReviewing] = useState<string | null>(null);
  // The customer rings while the box is being packed: change it, or stop
  // it. Both have to be reachable from the row the packer is looking at,
  // not from a screen somebody has to go and find.
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<{ id: string; orderNumber: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Who is standing at this screen.
   *
   * It is the packing line, and the person on it is a warehouse hand who
   * holds seven permissions — all of them about stock and preparation, none
   * about orders. Cancelling a customer's order was never their job, and
   * the customer's phone number is redacted from their view on purpose.
   *
   * So the two controls appear for whoever ALSO has the authority: a
   * supervisor or an owner looking at the same screen. Showing them to the
   * packer would be two buttons that can only ever produce a red error.
   */
  const { currentUser } = useApp();
  const mayOpenOrder = userCan(currentUser, 'orders.view');
  const mayCancel = userCan(currentUser, 'orders.cancel');
  // The suggested round is the assistants' box (PR-5): without it the list below is the whole screen, and it is whole.
  const mayAskAssistant = userCan(currentUser, AI_ASSIST_KEY);

  const load = useCallback(async () => {
    try {
      setData(await apiJson('/api/ops/preparation'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  if (error) return <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>;
  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-3">
      <ScreenTitle />
      <div className="flex flex-wrap gap-3 text-sm">
        <Kpi label="منتجات للتجهيز" value={data.totals.products} />
        <Kpi label="طلبات" value={data.totals.orders} />
        <Kpi label="نواقص" value={data.totals.shortages} danger={data.totals.shortages > 0} />
        <span className="text-xs text-[var(--sys-muted-foreground)] self-center">
          {data.allowNegativeStock ? 'المخزون السالب مسموح مع تنبيه' : 'المخزون السالب ممنوع — النقص يمنع الشحن'}
        </span>
      </div>

      {data.groups.length > 0 && mayAskAssistant && <PickingAssistant />}

      {data.groups.length === 0 ? (
        <MissionDone why="لا توجد طلبات مؤكدة بانتظار التجهيز." />
      ) : (
        data.groups.map((g) => (
        <section key={g.productId} className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
          <button
            onClick={() => setClosed((c) => ({ ...c, [g.productId]: !c[g.productId] }))}
            className="w-full flex items-center gap-3 p-4 text-right hover:bg-[var(--sys-surface)]"
          >
            <span className="w-9 h-9 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] flex items-center justify-center">
              <RiArchiveDrawerLine className="w-4 h-4 text-[var(--sys-primary)]" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-[var(--sys-heading)] truncate">{g.productName}</span>
              <span className="block text-xs text-[var(--sys-muted-foreground)]">
                {g.orders} طلب · مطلوب {g.required} · متاح {g.available}
                {g.shortage > 0 && <span className="text-[var(--sys-destructive)]"> · نقص {g.shortage}</span>}
              </span>
            </span>
            {!closed[g.productId] ? <RiArrowDownSLine className="w-4 h-4 text-[var(--sys-muted-foreground)]" /> : <RiArrowLeftSLine className="icon-mirror w-4 h-4 text-[var(--sys-muted-foreground)]" />}
          </button>

          {!closed[g.productId] && (
            <div className="border-t border-[var(--sys-border)] p-3">
              {/* A packer reads this standing at a shelf. Six columns on a
                  phone is every cell wrapped to four lines; the same
                  definition gives a table on the packing desk and a card in
                  the hand, led by the order and the customer. */}
              <Rows
                rows={g.lines}
                keyOf={(l) => l.orderId}
                alert={(l) => l.reservedQty < l.quantity + l.freeQuantity}
                columns={[
                  {
                    key: 'order',
                    label: 'الطلب',
                    primary: true,
                    render: (l) => (
                      <span className="font-medium text-[var(--sys-heading)]" dir="ltr">{l.orderNumber}</span>
                    ),
                  },
                  { key: 'customer', label: 'العميل', primary: true, render: (l) => l.customerName },
                  { key: 'region', label: 'المحافظة', render: (l) => l.regionName ?? '—' },
                  {
                    key: 'qty',
                    label: 'الكمية',
                    align: 'end',
                    render: (l) => (
                      <span className="tabular-nums">
                        {l.quantity}
                        {l.freeQuantity > 0 && ` (+${l.freeQuantity})`}
                      </span>
                    ),
                  },
                  {
                    key: 'reserved',
                    label: 'محجوز',
                    align: 'end',
                    render: (l) => (
                      <span
                        className={`tabular-nums ${
                          l.reservedQty >= l.quantity + l.freeQuantity
                            ? 'text-[var(--sys-success)]'
                            : 'text-[var(--sys-destructive)]'
                        }`}
                      >
                        {l.reservedQty}
                      </span>
                    ),
                  },
                ]}
                actions={(l) => (
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    {mayOpenOrder && (
                      <button
                        type="button"
                        onClick={() => setOpenOrderId(l.orderId)}
                        title="افتح الطلب وعدّله — ما لم تكن بوليصته قد طُبعت"
                        aria-label="افتح الطلب"
                        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1 rounded-lg text-[var(--sys-muted)] hover:text-[var(--sys-primary)] hover:bg-[var(--sys-primary-soft)]"
                      >
                        <RiPencilLine className="w-4 h-4" />
                      </button>
                    )}
                    {mayCancel && (
                      <button
                        type="button"
                        onClick={() => setCancelling({ id: l.orderId, orderNumber: l.orderNumber })}
                        title="ألغِ الطلب — يعود المحجوز من بضاعته إلى المخزون"
                        aria-label="ألغِ الطلب"
                        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1 rounded-lg text-[var(--sys-muted)] hover:text-[var(--sys-destructive)] hover:bg-[var(--sys-destructive-soft)]"
                      >
                        <RiCloseCircleLine className="w-4 h-4" />
                      </button>
                    )}
                    {l.pendingChangeRequestId && (
                      <button
                        type="button"
                        onClick={() => setReviewing(l.pendingChangeRequestId!)}
                        title="طلب تعديل بانتظار البتّ — راجعه قبل التغليف"
                        className="min-h-11 md:min-h-0 inline-flex items-center inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--sys-warning)]/40 bg-[var(--sys-warning-soft)] text-xs font-semibold text-[var(--sys-warning)] hover:border-[var(--sys-warning)]"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--sys-warning)] animate-pulse" aria-hidden />
                        طلب تعديل
                      </button>
                    )}
                  </span>
                )}
              />
            </div>
          )}
        </section>
        ))
      )}

      <NextStepButton />

      {openOrderId && (
        <OrderDetailModal
          isOpen
          orderId={openOrderId}
          onClose={() => setOpenOrderId(null)}
          onRefresh={load}
        />
      )}

      {cancelling && (
        <RejectDialog
          open
          orderNumber={cancelling.orderNumber}
          busy={busy}
          onClose={() => setCancelling(null)}
          onSubmit={async (value) => {
            setBusy(true);
            setError(null);
            try {
              // Through the ordinary cancellation path: it checks whether
              // the parcel can still be taken off the shelf, releases the
              // reservation, and records who stopped it.
              const fresh = await apiJson<{ order: { version: number } }>(`/api/orders/${cancelling.id}`);
              await apiJson(`/api/orders/${cancelling.id}/confirmation`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'cancel',
                  note: `${value.rejectionReason}${value.note ? ` — ${value.note}` : ''}`,
                  expectedVersion: fresh.order.version,
                }),
              });
              setCancelling(null);
              await load();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'تعذر الإلغاء');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {reviewing && (
        <ChangeRequestReview
          requestId={reviewing}
          onClose={() => setReviewing(null)}
          onDecided={load}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className={`px-4 py-2 rounded-lg border ${danger ? 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)]' : 'bg-[var(--sys-card)] border-[var(--sys-border)]'}`}>
      <p className="text-xs text-[var(--sys-muted-foreground)]">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${danger ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-heading)]'}`}>{value}</p>
    </div>
  );
}
