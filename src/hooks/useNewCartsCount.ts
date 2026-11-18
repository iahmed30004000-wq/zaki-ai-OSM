'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';

/** Once a minute is fresh enough for a cart Zaki pages sends fifteen minutes after the visitor left. */
const EVERY_MS = 60_000;

/**
 * THE NUMBER ON «السلات المهجورة» IN THE MENU — the NEW carts this person may see in this store.
 *
 * Asked only while the menu draws that line (`enabled`): a person who may not open the screen never asks. A hidden tab
 * does not ask either, and a refused or failed answer leaves the badge empty rather than wrong.
 */
export function useNewCartsCount(enabled: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    // A tick never asks on top of its own question (H2, 18/11 — the header polls' rule): while the last read is still out, the next tick does nothing.
    let inFlight = false;
    const read = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await apiFetch('/api/abandoned-carts/summary');
        if (!res.ok) return;
        const body = (await res.json()) as { new?: unknown };
        if (alive && typeof body.new === 'number') setCount(body.new);
      } catch {
        /* the menu works without the number */
      } finally {
        inFlight = false;
      }
    };
    void read();
    const timer = setInterval(read, EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled]);

  return enabled ? count : 0;
}
