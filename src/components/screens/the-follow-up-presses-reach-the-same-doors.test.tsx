// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { DEFAULT_WINBACK_RULE } from '@/lib/winback';

/**
 * «المتابعة» ON THE KIT (R8f, 18/11) — THE SAME PRESSES, REACHING THE SAME DOORS.
 *
 * The three lists of the screen (the postponed list, the daily calls, the win-back list) moved from hand-written buttons and surfaces to the
 * kit's `Button` and `Card`, and the frame moved to `PageShell`. That is a change of LOOK only. What this file holds:
 *
 *   · every press on the three lists still sends the same request, to the same door, with the same body — table-driven, one row per press;
 *   · a press that must not be offered is still not offered (a row that is not due, a colleague's row, a call with no result picked);
 *   · every kit button in the four files says `type="button"` (the kit sets no default, and a default `submit` inside a form is a second action);
 *   · the money lines of the win-back card are byte-for-byte what they were — not a class, not a word;
 *   · and the frame is one `PageShell`, named from the registry, while the leads lane line stays exactly as it was (another request moves it).
 *
 * No browser behind the login can be opened (every account has a second factor only the owner completes), so this is rendered in jsdom.
 */

const { api, ask, tell, toast } = vi.hoisted(() => ({
  api: vi.fn(),
  ask: vi.fn(),
  tell: vi.fn(),
  toast: { done: vi.fn(), failed: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => ask, useTell: () => tell }));
vi.mock('@/components/orders/OrderRef', () => ({
  OrderRef: ({ id, number }: { id: string; number: string }) => <a href={`/orders/${id}`}>{number}</a>,
}));

import { ConfirmationPostponedScreen } from './ConfirmationPostponedScreen';
import { WinbackScreen } from './WinbackScreen';
import { WinbackDaily } from './WinbackDaily';

const postponedRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  totalAmount: 10,
  currency: 'USD',
  dueAt: '2026-10-22T10:00:00.000Z',
  daysRemaining: 1,
  postponePreferredTime: null,
  postponeCount: 1,
  followUpReason: null,
  actionable: true,
  customer: { fullName: 'عميل تجريبي', phone: '0790000000', city: 'عمّان' },
  claimer: null,
  ...over,
});

const winbackRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  customer: { fullName: 'عميل تجريبي', phone: '0790000000' },
  product: 'ساعة',
  quantity: 2,
  sellingPrice: 40,
  discountAmount: 0,
  rejectionReason: 'PRICE_TOO_HIGH',
  rejectionNote: null,
  rejectedAt: '2026-09-20T10:00:00.000Z',
  returnLabel: null,
  returnReceivedAt: null,
  verdict: { eligible: true, dueAt: '2026-10-04T10:00:00.000Z', maxDiscount: 10 },
  ...over,
});

const daily = {
  enabled: true,
  window: { fromHours: 24, toHours: 72 },
  canAssign: true,
  canCall: true,
  assignees: [{ id: 'u1', name: 'سارة' }],
  items: [
    { orderId: 'd1', orderNumber: 'ORD-D1', kind: 'LOST', reason: 'PRICE_TOO_HIGH', reasonAr: 'السعر مرتفع', happenedAt: '2026-11-18T00:00:00Z', assignee: null, lastCall: null },
  ],
};

let postponedRows: ReturnType<typeof postponedRow>[];
let winbackRows: ReturnType<typeof winbackRow>[];
let canOffer: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  postponedRows = [postponedRow('P1')];
  winbackRows = [winbackRow('W1')];
  canOffer = true;
  ask.mockResolvedValue('7');
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { success: true, order: { orderNumber: 'ORD-NEW' } };
    const path = url.split('?')[0];
    const pagination = { total: 1, page: 1, limit: 25, totalPages: 1 };
    if (path === '/api/confirmation/postponed') {
      return {
        leadDays: 2,
        orders: postponedRows,
        pagination,
        facts: { total: 1, whens: { now: 1, overdue: 0, soon: 0, week: 0, later: 0 }, kinds: { postponed: 1, followup: 0 }, times: { once: 1, many: 0 }, agents: null },
      };
    }
    if (path === '/api/confirmation/winback') {
      return {
        rows: winbackRows,
        pagination,
        facts: { views: { ready: 1, cooling: 0, skipped: 0 }, reasons: [], products: [], periods: { '7': 0, '30': 1, '90': 1 }, shipping: { before: 1, after: 0 } },
        rule: { ...DEFAULT_WINBACK_RULE, reasons: [...DEFAULT_WINBACK_RULE.reasons] },
        canEditRule: true,
        canOffer,
      };
    }
    if (path === '/api/confirmation/winback/daily') return daily;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');

