// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { OrderStateBadge } from './OrderStateBadge';
import { OrderStateChip } from '@/components/ui/StatusChip';
import { BENCH_CONFIRMED_AR } from '@/lib/test-store';
import { STATE_LABEL_AR } from '@/lib/order-state';

/**
 * «مؤكَّد — تيست، ما بينشحن» (B2, 18/11).
 *
 * The badge every list, the order's detail and the desk card draw. A confirmed order of a bench store stops there, and
 * the word says so — DERIVED from `Store.isTest`, which the screens pass as `testStore`; there is no state of its own.
 * Rendered, not read from source: what a person sees is the text in the chip.
 */

afterEach(cleanup);

const text = (el: React.ReactElement) => render(el).container.textContent;

describe('the state chip of a bench order', () => {
  it('a confirmed bench order reads the owner’s sentence', () => {
    expect(text(<OrderStateBadge state="CONFIRMED" testStore />)).toBe(BENCH_CONFIRMED_AR);
    expect(text(<OrderStateChip state="CONFIRMED" testStore />)).toBe(BENCH_CONFIRMED_AR);
  });

  it('NEGATIVE: a real store’s confirmed order reads «مؤكد», as before', () => {
    expect(text(<OrderStateBadge state="CONFIRMED" />)).toBe(STATE_LABEL_AR.CONFIRMED);
    expect(text(<OrderStateBadge state="CONFIRMED" testStore={false} />)).toBe(STATE_LABEL_AR.CONFIRMED);
  });

  it('NEGATIVE: a bench order in any other state keeps its own word — the sentence is about confirmation only', () => {
    for (const s of ['NEW', 'CLAIMED', 'NO_ANSWER', 'POSTPONED', 'CANCELLED', 'SHIPPED', 'DELIVERED'] as const) {
      expect(text(<OrderStateBadge state={s} testStore />), s).toBe(STATE_LABEL_AR[s]);
    }
  });
});
