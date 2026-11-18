'use client';

import React, { useState } from 'react';
import { RiPhoneLine, RiWhatsappLine, RiShoppingCartLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { CreateOrderModal } from '@/components/orders/CreateOrderModal';
import { apiJson } from '@/lib/api-client';
import { whatsappLink } from '@/lib/message-templates';
import { CART_STATUS_AR, HAND_STATUSES, cartWhatsappText, isCartStatus, isClosedCart } from '@/lib/abandoned-cart-rules';

/**
 * «السلات المهجورة» — THE PIECES THE LIST AND THE CART'S PAGE SHARE: the status chip, the call and WhatsApp links, the
 * status picker with «ما رد», and «حوّل لطلب».
 */

export interface CartPowers {
  work: boolean;
  note: boolean;
  assign: boolean;
  convert: boolean;
  settings: boolean;
}

export interface CartRow {
  id: string;
  externalId: string;
  landingPageName: string | null;
  landingPageUrl: string | null;
  productId: string | null;
  productName: string | null;
  customerName: string | null;
  phone: string;
  phoneShown: string;
  city: string | null;
  country: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  status: string;
  attempts: number;
  nextFollowUpAt: string | null;
  region: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  order: { id: string; orderNumber: string } | null;
  hasOrder: { id: string; orderNumber: string } | null;
}

export function CartStatusChip({ status }: { status: string }) {
  const s = isCartStatus(status) ? CART_STATUS_AR[status] : null;
  return <StatusChip tone={s?.tone ?? 'neutral'}>{s?.label ?? status}</StatusChip>;
}

/** «اتصال» and «واتساب», the message already written with the product's name. No WhatsApp for a number with no country. */
export function CartContact({ cart, dialCode }: { cart: CartRow; dialCode: string | null }) {
  const tel = `tel:${cart.phoneShown.replace(/[^\d+]/g, '')}`;
  const wa = whatsappLink(cart.phoneShown, dialCode, cartWhatsappText(cart.customerName, cart.productName));
  return (
    <div className="flex items-center gap-2">
      <a
        href={tel}
        className="inline-flex min-h-11 md:min-h-0 items-center gap-1 rounded-lg border border-[var(--sys-border)] px-2 py-1 text-note font-semibold text-[var(--sys-foreground)] hover:bg-[var(--sys-surface)]"
      >
        <RiPhoneLine className="w-4 h-4" /> اتصال
      </a>
      {wa ? (
        <a
          href={wa}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 md:min-h-0 items-center gap-1 rounded-lg border border-[var(--sys-border)] px-2 py-1 text-note font-semibold text-[var(--sys-success)] hover:bg-[var(--sys-success-soft)]"
        >
          <RiWhatsappLine className="w-4 h-4" /> واتساب
        </a>
      ) : (
        <span className="text-note text-[var(--sys-muted)]" title="الرقم بلا رمز بلد">واتساب غير متاح</span>
      )}
    </div>
  );
}

/** The status picker and «ما رد» — a closed cart (it became an order) shows neither. */
export function CartStatusControls({
  cart,
  may,
  onChanged,
}: {
  cart: Pick<CartRow, 'id' | 'status' | 'attempts'>;
  may: CartPowers;
  onChanged: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!may.work || isClosedCart(cart.status)) return null;

  const send = async (body: Record<string, unknown>, said: string) => {
    setBusy(true);
    try {
      await apiJson(`/api/abandoned-carts/${cart.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast.done(said);
      await onChanged();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'ما زبط التغيير');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => send({ action: 'no_answer' }, `ما رد — المحاولة ${cart.attempts + 1}`)}>
        ما رد
      </Button>
      <select
        aria-label="حالة السلة"
        value=""
        disabled={busy}
        onChange={(e) => {
          const next = e.target.value;
          if (next) void send({ action: 'status', status: next }, `صارت «${CART_STATUS_AR[next as keyof typeof CART_STATUS_AR]?.label ?? next}»`);
        }}
        className="min-h-11 md:min-h-0 rounded-lg border border-[var(--sys-border-strong)] bg-[var(--sys-card)] px-2 py-1 text-note"
      >
        <option value="">غيّر الحالة…</option>
        {HAND_STATUSES.filter((s) => s !== cart.status).map((s) => (
          <option key={s} value={s}>
            {CART_STATUS_AR[s].label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * «حوّل لطلب» — THE ORDINARY ORDER FORM, FILLED FROM THE CART.
 *
 * The order is created by the form's own door (`POST /api/orders`), exactly as a typed order. Only when it answers with
 * the new order is the cart tied to it (`POST /api/abandoned-carts/:id/convert`). If that second call fails, the order
 * still exists and the message says so — the cart can be tied again from its page.
 */
export function useCartConversion(onConverted: () => void | Promise<void>) {
  const toast = useToast();
  const [cart, setCart] = useState<CartRow | null>(null);

  const tie = async (target: CartRow, order?: { id: string; orderNumber?: string }) => {
    if (!order?.id) return;
    try {
      await apiJson(`/api/abandoned-carts/${target.id}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.id }),
      });
      toast.done(`السلة صارت الطلب ${order.orderNumber ?? ''}`.trim());
    } catch (e) {
      toast.warn(`انعمل الطلب ${order.orderNumber ?? ''} بس ما انربطت السلة فيه`.trim(), e instanceof Error ? e.message : undefined);
    }
    await onConverted();
  };

  // ONE form for the whole screen, whichever row asked: the form reads the regions and the catalogue when it mounts.
  const modal = (
    <CreateOrderModal
      isOpen={cart !== null}
      onClose={() => setCart(null)}
      onSuccess={(order) => {
        if (cart) void tie(cart, order);
      }}
      prefill={
        cart
          ? {
              customerName: cart.customerName,
              customerPhone: cart.phoneShown,
              regionId: cart.region?.id ?? null,
              city: cart.city,
              productId: cart.productId,
              internalNotes: `من سلة مهجورة${cart.landingPageName ? ` — صفحة «${cart.landingPageName}»` : ''}`,
            }
          : undefined
      }
    />
  );

  return { start: setCart, modal };
}

export function ConvertCartButton({ cart, may, onStart }: { cart: CartRow; may: CartPowers; onStart: (cart: CartRow) => void }) {
  if (!may.convert || isClosedCart(cart.status)) return null;
  return (
    <Button size="sm" onClick={() => onStart(cart)}>
      <RiShoppingCartLine className="w-4 h-4 ml-1" /> حوّل لطلب
    </Button>
  );
}

/** «له طلب»: the same phone ordered the same product in the last seven days — say it before anybody calls. */
export function HasOrderMark({ cart }: { cart: Pick<CartRow, 'hasOrder'> }) {
  if (!cart.hasOrder) return null;
  return (
    <StatusChip tone="good" title={`الطلب ${cart.hasOrder.orderNumber}`}>
      له طلب
    </StatusChip>
  );
}
