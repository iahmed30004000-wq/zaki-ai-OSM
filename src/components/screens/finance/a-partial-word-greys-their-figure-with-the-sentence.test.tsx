// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * THE SCREEN SAYS WHY THEIR FIGURE IS GREY WHEN THE COMPANY CALLS A PARCEL «PARTIAL».
 *
 * The verdicts here are not typed by hand: they are what the REAL matrix answers for a parcel on the road whose line reads
 * «تم توصيلها بشكل جزئي», handed to the REAL screen part. The screen prints the first sentence it finds among the refused
 * sayings in its own order (their figure, ours, the parking), so the person reads the one that says what to do — «استلم جزءاً» —
 * and not the second refusal behind it. Once the order is recorded partial, the same row offers the answer again.
 */
vi.mock('@/lib/api-client', () => ({ apiJson: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { DifferenceActions } from './DifferenceActions';
import { WHY, decisionMatrix, type DecisionFacts } from '@/lib/settlement-decisions';

const facts = (over: Partial<DecisionFacts> = {}): DecisionFacts => ({
  hasOrder: true,
  shippingStatus: 'SHIPPED',
  settlementStatus: 'PENDING_COLLECTION',
  openRequests: [],
  claimedElsewhere: false,
  statementApproved: false,
  expectedAmount: 20,
  statementAmount: 18,
  courierOutcome: 'PARTIAL',
  minorUnit: 3,
  ...over,
});

const props = (over: Record<string, unknown> = {}) => ({
  statementId: 's1', matchId: 'm1', orderId: 'o1', orderNumber: 'ORD-1', resolution: null, resolutionNote: null,
  onResolved: vi.fn(), ...over,
});

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

afterEach(cleanup);

describe('a parcel on the road that the company calls partial', () => {
  it('their figure is grey and the sentence beside it says what to do first; the parking stays open', () => {
    render(<DifferenceActions {...props({ decisions: decisionMatrix(facts()) })} />);
    expect(button(/اعتُمد رقم الشركة/).disabled).toBe(true);
    expect(button(/رقمنا هو المعتمد/).disabled).toBe(true);
    expect(button('قيد المراجعة').disabled).toBe(false);
    expect(screen.getByText(WHY.partialFirst)).toBeTruthy();
  });

  it('and it is the ONLY sentence: the second refusal (a claim before delivery) is not printed beside it', () => {
    render(<DifferenceActions {...props({ decisions: decisionMatrix(facts()) })} />);
    expect(screen.queryByText(WHY.notDeliveredYet)).toBeNull();
  });
});

describe('the same line once the follow-up has recorded «استلم جزءاً»', () => {
  it('the order is partially delivered: their figure is offered again and no refusal is printed for it', () => {
    render(<DifferenceActions {...props({ decisions: decisionMatrix(facts({ shippingStatus: 'PARTIALLY_DELIVERED' })) })} />);
    expect(button(/اعتُمد رقم الشركة/).disabled).toBe(false);
    expect(screen.queryByText(WHY.partialFirst)).toBeNull();
  });
});

describe('every other reading on the road is offered as before', () => {
  it('«تم توصيلها» (a delivery) leaves their figure open and prints no sentence about the word', () => {
    render(<DifferenceActions {...props({ decisions: decisionMatrix(facts({ courierOutcome: 'DELIVERED' })) })} />);
    expect(button(/اعتُمد رقم الشركة/).disabled).toBe(false);
    expect(screen.queryByText(WHY.partialFirst)).toBeNull();
  });
});
