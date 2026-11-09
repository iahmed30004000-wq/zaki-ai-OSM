'use client';

import React from 'react';
import { HealthChip } from '@/components/ui/HealthChip';
import { SAID_TONE, saidChipLabel, saidHint, saidTitle, saidWhen, type SaidOnTheRow } from '@/lib/parcel-tracking/said';

/**
 * «الشركة بتقول: تم التوصيل» — WHAT THE DELIVERY COMPANY ALREADY SAYS, BESIDE THE REASON THE ROW IS IN FRONT OF YOU.
 *
 * The company is asked every two minutes, and a parcel our own state still shows on the road may have been delivered
 * for days: the girls chasing it could not see that, and rang a customer who had the goods. The word is only SHOWN — the
 * state, the lateness and the rank are untouched, and the person at the door or the statement still writes the outcome.
 *
 * Three lines, the same on a desk and on a card (the card's heading is this column): the chip with the company's own name
 * for what it said, how old the word is with the company's free note when it wrote one, and — for a part delivery only —
 * the act that cannot wait for the statement. The words are the server's (`said`) and the library's; this draws.
 */
export function CourierSaidChip({ said }: { said: SaidOnTheRow }) {
  const hint = saidHint(said);
  return (
    <>
      <HealthChip className="mt-1 flex" health={{ tone: SAID_TONE[said.status], label: saidChipLabel(said), why: saidTitle(said) }} />
      <span className="mt-1 block max-w-xs break-words text-xs font-normal text-[var(--sys-muted-foreground)]">{saidWhen(said)}</span>
      {hint && <span className="mt-1 block text-xs font-medium text-[var(--sys-warning)]">{hint}</span>}
    </>
  );
}
