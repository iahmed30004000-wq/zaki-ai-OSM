// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { CALL_PROOF_WORDS } from '@/lib/call-proof-words';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE POSTPONE DIALOG’S «لا يرد — إعادة المحاولة لاحقاً» (Confirmation Center v2, step A; found by the review: a control that records a «didn’t answer»
 * the first pass missed)
 *
 *  1. With the proof on and her «لا يرد» still shut (no «اتصال» press of hers, or the thirty seconds are not over), the reason «لا يرد» in the dialog is DISABLED and
 *     the card’s own sentence is printed under the list — she is told before she types a date, not after the dialog closed on a refusal.
 *  2. The other reasons stay free; with the lock gone (or the prop absent — the proof off) the dialog is today’s, and the form sends «لا يرد» like any reason.
 *  3. A form already holding «لا يرد» when the lock appears does not send it.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [], loading: false }) }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], loading: false }) }));

import { PostponeDialog } from './ActionDialogs';

afterEach(cleanup);

// The reasons list is the one select that holds «لا يرد» (the label is not wired to its field).
const select = () =>
  (screen.getAllByRole('combobox') as HTMLSelectElement[]).find((el) => Array.from(el.options).some((o) => o.value === 'NO_ANSWER')) as HTMLSelectElement;
const option = (value: string) => Array.from(select().options).find((o) => o.value === value) as HTMLOptionElement;
const draw = (noAnswerLock?: string | null, onSubmit = vi.fn()) => {
  render(<PostponeDialog open orderNumber="ORD-1" postponeCount={0} noAnswerLock={noAnswerLock} onClose={() => {}} onSubmit={onSubmit} />);
  return onSubmit;
};

describe('the reason «لا يرد» while her call is unproven', () => {
  it('is disabled, and the card’s sentence is printed under the list', () => {
    draw(CALL_PROOF_WORDS.wait(12));
    expect(option('NO_ANSWER').disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(12))).toBeTruthy();
  });

  it('leaves every other reason free', () => {
    draw(CALL_PROOF_WORDS.noOpened);
    for (const o of Array.from(select().options)) if (o.value !== 'NO_ANSWER') expect(o.disabled, o.value).toBe(false);
    expect(screen.getByText(CALL_PROOF_WORDS.noOpened)).toBeTruthy();
  });

  it('is today’s dialog with no lock: the option is free, no sentence, and the form sends «لا يرد»', () => {
    for (const lock of [undefined, null]) {
      cleanup();
      const onSubmit = draw(lock);
      expect(option('NO_ANSWER').disabled).toBe(false);
      expect(screen.queryByText(/استنّى|اضغط «اتصال»/)).toBeNull();
      fireEvent.change(select(), { target: { value: 'NO_ANSWER' } });
      screen.getByRole('button', { name: 'تأجيل' }).click();
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ reason: 'NO_ANSWER' }));
    }
  });

  it('a form that already holds «لا يرد» when the lock appears does not send it', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<PostponeDialog open orderNumber="ORD-1" postponeCount={0} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(select(), { target: { value: 'NO_ANSWER' } });
    rerender(<PostponeDialog open orderNumber="ORD-1" postponeCount={0} noAnswerLock={CALL_PROOF_WORDS.noOpened} onClose={() => {}} onSubmit={onSubmit} />);
    screen.getByRole('button', { name: 'تأجيل' }).click();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
