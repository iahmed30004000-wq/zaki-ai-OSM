'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RiArrowRightLine, RiExternalLinkLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { routeLabel } from '@/lib/route-registry';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { OrderRef } from '@/components/orders/OrderRef';
import { apiJson } from '@/lib/api-client';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { arDateTime } from '@/lib/format';
import { CART_AUTO_ACTION, CART_STATUS_AR, isCartStatus } from '@/lib/abandoned-cart-rules';
import {
  CartContact,
  CartStatusChip,
  CartStatusControls,
  ConvertCartButton,
  HasOrderMark,
  useCartConversion,
  type CartPowers,
  type CartRow,
} from '@/components/carts/cart-parts';

/**
 * «السلة» — ONE ABANDONED CART: what the visitor typed and where, what the team did with it, and the order it became.
 * Every press here is the list's, plus the three that need room: a note, a follow-up date, an assignment.
 */

interface Activity {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  metadata: string | null;
  createdAt: string;
  user: { id: string; name: string } | null;
}

interface Detail {
  cart: CartRow & {
    source: string;
    landingPageId: string | null;
    createdAt: string;
    order: { id: string; orderNumber: string; confirmationStatus: string; createdAt: string } | null;
    activities: Activity[];
  };
  people: { id: string; name: string }[];
  dialCode: string | null;
  may: CartPowers;
}

const statusWord = (s: string | null) => (s && isCartStatus(s) ? CART_STATUS_AR[s].label : s ?? '');

