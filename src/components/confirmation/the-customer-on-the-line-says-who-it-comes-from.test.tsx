// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «الزبون على الخط» — THE CARD SAYS WHO IT IS TAKEN FROM (the owner, 7/11).
 *
 * The customer rang the FIRST agent; a colleague pulled his order after the first agent's «لا يرد» and has logged nothing on it.
 * The server now lets the first agent take it (`customer-on-the-line.ts`), and the card must never make that a surprise:
 *
 *   · a card she may take FROM A COLLEAGUE says so above the button — «عند <name> ولسا ما اتصلت فيه — بتنسحب منها» — and keeps the
 *     same button, «خده — الزبون على الخط» (no new one);
 *   · a card she may take from the pool says nothing of the kind;
 *   · a refused card shows the holder's name in its row and the server's own sentence under it, and no button;
 *   · pressing the button asks the one door with the order's id, and a refusal (the colleague started on it meanwhile) shows the
 *     server's sentence and takes nothing.
 */

const { api, toast } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { failed: vi.fn(), done: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { CustomerOnTheLine, type OnTheLineCard } from './CustomerOnTheLine';

const NOTE = 'عند هند ولسا ما اتصلت فيه — بتنسحب منها';
const TAKE = 'خده — الزبون على الخط';
const STARTED = 'الطلب مع هند وهي بدأت عليه — حوّلي الزبون إلها أو للمشرفة';

const card = (over: Partial<OnTheLineCard> = {}): OnTheLineCard => ({
  id: 'o1',
  orderNumber: 'ORD-1',
  product: 'ساعة',
  governorate: 'دمشق',
  status: 'قيد التأكيد',
  holder: 'بالطابور',
  takeable: true,
  fromColleague: null,
  code: null,
  message: null,
  ...over,
});
const fromHind = (over: Partial<OnTheLineCard> = {}) => card({ holder: 'هند', fromColleague: 'هند', ...over });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

/** Open the box, type his number, press «دوّري» — and let the cards come back. */
async function searchFor(cards: OnTheLineCard[]) {
  api.mockResolvedValueOnce({ orders: cards });
  const onTaken = vi.fn();
  render(<CustomerOnTheLine onTaken={onTaken} />);
  fireEvent.click(screen.getByRole('button', { name: 'الزبون على الخط' }));
  fireEvent.change(screen.getByLabelText('رقم الزبون اللي عم يحكي'), { target: { value: '0966793918' } });
  fireEvent.click(screen.getByRole('button', { name: 'دوّري' }));
  await screen.findByText('ORD-1');
  return onTaken;
}
const takeButton = () => screen.queryByRole('button', { name: TAKE });

describe('a card she may take from a colleague', () => {
  it('says who she would take it from, ABOVE the same button', async () => {
    await searchFor([fromHind()]);
    const note = screen.getByText(NOTE);
    const button = takeButton();
    expect(button, 'الزر نفسه «خده — الزبون على الخط»').not.toBeNull();
    // The note comes first in the page: she reads it before she can press.
    expect(note.compareDocumentPosition(button as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The holder's name is in the row as well, as on every card.
    expect(screen.getByText('هند')).toBeTruthy();
  });

  it('asks the one door with the order’s id, says it is hers, and hands it to the desk', async () => {
    const onTaken = await searchFor([fromHind()]);
    api.mockResolvedValueOnce({ ok: true, orderId: 'o1', orderNumber: 'ORD-1' });
    fireEvent.click(takeButton() as HTMLElement);
    await waitFor(() => expect(onTaken).toHaveBeenCalledWith('o1'));
    expect(api).toHaveBeenLastCalledWith('/api/confirmation/callback-take', { method: 'POST', body: JSON.stringify({ orderId: 'o1' }) });
    expect(toast.done).toHaveBeenCalledWith('صار الطلب ORD-1 معك');
  });

  it('NEGATIVE: the colleague started on it meanwhile — the server’s sentence is shown, nothing is taken, the desk is not told', async () => {
    const onTaken = await searchFor([fromHind()]);
    api.mockRejectedValueOnce(new Error(STARTED));
    fireEvent.click(takeButton() as HTMLElement);
    await screen.findByText(STARTED);
    expect(onTaken).not.toHaveBeenCalled();
    expect(toast.done).not.toHaveBeenCalled();
  });
});

describe('a card she may take from the pool, and the ones she may not', () => {
  it('NEGATIVE: a card from the pool carries no such note — the button alone', async () => {
    await searchFor([card()]);
    expect(takeButton()).not.toBeNull();
    expect(screen.queryByText(/ولسا ما اتصلت فيه/)).toBeNull();
    expect(screen.queryByText(/بتنسحب منها/)).toBeNull();
  });

  it('a refused card shows the holder’s name and the server’s sentence — and no button, and no note', async () => {
    await searchFor([
      card({ holder: 'هند', takeable: false, fromColleague: null, code: 'HELD_BY_COLLEAGUE', message: STARTED }),
    ]);
    expect(screen.getByText('هند')).toBeTruthy();
    expect(screen.getByText(STARTED)).toBeTruthy();
    expect(takeButton()).toBeNull();
    expect(screen.queryByText(/بتنسحب منها/)).toBeNull();
  });

  it('NEGATIVE: a note is only ever drawn with the button — a card that is not takeable never promises a withdrawal', async () => {
    await searchFor([fromHind({ takeable: false, code: 'HELD_BY_COLLEAGUE', message: STARTED })]);
    expect(takeButton()).toBeNull();
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.getByText(STARTED)).toBeTruthy();
  });

  it('one search can hold both kinds, each with its own words', async () => {
    api.mockResolvedValueOnce({
      orders: [
        fromHind({ id: 'o1', orderNumber: 'ORD-1' }),
        card({ id: 'o2', orderNumber: 'ORD-2', holder: 'هند', takeable: false, code: 'HELD_BY_COLLEAGUE', message: STARTED }),
        card({ id: 'o3', orderNumber: 'ORD-3' }),
      ],
    });
    render(<CustomerOnTheLine onTaken={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'الزبون على الخط' }));
    fireEvent.change(screen.getByLabelText('رقم الزبون اللي عم يحكي'), { target: { value: '0966793918' } });
    fireEvent.click(screen.getByRole('button', { name: 'دوّري' }));
    await screen.findByText('ORD-3');
    expect(screen.getAllByRole('button', { name: TAKE })).toHaveLength(2);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
    expect(screen.getAllByText(STARTED)).toHaveLength(1);
  });
});

describe('the words above the box', () => {
  it('say that a colleague’s pull she has not started on can be taken, and one she has started on stays with her', async () => {
    render(<CustomerOnTheLine onTaken={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'الزبون على الخط' }));
    const intro = screen.getByText(/بتاخدي على الخط/);
    expect(intro.textContent).toContain('طلب سحبته زميلتك وما بدأت عليه');
    expect(intro.textContent).toContain('زميلتك بدأت عليه بيضل معها');
    // The old sentence promised the opposite for every order a colleague holds.
    expect(intro.textContent).not.toContain('واللي مع زميلتك بيضل معها');
  });
});
