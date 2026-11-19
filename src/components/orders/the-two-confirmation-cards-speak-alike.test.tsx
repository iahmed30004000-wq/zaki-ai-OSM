// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ONE ACT, ONE WORD — ON BOTH CARDS THAT CONFIRM AN ORDER.
 *
 * The agent's desk («طلباتي») says «لا يرد» and «تأجيل». The order's own panel said «لم يجب» and
 * «الاتصال لاحقاً» for the very same two acts, and counted them with the same three-attempt limit.
 * A person who works both reads two vocabularies for one thing. Only the WORDS are shared here:
 * the actions, the counter and the stored reason codes are what they were.
 */

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ attempts: [], summary: null }) })),
}));

import { ConfirmationActions } from './ConfirmationActions';

afterEach(cleanup);

const ORDER = { id: 'o-1', orderNumber: 'ORD-1', confirmationStatus: 'NEW', version: 1 };

describe('the order panel’s quick actions', () => {
  it('say what the agent’s desk says', () => {
    render(<ConfirmationActions order={ORDER} ar isRtl onRefreshOrder={() => {}} />);
    expect(screen.getByRole('button', { name: 'لا يرد' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تأجيل' })).toBeTruthy();
    // …and not the old words
    expect(screen.queryByRole('button', { name: 'لم يجب' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'الاتصال لاحقاً' })).toBeNull();
  });

  it('and the desk still says them — one vocabulary, not two that happen to match today', () => {
    // 18/11 (R8d): the desk's card and its presses moved from ConfirmationMineScreen.tsx to confirmation/OrderCard.tsx — same assertion, read there.
    const desk = readFileSync(join(process.cwd(), 'src/components/screens/confirmation/OrderCard.tsx'), 'utf8');
    expect(desk).toContain('لا يرد');
    expect(desk).toContain('تأجيل');
  });

  it('what each button DOES is unchanged: the same contact result and the same two forms', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/orders/ConfirmationActions.tsx'), 'utf8');
    expect(src).toContain("result: 'NO_ANSWER'");
    expect(src).toContain("setOpenForm('call_later')");
  });
});
