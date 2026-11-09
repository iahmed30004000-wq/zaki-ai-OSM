// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «الشركة بتقول» AND THE COPY BUTTON — WHAT THE FOLLOW-UP SCREEN DRAWS.
 *
 * The delivery company is asked every two minutes and the door sends each row what it said (`courierSaid`). The screen:
 *
 *   • draws «الشركة بتقول: <the company's name for it>» beside the reason the row is in front of you, in the tone of the
 *     word, with how old it is and — apart — the company's free note; a part delivery also carries the act that cannot
 *     wait for the statement; a row with no word draws nothing;
 *   • offers «الشركة بتقول» as a dropdown with the server's number beside each of the five words, sends only what was
 *     chosen, and puts it back with the other choices;
 *   • has ONE copy button on the «الباركود» column — the barcode, and the reference for a parcel with none — that is a
 *     44px words-and-all button on a phone card, and hands the value to a field to select when the browser refuses;
 *   • and changes nothing else on the screen (the rest is the old tests', all still green).
 */

const { api, tell, toast } = vi.hoisted(() => ({
  api: vi.fn(),
  tell: vi.fn<(options: unknown) => Promise<void>>(async () => undefined),
  toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>متابعة الشحن</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => true, useTell: () => tell }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { TrackingScreen } from '@/components/screens/TrackingScreen';

// What a test awaits it may wait eight seconds for: a loaded machine is not a failing test.
configure({ asyncUtilTimeout: 8000 });

const P1 = '11111111-1111-4111-8111-111111111111';
const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };
const SAID_COUNTS = { DELIVERED: 12, PARTIALLY_DELIVERED: 1, RETURNED: 3, CANCELLED: 2, FAILED_DELIVERY: 4 };

const parcel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus: 'SHIPPED',
  collectionStatus: 'NOT_APPLICABLE',
  settlementStatus: 'NOT_APPLICABLE',
  daysInTransit: 4,
  lateThresholdDays: 3,
  late: true,
  totalAmount: 40,
  currency: 'JOD',
  deliveryFailureReason: null,
  customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
  region: { name: 'عمّان' },
  deliveryProvider: { id: P1, name: 'الباشا', kind: 'COMPANY' },
  expectedCollection: 37.5,
  _count: { deliveryAttempts: 0, notes: 0 },
  alert: null,
  courierSaid: null,
  ...over,
});
const word = (status: string, label: string, over: Record<string, unknown> = {}) => ({
  status,
  label,
  note: null,
  at: '2026-11-09T10:00:00.000Z',
  ageMinutes: 120,
  ...over,
});

let rows: ReturnType<typeof parcel>[];
let saidCounts: Record<string, number> | undefined;

const gets = () =>
  api.mock.calls.filter((c) => !(c[1] && (c[1] as RequestInit).method)).map((c) => new URL(c[0] as string, 'http://x').searchParams);
const writes = () => api.mock.calls.filter((c) => c[1] && (c[1] as RequestInit).method);

beforeEach(() => {
  vi.clearAllMocks();
  rows = [parcel('a')];
  saidCounts = SAID_COUNTS;
  api.mockImplementation(async () => ({
    count: rows.length,
    orders: rows,
    lateCount: 0,
    dialCode: '962',
    pagination: { total: rows.length, page: 1, limit: 25, totalPages: 1 },
    facts: {
      total: rows.length,
      tasks: NO_TASKS,
      lateCount: 0,
      notLate: 0,
      couriers: [{ id: P1, name: 'الباشا', count: rows.length }],
      regions: [],
      ages: { fresh: 1, few: 0, week: 0, old: 0 },
      ...(saidCounts ? { said: saidCounts } : {}),
    },
    applied: {},
    capped: false,
    access: { money: true, returns: true, collect: false },
  }));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  delete (document as { execCommand?: unknown }).execCommand;
});

