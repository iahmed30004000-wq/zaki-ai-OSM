// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * THE SCREEN OF THE STATEMENT, ON THE TWO THINGS THE OWNER ASKED FOR.
 *
 * 1. «لما بنعمل اعتماد للكشف — بتتسجل حركت المال مره ثانيه»: when the server finds a hand entry of the same
 *    money it answers POSSIBLE_DOUBLE with the rows. The screen LISTS them with «اعتمد هيك» and «رجوع» and
 *    never confirms by itself.
 * 2. «الاثبات اقدر اغيرو لغاية قبل ما اضغط زر اعتماد»: each receipt offers «غيّر الإثبات» (a real file input)
 *    and «احذف الإيصال» (asks first) while the statement is unapproved; after approval both are gone and the
 *    line «الكشف مغلق نهائياً — التصحيح بكشف تسوية» takes their place.
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

const SENTENCE = 'في حركة يدوية بنفس المبلغ بنفس المحفظة — إذا هي نفس مصاري الكشف، اعكسها («قيد عكسي») قبل الاعتماد.';
const gap = { claimed: 1543.9, received: 1543.9, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 };
const receipt = (id: string, over: Record<string, unknown> = {}) => ({
  id, amount: 1543.9, currencyCode: 'USD', receivedAt: '2026-10-28T09:00:00Z', note: null, wallet: 'شام كاش دولار',
  proof: { name: 'slip.png', mime: 'image/png', size: 100 }, ...over,
});
const statement = (over: Record<string, unknown> = {}) => ({
  id: 's1', reference: '7446102700052', fileName: 'x.xlsx', status: 'MATCHED', approvedAt: null,
  currencyCode: 'USD', totalAmount: 1543.9, createdAt: '2026-10-28T00:00:00Z', periodFrom: null, periodTo: null,
  counts: { lines: 3, receipts: 2, matches: 3 }, receipts: [receipt('r1'), receipt('r2', { proof: null })], gap, ...over,
});

let statements: ReturnType<typeof statement>[];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const calls = (method: string) => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

beforeEach(() => {
  vi.clearAllMocks();
  statements = [statement()];
  confirm.mockResolvedValue(true);
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE' || init?.method === 'PUT') return { ok: true };
    if (url.startsWith('/api/finance/statements')) return { statements };
    if (url.startsWith('/api/ops/references')) return { providers: [] };
    if (url.startsWith('/api/finance/wallets')) return { wallets: [] };
    return {};
  });
});
afterEach(cleanup);

describe('the receipts of an unapproved statement', () => {
  it('each one offers a real file input «غيّر الإثبات» and «احذف الإيصال»', async () => {
    render(<CollectionScreen />);
    const change = await screen.findAllByText('غيّر الإثبات');
    // Two receipts, each drawn in the table and in the phone card.
    expect(change.length).toBeGreaterThanOrEqual(2);
    for (const label of change) {
      const input = label.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.accept).toContain('application/pdf');
    }
    expect(screen.getAllByRole('button', { name: 'احذف الإيصال' }).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('الكشف مغلق نهائياً — التصحيح بكشف تسوية')).toBeNull();
  });

  it('«احذف الإيصال» asks first, and a no deletes nothing', async () => {
    confirm.mockResolvedValue(false);
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'احذف الإيصال' }))[0]);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0].tone).toBe('danger');
    expect(calls('DELETE')).toHaveLength(0);
  });

  it('and on a yes calls the delete door for THAT receipt', async () => {
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'احذف الإيصال' }))[1]);
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1));
    expect(calls('DELETE')[0][0]).toBe('/api/finance/statements/s1/receipts/r2');
  });

  it('choosing a file sends it to the proof door of THAT receipt, as base64 with its own name', async () => {
    render(<CollectionScreen />);
    const [first] = await screen.findAllByText('غيّر الإثبات');
    const input = first.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'new-slip.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    const [url, init] = calls('PUT')[0] as [string, RequestInit];
    expect(url).toBe('/api/finance/statements/s1/receipts/r1/proof');
    expect(JSON.parse(String(init.body))).toEqual({ fileName: 'new-slip.png', content: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3)) });
  });
});

