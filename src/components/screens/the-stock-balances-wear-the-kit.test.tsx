// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { routeLabel } from '@/lib/route-registry';

/**
 * «أرصدة المخزون» ON THE KIT (R12c, plan 17/11) — ONE LOOK, NOTHING ELSE.
 *
 * The screen, the opening count and the receiving dialog moved onto the kit's buttons and cards and into `PageShell`.
 * What these hold: the frame (one h1, the menu's name, full width), every press still reaches the same handler, the
 * two doors that WRITE stock (the opening count and receiving) still post the very same body, and the figure lines
 * of the three files are byte-identical to what they were.
 */

const { api, phone, user } = vi.hoisted(() => ({
  api: vi.fn(),
  phone: { value: false },
  user: {
    current: {
      id: 'u1',
      name: 'سارة',
      role: 'COMPANY_ADMIN',
      permissions: ['inventory.view', 'inventory.adjust'],
      status: 'ACTIVE',
    } as Record<string, unknown>,
  },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/inventory/balances',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar', currentUser: user.current }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => null }));

import { InventoryBalancesScreen } from './InventoryBalancesScreen';
import { OpeningStockCountBanner } from '@/components/inventory/OpeningStockCount';
import { ReceiveDialog } from '@/components/inventory/ReceiveDialog';

const band = { key: 'cover', ar: 'مدة الكفاية', earned: 30, weight: 55, why: 'تكفي أياماً' };
const health = (state: string, over: Record<string, unknown> = {}) => ({
  tone: state === 'low' ? 'warn' : 'ok',
  label: state === 'low' ? 'قارب على الانتهاء' : 'متوفر',
  why: 'سبب مكتوب',
  state,
  available: 10,
  perDay: 2,
  coverDays: 5,
  windowDays: 13,
  score: 40,
  bands: [band],
  needsRestock: state === 'low',
  ...over,
});
const row = (id: string, state: string, sourceType: 'PURCHASED' | 'MANUFACTURED' = 'PURCHASED') => ({
  id,
  name: `منتج ${id}`,
  sku: `SKU-${id}`,
  sourceType,
  produced: 20,
  sold: 10,
  remaining: 12,
  reserved: 2,
  lastUnitCost: 3,
  health: health(state),
});
const ROWS = [row('A', 'low'), row('B', 'healthy'), row('M', 'healthy', 'MANUFACTURED')];

beforeEach(() => {
  api.mockReset();
  phone.value = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        stockSummary: ROWS,
        alerts: [{ state: 'low', tone: 'warn', ar: 'قارب على الانتهاء', count: 1 }],
        ledgerDays: 13,
      }),
    }))
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The opening count's door answers «countable, never counted» unless a test says otherwise. */
const openingState = (over: Record<string, unknown> = {}) => ({
  count: null,
  movements: 0,
  countable: true,
  products: [{ id: 'p1', name: 'سيروم', sku: 'S1' }],
  ...over,
});

const mount = async () => {
  api.mockImplementation(async (url: string) => (url === '/api/inventory/opening-count' ? openingState({ countable: false }) : { ok: true }));
  render(<InventoryBalancesScreen />);
  await screen.findByText('منتج A');
};
const productLinks = () => screen.queryAllByRole('link', { name: /^منتج [A-Z]$/ });

describe('the frame', () => {
  it('ONE h1, the menu’s own name, and no width cap (there was none)', async () => {
    await mount();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(routeLabel('/inventory/balances'));
    const frame = h1s[0].closest('header')!.parentElement as HTMLElement;
    expect(frame.className).not.toMatch(/max-w-/);
    expect(frame.className).toContain('min-w-0');
  });

  it('at 375px nothing is wider than the phone: no fixed pixel widths, no nowrap rows', async () => {
    phone.value = true;
    await mount();
    const tokens = [...document.body.querySelectorAll('[class]')].flatMap((e) => (e.getAttribute('class') ?? '').split(/\s+/));
    const wide = tokens.filter((t) => /^(min-w|w)-\[(\d+)px\]$/.test(t) && Number(/\d+/.exec(t)![0]) > 375);
    expect(wide).toEqual([]);
    expect(tokens).not.toContain('whitespace-nowrap');
  });
});

