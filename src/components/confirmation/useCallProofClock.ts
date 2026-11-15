'use client';

import { useEffect, useState } from 'react';

/**
 * A ONE-SECOND TICK THAT STOPS BY ITSELF («إثبات المكالمات»).
 *
 * The desk's «لا يرد» waits for thirty seconds after her «اتصال»; the card says how many are left. `until` is the phone-clock instant of the LAST card's unlock
 * (null = no card is waiting): with nothing to wait for there is no timer at all, so a desk with the proof off pays nothing, and once the instant has passed the
 * tick stops — an idle desk never re-draws itself every second. Returns the phone's clock as of the last tick (state, so a render never reads the clock
 * itself); the caller adds the server's offset.
 */
export function useCallProofClock(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const tick = () => {
      const n = Date.now();
      setNow(n);
      return n >= until;
    };
    if (tick()) return;
    const t = setInterval(() => {
      if (tick()) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [until]);
  return now;
}