describe('after approval', () => {
  beforeEach(() => {
    statements = [statement({ status: 'APPROVED', approvedAt: '2026-10-28T12:00:00Z' })];
  });

  // (Was «…الكشف معتمد — التصحيح بقيد عكسي». The lock gives the closed statement one sentence, on the screen and at every door.)
  it('both controls are gone and the line says the statement is closed for good — the correction is a settlement statement', async () => {
    render(<CollectionScreen />);
    expect((await screen.findAllByText('الكشف مغلق نهائياً — التصحيح بكشف تسوية')).length).toBeGreaterThan(0);
    expect(screen.queryByText('غيّر الإثبات')).toBeNull();
    expect(screen.queryByRole('button', { name: 'احذف الإيصال' })).toBeNull();
    expect(document.querySelectorAll('li input[type="file"]')).toHaveLength(0);
  });
});

describe('«اعتماد» when a hand entry of the same money is in the wallet', () => {
  const rows = [
    {
      id: 'hand-1', wallet: 'شام كاش دولار', currencyCode: 'USD', date: '2026-10-27T18:16:00Z', amount: 1543.9,
      party: 'الباشا 27-10-2026', note: 'Qabas', by: 'مها المحاسبة',
    },
  ];
  const approveCalls = () => fetchApi.mock.calls.filter((c) => (c[1] as RequestInit).method === 'PATCH');

  it('lists the rows with two buttons, sends nothing by itself, and «رجوع» closes it', async () => {
    fetchApi.mockResolvedValue(json({ code: 'POSSIBLE_DOUBLE', error: SENTENCE, rows }, 409));
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'اعتماد' }))[0]);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(SENTENCE)).toBeTruthy();
    expect(within(dialog).getByText(/الباشا 27-10-2026/)).toBeTruthy();
    expect(within(dialog).getByText(/Qabas/)).toBeTruthy();
    expect(within(dialog).getByText(/مها المحاسبة/)).toBeTruthy();
    expect(within(dialog).getByText(/1,?543\.9/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'اعتمد هيك' })).toBeTruthy();

    // It did not confirm on its own: one request, and it carried no confirmation.
    expect(approveCalls()).toHaveLength(1);
    expect(JSON.parse(String((approveCalls()[0][1] as RequestInit).body))).toEqual({ approve: true });

    fireEvent.click(within(dialog).getByRole('button', { name: 'رجوع' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(approveCalls()).toHaveLength(1);
  });

  it('«اعتمد هيك» sends the approval again WITH the confirmation, and says it is approved', async () => {
    fetchApi
      .mockResolvedValueOnce(json({ code: 'POSSIBLE_DOUBLE', error: SENTENCE, rows }, 409))
      .mockResolvedValueOnce(json({ statement: { id: 's1' } }, 200));
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'اعتماد' }))[0]);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'اعتمد هيك' }));

    await waitFor(() => expect(approveCalls()).toHaveLength(2));
    expect(JSON.parse(String((approveCalls()[1][1] as RequestInit).body))).toEqual({ approve: true, confirmPossibleDouble: true });
    expect((await screen.findAllByText('اعتُمد الكشف وسُجِّلت حركة المحفظة')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a plain approval sends no confirmation at all', async () => {
    fetchApi.mockResolvedValue(json({ statement: { id: 's1' } }, 200));
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'اعتماد' }))[0]);
    await waitFor(() => expect(approveCalls()).toHaveLength(1));
    expect(JSON.parse(String((approveCalls()[0][1] as RequestInit).body))).toEqual({ approve: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('any other refusal is shown as a sentence, not as a dialog', async () => {
    fetchApi.mockResolvedValue(json({ code: 'ALREADY_APPROVED', error: 'الكشف معتمد مسبقاً' }, 409));
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'اعتماد' }))[0]);
    expect((await screen.findAllByText('الكشف معتمد مسبقاً')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
