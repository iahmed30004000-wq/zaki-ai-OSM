'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiLoader4Line } from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { OrderLink } from '@/components/orders/OrderLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { PullPanel, useQueue } from '@/components/confirmation/PullPanel';
import { CONFIRMATION_STATUS_AR, type ConfirmationStatus } from '@/lib/confirmation-workflow';

/**
 * /confirmation/queue — THE SUPERVISOR'S VIEW OF THE POOL.
 *
 * An agent no longer comes here: «اسحب الطلب التالي» sits at the top of
 * «طلباتي», where she works, so pulling does not send her anywhere (and the
 * menu does not offer her this page — the registry gives it to
 * `confirmation.supervise` alone, and the page sends anybody else to
 * «طلباتي»). What stays is what only a supervisor needs: the same counter and
 * the rows behind it, which are the same data. A supervisor who ALSO pulls
 * finds the button on the panel, and pressing it takes her to what she pulled.
 */

export function ConfirmationQueueScreen() {
  const router = useRouter();
  const queue = useQueue(true);
  const { data } = queue;

  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <ScreenTitle />
      <PullPanel queue={queue} onPulled={() => router.push('/confirmation/mine')} />

      {data.orders && (
        <section className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
          <header className="px-4 py-3 border-b border-[var(--sys-border)] text-sm font-semibold text-[var(--sys-heading)]">
            عرض المشرف — نفس الطلبات المنتظرة ({data.orders.length})
          </header>
          <Rows
            rows={data.orders}
            keyOf={(o) => o.id}
            columns={[
              {
                key: 'order',
                label: 'الطلب',
                primary: true,
                render: (o) => (
                  <OrderLink id={o.id} number={o.orderNumber} className="font-medium text-[var(--sys-heading)]" />
                ),
              },
              {
                key: 'customer',
                label: 'العميل',
                primary: true,
                render: (o) => `${o.customer.fullName} · ${o.customer.city}`,
              },
              { key: 'state', label: 'الحالة', render: (o) => CONFIRMATION_STATUS_AR[o.confirmationStatus as ConfirmationStatus] ?? 'غير معروفة' },
              // A returning customer's order, held for the agent who worked him last (order-reservation.ts). «—» when it is everybody's.
              { key: 'heldFor', label: 'تابع لـ', render: (o) => o.reservedFor?.name ?? '—' },
              {
                key: 'postponed',
                label: 'التأجيلات',
                align: 'end',
                render: (o) => <span className="tabular-nums">{o.postponeCount}</span>,
              },
            ]}
            empty={
              <EmptyState
                title="لا طلبات تنتظر التأكيد"
                why="الطابور يمتلئ حين تصل طلباتٌ جديدة. فراغُه يعني أنّ كلّ ما وصل قد سُحب."
              />
            }
          />
        </section>
      )}
    </div>
  );
}
