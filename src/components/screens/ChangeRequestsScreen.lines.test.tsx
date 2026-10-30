// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { ReviewPreview } from '@/lib/change-request-review';

/**
 * «حتى لما رفعت طلب تعديل ما ظهر بطلبات التعديل» — and a request that edits several lines, in the queue.
 *
 * A request its raiser may also decide is approved the instant it is raised, so it lives in «بانتظار التطبيق»; the screen
 * used to open on «بانتظار القرار», which read 0, and the person went away believing the request had been lost. Read off
 * the rendered screen: which tab it opens on, what each tab says it holds, the way to the full tab from the empty one, the
 * lines in words (with product names), and the button that carries a lines request out — shut by the server's check.
 */

const { apiJson, apiFetch } = vi.hoisted(() => ({
  apiJson: vi.fn<(url: string) => Promise<unknown>>(),
  apiFetch: vi.fn<(url: string, init?: { body?: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(),
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

const request = (over: Record<string, unknown> = {}) => ({
  id: 'cr-1',
  reason: 'الزبون زاد الكمية',
  status: 'PENDING',
  blocking: false,
  changedDuringReview: false,
  createdAt: '2026-10-29T10:00:00.000Z',
  slaDueAt: null,
  overdue: false,
  decisionNote: null,
  requestedByName: 'ريم',
  requestedRole: 'CONFIRMATION_AGENT',
  isMine: false,
  intent: 'EDIT',
  postponeUntil: null,
  cancelReason: null,
  carryOut: { kind: 'EDIT_ORDER' },
  changes: { customerName: { from: 'سامر', to: 'سامر أحمد' } },
  order: {
    id: 'o1',
    orderNumber: 'SY-2026-0148',
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'PACKING',
    version: 3,
    customer: { fullName: 'سامر', phone: '0791234567' },
  },
  ...over,
});

const linesRequest = (over: Record<string, unknown> = {}) =>
  request({ changes: { lines: LINES }, lineNames: { 'prod-cream-0001': 'كريم' }, ...over });

const preview = (over: Partial<ReviewPreview> = {}): ReviewPreview => ({
  requestId: 'cr-1',
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
  ...over,
});

/** The two lists the screen asks for, and the previews of the requests in them. */
function serve(lists: { pending?: unknown[]; awaiting?: unknown[] }, previews: Record<string, ReviewPreview | Error> = {}) {
  apiJson.mockReset();
  apiJson.mockImplementation(async (url: string) => {
    const hit = Object.entries(previews).find(([id]) => url === `/api/control/change-requests/${id}/preview`);
    if (hit) {
      if (hit[1] instanceof Error) throw hit[1];
      return hit[1];
    }
    if (url.includes('status=PENDING')) return { requests: lists.pending ?? [] };
    if (url.includes('status=AWAITING_APPLY')) return { requests: lists.awaiting ?? [] };
    return { requests: [] };
  });
}

const tab = (name: RegExp) => screen.getByRole('button', { name });
const ready = async () => {
  render(<ChangeRequestsScreen />);
  await screen.findByRole('button', { name: /بانتظار القرار/ });
};

beforeEach(() => {
  apiJson.mockReset();
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
});
afterEach(cleanup);

describe('Ⅰ · it opens on the tab that has the request', () => {
  it('«بانتظار القرار: 0 / بانتظار التطبيق: 4» opens on the second — and both counts are on the tabs', async () => {
    serve({ pending: [], awaiting: [1, 2, 3, 4].map((n) => request({ id: `cr-${n}`, status: 'APPROVED', decisionNote: 'طُبِّق مباشرةً' })) });
    await ready();
    // The cards of the second tab are drawn; the first tab's empty state is not.
    expect((await screen.findAllByText('SY-2026-0148')).length).toBe(4);
    expect(screen.queryByText('لا طلبَ ينتظر المراجعة')).toBeNull();
    expect(tab(/بانتظار القرار/).textContent).toContain('0');
    expect(tab(/بانتظار التطبيق/).textContent).toContain('4');
  });

  it('opens on the first when it has requests, even if the second has more', async () => {
    serve({ pending: [request()], awaiting: [request({ id: 'cr-9', status: 'APPROVED' })] });
    await ready();
    expect(await screen.findByText('مراجعة واتخاذ القرار')).toBeTruthy();
  });

  it('and on the first when both are empty', async () => {
    serve({});
    await ready();
    expect(await screen.findByText('لا طلبَ ينتظر المراجعة')).toBeTruthy();
  });

  it('a hand that already chose a tab is not moved: picking the empty one stays on it', async () => {
    serve({ pending: [], awaiting: [request({ id: 'cr-9', status: 'APPROVED' })] });
    await ready();
    await screen.findByText('SY-2026-0148');
    fireEvent.click(tab(/بانتظار القرار/));
    expect(await screen.findByText('لا طلبَ ينتظر المراجعة')).toBeTruthy();
  });
});

describe('Ⅱ · each tab says what it holds', () => {
  it('under the tabs, in a sentence', async () => {
    serve({ pending: [request()], awaiting: [] });
    await ready();
    await screen.findByText('SY-2026-0148');
    expect(screen.getByText('طلبات لسا ما حدا بتّ فيها: وافق أو ارفض.')).toBeTruthy();
    fireEvent.click(tab(/بانتظار التطبيق/));
    expect(await screen.findByText('طلبات اعتُمدت ولسا ما انكتبت على الطلب — اضغط التنفيذ.')).toBeTruthy();
  });

  it('an empty tab points at the full one, with the count, and the press goes there', async () => {
    serve({ pending: [request()], awaiting: [] });
    await ready();
    await screen.findByText('SY-2026-0148');
    fireEvent.click(tab(/بانتظار التطبيق/));
    // Empty here, a request in the other tab: the way there is a button, not a guess.
    const go = await screen.findByRole('button', { name: /افتح «بانتظار القرار» — فيه 1 طلب/ });
    fireEvent.click(go);
    expect(await screen.findByText('مراجعة واتخاذ القرار')).toBeTruthy();
  });

  it('and says nothing of the sort when both are empty', async () => {
    serve({});
    await ready();
    await screen.findByText('لا طلبَ ينتظر المراجعة');
    expect(screen.queryByRole('button', { name: /افتح «/ })).toBeNull();
  });
});

describe('Ⅲ · a request that edits lines, in words', () => {
  it('one sentence per line with the product NAME, never the raw request', async () => {
    serve({ pending: [linesRequest()] });
    await ready();
    await screen.findByText('SY-2026-0148');
    expect(screen.getByText(/كريم — الكمية: 3 ← 5 · إجمالي السطر: 36 ← 60/)).toBeTruthy();
    // The key `lines` is not drawn as a field with an empty value, and no JSON leaks.
    expect(screen.queryByText('أسطر الطلب')).toBeNull();
    expect(document.body.textContent).not.toContain('"edits"');
    expect(document.body.textContent).not.toContain('lineId');
  });

  it('a line whose product the server could not name is «سطر ١», not an id', async () => {
    serve({ pending: [linesRequest({ lineNames: {} })] });
    await ready();
    await screen.findByText('SY-2026-0148');
    expect(screen.getByText(/سطر 1 — الكمية: 3 ← 5/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('prod-cream-0001');
  });

  it('the customer fields that travel beside the lines are drawn as before', async () => {
    serve({ pending: [linesRequest({ changes: { lines: LINES, customerName: { from: 'سامر', to: 'سامر أحمد' } } })] });
    await ready();
    await screen.findByText('SY-2026-0148');
    expect(screen.getByText('اسم العميل')).toBeTruthy();
    expect(screen.getByText('سامر أحمد')).toBeTruthy();
  });
});

describe('Ⅳ · carrying a lines request out waits for the server’s check', () => {
  const awaitingLines = () => linesRequest({ status: 'APPROVED', decisionNote: 'طُبِّق مباشرةً', carryOut: { kind: 'EDIT_ORDER' } });
  const carry = () => screen.getByRole('button', { name: 'طبّق التعديل على الطلب' }) as HTMLButtonElement;

  it('is shut while the check is in the air', async () => {
    apiJson.mockReset();
    apiJson.mockImplementation((url: string) =>
      url.includes('/preview')
        ? new Promise(() => undefined)
        : Promise.resolve({ requests: url.includes('status=AWAITING_APPLY') ? [awaitingLines()] : [] })
    );
    await ready();
    await screen.findByText(/جارٍ حساب أثر الطلب/);
    expect(carry().disabled).toBe(true);
    expect(carry().title).toBe('جارٍ فحص الطلب…');
  });

  it('is open when nothing stops it — and a press sends the id and the version, nothing else', async () => {
    serve({ awaiting: [awaitingLines()] }, { 'cr-1': preview() });
    await ready();
    await screen.findByText(/المطلوب من الزبون:/);
    await waitFor(() => expect(carry().disabled).toBe(false));

    fireEvent.click(carry());
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [url, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/orders/o1');
    expect(JSON.parse(init.body)).toEqual({ changeRequestId: 'cr-1', expectedVersion: 3 });
  });

  it('is shut with the reason on the card when the order can no longer take it', async () => {
    serve(
      { awaiting: [awaitingLines()] },
      { 'cr-1': preview({ blocked: true, problems: [{ code: 'STOCK_SHORT_BLOCKED', blocking: true, messageAr: 'المخزون ما بيكفي لـكريم.' }] }) }
    );
    await ready();
    await screen.findByText('ما ينفع تنفيذ هذا الطلب الآن:');
    await waitFor(() => expect(carry().title).toBe('المخزون ما بيكفي لـكريم.'));
    expect(carry().disabled).toBe(true);

    fireEvent.click(carry());
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('is shut when the check itself could not be made', async () => {
    serve({ awaiting: [awaitingLines()] }, { 'cr-1': new Error('تعذر الاتصال') });
    await ready();
    await screen.findByText('تعذر الاتصال');
    await waitFor(() => expect(carry().title).toMatch(/تعذّر فحص الطلب/));
    expect(carry().disabled).toBe(true);
  });

  it('asks about THIS request only — an ordinary one in the same tab is never previewed and never shut', async () => {
    serve({ awaiting: [request({ id: 'cr-2', status: 'APPROVED', carryOut: { kind: 'EDIT_ORDER' } })] });
    await ready();
    await screen.findByText('SY-2026-0148');
    expect(apiJson.mock.calls.some(([url]) => String(url).includes('/preview'))).toBe(false);
    expect(carry().disabled).toBe(false);
  });
});
