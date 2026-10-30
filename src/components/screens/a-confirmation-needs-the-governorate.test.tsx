// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «تأكيد الطلب» WAITS FOR THE GOVERNORATE, ON THE CARD (30/10).
 *
 * The owner: «المفروض ما يسمح لموظفة التأكيد تأكّد غير لما تحدد المحافظة». The door refuses (`REGION_REQUIRED`); this is the
 * screen telling her BEFORE the press, and giving her the field that fixes it on the very card — not behind «افتح وعدّل».
 *
 * DEFINITION OF DONE for this file:
 *   · an order with no `regionId`: a real, visible select «المحافظة — لازم قبل التأكيد», a visible line (no hover) beside the
 *     button, and «تأكيد الطلب» shut;
 *   · what the customer typed is printed as «المكتوب: …», never as the governorate; `matchRegion` only SUGGESTS — nothing
 *     is written until «احفظ المحافظة» is pressed, and the write is the ordinary `PATCH regionId`;
 *   · an order that has a governorate draws none of it (NEGATIVE);
 *   · a `REGION_REQUIRED` refusal from the door is shown as the sentence, in Arabic.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, user } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: user.current }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({
    regions: [
      { id: 'r-dam', name: 'دمشق' },
      { id: 'r-rif', name: 'ريف دمشق' },
      { id: 'r-swe', name: 'السويداء' },
    ],
    countryName: 'سوريا',
    currency: null,
    loading: false,
  }),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>طلباتي</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/confirmation/PullPanel', () => ({ PullPanel: () => null, useQueue: () => ({ reload: vi.fn() }) }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';
import { REGION_REQUIRED_MESSAGE } from '@/lib/confirmation-queue';

const order = (attempts: number, over: Record<string, unknown> = {}) => ({
  id: 'W1',
  orderNumber: 'ORD-W1',
  merchantRef: null,
  confirmationStatus: attempts > 0 ? 'NO_ANSWER' : 'NEW',
  state: 'NEW',
  previousOrders: 0,
  version: 4,
  totalAmount: 45,
  currency: 'JOD',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: attempts,
  source: 'LANDING_PAGE',
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  deliveryAddress: 'شارع الجلاء',
  regionId: null,
  region: null,
  customerNotes: null,
  customer: { id: 'c1', fullName: 'زبون', phone: '0790000001', rawPhone: '0790000001', city: 'سكاكة الجوف', address: 'عنوان' },
  items: [{ id: 'l1', productName: 'كريم', quantity: 1, freeQuantity: 0, lineTotal: 45 }],
  addOns: [],
  _count: { contactAttempts: attempts, notes: 0 },
  ...over,
});

const desk = (row: ReturnType<typeof order>) => ({
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-10-30T08:00:00.000Z',
  work: [row],
  noAnswer: [],
  closedToday: [],
  confirmed: { day: '2026-10-30', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
});

const refusal = (message: string, code: string) => Object.assign(new Error(message), { status: 409, data: { errorAr: message, code } });

const draw = async (row: ReturnType<typeof order>, after?: (url: string, init?: { method?: string }) => unknown) => {
  user.current = { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.work', 'orders.contact_log'], status: 'ACTIVE' };
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.startsWith('/api/confirmation/mine')) return desk(row);
    if (after) return after(url, init);
    throw new Error(`unexpected ${url}`);
  });
  apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}), clone() { return this; } }));
  render(<ConfirmationMineScreen />);
  await screen.findByText('ORD-W1');
};