/** One row per press: what is drawn, how the press is made, and the one request it must send. */
const PRESSES: {
  name: string;
  draw: () => Promise<void>;
  press: () => void;
  door: string;
  body: Record<string, unknown>;
}[] = [
  {
    name: 'postponed · «إلى الطابور»',
    draw: async () => {
      render(<ConfirmationPostponedScreen embedded />);
      await screen.findAllByText('ORD-P1');
    },
    press: () => fireEvent.click(screen.getAllByRole('button', { name: /إلى الطابور/ })[0]),
    door: '/api/confirmation/postponed',
    body: { orderId: 'P1' },
  },
  {
    name: 'win-back · «اعرضه من جديد»',
    draw: async () => {
      render(<WinbackScreen embedded />);
      await screen.findByText('ORD-W1');
    },
    press: () => fireEvent.click(screen.getByRole('button', { name: 'اعرضه من جديد' })),
    door: '/api/confirmation/winback',
    body: { orderId: 'W1', discount: 7 },
  },
  {
    name: 'daily · «سجّل»',
    draw: async () => {
      render(<WinbackDaily />);
      await screen.findAllByText('ORD-D1');
      fireEvent.change(screen.getAllByLabelText('نتيجة الاتصال — ORD-D1')[0], { target: { value: 'AGREED' } });
    },
    press: () => fireEvent.click(screen.getAllByRole('button', { name: 'سجّل' })[0]),
    door: '/api/confirmation/winback/daily',
    body: { action: 'call', orderId: 'd1', result: 'AGREED' },
  },
];

describe('every press on the three lists sends the same request it sent before the kit', () => {
  it.each(PRESSES)('$name', async ({ draw, press, door, body }) => {
    await draw();
    press();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe(door);
    expect(JSON.parse((posts()[0][1] as RequestInit).body as string)).toEqual(body);
  });

  it.each(PRESSES)('$name — is a kit button that never submits a form', async ({ draw }) => {
    await draw();
    const buttons = screen.getAllByRole('button').filter((b) => /إلى الطابور|اعرضه من جديد|سجّل|عدّل القاعدة/.test(b.textContent ?? ''));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.getAttribute('type'), b.textContent ?? '').toBe('button');
  });
});

