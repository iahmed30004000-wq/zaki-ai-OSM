// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [], loading: false }) }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], loading: false }) }));

import { PostponeDialog } from './ActionDialogs';
import { NO_ANSWER_NOT_A_POSTPONE_HINT, POSTPONE_REASONS } from '@/lib/postpone-reasons';

/**
 * REQUEST C2, decision 6 — THE POSTPONE DIALOG UNDER THE PLAN: with `planOn` the reason «لا يرد» is not offered at all and one line says why (the door refuses it with 409
 * anyway — `the-plan-holds-the-postponements.test.ts`). Without it the dialog is main's: all five reasons, «لا يرد» among them.
 */
afterEach(cleanup);
const draw = (props: Partial<React.ComponentProps<typeof PostponeDialog>> = {}) => {
  const onSubmit = vi.fn();
  render(<PostponeDialog open orderNumber="ORD-1" postponeCount={0} onClose={() => {}} onSubmit={onSubmit} {...props} />);
  return onSubmit;
};
const reasons = () => [...[...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'POSTPONED'))!.options].map((o) => o.value);

describe('the plan on', () => {
  it('«لا يرد» is not among the reasons, and the one line says where it goes', () => {
    draw({ planOn: true });
    expect(reasons()).not.toContain('NO_ANSWER');
    expect(reasons()).toEqual(POSTPONE_REASONS.map((r) => r.value).filter((v) => v !== 'NO_ANSWER'));
    expect(screen.getByText(NO_ANSWER_NOT_A_POSTPONE_HINT)).toBeTruthy();
    expect(NO_ANSWER_NOT_A_POSTPONE_HINT).not.toMatch(/[A-Za-z]/);
  });

  it('a customer\'s reason still submits', () => {
    const onSubmit = draw({ planOn: true });
    fireEvent.submit(document.querySelector('form')!);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ reason: 'POSTPONED' }));
  });
});

describe('NEGATIVE / the way back — the plan off: main\'s dialog', () => {
  it('all five reasons, «لا يرد» among them and choosable, and no line of the plan', () => {
    draw();
    expect(reasons()).toEqual(POSTPONE_REASONS.map((r) => r.value));
    expect(reasons()).toContain('NO_ANSWER');
    expect(screen.queryByText(NO_ANSWER_NOT_A_POSTPONE_HINT)).toBeNull();
  });
});
