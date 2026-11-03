// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «CSV الجاهزة للشحن» ON «إنشاء شحنة» (the owner, 3/11: «csv عند انشاء الشحنة استخرج الطلبات الجاهزة للشحن مش المؤجلة»).
 *
 * The button asks the file door with the filters and the search on the screen and the courier chosen for the shipment,
 * downloads what it answers, and says under the tabs how many orders the file holds and how many it left out and why —
 * «2 مؤجّلين برّا الملف». It is drawn only for whoever holds the screen's key and the address-book key, and waits for a
 * courier. A refusal is said on the screen, not saved as a file.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, user, failed } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: null as unknown },
  failed: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/shipments/new', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: (...a: unknown[]) => failed(...a), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));

import { ShipmentsNewScreen } from './ShipmentsNewScreen';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 20000 });

const BOTH = { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.ship', 'customers.view'] };
const SHIP_ONLY = { id: 'u2', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.ship'] };

const row = {
  id: '1', orderNumber: 'ORD-1', merchantRef: 'ORD-1',
  customer: { id: 'c1', fullName: 'سامر خليل', phone: '0790000000', city: 'عمّان' },
  previousOrders: 0, region: { id: 'r1', name: 'عمّان' },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
  cod: { subtotal: 20, discount: 0, deliveryFee: 0, cod: 20, currency: 'JOD', feeSource: 'region' },
  blocks: [], selectable: true, hardBlocked: false, shipHoldUntil: null, standDownBlocked: null, shipHoldReason: null,
};

const fileAnswer = (held: number, unready: number, rows: number, blocked = 0) => ({
  ok: true,
  status: 200,
  headers: new Headers({
    'X-Rows': String(rows), 'X-Left-Held': String(held), 'X-Left-Unready': String(unready), 'X-Left-Blocked': String(blocked),
  }),
  blob: async () => new Blob(['x'], { type: 'text/csv' }),
  json: async () => ({}),
});

const BUTTON = /CSV الجاهزة للشحن/;

async function draw() {
  render(<ShipmentsNewScreen />);
  await waitFor(() => expect(screen.queryAllByText(/سامر خليل/).length).toBeGreaterThan(0), WAIT);
}

beforeEach(() => {
  vi.clearAllMocks();
  user.current = BOTH;
  apiJson.mockImplementation(async (url: string) => {
    if (url.includes('/api/ops/shipments')) return { orders: [row], heldCount: 2 };
    return { providers: [{ id: 'p1', name: 'الباشا' }], regions: [{ id: 'r1', name: 'عمّان' }] };
  });
  // jsdom has no object URLs: the download is a link to one.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:x');
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe('who is offered the file', () => {
  it('the holder of both keys sees the button; under «الكل» the press asks for a courier, out loud, and fetches nothing', async () => {
    await draw();
    const button = screen.getByRole('button', { name: BUTTON }) as HTMLButtonElement;
    // Never a dead greyed button (the owner, 3/11: «ليش تنزيل ال CSV مش شغال»): it presses, and says why there is no file.
    expect(button.disabled).toBe(false);
    expect(button.title).toContain('اختر شركة الشحن');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(apiFetch).not.toHaveBeenCalled();
    const said = await screen.findByText(/اختر شركة الشحن من «شركة الشحن \(للشحنة\)» فوق أولاً/, undefined, WAIT);
    expect(said.getAttribute('role')).toBe('status');
    // And the cursor is put on the very list to pick from.
    expect(document.activeElement).toBe(screen.getByLabelText(/شركة الشحن \(للشحنة\)/));
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    await waitFor(() => expect((screen.getByRole('button', { name: BUTTON }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('NEGATIVE: without the address-book key there is no button', async () => {
    user.current = SHIP_ONLY;
    await draw();
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });
});

describe('the press', () => {
  it('asks the file door with the courier and the search on the screen, and says what the file left out', async () => {
    apiFetch.mockResolvedValue(fileAnswer(2, 0, 8));
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    fireEvent.change(screen.getByPlaceholderText(/رقم الطلب/), { target: { value: 'سامر' } });
    await waitFor(() => expect((screen.getByRole('button', { name: BUTTON }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    });

    const url = String(apiFetch.mock.calls[0][0]);
    expect(url.startsWith('/api/ops/shipments/export?')).toBe(true);
    const asked = new URL(url, 'http://x').searchParams;
    expect(asked.get('courier')).toBe('p1');
    expect(asked.get('q')).toBe('سامر');
    expect(asked.get('held')).toBeNull();
    expect((await screen.findByText('نزل الملف: 8 طلب جاهز للشحن · 2 مؤجّلين برّا الملف', undefined, WAIT)).getAttribute('role')).toBe('status');
  });

  it('one postponed, one not reserved: each said in its own words', async () => {
    apiFetch.mockResolvedValue(fileAnswer(1, 1, 3));
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    await waitFor(() => expect((screen.getByRole('button', { name: BUTTON }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    });
    expect((await screen.findByText('نزل الملف: 3 طلب جاهز للشحن · 1 مؤجّل برّا الملف · 1 غير محجوز برّا الملف', undefined, WAIT)).getAttribute('role')).toBe('status');
  });

  it('no governorate or no fee row: said in its own words beside the others', async () => {
    apiFetch.mockResolvedValue(fileAnswer(0, 1, 5, 2));
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    await waitFor(() => expect((screen.getByRole('button', { name: BUTTON }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    });
    expect((await screen.findByText('نزل الملف: 5 طلب جاهز للشحن · 1 غير محجوز برّا الملف · 2 بلا محافظة أو أجرة توصيل برّا الملف', undefined, WAIT)).getAttribute('role')).toBe('status');
  });

  it('nothing ready because of the fee: the sentence carries the blocked count', async () => {
    apiFetch.mockResolvedValue({
      ok: false, status: 409, headers: new Headers(),
      json: async () => ({ errorAr: 'ما في طلب جاهز للشحن بهالفلاتر — ما في ملف.', held: 0, unready: 0, blocked: 3 }),
    });
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    await waitFor(() => expect((screen.getByRole('button', { name: BUTTON }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    });
    expect((await screen.findByText('ما في طلب جاهز للشحن بهالفلاتر — ما في ملف. · 3 بلا محافظة أو أجرة توصيل برّا الملف', undefined, WAIT)).getAttribute('role')).toBe('status');
  });

  it('nothing ready: the door’s sentence and what it left out are on the screen, and no file is made', async () => {
    apiFetch.mockResolvedValue({
      ok: false, status: 409, headers: new Headers(),
      json: async () => ({ errorAr: 'ما في طلب جاهز للشحن بهالفلاتر — ما في ملف.', held: 2, unready: 0 }),
    });
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    await waitFor(() => expect((screen.getByRole('button', { name: BUTTON }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    });
    expect((await screen.findByText('ما في طلب جاهز للشحن بهالفلاتر — ما في ملف. · 2 مؤجّلين برّا الملف', undefined, WAIT)).getAttribute('role')).toBe('status');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('a refusal of another kind is a failure toast, not a file', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, headers: new Headers(), json: async () => ({ errorAr: 'ممنوع' }) });
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    await waitFor(() => expect((screen.getByRole('button', { name: BUTTON }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    });
    await waitFor(() => expect(failed).toHaveBeenCalledWith('ممنوع'));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('the ticked rows are the file (the owner, 3/11: «خليها تنزل الي بحددو من المؤجل او جاهز»)', () => {
  const PICKED = /CSV المحدَّدة \(1\)/;
  const tickTheRow = () => {
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[boxes.length - 1]);
  };

  it('a ticked row on «مؤجَّلة الشحن»: the button counts it, and the press posts exactly its id with the courier', async () => {
    apiFetch.mockResolvedValue(fileAnswer(0, 0, 1));
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: /مؤجَّلة الشحن/ }));
    await waitFor(() => expect(apiJson.mock.calls.some(([u]) => String(u).includes('held=only'))).toBe(true), WAIT);
    await waitFor(() => expect(screen.queryAllByText(/سامر خليل/).length).toBeGreaterThan(0), WAIT);
    tickTheRow();
    const button = await screen.findByRole('button', { name: PICKED }, WAIT);
    await act(async () => {
      fireEvent.click(button);
    });

    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ops/shipments/export');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ courier: 'p1', ids: ['1'] });
    expect((await screen.findByText('نزل الملف: 1 طلب من المحدَّدة', undefined, WAIT)).getAttribute('role')).toBe('status');
  });

  it('a ticked id that left the list since is said in its own words', async () => {
    apiFetch.mockResolvedValue({ ...fileAnswer(0, 0, 1), headers: new Headers({ 'X-Rows': '1', 'X-Left-Gone': '1' }) });
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    tickTheRow();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: PICKED }, WAIT));
    });
    expect(await screen.findByText('نزل الملف: 1 طلب من المحدَّدة · 1 طلع من القائمة من وقت ما تحدّد (انشحن أو انلغى)', undefined, WAIT)).toBeTruthy();
  });

  it('NEGATIVE: nothing ticked — the whole ready tab, by the address, as before', async () => {
    apiFetch.mockResolvedValue(fileAnswer(0, 0, 4));
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    });
    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(url.startsWith('/api/ops/shipments/export?')).toBe(true);
    expect(init?.method).toBeUndefined();
  });
});