/** One history line in words. The door's lines (no person) are Zaki pages'. */
function activityText(a: Activity, people: Map<string, string>): string {
  const meta = (() => {
    try {
      return a.metadata ? (JSON.parse(a.metadata) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  switch (a.action) {
    case 'RECEIVED':
      return 'وصلت السلة من صفحة الهبوط';
    case 'UPDATED':
      return 'الزائر عدّل بياناته وانحدّثت السلة';
    case 'RECOVERED':
      return a.toStatus === 'CONVERTED'
        ? `الزبون طلب من الصفحة كمان${meta.orderNumber ? ` (${String(meta.orderNumber)})` : ''} — والسلة ضلّت «صارت طلب»`
        : `الزبون طلب لحاله${meta.orderNumber ? ` — ${String(meta.orderNumber)}` : ''}${meta.replaced ? ` (بدل الطلب التلقائي ${String(meta.replaced)})` : ''}`;
    case CART_AUTO_ACTION.SKIPPED:
      return `ما صارت طلب تلقائيًا — ${a.note ?? ''}`;
    case CART_AUTO_ACTION.STOOD_DOWN:
      return `الطلب التلقائي${meta.orderNumber ? ` ${String(meta.orderNumber)}` : ''} انلغى — ${a.note ?? ''}`;
    case 'STATUS_CHANGED':
      return `الحالة: ${statusWord(a.fromStatus)} ← ${statusWord(a.toStatus)}`;
    case 'NO_ANSWER':
      return 'اتصال وما رد';
    case 'NOTE':
      return a.note ?? '';
    case 'FOLLOW_UP':
      return meta.at ? `موعد متابعة: ${arDateTime(String(meta.at))}` : 'انشال موعد المتابعة';
    case 'ASSIGNED':
      return meta.to ? `انسندت لـ ${people.get(String(meta.to)) ?? 'موظف'}` : 'انشال الإسناد';
    case 'CONVERTED':
      return `${meta.auto ? 'صارت طلب تلقائيًا (فيها اسم ورقم)' : 'انحوّلت لطلب'}${meta.orderNumber ? ` ${String(meta.orderNumber)}` : ''}`;
    default:
      return a.action;
  }
}

/** A Date as the value a `datetime-local` box holds, in the browser's own zone. */
function localBox(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AbandonedCartDetailScreen({ id }: { id: string }) {
  const toast = useToast();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<Detail>(`/api/abandoned-carts/${id}`);
      setData(d);
      setFollowUp(localBox(d.cart.nextFollowUpAt));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ما قدرنا نجيب السلة');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);
  // Back on the tab after a call: read again, so the status a colleague set is the one shown.
  useLiveRefresh(load);

  const conversion = useCartConversion(load);

  const press = async (body: Record<string, unknown>, said: string) => {
    setBusy(true);
    try {
      await apiJson(`/api/abandoned-carts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast.done(said);
      await load();
      return true;
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'ما زبط');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-4" dir="rtl">
        <BackLink />
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-6 max-w-4xl mx-auto" dir="rtl">
        <SkeletonRows rows={4} />
      </div>
    );
  }

  const { cart, may, people, dialCode } = data;
  const names = new Map(people.map((p) => [p.id, p.name]));
  if (cart.assignedTo) names.set(cart.assignedTo.id, cart.assignedTo.name);

  const fact = (label: string, value: React.ReactNode) => (
    <div className="flex flex-col gap-0.5">
      <dt className="text-note text-[var(--sys-muted-foreground)]">{label}</dt>
      <dd className="text-sm text-[var(--sys-heading)]">{value || <span className="text-[var(--sys-muted)]">—</span>}</dd>
    </div>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6" dir="rtl">
      <BackLink />
      <PageHeader title={cart.customerName || 'سلة بلا اسم'} description={`سلة مهجورة من صفحة الهبوط — آخر نشاط ${arDateTime(cart.lastSeenAt)}`}>
        <div className="flex flex-wrap items-center gap-2">
          <CartStatusChip status={cart.status} />
          <HasOrderMark cart={cart} />
        </div>
      </PageHeader>

      {cart.hasOrder && (
        <p className="text-sm text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg p-3">
          نفس الرقم طلب نفس المنتج هالأسبوع:{' '}
          <OrderRef id={cart.hasOrder.id} number={cart.hasOrder.orderNumber} className="font-mono font-semibold text-[var(--sys-primary)]" /> — شوف الطلب قبل ما تتصل.
        </p>
      )}

      <section className="rounded-lg border border-[var(--sys-border)] p-4 space-y-4">
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {fact('الهاتف', <span dir="ltr" className="tabular-nums">{cart.phoneShown}</span>)}
          {fact('المدينة', cart.region?.name ?? cart.city)}
          {fact('المنتج', cart.productName)}
          {fact(
            'الصفحة',
            cart.landingPageUrl ? (
              <a href={cart.landingPageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[var(--sys-primary)] hover:underline">
                {cart.landingPageName || 'الصفحة'} <RiExternalLinkLine className="icon-mirror w-4 h-4" />
              </a>
            ) : (
              cart.landingPageName
            )
          )}
          {fact('أول ظهور', arDateTime(cart.firstSeenAt))}
          {fact('آخر نشاط', arDateTime(cart.lastSeenAt))}
          {fact('المحاولات', <span className="tabular-nums">{cart.attempts}</span>)}
          {fact('المسؤول', cart.assignedTo?.name ?? 'غير مسندة')}
          {fact('موعد المتابعة', cart.nextFollowUpAt ? arDateTime(cart.nextFollowUpAt) : null)}
          {fact(
            'الطلب المرتبط',
            cart.order ? <OrderRef id={cart.order.id} number={cart.order.orderNumber} className="font-mono font-semibold text-[var(--sys-primary)]" /> : null
          )}
        </dl>

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--sys-border)] pt-4">
          <CartContact cart={cart} dialCode={dialCode} />
          <CartStatusControls cart={cart} may={may} onChanged={load} />
          <ConvertCartButton cart={cart} may={may} onStart={conversion.start} />
        </div>

        {(may.work || may.assign) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-[var(--sys-border)] pt-4">
            {may.work && (
              // The kit's box (R10c): a day AND an hour, so it is the kit's `Input` and not `DateRange` (a span of days). The value,
              // the change and the body sent are the ones the raw box had.
              <div className="flex items-end gap-2">
                <Input id="cart-follow-up-at" label="موعد المتابعة" type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void press(
                      { action: 'follow_up', at: followUp ? new Date(followUp).toISOString() : null },
                      followUp ? 'انحفظ موعد المتابعة' : 'انشال موعد المتابعة'
                    )
                  }
                >
                  احفظ
                </Button>
              </div>
            )}
            {may.assign && (
              <Select
                id="cart-assignee"
                label="المسؤول"
                value={cart.assignedTo?.id ?? ''}
                disabled={busy}
                onChange={(e) => void press({ action: 'assign', userId: e.target.value || null }, e.target.value ? 'انسندت السلة' : 'انشال الإسناد')}
              >
                <option value="">غير مسندة</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-[var(--sys-border)] p-4 space-y-3">
        <h2 className="text-sm font-bold text-[var(--sys-heading)]">السجل والملاحظات</h2>
        {may.note && (
          <form
            className="flex flex-col sm:flex-row gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!note.trim()) return;
              if (await press({ action: 'note', text: note.trim() }, 'انحفظت الملاحظة')) setNote('');
            }}
          >
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="اكتب ملاحظة…"
              aria-label="ملاحظة"
              className="flex-1 rounded-lg border border-[var(--sys-border-strong)] bg-[var(--sys-card)] px-2 py-1 text-sm"
            />
            <Button type="submit" size="sm" disabled={busy || !note.trim()}>
              أضف ملاحظة
            </Button>
          </form>
        )}
        {cart.activities.length === 0 ? (
          <p className="text-sm text-[var(--sys-muted-foreground)]">لسا ما في شي بالسجل.</p>
        ) : (
          <ol className="space-y-2">
            {cart.activities.map((a) => (
              <li key={a.id} className="border-b border-[var(--sys-surface-strong)] pb-2 last:border-0">
                <p className={a.action === 'NOTE' ? 'whitespace-pre-wrap text-sm text-[var(--sys-heading)]' : 'text-sm text-[var(--sys-foreground)]'}>
                  {activityText(a, names)}
                </p>
                <p className="text-note text-[var(--sys-muted)]">
                  {a.user?.name ?? 'صفحات الهبوط'} · {arDateTime(a.createdAt)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {conversion.modal}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/abandoned-carts" className="inline-flex items-center gap-1 text-sm text-[var(--sys-primary)] hover:underline">
      <RiArrowRightLine className="icon-mirror w-4 h-4" /> {routeLabel('/abandoned-carts')}
    </Link>
  );
}