describe('the counts did not move', () => {
  it('DESK: one count button, one alert chip, «استلام» on the two bought products only, one «من أين الدرجة؟» per card, the two links', async () => {
    await mount();
    expect(screen.getAllByRole('button', { name: /جرد مخزون/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /قارب على الانتهاء/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'استلام' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'من أين الدرجة؟' })).toHaveLength(3);
    expect(productLinks()).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'سجل حركات المخزون' }).getAttribute('href')).toBe('/inventory/movements');
    expect(screen.getAllByRole('textbox')).toHaveLength(1); // the search
  });

  it('NEGATIVE: without inventory.adjust there is no «استلام» at all', async () => {
    user.current = { ...user.current, permissions: ['inventory.view'] };
    try {
      await mount();
      expect(screen.queryByRole('button', { name: 'استلام' })).toBeNull();
    } finally {
      user.current = { ...user.current, permissions: ['inventory.view', 'inventory.adjust'] };
    }
  });
});

describe('every press reaches the handler it reached before', () => {
  it('the alert chip filters, and the kit «اعرض الكل» brings every card back', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: 'اعرض الكل' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /قارب على الانتهاء/ }));
    expect(productLinks()).toHaveLength(1);
    const all = screen.getByRole('button', { name: 'اعرض الكل' });
    expect(all.className).toContain('bg-transparent'); // the kit's quiet button
    fireEvent.click(all);
    expect(productLinks()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'اعرض الكل' })).toBeNull();
  });

  it('«من أين الدرجة؟» opens THIS card’s bands, says it is open, and closes them', async () => {
    await mount();
    const card = screen.getByText('منتج B').closest('div[class*="space-y-3"]') as HTMLElement;
    const press = within(card).getByRole('button', { name: 'من أين الدرجة؟' });
    expect(press.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(press);
    expect(within(card).getByText('مدة الكفاية')).toBeTruthy();
    expect(screen.getAllByText('مدة الكفاية')).toHaveLength(1);
    const hide = within(card).getByRole('button', { name: 'أخفِ البنود' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hide);
    expect(screen.queryByText('مدة الكفاية')).toBeNull();
  });

  it('the desk «استلام» opens the dialog for THAT product', async () => {
    await mount();
    const card = screen.getByText('منتج B').closest('div[class*="space-y-3"]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'استلام' }));
    expect(screen.getByText('استلام بضاعة — منتج B')).toBeTruthy();
  });
});

describe('the receiving dialog — the same body, the kit buttons', () => {
  const draw = () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<ReceiveDialog product={{ id: 'p1', name: 'سيروم', remaining: 5, lastUnitCost: 3 }} onClose={onClose} onSaved={onSaved} />);
    return { onClose, onSaved };
  };

  it('posts exactly what it posted: action, product, quantity, typed cost, zero-cost reason, note', async () => {
    api.mockResolvedValue({ ok: true });
    const { onSaved } = draw();
    fireEvent.change(screen.getByLabelText('الكمية المستلمة'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText(/تكلفة الوحدة في هذه الدفعة/), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('ملاحظة'), { target: { value: ' وصلت ' } });
    fireEvent.click(screen.getByRole('button', { name: 'استلام' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('أُضيفت 7 وحدة إلى سيروم'));
    const [url, init] = api.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/inventory');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'receive',
      productId: 'p1',
      quantity: 7,
      unitCost: 2.5,
      zeroCostReason: null,
      note: 'وصلت',
    });
  });

  it('NEGATIVE: «إلغاء» closes and posts nothing', () => {
    const { onClose } = draw();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
  });

  it('NEGATIVE: while it saves, the button is locked and says so', async () => {
    let finish: (v: unknown) => void = () => {};
    api.mockReturnValue(new Promise((r) => (finish = r)));
    draw();
    fireEvent.change(screen.getByLabelText('الكمية المستلمة'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'استلام' }));
    const busy = await screen.findByRole('button', { name: 'جارٍ الاستلام…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    finish({ ok: true });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'جارٍ الاستلام…' })).toBeNull());
  });
});

describe('the opening count — the same body, the kit buttons', () => {
  const openDialog = async () => {
    api.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/inventory/opening-count' && !init ? openingState() : { ok: true }
    );
    const onCounted = vi.fn();
    render(<OpeningStockCountBanner onCounted={onCounted} />);
    fireEvent.click(await screen.findByRole('button', { name: /سجّل العدّ الافتتاحيّ/ }));
    return onCounted;
  };
  const save = () => screen.getByRole('button', { name: 'سجّل العدّ' }) as HTMLButtonElement;

  it('posts exactly what it posted, then tells the screen', async () => {
    const onCounted = await openDialog();
    fireEvent.change(screen.getByPlaceholderText('الاسم كما يُوقَّع على ورقة العدّ'), { target: { value: ' أبو سامي ' } });
    fireEvent.change(screen.getByLabelText('وقت العدّ *'), { target: { value: '2026-11-18T09:30' } });
    fireEvent.change(screen.getAllByLabelText('الكمية المعدودة من سيروم')[0], { target: { value: '40' } });
    fireEvent.change(screen.getAllByLabelText('كلفة وحدة سيروم')[0], { target: { value: '1.25' } });
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(onCounted).toHaveBeenCalledTimes(1));
    const post = api.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST') as [string, RequestInit];
    expect(post[0]).toBe('/api/inventory/opening-count');
    expect(JSON.parse(post[1].body as string)).toEqual({
      countedByName: 'أبو سامي',
      countedAt: new Date('2026-11-18T09:30').toISOString(),
      note: null,
      lines: [{ productId: 'p1', countedQty: 40, unitCost: 1.25, zeroCostReason: null }],
    });
  });

  it('NEGATIVE: with no name and no line the kit button stays locked, and pressing it posts nothing', async () => {
    await openDialog();
    expect(save().disabled).toBe(true);
    fireEvent.click(save());
    expect(api.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('NEGATIVE: «إلغاء» closes the dialog and posts nothing', async () => {
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('button', { name: 'سجّل العدّ' })).toBeNull();
    expect(api.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('a store already counted shows who counted, when, and how many lines', async () => {
    api.mockResolvedValue(
      openingState({ count: { countedByName: 'أبو سامي', countedAt: '2026-11-01T08:00:00.000Z', note: null, _count: { batches: 4 } } })
    );
    render(<OpeningStockCountBanner onCounted={() => {}} />);
    expect((await screen.findByText(/العدّ الافتتاحيّ: عدَّه/)).textContent).toContain('في 2026-11-01 · 4 بنداً');
  });
});

describe('the figure lines are the lines they were', () => {
  const ROOT = process.cwd();
  const src = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

  it('the screen, the opening count and the receiving dialog still carry their figure and body lines verbatim', () => {
    const screenSrc = src('src/components/screens/InventoryBalancesScreen.tsx');
    for (const line of [
      "          countedQuantity: onTheWire(countedTyped),",
      '                      دخل {s.produced} · خرج {s.sold}',
      '                  على الرف {selected.remaining} · محجوز {selected.reserved}',
      '                {systemQty}',
      "  const systemQty = selected?.health.available ?? 0;",
    ]) expect(screenSrc.split(/\n/), 'سطر رقم تغيّر').toContain(line);

    const opening = src('src/components/inventory/OpeningStockCount.tsx');
    for (const line of [
      '        في {state.count.countedAt.slice(0, 10)} · {state.count._count.batches} بنداً',
      '              countedQty: Number(r.qty),',
      '              unitCost: Number(r.cost),',
      "              zeroCostReason: Number(r.cost) === 0 ? r.zeroReason.trim() : null,",
    ]) expect(opening.split(/\n/), 'سطر رقم تغيّر').toContain(line);

    const receive = stripComments(src('src/components/inventory/ReceiveDialog.tsx'));
    for (const line of [
      '          الرصيد الحالي: <b>{product.remaining}</b> وحدة',
      '                quantity: Number(quantity),',
      "                unitCost: unitCost === '' ? undefined : Number(unitCost),",
    ]) expect(receive.split(/\n/), 'سطر رقم تغيّر').toContain(line);
  });
});
