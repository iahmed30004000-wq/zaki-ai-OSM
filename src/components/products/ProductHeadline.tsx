'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { RiArchiveLine, RiCoinsLine, RiLoader4Line } from '@remixicon/react';

/**
 * WHAT A PRODUCT IS OPENED TO FIND OUT.
 *
 * «لما أروح ع المنتج، متوسط تكلفة الوحدة مش موجود، المخزون مش موجود».
 *
 * Both were there — measured at the time: 108 of 114 products carry
 * batches and every batch is priced — but they sat in a panel below the
 * gallery, the information card, the sales card, the offers and the
 * production runs. A number nobody scrolls to is a number that is not
 * there, and the seller said so twice on two different pages of notes.
 *
 * So they are also at the top, beside the name. The SAME endpoint as the
 * panel below: one figure with two readings is the thing this codebase
 * refuses everywhere else, and a second query could answer differently.
 */

interface Stock {
  onHand: number;
  available: number;
  /** ABSENT (not zero) for a caller without `costs.view`. */
  averageCost?: number;
  currencyCode: string;
}

export function ProductHeadline({ productId }: { productId: string }) {
  const [stock, setStock] = useState<Stock | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setStock(await apiJson<Stock>(`/api/products/${productId}/stock`));
    } catch {
      // The panel below says why. A headline that turns into an error
      // message pushes the product's name off the first screen.
      setFailed(true);
    }
  }, [productId]);

  useEffect(() => { void load(); }, [load]);

  if (failed) return null;

  const money = (n: number) =>
    `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${stock?.currencyCode ?? ''}`.trim();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!stock ? (
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-border)] px-3 py-1.5 text-xs text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-4 w-4 animate-spin" aria-hidden /> جارٍ القراءة…
        </span>
      ) : (
        <>
          {/* Available, not on-hand: what is on the shelf minus what is
              already promised to an order is the number anybody deciding
              anything actually needs. */}
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-1.5">
            <RiArchiveLine className="h-4 w-4 text-[var(--sys-primary)]" aria-hidden />
            <span className="text-xs text-[var(--sys-muted-foreground)]">متاح</span>
            <b className="text-sm tabular-nums text-[var(--sys-heading)]">{stock.available}</b>
            <span className="text-xs text-[var(--sys-muted)]">من {stock.onHand}</span>
          </span>

          {/* The weighted average of the stock actually on hand — a March
              run at 3.20 and a June one at 3.60 are one product and two
              costs, and the average is what a sale is measured against. */}
          {stock.averageCost !== undefined && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-1.5">
            <RiCoinsLine className="h-4 w-4 text-[var(--sys-warning)]" aria-hidden />
            <span className="text-xs text-[var(--sys-muted-foreground)]">متوسط كلفة الوحدة</span>
            <b className="text-sm tabular-nums text-[var(--sys-heading)]" dir="ltr">{money(stock.averageCost)}</b>
          </span>
          )}
        </>
      )}
    </div>
  );
}
