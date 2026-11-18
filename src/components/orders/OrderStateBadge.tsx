'use client';

import React from 'react';
import { OrderStateChip } from '@/components/ui/StatusChip';

/**
 * Kept as a name, not as a second implementation.
 *
 * Five screens import this. What it used to hold — a sixteen-entry map of
 * Arabic words and CSS classes — was a SECOND copy of something
 * `order-state.ts` already said, and the two had drifted: six states were
 * spelled differently depending on which screen you were looking at. The
 * words and the tones now come from that one place, and the chip that draws
 * them is `ui/StatusChip`.
 *
 * The cancellation split lives there too. It is the one thing this badge
 * ever decided that was worth deciding.
 */
export function OrderStateBadge({ state, beforeShipping, testStore }: { state: string; beforeShipping?: boolean; testStore?: boolean }) {
  return <OrderStateChip state={state} beforeShipping={beforeShipping} testStore={testStore} />;
}
