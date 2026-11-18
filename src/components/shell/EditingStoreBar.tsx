'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { RiStore2Line } from '@remixicon/react';
import { Card } from '@/components/ui/Card';

/**
 * «عم تعدّل: <المتجر>» — ONE BAR, EVERY STOREFRONT SCREEN.
 *
 * Eight screens used to edit whichever store the header cookie happened
 * to hold without saying which — and /store/domain attaches a real
 * hostname to it. This bar names the store and carries its switcher, so
 * the seller always knows and can move. It reads /api/context like the
 * entry picker does and switches the same way, then reloads: the screens
 * below read the selected store on the server.
 *
 * Mounted once, in the store layout — not copied into ten screens.
 */
interface StoreRow {
  id: string;
  name: string;
  countryId?: string;
}

interface ContextResponse {
  stores: StoreRow[];
  selection: { countryId: string; storeId: string | null } | null;
}

export function EditingStoreBar() {
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [countryId, setCountryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiJson<ContextResponse>('/api/context');
      setStores(res.stores || []);
      setCurrentId(res.selection?.storeId ?? null);
      setCountryId(res.selection?.countryId ?? null);
    } catch {
      /* a bar that cannot load stays silent — the screens load themselves */
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!currentId) return null;
  const current = stores.find((s) => s.id === currentId);

  async function switchStore(id: string) {
    if (!id || id === currentId || !countryId) return;
    setBusy(true);
    try {
      await apiJson('/api/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryId, storeId: id }),
      });
      window.location.reload();
    } catch {
      setBusy(false);
    }
  }

  return (
    // The kit's plain card (a strip above the store's tabs, no theme ornament). It takes no `dir`; the page is
    // right-to-left from its root.
    <Card plain className="mb-3 flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-bold text-[var(--sys-heading)]">
        <RiStore2Line className="h-4 w-4 shrink-0 text-[var(--sys-primary)]" />
        عم تعدّل: <span className="truncate">{current?.name ?? '…'}</span>
      </span>
      {stores.length > 1 && (
        <select
          aria-label="بدّل المتجر"
          value={currentId}
          disabled={busy}
          onChange={(e) => void switchStore(e.target.value)}
          className="h-11 md:h-10 min-w-0 max-w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-surface)] px-2 text-sm text-[var(--sys-heading)] disabled:opacity-50"
        >
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
    </Card>
  );
}
