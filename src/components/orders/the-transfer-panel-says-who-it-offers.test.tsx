// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE TRANSFER PANEL SAYS WHO IT OFFERS (the owner, 1/11: «سحبت الطلب اجيت اعطيه لموظفة التأكيد مش ملاقيها ليييش؟»)
 *
 * The panel always said «زملاء بنفس الرتبة فقط», and for the owner — who had just taken the order — that meant people of HIS role, so
 * the confirmation employee was nowhere in it and nothing told him why. The door now answers `scope`: for whoever assigns it is every
 * employee who can work the order («موظفو التأكيد»), and for an agent giving an order up it is still her own role.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, useApp } = vi.hoisted(() => ({ apiJson: vi.fn(), useApp: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => useApp() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn() }) }));

import { OrderResponsibility } from './OrderResponsibility';

const held = { id: 'o1', claimedById: 'me', claimedAt: null, claimer: { id: 'me', name: 'أحمد' }, owner: null, confirmationStatus: 'CONFIRMED' };

async function open(answer: Record<string, unknown>) {
  useApp.mockReturnValue({ currentUser: { id: 'me', role: 'X', status: 'ACTIVE', permissions: ['orders.release'] } });
  apiJson.mockResolvedValue(answer);
  render(<OrderResponsibility order={held} currentUserId="me" onChanged={() => {}} />);
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  fireEvent.click(await screen.findByText('تحويل لزميل'));
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the panel', () => {
  it('for whoever assigns: «موظفو التأكيد», and the confirmation employee is in the list', async () => {
    await open({ mayTransfer: true, scope: 'ANY_AGENT', candidates: [{ id: 'a3', name: 'عبير' }, { id: 'a2', name: 'ليلى' }] });
    expect(screen.getByText('يُحوَّل إلى (موظفو التأكيد)')).toBeTruthy();
    expect(screen.queryByText(/زملاء بنفس الرتبة فقط/)).toBeNull();
    expect(screen.getByRole('option', { name: 'عبير' })).toBeTruthy();
  });

  it('for an agent giving the order up: still «زملاء بنفس الرتبة فقط»', async () => {
    await open({ mayTransfer: true, scope: 'SAME_RANK', candidates: [{ id: 'a2', name: 'ليلى' }] });
    expect(screen.getByText('يُحوَّل إلى (زملاء بنفس الرتبة فقط)')).toBeTruthy();
    expect(screen.queryByText(/موظفو التأكيد/)).toBeNull();
  });

  it('an older answer with no scope reads as before — the old words', async () => {
    await open({ mayTransfer: true, candidates: [{ id: 'a2', name: 'ليلى' }] });
    expect(screen.getByText('يُحوَّل إلى (زملاء بنفس الرتبة فقط)')).toBeTruthy();
  });

  it('with nobody to offer, the button is greyed and says which kind of nobody', async () => {
    useApp.mockReturnValue({ currentUser: { id: 'me', role: 'X', status: 'ACTIVE', permissions: ['orders.release'] } });
    apiJson.mockResolvedValue({ mayTransfer: true, scope: 'ANY_AGENT', candidates: [] });
    render(<OrderResponsibility order={held} currentUserId="me" onChanged={() => {}} />);
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    const button = (await screen.findByText('تحويل لزميل')).closest('button')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('موظف تأكيد');
    cleanup();

    apiJson.mockResolvedValue({ mayTransfer: true, scope: 'SAME_RANK', candidates: [] });
    render(<OrderResponsibility order={held} currentUserId="me" onChanged={() => {}} />);
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(((await screen.findByText('تحويل لزميل')).closest('button')!).getAttribute('title')).toBe('لا يوجد زميل بنفس الرتبة');
  });
});