const draw = async () => {
  render(<TrackingScreen />);
  await screen.findByLabelText('جهة الشحن');
};
/** The desk's table, and the phone's cards — `Rows` draws both and the stylesheet shows one. */
const desk = () => document.querySelector('table') as HTMLElement;
const cards = () => document.querySelector('ul.md\\:hidden') as HTMLElement;
/**
 * The desk's own copy button — the one in the column. The table's last cell also carries the phone card's twin of it (drawn
 * by the stylesheet only below the desk's width, `md:hidden`), and a test with no stylesheet sees both.
 */
const deskButton = (name: string | RegExp) => {
  const found = within(desk())
    .getAllByRole('button', { name })
    .filter((b) => !b.closest('span.md\\:hidden'));
  expect(found, String(name)).toHaveLength(1);
  return found[0];
};

describe('the chip — «الشركة بتقول: …» beside the reason the row is here', () => {
  it.each([
    ['DELIVERED', 'تم التوصيل', '--sys-success'],
    ['PARTIALLY_DELIVERED', 'تم توصيلها بشكل جزئي', '--sys-warning'],
    ['RETURNED', 'تم ارجاعها', '--sys-destructive'],
    ['CANCELLED', 'ملغاة', '--sys-destructive'],
    ['FAILED_DELIVERY', 'مؤجلة', '--sys-warning'],
  ])('— %s: the company’s own name for it, in the word’s own tone (%s)', async (status, label, token) => {
    rows = [parcel('a', { courierSaid: word(status, label) })];
    await draw();
    const chip = within(desk()).getByText(`الشركة بتقول: ${label}`);
    expect(chip.className).toContain(token);
    expect(chip.getAttribute('title')).toContain('قالتها الشركة قبل ساعتين');
    // Not the other two tones.
    for (const other of ['--sys-success', '--sys-warning', '--sys-destructive'].filter((t) => t !== token)) {
      expect(chip.className, `${status} wears ${other}`).not.toContain(`text-[var(${other})]`);
    }
  });

  it('and a phone card has it too — in the heading, with the reference', async () => {
    rows = [parcel('a', { courierSaid: word('DELIVERED', 'تم التوصيل') })];
    await draw();
    expect(within(cards()).getByText('الشركة بتقول: تم التوصيل')).toBeTruthy();
    expect(within(cards()).getByText('قبل ساعتين')).toBeTruthy();
  });

  it('and a row the company has said nothing about — or whose word the door left out — draws nothing of it', async () => {
    rows = [parcel('a', { courierSaid: null }), parcel('b', { courierSaid: undefined })];
    await draw();
    expect(document.body.textContent).not.toContain('الشركة بتقول:');
  });

  it('and how old the word is sits under the chip, short and spoken', async () => {
    rows = [
      parcel('a', { courierSaid: word('DELIVERED', 'تم التوصيل', { ageMinutes: 0 }) }),
      parcel('b', { courierSaid: word('DELIVERED', 'تم التوصيل', { ageMinutes: 45 }) }),
      parcel('c', { courierSaid: word('DELIVERED', 'تم التوصيل', { ageMinutes: 3 * 24 * 60 }) }),
    ];
    await draw();
    for (const age of ['قبل لحظات', 'قبل 45 دقيقة', 'قبل 3 أيام']) expect(within(desk()).getByText(age), age).toBeTruthy();
  });

  it('— the company’s free note is a second line and a tooltip; it is NEVER the label', async () => {
    rows = [parcel('a', { courierSaid: word('DELIVERED', 'تم التوصيل', { note: 'العميل طلب يؤجّلوها للخميس' }) })];
    await draw();
    const chip = within(desk()).getByText('الشركة بتقول: تم التوصيل');
    expect(chip.getAttribute('title')).toContain('ملاحظة الشركة: «العميل طلب يؤجّلوها للخميس»');
    expect(within(desk()).getByText('قبل ساعتين · «العميل طلب يؤجّلوها للخميس»')).toBeTruthy();
    expect(screen.queryByText(/الشركة بتقول: العميل طلب/)).toBeNull();
  });

  it('— and ONLY a part delivery carries «سجّلي «استلم جزءاً» بالبنود», where the act is: on the desk and on the card', async () => {
    rows = [
      parcel('p', { courierSaid: word('PARTIALLY_DELIVERED', 'تم توصيلها بشكل جزئي') }),
      parcel('d', { courierSaid: word('DELIVERED', 'تم التوصيل') }),
      parcel('r', { courierSaid: word('RETURNED', 'تم ارجاعها') }),
    ];
    await draw();
    expect(within(desk()).getAllByText('سجّلي «استلم جزءاً» بالبنود')).toHaveLength(1);
    expect(within(cards()).getAllByText('سجّلي «استلم جزءاً» بالبنود')).toHaveLength(1);
    // The hint names a button this screen really has.
    expect(within(desk()).getAllByText('استلم جزءاً').length).toBeGreaterThan(0);
  });

  it('— and nothing it draws is English', async () => {
    rows = [
      parcel('a', { courierSaid: word('DELIVERED', 'تم التوصيل', { note: 'ملاحظة' }) }),
      parcel('b', { courierSaid: word('PARTIALLY_DELIVERED', 'تم توصيلها بشكل جزئي', { ageMinutes: 59 }) }),
      parcel('c', { courierSaid: word('FAILED_DELIVERY', 'مؤجلة', { ageMinutes: 70 * 60 }) }),
    ];
    await draw();
    const drawn = [...within(desk()).getAllByText(/الشركة بتقول|قبل |سجّلي/)].map((e) => `${e.textContent} ${e.getAttribute('title') ?? ''}`);
    expect(drawn.length).toBeGreaterThanOrEqual(6);
    expect(drawn.filter((t) => /[A-Za-z]/.test(t))).toEqual([]);
  });
});

