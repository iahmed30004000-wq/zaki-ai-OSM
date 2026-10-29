// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { handCategoriesFor, handMovementRefusal } from '@/lib/hand-movement-rules';

/**
 * «حركة جديدة» — THE DIALOG AND THE DOOR AGREE.
 *
 * A courier collection typed here was written a second time when its statement was approved. The dialog now
 * offers only the categories the door accepts for the chosen direction, switching direction keeps the pair
 * valid, and one short line under the box says where courier money is recorded.
 */

vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['finance.cashbox_view', 'finance.cashbox', 'finance.wallets_manage'] } }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/finance/wallets', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المحافظ</h1> }));

import { WalletsScreen } from './WalletsScreen';

const WALLET = {
  id: 'w1', name: 'شام كاش دولار', currencyCode: 'USD', isActive: true, opening: 0, in: 0, out: 0, balance: 0,
  movements: 0, country: { id: 'c1', name: 'سوريا' }, openingCount: null,
};

let sent: { url: string; body: any }[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if ((init?.method ?? 'GET') !== 'GET') {
        sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return json({ movement: { id: 'm1' } }, 201);
      }
      if (url.includes('/movements')) return json({ movements: [] });
      return json({ wallets: [WALLET] });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openDialog() {
  render(<WalletsScreen />);
  fireEvent.click(await screen.findByText('حركة جديدة'));
  return screen.findByRole('dialog');
}

/** The options a person can actually choose. */
const optionsOf = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('option')
    .filter((o) => !(o as HTMLOptionElement).disabled)
    .map((o) => (o as HTMLOptionElement).value);

/** The ones listed but not choosable — each with the door that writes it. */
const disabledOf = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('option')
    .filter((o) => (o as HTMLOptionElement).disabled)
    .map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' }));

describe('the category box', () => {
  /*
   * OLD → NEW (29/10, P19a). The dialog used to open on «مصروف» and offer expense + commission going OUT; those two
   * have ledgers of their own (the expense list; the commission entries) and are refused by the door in both
   * directions now. They stay LISTED, disabled, each naming the door to use — marked, not removed — and the dialog
   * opens on the first category a person may type.
   */
  it('opens on «صادر» offering adjustment and other only — never a collection, a transfer, an expense or a commission', async () => {
    const dialog = await openDialog();
    expect(optionsOf(dialog)).toEqual(['ADJUSTMENT', 'OTHER']);
    expect(optionsOf(dialog)).toEqual(
      ['ADJUSTMENT', 'OTHER'].filter((c) => handCategoriesFor('OUT').includes(c))
    );
    expect((within(dialog).getByRole('combobox') as HTMLSelectElement).value).toBe('ADJUSTMENT');
  });

  it('lists the expense and the commission DISABLED, each naming the door that writes it — in both directions', async () => {
    const dialog = await openDialog();
    for (const direction of ['وارد', 'صادر']) {
      fireEvent.click(within(dialog).getByRole('button', { name: direction }));
      await waitFor(() => expect(disabledOf(dialog).map((o) => o.value)).toEqual(['EXPENSE', 'COMMISSION']));
      const text = Object.fromEntries(disabledOf(dialog).map((o) => [o.value, o.text]));
      expect(text.EXPENSE).toContain('سجّل مصروفاً');
      expect(text.COMMISSION).toContain('صرف');
    }
  });

  it('on «وارد» offers the same two, and a chosen pair stays valid when the direction flips', async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'OTHER' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'وارد' }));

    await waitFor(() => expect(optionsOf(dialog)).toEqual(['ADJUSTMENT', 'OTHER']));
    expect((within(dialog).getByRole('combobox') as HTMLSelectElement).value).toBe('OTHER');
  });

  it('says in one line where courier money is recorded', async () => {
    const dialog = await openDialog();
    expect(within(dialog).getByText(/تحصيل شركة الشحن لا يُكتب هنا/)).toBeTruthy();
    expect(within(dialog).getByText(/استلمت منه/)).toBeTruthy();
    // And the second line: where the expense, the commission and the salary are written.
    expect(within(dialog).getByText(/المصروف من «سجّل مصروفاً» في «الأرباح»/)).toBeTruthy();
  });

  it('and every pair the dialog can send is a pair the door accepts', async () => {
    const dialog = await openDialog();
    for (const direction of ['وارد', 'صادر']) {
      fireEvent.click(within(dialog).getByRole('button', { name: direction }));
      const dir = direction === 'وارد' ? 'IN' : 'OUT';
      for (const category of optionsOf(dialog)) {
        expect(handMovementRefusal(category, dir), `${category} ${dir}`).toBeNull();
      }
    }
  });
});
