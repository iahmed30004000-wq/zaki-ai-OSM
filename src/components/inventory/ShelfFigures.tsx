'use client';

import React, { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';

/**
 * «النقل من المتاح» (the owner, 27/11): beside each line of a new transfer, what the chosen warehouse has of the product —
 * «على الرف · محجوز · متاح», the server's figures (`/api/inventory/shelf`). The only thing judged here is whether what was
 * typed is more than «متاح», so the press waits and says why; the transfer door judges it again on its own, fresh.
 */

export interface ShelfFigure {
  onHand: number;
  held: number;
  free: number;
}
export type Shelf = Record<string, ShelfFigure>;

/** One warehouse's shelf; null while unknown (not chosen, loading, or the read failed — the door still judges). */
export function useShelf(warehouseId: string): Shelf | null {
  const [read, setRead] = useState<{ id: string; shelf: Shelf } | null>(null);
  useEffect(() => {
    if (!warehouseId) return;
    let live = true;
    Promise.resolve()
      .then(() => apiJson<{ products?: Shelf }>(`/api/inventory/shelf?warehouse=${encodeURIComponent(warehouseId)}`))
      .then(
        (a) => live && a?.products && setRead({ id: warehouseId, shelf: a.products }),
        () => undefined
      );
    return () => {
      live = false;
    };
  }, [warehouseId]);
  return read?.id === warehouseId ? read.shelf : null;
}

const NOTHING: ShelfFigure = { onHand: 0, held: 0, free: 0 };

/** Is the typed quantity more than the warehouse has free? Unknown shelf = not this screen's call. */
export function overFree(shelf: Shelf | null, productId: string, typed: string): boolean {
  if (!shelf || !productId || typed.trim() === '') return false;
  return Number(typed) > (shelf[productId] ?? NOTHING).free;
}

export function ShelfLine({ shelf, productId, typed, warehouseName }: { shelf: Shelf | null; productId: string; typed: string; warehouseName: string }) {
  if (!shelf || !productId) return null;
  const f = shelf[productId] ?? NOTHING;
  const over = overFree(shelf, productId, typed);
  return (
    <p data-shelf={productId} className={`text-note ${over ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-muted-foreground)]'}`}>
      بمخزن «{warehouseName}»: على الرف {f.onHand} · محجوز {f.held} · <span className="font-bold">متاح {f.free}</span>
      {over && ' — الكمية أكتر من المتاح.'}
    </p>
  );
}