const confirmButton = () => screen.getByRole('button', { name: /تأكيد الطلب/ }) as HTMLButtonElement;
const regionSelect = () => screen.getByLabelText(/المحافظة — لازم قبل التأكيد/) as HTMLSelectElement;
const patches = () => apiFetch.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH');

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('an order with no governorate', () => {
  it('(أ) draws a real select «المحافظة — لازم قبل التأكيد», a visible line beside the button, and shuts «تأكيد الطلب»', async () => {
    await draw(order(1));
    const select = regionSelect();
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['— اختر المحافظة —', 'دمشق', 'ريف دمشق', 'السويداء']);
    // a line she can read on a phone — not a tooltip
    expect(screen.getByText('اختر المحافظة لتفتح التأكيد')).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByText(/لازم قبل التأكيد/).textContent).toContain('سوريا');
  });

  it('(ب) what the customer typed is «المكتوب: …» and is never printed as the governorate', async () => {
    await draw(order(1));
    expect(screen.getByText(/المكتوب:/).textContent).toContain('سكاكة الجوف');
    expect(screen.queryByText(/المحافظة: سكاكة الجوف/)).toBeNull();
  });

  it('(ج) the select is a finger-sized control with the input border (44 points on a phone)', async () => {
    await draw(order(1));
    const cls = regionSelect().className;
    expect(cls).toMatch(/\bh-11\b/);
    expect(cls).toContain('border-[var(--sys-border-input)]');
  });

  it('(د) a typed city that matches a governorate is SUGGESTED — pre-selected, said, and NOT written', async () => {
    await draw(order(1, { customer: { id: 'c1', fullName: 'زبون', phone: '0790000001', rawPhone: '0790000001', city: 'محافظة السويداء', address: 'عنوان' } }));
    expect(regionSelect().value).toBe('r-swe');
    expect(screen.getByText(/اقتراح من المكتوب: السويداء/)).toBeTruthy();
    // nothing was sent, and the order is still without one
    expect(patches()).toEqual([]);
    expect(confirmButton().disabled).toBe(true);
  });

  it('(هـ) «احفظ المحافظة» writes the ordinary PATCH regionId with the version the screen loaded — and only then', async () => {
    await draw(order(1, { customer: { id: 'c1', fullName: 'زبون', phone: '0790000001', rawPhone: '0790000001', city: 'السويداء', address: 'عنوان' } }));
    fireEvent.change(regionSelect(), { target: { value: 'r-rif' } });
    expect(patches()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'احفظ المحافظة' }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    const [url, init] = patches()[0] as [string, { body: string }];
    expect(url).toBe('/api/orders/W1');
    expect(JSON.parse(init.body)).toEqual({ expectedVersion: 4, regionId: 'r-rif' });
  });

  it('(و) a written place that matches nothing suggests nothing: the select starts on «اختر» and the save is shut', async () => {
    await draw(order(1));
    expect(regionSelect().value).toBe('');
    expect(screen.queryByText(/اقتراح من المكتوب/)).toBeNull();
    const save = screen.getByRole('button', { name: 'احفظ المحافظة' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(patches()).toEqual([]);
  });

  it('(ز) before the first call the select and the save are shut with the contact-first line, and nothing is sent', async () => {
    await draw(order(0));
    expect(regionSelect().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'احفظ المحافظة' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/اتصل بالزبون أول — بعدها بتفتح الأزرار/)).toBeTruthy();
    expect(screen.getByText('اختر المحافظة لتفتح التأكيد')).toBeTruthy();
  });

  it('(ح) «ألغِ» and «تأجيل» are not held back by the missing governorate', async () => {
    await draw(order(1));
    expect((screen.getByRole('button', { name: /^ألغِ$/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /^تأجيل/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('NEGATIVE: an order that has its governorate', () => {
  it('(ط) draws no select and no line, and «تأكيد الطلب» is open', async () => {
    await draw(order(1, { regionId: 'r-dam', region: { name: 'دمشق' } }));
    expect(screen.queryByLabelText(/لازم قبل التأكيد/)).toBeNull();
    expect(screen.queryByText('اختر المحافظة لتفتح التأكيد')).toBeNull();
    expect(screen.queryByRole('button', { name: 'احفظ المحافظة' })).toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });

  it('(ي) a response from before the id was read (no regionId at all) does not shut the button on a guess', async () => {
    const { regionId: _gone, ...old } = order(1);
    void _gone;
    await draw(old as ReturnType<typeof order>);
    expect(screen.queryByLabelText(/لازم قبل التأكيد/)).toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });
});

describe('the door’s refusal is read out', () => {
  it('(ك) REGION_REQUIRED from «confirm» lands as the sentence, in Arabic, and says where to pick', async () => {
    // The id never arrived, so the button is open and the DOOR decides — the refusal is what is under test.
    const { regionId: _gone, ...old } = order(1);
    void _gone;
    await draw(old as ReturnType<typeof order>, (url, init) => {
      if (init?.method === 'POST') throw refusal(REGION_REQUIRED_MESSAGE, 'REGION_REQUIRED');
      throw new Error(`unexpected ${url}`);
    });
    fireEvent.click(confirmButton());
    const line = (await screen.findByText(/حدّد المحافظة أولاً/)).textContent ?? '';
    expect(line).toContain(REGION_REQUIRED_MESSAGE);
    expect(line).toContain('اختر المحافظة من الخانة بالبطاقة');
    expect(line).not.toMatch(/[A-Za-z]/);
  });
});
