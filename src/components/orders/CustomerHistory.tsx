'use client';

import React, { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { OrderStateBadge } from './OrderStateBadge';
import { OrderLink } from './OrderLink';
import { arDate } from '@/lib/format';
import { RiHistoryLine, RiLoader4Line, RiShieldFlashLine } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';

/**
 * "Has this customer ordered before?" — a small counter next to the order
 * that opens the customer's history and, for the current order, its merged
 * timeline. The customer is company-wide, so the history crosses stores:
 * an order returned elsewhere is still a returned order.
 */

interface HistoryOrder {
  id: string;
  orderNumber: string;
  /** Who holds it now — the route already sends it; see `holderId` below. */
  claimedById?: string | null;
  createdAt: string;
  state: string;
  totalAmount: number;
  currency: string;
  rejectionReason: string | null;
  returnReason: string | null;
  store: { name: string } | null;
  items: { productName: string; quantity: number; freeQuantity: number }[];
}

interface HistoryResponse {
  customer: { fullName: string; rawPhone: string; totalOrders: number; deliveredOrders: number; cancelledOrders: number };
  /** ABSENT without `insights.view` — the return-risk tier is a smart card. */
  risk?: { tier: 'SAFE' | 'WATCH' | 'HIGH'; returnRate: number; orders: number; returns: number; requiresPrepaymentOrApproval: boolean };
  orders: HistoryOrder[];
}


const RISK: Record<string, { text: string; cls: string }> = {
  SAFE: { text: 'خطورة منخفضة', cls: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/30' },
  WATCH: { text: 'تحت المراقبة', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30' },
  HIGH: { text: 'خطورة عالية', cls: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]' },
};

/**
 * `holderId` — the viewer, when she works the orders she holds
 * (`confirmation.work`). One of this customer's other orders that she holds
 * then opens on her desk even without «عرض الطلبات» (see `OrderLink`);
 * every other number stays as `OrderLink` decides.
 */
type Holder = { holderId?: string | null };

/** Small counter button: "سجل 3". Renders nothing distracting at zero. */
export function CustomerHistoryButton({
  customerId,
  orderId,
  previousOrders,
  label = 'السجل',
  holderId,
}: {
  customerId: string;
  orderId?: string;
  /**
   * Optional: a list whose rows do not carry the customer's order count
   * (postponed, win-back) offers the same button WITHOUT a number rather than
   * a made-up zero — «0» would say «عميل جديد» of a customer nobody counted.
   */
  previousOrders?: number;
  label?: string;
} & Holder) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={
          previousOrders === undefined
            ? 'طلبات هذا العميل السابقة'
            : previousOrders > 0
              ? `${previousOrders} طلب سابق لهذا العميل`
              : 'عميل جديد — لا طلبات سابقة'
        }
        className={`min-h-11 md:min-h-0 inline-flex items-center inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs ${
          previousOrders === undefined || previousOrders > 0
            ? 'bg-[var(--sys-surface)] border-[var(--sys-border)] text-[var(--sys-foreground)] hover:border-[var(--sys-primary)]'
            : 'bg-[var(--sys-card)] border-[var(--sys-border)] text-[var(--sys-muted)] hover:border-[var(--sys-primary)]'
        }`}
      >
        <RiHistoryLine className="w-4 h-4" />
        {label}
        {previousOrders !== undefined && <span className="tabular-nums" dir="ltr">{previousOrders}</span>}
      </button>

      {open && (
        <CustomerHistoryModal customerId={customerId} orderId={orderId} holderId={holderId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export function CustomerHistoryModal({
  customerId,
  orderId,
  onClose,
  holderId,
}: {
  customerId: string;
  orderId?: string;
  onClose: () => void;
} & Holder) {
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // This customer's OTHER orders, and nothing else. The order's own history
  // lives inside the order, where it belongs — two tabs here meant the
  // button answered two questions and you never knew which you would get.
  useEffect(() => {
    const q = orderId ? `?exclude=${orderId}` : '';
    apiJson<HistoryResponse>(`/api/customers/${customerId}/history${q}`)
      .then(setHistory)
      .catch((e) => setError(e instanceof Error ? e.message : 'تعذر تحميل السجل'));
  }, [customerId, orderId]);

  return (
    <Modal isOpen onClose={onClose} title="طلبات العميل السابقة" subtitle={history?.customer.fullName} maxWidth="2xl">
      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3 mb-3">{error}</p>}

      {history && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {history.risk && (
            <span className={`text-xs px-2 py-0.5 rounded-md border ${RISK[history.risk.tier].cls}`}>
              {RISK[history.risk.tier].text} · {Math.round(history.risk.returnRate * 100)}% مرتجع من {history.risk.orders} طلب
            </span>
          )}
          <span className="text-xs text-[var(--sys-muted-foreground)]">
            إجمالي {history.customer.totalOrders} · مسلّم {history.customer.deliveredOrders} · ملغى{' '}
            {history.customer.cancelledOrders}
          </span>
          {history.risk?.requiresPrepaymentOrApproval && (
            <span className="flex items-center gap-1 text-xs text-[var(--sys-destructive)]">
              <RiShieldFlashLine className="w-4 h-4" /> يتطلب دفعاً مسبقاً أو موافقة مشرف
            </span>
          )}
        </div>
      )}

      {!history ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-10">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : (
        <div className="space-y-2">
          {history?.orders.length === 0 && (
            <p className="text-sm text-[var(--sys-muted-foreground)]">
              هذا أوّل طلبٍ لهذا الرقم — لا سجلَّ سابقاً يُقاس عليه قبولٌ أو رفض.
            </p>
          )}
          {history?.orders.map((o) => (
            <article key={o.id} className="border border-[var(--sys-border)] rounded-lg p-3">
              <header className="flex flex-wrap items-center gap-2 text-sm">
                <OrderLink
                  id={o.id}
                  number={o.orderNumber}
                  opensOnHerDesk={!!holderId && o.claimedById === holderId}
                  className="font-medium text-[var(--sys-heading)]"
                />
                <OrderStateBadge state={o.state} />
                <span className="text-xs text-[var(--sys-muted-foreground)]" dir="ltr">
                  {arDate(o.createdAt)}
                </span>
                {o.store && <span className="text-xs text-[var(--sys-muted)]">{o.store.name}</span>}
                <span className="mr-auto tabular-nums text-[var(--sys-heading)]" dir="ltr">
                  <Money value={o.totalAmount} currency={o.currency} />
                </span>
              </header>
              <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">
                {o.items.map((i) => `${i.productName} × ${i.quantity + i.freeQuantity}`).join(' · ')}
              </p>
              {(o.rejectionReason || o.returnReason) && (
                <p className="mt-1 text-xs text-[var(--sys-destructive)]">{o.returnReason ?? o.rejectionReason}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}


/**
 * THE SAME BUTTON, DRAWN ONLY FOR WHOEVER THE DOOR WILL ANSWER.
 *
 * `GET /api/customers/:id/history` opens for the address book's key
 * (`customers.view`) or, from an order, for the person who works it
 * (`confirmation.work` — the work door in `order-work-door.ts`). Anyone else
 * got «سجلّ العميل ليس من صلاحيّاتك» after pressing a button that promised a
 * list, so on the lists that did not have this button until now it is not
 * drawn for them. The door still decides on its own; this only decides whether
 * to offer. It needs the order too, because that is what the work door reads.
 */
export function CustomerHistoryOffer(props: React.ComponentProps<typeof CustomerHistoryButton>) {
  const { currentUser } = useApp();
  if (!props.orderId) return null;
  if (!userCan(currentUser, 'customers.view') && !userCan(currentUser, 'confirmation.work')) return null;
  return <CustomerHistoryButton {...props} />;
}
