// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * «هل لازم أعمل قيد عكسي بالمكانين؟» — THE WALLET'S DIALOG, ON A TRANSFER'S LEG.
 *
 * A leg of a transfer is reversed with its transfer: the door carries the other leg in the same transaction. So the dialog
 * that opens on such a movement says so, in words, before the person presses — and the dialog of an ordinary movement does
 * not say it, because for that one it is not true.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/wallets',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'CUSTOM', permissions: ['finance.cashbox_view', 'finance.cashbox'] } }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>عنوان</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useAsk: () => async () => null, useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { WalletsScreen } from './WalletsScreen';

const WALLET = {
  id: 'w1', name: 'بينانس', currencyCode: 'USDT', isActive: true, opening: 0, in: 4511.41, out: 0, balance: 4511.41,
  movements: 2, country: { id: 'c1', name: 'سوريا' }, openingCount: null,
};
const move = (over: Record<string, unknown>) => ({
  direction: 'IN', party: 'x', category: 'OTHER', createdAt: '2026-11-14T18:27:00.000Z', isReversal: false, wasReversed: false,
  referenceType: null, referenceId: null, ...over,
});
const LEG = move({ id: 'm-leg', amount: 4501.41, party: 'تحويل من شام كاش سوري', category: 'TRANSFER_IN', note: 'ملاحظة التحويل', referenceType: 'TRANSFER', referenceId: 't1' });
const PLAIN = move({ id: 'm-plain', amount: 10, note: 'ملاحظة يدوية' });

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async (url: string) => {
    if (String(url).includes('/movements')) return { movements: [LEG, PLAIN] };
    if (String(url).startsWith('/api/finance/wallets')) return { wallets: [WALLET] };
    return {};
  });
});
afterEach(cleanup);

const dialogFor = async (note: string) => {
  render(<WalletsScreen />);
  const row = (await screen.findAllByText(note))[0].closest('tr') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: /قيد عكسي/ }));
  return within(await screen.findByRole('dialog', { name: 'قيد عكسي' }));
};

describe('the dialog of «قيد عكسي»', () => {
  it('on a leg of a transfer says the transfer is reversed whole — both legs, once — and that «التحويلات» will say so', async () => {
    const dialog = await dialogFor('ملاحظة التحويل');
    expect(dialog.getByText(/هذه حركة تحويل: القيد العكسي يعكس التحويل كله بمرة واحدة/)).toBeTruthy();
    expect(dialog.getByText(/الطرفين، كل واحد في محفظته/)).toBeTruthy();
    expect(dialog.getByText(/«التحويلات»/)).toBeTruthy();
    // And the reason is still the one thing asked.
    expect((dialog.getByRole('textbox') as HTMLTextAreaElement).required).toBe(true);
  });

  it('on an ordinary movement says no such thing — for it, it is not true', async () => {
    const dialog = await dialogFor('ملاحظة يدوية');
    expect(dialog.queryByText(/هذه حركة تحويل/)).toBeNull();
    expect(dialog.getByText(/القيد الأصلي لا يُحذف ولا يُعدَّل/)).toBeTruthy();
  });
});