describe('the filter «الشركة بتقول»', () => {
  const select = () => screen.getByLabelText('الشركة بتقول') as HTMLSelectElement;
  const options = () => within(select()).getAllByRole('option').map((o) => o.textContent);

  it('— is drawn beside the other dropdowns, with the five words and the server’s number beside each', async () => {
    await draw();
    expect(select().tagName).toBe('SELECT');
    expect(options()).toEqual(['أيّ كلمة', 'سُلِّمت (12)', 'سُلِّمت جزئياً (1)', 'رجعت (3)', 'مُلغاة (2)', 'مؤجَّلة (4)']);
    expect(select().value).toBe('all');
  });

  it('and the default question is exactly what it was: nothing about the word is asked until one is chosen', async () => {
    await draw();
    expect(gets()).toHaveLength(1);
    expect(gets()[0].toString()).toBe('page=1&limit=25');
  });

  it('and choosing a word asks for exactly that word, from page one; «أيّ كلمة» takes it back out', async () => {
    await draw();
    fireEvent.change(select(), { target: { value: 'RETURNED' } });
    await waitFor(() => expect(gets().at(-1)!.get('said')).toBe('RETURNED'));
    expect(gets().at(-1)!.get('page')).toBe('1');
    fireEvent.change(select(), { target: { value: 'all' } });
    await waitFor(() => expect(gets().at(-1)!.has('said')).toBe(false));
  });

  it('and it is one of the choices «إعادة تعيين» counts and clears', async () => {
    await draw();
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
    fireEvent.change(select(), { target: { value: 'CANCELLED' } });
    fireEvent.click(await screen.findByRole('button', { name: 'إعادة تعيين (1)' }));
    await waitFor(() => expect(select().value).toBe('all'));
    await waitFor(() => expect(gets().at(-1)!.has('said')).toBe(false));
  });

  it('and it sits with the other choices: a company, an age and a word together are three', async () => {
    await draw();
    fireEvent.change(screen.getByLabelText('جهة الشحن'), { target: { value: P1 } });
    fireEvent.change(screen.getByLabelText('مدّة الشحن'), { target: { value: 'fresh' } });
    fireEvent.change(select(), { target: { value: 'DELIVERED' } });
    await screen.findByRole('button', { name: 'إعادة تعيين (3)' });
    await waitFor(() => {
      const q = gets().at(-1)!;
      expect([q.get('courier'), q.get('age'), q.get('said')]).toEqual([P1, 'fresh', 'DELIVERED']);
    });
  });

  it('and a word that has just lost its last parcel stays chosen, with a zero — the box does not snap back behind the reader’s back', async () => {
    await draw();
    fireEvent.change(select(), { target: { value: 'FAILED_DELIVERY' } });
    saidCounts = { ...SAID_COUNTS, FAILED_DELIVERY: 0 };
    await waitFor(() => expect(options()).toContain('مؤجَّلة (0)'));
    expect(select().value).toBe('FAILED_DELIVERY');
  });

  it('and an answer that carries no numbers for it (an older server) reads as zeros — the screen still opens', async () => {
    saidCounts = undefined;
    await draw();
    expect(options()).toEqual(['أيّ كلمة', 'سُلِّمت (0)', 'سُلِّمت جزئياً (0)', 'رجعت (0)', 'مُلغاة (0)', 'مؤجَّلة (0)']);
  });
});

