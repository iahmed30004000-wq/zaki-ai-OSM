import React from 'react';

/**
 * ONE PRODUCT, WAREHOUSE BY WAREHOUSE — «على الرف · محجوز · متاح» (the owner, 27/11: «لازم متاح محجوز و ع الرف لكل مخزن»),
 * on a placed store's balance card. Every figure is the server's (`warehouse-figures.ts`); nothing is added up here.
 *
 *   على الرف   in that warehouse's books
 *   محجوز      held by orders on a shipment from it, until delivered (and by an exit or a transfer waiting for approval)
 *   متاح       what is free in it now
 *
 * Under the table, only when there is something to say: the units on the road between two warehouses, the confirmed orders
 * that are in no shipment yet (reserved for the store, in no warehouse yet), and old stock that still has no warehouse.
 */

export interface ShownWarehouses {
  warehouses: { id: string; onHand: number; held?: number; free?: number; pending?: number }[];
  unassigned?: number;
  unsourcedWithCourier?: number;
  inTransit: number;
  unplaced?: number;
}

function Chip({ label, value, title }: { label: string; value: number; title: string }) {
  return (
    <span className="inline-block rounded-full bg-[var(--sys-surface-strong)] px-2 py-0.5 text-note font-semibold text-[var(--sys-foreground)]" title={title}>
      {label} · {value}
    </span>
  );
}

export function WarehouseTable({ places, nameOf, chosen }: { places: ShownWarehouses; nameOf: (id: string) => string; chosen: string }) {
  return (
    <div className="space-y-2">
      {places.warehouses.length > 0 && (
        <ul className="space-y-1.5">
          {places.warehouses.map((x) => (
            <li
              key={x.id}
              data-warehouse={x.id}
              className={`rounded-lg bg-[var(--sys-surface)] px-2 py-1.5 ${chosen === x.id ? 'ring-2 ring-[var(--sys-primary)]' : ''}`}
            >
              <p className="text-note font-bold text-[var(--sys-heading)]">{nameOf(x.id)}</p>
              <dl className="grid grid-cols-3 gap-1 text-center text-note">
                <div>
                  <dt className="text-[var(--sys-muted-foreground)]">على الرف</dt>
                  <dd data-figure="onHand" className="font-semibold text-[var(--sys-foreground)]">{x.onHand}</dd>
                </div>
                <div title={x.pending ? `منها ${x.pending} بإخراج أو نقل ناطر اعتماد` : undefined}>
                  <dt className="text-[var(--sys-muted-foreground)]">محجوز</dt>
                  <dd data-figure="held" className="font-semibold text-[var(--sys-foreground)]">{x.held ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-[var(--sys-muted-foreground)]">متاح</dt>
                  <dd data-figure="free" className={`font-bold ${(x.free ?? 0) < 0 ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-foreground)]'}`}>
                    {x.free ?? '—'}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        {places.inTransit !== 0 && <Chip label="بالطريق" value={places.inTransit} title="بضاعة طالعة من مخزن ولسا ما وصلت المخزن التاني." />}
        {!!places.unassigned && (
          <Chip label="محجوز لسا بلا مخزن" value={places.unassigned} title="طلبات مؤكَّدة لسا ما دخلت شحنة: محجوزة من متاح المتجر، وبتصير على مخزن لما تدخل شحنة منه." />
        )}
        {!!places.unsourcedWithCourier && (
          <Chip label="مع الشحن بلا مخزن" value={places.unsourcedWithCourier} title="قطع طلبات طلعت وما إلها مخزن مسجّل." />
        )}
        {places.unplaced !== undefined && places.unplaced !== 0 && (
          <Chip label="بلا مكان" value={places.unplaced} title="قطع بالدفتر ما إلها مخزن." />
        )}
      </div>
    </div>
  );
}
