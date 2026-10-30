// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { ReviewPreview } from '@/lib/change-request-review';
import { AUTO_CHECKED_CARDS, PARALLEL_CHECKS, REVIEW_UNREADABLE_AR } from '@/lib/change-request-review';

/**
 * A LONG QUEUE OF «بانتظار التطبيق» — checked where the eye is, three at a time, and never shut by a budget that said «wait».
 *
 * The queue holds up to two hundred requests. Each lines request carries its own check; started all together they spend the
 * person's whole budget on one screen, and the 429 that follows used to shut the carry-out buttons with «تعذّر فحص». Now: the
 * first cards are checked, the rest carry an «افحص» button, no more than three checks are in the air, and a «wait» from the
 * server leaves the card unchecked — not shut. A request whose lines cannot be read is shut at once, with its sentence.
 */

type Gate = { id: string; open: () => void; fail: (e: Error) => void };

const { apiJson, apiFetch, state } = vi.hoisted(() => ({
  apiJson: vi.fn<(url: string) => Promise<unknown>>(),
  apiFetch: vi.fn<(url: string, init?: { body?: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(),
  state: { inflight: 0, peak: 0, started: [] as string[], gates: [] as Array<{ id: string; open: () => void; fail: (e: Error) => void }> },
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: (url: string) => apiJson(url),
  apiFetch: (url: string, init?: { body?: string }) => apiFetch(url, init),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/control/change-requests' }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => false }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useTell: () => vi.fn(),
}));

import { ChangeRequestsScreen } from './ChangeRequestsScreen';

const LINES = {
  v: 2,
  edits: [
    {
      lineId: 'l1',
      productId: { from: 'prod-cream-0001', to: 'prod-cream-0001' },
      quantity: { from: 3, to: 5 },
      lineTotal: { from: 36, to: 60 },
      freeQuantity: { from: 0, to: 0 },
    },
  ],
  snapshot: { orderVersion: 7, minorUnit: 3, before: { cod: 48.5 }, after: { cod: 72.5 } },
};

const card = (n: number, over: Record<string, unknown> = {}) => ({
  id: `cr-${n}`,
  reason: 'الزبون زاد الكمية',
  status: 'APPROVED',
  blocking: false,
  changedDuringReview: false,
  createdAt: '2026-10-29T10:00:00.000Z',
  slaDueAt: null,
  overdue: false,
  decisionNote: 'طُبِّق مباشرةً',
  requestedByName: 'ريم',
  requestedRole: 'CONFIRMATION_AGENT',
  isMine: false,
  intent: 'EDIT',
  postponeUntil: null,
  cancelReason: null,
  carryOut: { kind: 'EDIT_ORDER' },
  changes: { lines: LINES },
  lineNames: { 'prod-cream-0001': 'كريم' },
  order: {
    id: `o${n}`,
    orderNumber: `SY-${n}`,
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'PACKING',
    version: 3,
    customer: { fullName: 'سامر', phone: '0791234567' },
  },
  ...over,
});

const okPreview = (id: string): ReviewPreview => ({
  requestId: id,
  stale: false,
  lines: [],
  before: { subtotal: 46, discount: 0, deliveryFee: 2.5, addOns: 0, cod: 48.5, giftUnits: 0 },
  after: { subtotal: 70, discount: 0, deliveryFee: 2.5, addOns: 0, cod: 72.5, giftUnits: 0 },
  stock: [],
  problems: [],
  blocked: false,
  drift: { known: true, moved: false, items: [] },
  door: 'REQUEST',
  orderVersion: 3,
  minorUnit: 3,
});

const previewOf = (url: string) => /\/api\/control\/change-requests\/([^/]+)\/preview$/.exec(url)?.[1] ?? null;

/** The queue the screen reads, and previews that stay in the air until the test lets them go. */
function serve(awaiting: unknown[]) {
  apiJson.mockReset();
  apiJson.mockImplementation((url: string) => {
    const id = previewOf(url);
    if (id) {
      state.inflight += 1;
      state.peak = Math.max(state.peak, state.inflight);
      state.started.push(id);
      return new Promise((resolve, reject) => {
        state.gates.push({
          id,
          open: () => {
            state.inflight -= 1;
            resolve(okPreview(id));
          },
          fail: (e: Error) => {
            state.inflight -= 1;
            reject(e);
          },
        });
      });
    }
    return Promise.resolve({ requests: url.includes('status=AWAITING_APPLY') ? awaiting : [] });
  });
}

/** Lets the next `n` checks that reach the server finish, one by one. */
async function release(n: number, how: 'open' | 'fail' = 'open') {
  for (let i = 0; i < n; i += 1) {
    await waitFor(() => expect(state.gates.length).toBeGreaterThan(0));
    const gate = state.gates.shift() as Gate;
    if (how === 'open') gate.open();
    else gate.fail(Object.assign(new Error('طلبات كثيرة جداً. أعد المحاولة بعد 30 ثانية'), { status: 429, data: { code: 'RATE_LIMITED' } }));
  }
}

const carryButtons = () => screen.getAllByRole('button', { name: 'طبّق التعديل على الطلب' }) as HTMLButtonElement[];

beforeEach(() => {
  state.inflight = 0;
  state.peak = 0;
  state.started = [];
  state.gates = [];
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
});
afterEach(cleanup);

describe('Ⅰ · two hundred cards', () => {
  it('checks only the first few, three at a time — and every other card carries «افحص»', async () => {
    const cards = Array.from({ length: 200 }, (_, i) => card(i + 1));
    serve(cards);
    render(<ChangeRequestsScreen />);
    await screen.findByText('SY-1');

    // Let the first twelve through, one at a time; nothing else may start meanwhile.
    await release(AUTO_CHECKED_CARDS);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'افحص' })).toHaveLength(200 - AUTO_CHECKED_CARDS));
    expect(state.started).toHaveLength(AUTO_CHECKED_CARDS);
    expect(state.started).toEqual(cards.slice(0, AUTO_CHECKED_CARDS).map((c) => c.id));
    expect(state.peak).toBeLessThanOrEqual(PARALLEL_CHECKS);
    expect(state.peak).toBeGreaterThan(0);
  });

  it('a card that was not checked is not shut — the apply door judges it — and «افحص» checks that one only', async () => {
    serve(Array.from({ length: AUTO_CHECKED_CARDS + 2 }, (_, i) => card(i + 1)));
    render(<ChangeRequestsScreen />);
    await screen.findByText('SY-1');
    await release(AUTO_CHECKED_CARDS);

    const asks = await screen.findAllByRole('button', { name: 'افحص' });
    expect(asks).toHaveLength(2);
    // The checked cards are open (nothing stops them); the two unchecked are open too, and say they were not checked.
    await waitFor(() => expect(carryButtons().every((b) => !b.disabled)).toBe(true));
    expect(screen.getAllByText('لم يُفحص هذا الطلب بعد.')).toHaveLength(2);

    fireEvent.click(asks[0]);
    await release(1);
    expect(state.started).toHaveLength(AUTO_CHECKED_CARDS + 1);
    expect(state.started.at(-1)).toBe(`cr-${AUTO_CHECKED_CARDS + 1}`);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'افحص' })).toHaveLength(1));
  });
});