describe('the copy button of the «الباركود» column', () => {
  let written: string[];
  const clipboardThatWorks = () => {
    written = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async (t: string) => void written.push(t)) },
    });
  };
  const press = async (el: HTMLElement) => {
    fireEvent.click(el);
    await waitFor(() => expect(written.length + tell.mock.calls.length).toBeGreaterThan(0));
  };

  it('— copies the barcode, and says so on the button itself (the tick), without asking the server anything', async () => {
    clipboardThatWorks();
    rows = [parcel('a')];
    await draw();
    const button = deskButton('نسخ باركود الشحنة TRK-a');
    expect(button.getAttribute('title')).toBe('انسخ الباركود');
    fireEvent.click(button);
    await waitFor(() => expect(written).toEqual(['TRK-a']));
    await waitFor(() => expect(within(desk()).getByRole('button', { name: 'تم نسخ باركود الشحنة TRK-a' })).toBeTruthy());
    expect(writes()).toHaveLength(0);
    expect(gets()).toHaveLength(1);
  });

  it('and what is copied is the barcode as the courier wrote it — the invisible direction marks a right-to-left line wraps around it are not', async () => {
    clipboardThatWorks();
    const LRM = String.fromCharCode(0x200e);
    const RLM = String.fromCharCode(0x200f);
    rows = [parcel('a', { trackingNumber: `${LRM}KSA-77${RLM}` })];
    await draw();
    await press(deskButton(/^نسخ باركود الشحنة/));
    expect(written).toEqual(['KSA-77']);
  });

  it('— a parcel with no barcode (a manual company, or not sent yet) copies the reference, and the tooltip says so', async () => {
    clipboardThatWorks();
    rows = [
      parcel('a', { trackingNumber: null, merchantRef: 'M-77', deliveryProvider: { id: P1, name: 'مندوب', kind: 'AGENT' } }),
      parcel('b', { trackingNumber: null, merchantRef: null }),
    ];
    await draw();
    expect(within(desk()).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    const ref = deskButton('نسخ مرجع الطلب M-77');
    expect(ref.getAttribute('title')).toBe('انسخ المرجع');
    await press(ref);
    expect(written).toEqual(['M-77']);
    // …and with no merchant reference, the order number the row prints.
    const number = deskButton('نسخ مرجع الطلب ORD-b');
    expect(number.getAttribute('title')).toBe('انسخ المرجع');
    fireEvent.click(number);
    await waitFor(() => expect(written).toEqual(['M-77', 'ORD-b']));
  });

  it('— when the browser refuses, the value goes to a field to select by hand (the dialog), not to a warning that goes away', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) },
    });
    document.execCommand = vi.fn(() => false);
    rows = [parcel('a')];
    await draw();
    fireEvent.click(deskButton('نسخ باركود الشحنة TRK-a'));
    await waitFor(() => expect(tell).toHaveBeenCalledTimes(1));
    expect(tell).toHaveBeenCalledWith({ title: 'تعذّر النسخ — انسخه يدوياً', value: 'TRK-a' });
    expect(toast.warn).not.toHaveBeenCalled();
    // No tick for a copy that did not happen.
    expect(within(desk()).queryByRole('button', { name: /^تم نسخ/ })).toBeNull();
  });

  it('— and where there is no clipboard at all (a plain-HTTP office server) it is the same: the field', async () => {
    rows = [parcel('a', { trackingNumber: null, merchantRef: 'M-9' })];
    await draw();
    fireEvent.click(deskButton('نسخ مرجع الطلب M-9'));
    await waitFor(() => expect(tell).toHaveBeenCalledWith({ title: 'تعذّر النسخ — انسخه يدوياً', value: 'M-9' }));
  });

  it('— on a phone card it has WORDS and is a 44px target; the desk keeps the small icon in the column', async () => {
    clipboardThatWorks();
    rows = [parcel('a'), parcel('b', { trackingNumber: null, merchantRef: 'M-1' })];
    await draw();

    const onCard = within(cards()).getByRole('button', { name: 'نسخ باركود الشحنة TRK-a' });
    expect(onCard.textContent).toBe('انسخ الباركود');
    expect(onCard.className).toMatch(/(^|\s)h-11(\s|$)/);
    expect(onCard.className).toContain('md:h-8');
    // …inside a wrapper that the desk does not draw, since the desk has the column.
    expect(onCard.closest('span.md\\:hidden')).not.toBeNull();
    expect(within(cards()).getByRole('button', { name: 'نسخ مرجع الطلب M-1' }).textContent).toBe('انسخ المرجع');

    const onDesk = deskButton('نسخ باركود الشحنة TRK-a');
    expect(onDesk.textContent).toBe('');
    expect(onDesk.className).toMatch(/(^|\s)h-11(\s|$)/);
    expect(onDesk.className).toContain('md:h-7');
    expect(onDesk.closest('td')).not.toBeNull();

    // The card still does not draw the barcode column itself — only the button that copies it.
    expect(within(cards()).queryByText('TRK-a')).toBeNull();
    expect(within(desk()).getByText('TRK-a')).toBeTruthy();

    fireEvent.click(onCard);
    await waitFor(() => expect(written).toEqual(['TRK-a']));
  });

  it('— the barcode is still printed in its column, left-to-right, as it was', async () => {
    rows = [parcel('a')];
    await draw();
    const printed = within(desk()).getByText('TRK-a');
    expect(printed.getAttribute('dir')).toBe('ltr');
  });
});