describe('NEGATIVE: what was not offered is still not offered', () => {
  it('a postponed row that is not due has no «إلى الطابور», only a dash', async () => {
    postponedRows = [postponedRow('P1', { actionable: false })];
    render(<ConfirmationPostponedScreen embedded />);
    await screen.findAllByText('ORD-P1');
    expect(screen.queryByRole('button', { name: /إلى الطابور/ })).toBeNull();
  });

  it('a colleague’s row without the key to hand it over has no «إلى الطابور»', async () => {
    postponedRows = [postponedRow('P1', { mayHandBack: false })];
    render(<ConfirmationPostponedScreen embedded />);
    await screen.findAllByText('ORD-P1');
    expect(screen.queryByRole('button', { name: /إلى الطابور/ })).toBeNull();
  });

  it('«سجّل» is held until a result is picked, and a press then sends nothing', async () => {
    render(<WinbackDaily />);
    await screen.findAllByText('ORD-D1');
    const save = screen.getAllByRole('button', { name: 'سجّل' })[0] as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    await new Promise((r) => setTimeout(r, 10));
    expect(posts()).toHaveLength(0);
  });

  it('a win-back row that is not eligible has no offer button, only the sentence', async () => {
    winbackRows = [winbackRow('W1', { verdict: { eligible: false, code: 'COOLING', reason: 'لم يمضِ وقت كافٍ', dueAt: '2026-12-01T00:00:00.000Z' } })];
    render(<WinbackScreen embedded />);
    const card = (await screen.findByText('ORD-W1')).closest('article')!;
    expect(within(card).queryByRole('button', { name: 'اعرضه من جديد' })).toBeNull();
    expect(card.querySelector('footer')!.textContent).toContain('لم يمضِ وقت كافٍ');
  });

  it('without the offer key an eligible row has no «اعرضه من جديد» — the ceiling is still written', async () => {
    canOffer = false;
    render(<WinbackScreen embedded />);
    const card = (await screen.findByText('ORD-W1')).closest('article')!;
    expect(within(card).queryByRole('button', { name: 'اعرضه من جديد' })).toBeNull();
    expect(card.textContent).toContain('أقصى خصم');
  });

  it('a press on «إلى الطابور» holds the button while the request is in the air — one request, not two', async () => {
    let finish!: (v: unknown) => void;
    const original = api.getMockImplementation()!;
    api.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === 'POST' ? new Promise((r) => (finish = r)) : original(url, init)
    );
    render(<ConfirmationPostponedScreen embedded />);
    await screen.findAllByText('ORD-P1');
    fireEvent.click(screen.getAllByRole('button', { name: /إلى الطابور/ })[0]);
    await waitFor(() => expect((screen.getAllByRole('button', { name: /إلى الطابور/ })[0] as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getAllByRole('button', { name: /إلى الطابور/ })[0]);
    expect(posts()).toHaveLength(1);
    finish({ success: true });
  });
});

describe('the sources', () => {
  const ROOT = process.cwd();
  const raw = (f: string) => readFileSync(join(ROOT, 'src/components/screens', f), 'utf8').replace(/\r\n/g, '\n');
  const FILES = ['ConfirmationFollowUpScreen.tsx', 'ConfirmationPostponedScreen.tsx', 'WinbackScreen.tsx', 'WinbackDaily.tsx'];

  it.each(FILES)('%s — no hand-written button is left, and every kit button says type="button"', (f) => {
    const src = stripComments(raw(f));
    expect(src, 'زر مكتوب باليد').not.toMatch(/<button(?=[\s>/])/);
    for (const m of src.matchAll(/<Button\b[^>]*?>/g)) expect(m[0], 'زر بلا type').toMatch(/type="button"/);
  });

  it('the money lines of the win-back card are exactly what they were (not a class, not a word)', () => {
    const src = raw('WinbackScreen.tsx');
    for (const line of [
      '            <p className="text-xs text-[var(--sys-muted-foreground)]">',
      '              {r.product ?? \'—\'} · {r.quantity} × <Money value={r.sellingPrice} />',
      '                <> · محسومٌ سابقاً <Money value={r.discountAmount} /></>',
      '                  <span className="inline-flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">',
      '                    أقصى خصم <Money value={r.verdict.maxDiscount} />',
    ]) {
      expect(src.split('\n'), line.trim()).toContain(line);
    }
  });

  it('the frame is one PageShell named from the registry, and the leads lane line is untouched', () => {
    const src = stripComments(raw('ConfirmationFollowUpScreen.tsx'));
    expect(src.match(/<PageShell\b/g)).toHaveLength(1);
    expect(src).toContain(`<PageShell title={routeLabel('/confirmation/follow-up')} width="wide">`);
    expect(src).not.toMatch(/<PageHeader\b/);
    expect(raw('ConfirmationFollowUpScreen.tsx').split('\n')).toContain('      <LeadsLane />');
  });

  it('the leads lane is drawn ABOVE the tabs (R10c moves it; until then its place is unchanged)', () => {
    const src = stripComments(raw('ConfirmationFollowUpScreen.tsx'));
    const lane = src.indexOf('<LeadsLane />');
    const tabs = src.indexOf('<Tabs ');
    expect(lane).toBeGreaterThan(-1);
    expect(tabs).toBeGreaterThan(-1);
    expect(lane).toBeLessThan(tabs);
  });
});