describe('Ⅱ · the budget says «wait»', () => {
  it('leaves the card unchecked with «افحص», and does NOT shut its button on «تعذّر فحص»', async () => {
    serve([card(1)]);
    render(<ChangeRequestsScreen />);
    await screen.findByText('SY-1');
    await release(1, 'fail');

    await screen.findByText('الفحص مزدحم الآن — حاول بعد قليل.');
    expect(screen.getByRole('button', { name: 'افحص' })).toBeTruthy();
    await waitFor(() => expect(carryButtons()[0].disabled).toBe(false));
    expect(carryButtons()[0].title).toBe('');
    expect(document.body.textContent).not.toContain('تعذّر فحص الطلب');
  });

  it('and «افحص» asks again, and the answer shuts or opens the card as any answer does', async () => {
    serve([card(1)]);
    render(<ChangeRequestsScreen />);
    await screen.findByText('SY-1');
    await release(1, 'fail');

    fireEvent.click(await screen.findByRole('button', { name: 'افحص' }));
    await release(1);
    await screen.findByText(/المطلوب من الزبون:/);
    expect(screen.queryByRole('button', { name: 'افحص' })).toBeNull();
    await waitFor(() => expect(carryButtons()[0].disabled).toBe(false));
  });

  it('whereas a check that FAILED for another reason still shuts the card', async () => {
    serve([card(1)]);
    render(<ChangeRequestsScreen />);
    await screen.findByText('SY-1');
    await waitFor(() => expect(state.gates.length).toBe(1));
    (state.gates.shift() as Gate).fail(new Error('تعذر الاتصال'));
    await screen.findByText('تعذر الاتصال');
    await waitFor(() => expect(carryButtons()[0].disabled).toBe(true));
  });
});

describe('Ⅲ · lines the apply door cannot read', () => {
  const unreadable = () => card(1, { changes: { lines: { v: 2, edits: [] } }, lineNames: {} });

  it('shuts the button now, with its sentence on the card and on the button — and asks the server nothing', async () => {
    serve([unreadable()]);
    render(<ChangeRequestsScreen />);
    await screen.findByText('SY-1');

    const [carry] = carryButtons();
    expect(carry.disabled).toBe(true);
    expect(carry.title).toBe(REVIEW_UNREADABLE_AR);
    expect(screen.getByText(REVIEW_UNREADABLE_AR)).toBeTruthy();
    expect(state.started).toEqual([]);

    fireEvent.click(carry);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('an ordinary request beside it is untouched', async () => {
    serve([unreadable(), card(2, { changes: { customerName: { from: 'أ', to: 'ب' } } })]);
    render(<ChangeRequestsScreen />);
    await screen.findByText('SY-2');
    const [bad, good] = carryButtons();
    expect(bad.disabled).toBe(true);
    expect(good.disabled).toBe(false);
  });
});
