// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «من يتحمّل الفرق؟» — THE QUESTION THE APPROVAL ASKS WHEN THE COMPANY PAID LESS AND THE DOOR HAS NO NAME.
 *
 * The server stops the approval with SHORTFALL_UNNAMED and the lines. The screen lists them, one box per line
 * (a person, or «على الشركة»), and sends the approval AGAIN with the answers — only once every line has one, and
 * carrying the earlier confirmation of a possible double if it had been given.
 */
const { api, fetchApi, confirm } = vi.hoisted(() => ({ api: vi.fn(), fetchApi: vi.fn(), confirm: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: (...a: unknown[]) => fetchApi(...a) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/collection',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['settlement.upload'] } }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>التحصيل</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirm, useAsk: () => async () => null }));

import { CollectionScreen } from './CollectionScreen';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const SENTENCE = 'سطور مقبولة برقم الشركة وهو أقل من رقمنا، ولا موظف مسجَّل لتسليمها: ORD-1، ORD-2. سمِّ موظفاً لكل سطر أو اختر «على الشركة» ثم اعتمد.';
const UNNAMED = {
  code: 'SHORTFALL_UNNAMED',
  error: SENTENCE,
  lines: [
    { matchId: M1, orderNumber: 'ORD-1', amount: 2, currencyCode: 'USD' },
    { matchId: M2, orderNumber: 'ORD-2', amount: 0.5, currencyCode: 'USD' },
  ],
  candidates: [{ id: 'u-sara', name: 'سارة', role: 'FOLLOW_UP_AGENT' }, { id: 'u-mona', name: 'منى', role: 'FOLLOW_UP_AGENT' }],
};
const gap = { claimed: 15.5, received: 15.5, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 };
const statement = {
  id: 's1', reference: 'ST-1', fileName: 'x.xlsx', status: 'MATCHED', approvedAt: null, currencyCode: 'USD', totalAmount: 15.5,
  createdAt: '2026-10-28T00:00:00Z', periodFrom: null, periodTo: null, counts: { lines: 2, receipts: 1, matches: 2 },
  receipts: [{ id: 'r1', amount: 15.5, currencyCode: 'USD', receivedAt: '2026-10-28T09:00:00Z', note: null, wallet: 'الصندوق', proof: null }], gap,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const patches = () => fetchApi.mock.calls.filter((c) => (c[1] as RequestInit).method === 'PATCH');
const bodyOf = (i: number) => JSON.parse(String((patches()[i][1] as RequestInit).body));

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/finance/statements')) return { statements: [statement] };
    if (url.startsWith('/api/ops/references')) return { providers: [] };
    if (url.startsWith('/api/finance/wallets')) return { wallets: [] };
    return {};
  });
});
afterEach(cleanup);

const press = async () => fireEvent.click((await screen.findAllByRole('button', { name: 'اعتماد' }))[0]);

describe('the approval stops for a missing name', () => {
  it('lists every line with its difference, and a box per line with «على الشركة» and the people', async () => {
    fetchApi.mockResolvedValue(json(UNNAMED, 409));
    render(<CollectionScreen />);
    await press();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(SENTENCE)).toBeTruthy();
    // (The sentence names both orders too, so each is found among several.)
    expect(within(dialog).getAllByText(/ORD-1/).length).toBeGreaterThan(1);
    expect(within(dialog).getAllByText(/ORD-2/).length).toBeGreaterThan(1);
    expect(within(dialog).getByText(/ORD-2 — الفرق/)).toBeTruthy();
    const boxes = within(dialog).getAllByRole('combobox');
    expect(boxes).toHaveLength(2);
    const options = within(boxes[0]).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['اختر…', 'على الشركة', 'سارة', 'منى']);
    // It did not answer for the approver.
    expect(patches()).toHaveLength(1);
    expect(bodyOf(0)).toEqual({ approve: true });
  });

  it('«اعتمد» stays off until EVERY line has an answer', async () => {
    fetchApi.mockResolvedValue(json(UNNAMED, 409));
    render(<CollectionScreen />);
    await press();
    const dialog = await screen.findByRole('dialog');
    const [one, two] = within(dialog).getAllByRole('combobox');
    const go = within(dialog).getByRole('button', { name: 'اعتمد' }) as HTMLButtonElement;

    expect(go.disabled).toBe(true);
    fireEvent.change(one, { target: { value: 'u-sara' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(two, { target: { value: 'COMPANY' } });
    expect(go.disabled).toBe(false);
  });

  it('sends the approval again with the answers, keyed by line', async () => {
    fetchApi.mockResolvedValueOnce(json(UNNAMED, 409)).mockResolvedValueOnce(json({ statement: { id: 's1' } }, 200));
    render(<CollectionScreen />);
    await press();
    const dialog = await screen.findByRole('dialog');
    const [one, two] = within(dialog).getAllByRole('combobox');
    fireEvent.change(one, { target: { value: 'u-sara' } });
    fireEvent.change(two, { target: { value: 'COMPANY' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعتمد' }));

    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(bodyOf(1)).toEqual({ approve: true, shortfallPeople: { [M1]: 'u-sara', [M2]: 'COMPANY' } });
    expect((await screen.findAllByText('اعتُمد الكشف وسُجِّلت حركة المحفظة')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('«رجوع» sends nothing', async () => {
    fetchApi.mockResolvedValue(json(UNNAMED, 409));
    render(<CollectionScreen />);
    await press();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'رجوع' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(patches()).toHaveLength(1);
  });

  it('a person the server refuses (the owner, the confirmer…) comes back as a sentence, not a dialog', async () => {
    fetchApi
      .mockResolvedValueOnce(json(UNNAMED, 409))
      .mockResolvedValueOnce(json({ code: 'SHORTFALL_BAD_PERSON', error: 'اختيار غير مقبول: ORD-1 — المالك والمدراء لا يتحمّلون فرق التحصيل' }, 409));
    render(<CollectionScreen />);
    await press();
    const dialog = await screen.findByRole('dialog');
    const [one, two] = within(dialog).getAllByRole('combobox');
    fireEvent.change(one, { target: { value: 'u-sara' } });
    fireEvent.change(two, { target: { value: 'u-mona' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعتمد' }));

    expect((await screen.findAllByText(/المالك والمدراء لا يتحمّلون فرق التحصيل/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('an earlier «اعتمد هيك» is not forgotten: the same approval carries both answers', async () => {
    fetchApi
      .mockResolvedValueOnce(json({ code: 'POSSIBLE_DOUBLE', error: 'حركة يدوية بنفس المبلغ', rows: [] }, 409))
      .mockResolvedValueOnce(json(UNNAMED, 409))
      .mockResolvedValueOnce(json({ statement: { id: 's1' } }, 200));
    render(<CollectionScreen />);
    await press();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'اعتمد هيك' }));

    const dialog = await screen.findByText(SENTENCE).then(() => screen.getByRole('dialog'));
    const [one, two] = within(dialog).getAllByRole('combobox');
    fireEvent.change(one, { target: { value: 'COMPANY' } });
    fireEvent.change(two, { target: { value: 'COMPANY' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعتمد' }));

    await waitFor(() => expect(patches()).toHaveLength(3));
    expect(bodyOf(2)).toEqual({ approve: true, confirmPossibleDouble: true, shortfallPeople: { [M1]: 'COMPANY', [M2]: 'COMPANY' } });
  });
});