describe('how it is built', () => {
  const src = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/TrackingScreen.tsx'), 'utf8'));
  const chip = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/tracking/CourierSaidChip.tsx'), 'utf8'));
  const copy = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/tracking/ParcelCopy.tsx'), 'utf8'));

  it('— the screen draws the server’s word: no clock, no arithmetic, no table of the company’s codes of its own', () => {
    for (const [name, s] of [['TrackingScreen', src()], ['CourierSaidChip', chip()], ['ParcelCopy', copy()]] as const) {
      expect(s, `${name}: صار يقرأ الساعة`).not.toMatch(/Date\.now\(\)|new Date\(|getTime\(\)/);
      expect(s, `${name}: جدول رموز الشركة`).not.toMatch(/DELIVERED_TO_RECIPIENT|POSTPONED_DELIVERY|LOGESTECHS/);
      expect(s, `${name}: يستورد ما للخادم`).not.toMatch(/logestechs|apply-event|courier-said-read|from '@\/lib\/db'/);
    }
  });

  it('— and the copy goes through the product’s one copy button, never straight to the clipboard', () => {
    expect(copy()).toContain("from '@/components/orders/CopyValue'");
    for (const [name, s] of [['TrackingScreen', src()], ['CourierSaidChip', chip()], ['ParcelCopy', copy()]] as const) {
      expect(s, `${name}: نسخ خامّ`).not.toMatch(/navigator\.clipboard/);
    }
  });
});
