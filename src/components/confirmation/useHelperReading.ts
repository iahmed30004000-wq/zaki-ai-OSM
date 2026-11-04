'use client';

import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import type { HelperReading } from '@/lib/call-outcome';

/** Asked again at these moments after she is back: the app may still be reading the call log, or sending. */
const TRIES_MS = [0, 2_500, 6_000, 12_000];
/** The app's clock starts the call a little after the press here, never long before it. */
const BEFORE_PRESS_MS = 30_000;

/**
 * «مساعد الاتصال» — WHAT HER PHONE READ OF THE CALL SHE HAS JUST COME BACK FROM, or null.
 *
 * `call` is set only when the call went through the app (the card carried `callHelperLink`) and she is back on the page.
 * The reading is the one for this order whose `startedAt` is not older than the press — a reading of an earlier call to
 * the same customer is not this call's. Read-only: nothing is recorded from it.
 */
export function useHelperReading(call: { orderId: string; startedAt: number } | null): HelperReading | null {
  const [reading, setReading] = useState<HelperReading | null>(null);
  const orderId = call?.orderId ?? null;
  const startedAt = call?.startedAt ?? null;

  useEffect(() => {
    setReading(null);
    if (!orderId || startedAt === null) return;
    let live = true;
    let found = false;
    const timers = TRIES_MS.map((ms) =>
      window.setTimeout(async () => {
        if (!live || found) return;
        try {
          const r = await apiJson<{ reading: HelperReading | null }>(`/api/call-helper/reading?orderId=${encodeURIComponent(orderId)}`);
          if (!live || found || !r.reading || r.reading.startedAt < startedAt - BEFORE_PRESS_MS) return;
          found = true;
          setReading(r.reading);
        } catch {
          // Nothing to show is not an error: the sheet keeps its own order.
        }
      }, ms)
    );
    return () => {
      live = false;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [orderId, startedAt]);

  return reading;
}
