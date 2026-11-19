// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';

/**
 * «يدوي — بلا كشف» AND ITS PARTS ON THE KIT (R13c2, plan 17/11) — ONE LOOK, AND NOT ONE FIGURE, PRESS OR REQUEST MOVED.
 *
 * The six files: `ManualMatching`, `ManualStatementDialog`, `LinkLineDialog`, `SwapDialog`, `DifferenceActions`, `CourierReason`.
 * A money screen may look different; nothing it prints or asks may change. This file holds
 *   the figures — every text (and every field hint) with a digit, frozen from the six files as they were on main BEFORE this request
 *     (osm/main 7638cf10, 18/11), each in the state that shows the most of them, on a desk and on a phone;
 *   the requests — every body each press sends, written out whole: the same URL, the same method, the same JSON;
 *   the double press — each press that sends money or a decision is grey while its request runs: a second press sends nothing;
 *   the presses — the kit's buttons, one look per role (the one action: primary · the rest: secondary · «رجعت»: danger · a text
 *     link: quiet), every one that must not submit says `type="button"`, and the search's own submit still submits;
 *   the surfaces — the instruction card is the kit's card; the strip, the dialog's note and the company's line are its plain card;
 *   the captions — the six files write no extra-small size;
 *   the shared parts — the follow-up screen's «فيه فرق» dialog still draws `DifferenceActions` and `CourierReason`;
 *   the phone — jsdom: classes, not pixels.
 */

const { api, confirm, phone, user, toast } = vi.hoisted(() => ({
  api: vi.fn(),
  confirm: vi.fn(),
  phone: { value: false },
  user: { current: null as unknown },
  toast: { done: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/finance/matching',
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirm, useAsk: () => async () => null, useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({
  CollectDialog: (p: { orders: { id: string }[] }) => (
    <div role="dialog" aria-label="استلام المبلغ">
      {p.orders.map((o) => o.id).join(',')}
    </div>
  ),
}));

import { ManualMatching } from './ManualMatching';
import { LinkLineDialog } from './LinkLineDialog';
import { SwapDialog } from './SwapDialog';
import { DifferenceActions } from './DifferenceActions';
import { CourierReason } from './CourierReason';
import { DifferenceDialog } from '@/components/screens/tracking/DifferenceDialog';

const FILES = ['ManualMatching', 'ManualStatementDialog', 'LinkLineDialog', 'SwapDialog', 'DifferenceActions', 'CourierReason'];
const source = (name: string) => readFileSync(join(process.cwd(), `src/components/screens/finance/${name}.tsx`), 'utf8');
/** Built from parts, so this file writes no class-like token the stylesheet would pick up. */
const XS = ['text', 'xs'].join('-');

/** Every text node that carries a digit, and every field's hint or value that does — in the order the page draws them. */
const figures = () => {
  const out: string[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (/[\d٠-٩]/.test(t)) out.push(t);
    } else if (n instanceof HTMLInputElement) {
      for (const v of [n.placeholder, n.value]) if (/[\d٠-٩]/.test(v ?? '')) out.push(`[${v}]`);
    }
  }
  return out;
};
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as unknown;
const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
/** A gate the test opens by hand: the request is «on its way» until then. */
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

afterEach(() => cleanup());

/* ═════════════════════════ «مطابقة يدوية» — the list, the strip, the bar ═════════════════════════ */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const parcel = (ref: string, over: Record<string, unknown> = {}) => ({
  id: `id-${ref}`, orderNumber: `ORD-${ref}`, merchantRef: ref, trackingNumber: `TRK-${ref}`, shippingStatus: 'SHIPPED',
  settlementStatus: 'NOT_APPLICABLE', daysInTransit: 1, late: false, totalAmount: 40, currency: 'JOD',
  customer: { fullName: `زبون ${ref}`, phone: '0790000000', city: 'عمّان' }, deliveryProvider: { id: A, name: 'أبو علي', kind: 'AGENT' },
  expectedCollection: 37.5, alert: null as null | { kind: string; at: string; acknowledged: boolean }, ...over,
});
const PARCELS = () => [
  parcel('M1'),
  parcel('M3', { totalAmount: 18.5, expectedCollection: 16 }),
  parcel('M2', { totalAmount: 12.25, expectedCollection: 9.75, alert: { kind: 'CANCELLED', at: '2026-11-01T10:00:00Z', acknowledged: false } }),
  parcel('D1', { shippingStatus: 'DELIVERED', settlementStatus: 'UNSETTLED', totalAmount: 55, expectedCollection: 51.5 }),
  parcel('D2', { shippingStatus: 'DELIVERED', settlementStatus: 'UNSETTLED', totalAmount: 30, expectedCollection: 27.125 }),
];
const FACTS = {
  total: 5, tasks: { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 2 }, lateCount: 0,
  couriers: [{ id: A, name: 'أبو علي', count: 5 }], regions: [], ages: { fresh: 0, few: 0, week: 0, old: 0 },
};
const ADMIN = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['ops.track', 'finance.cashbox', 'settlement.review', 'settlement.upload'] };

let held: ReturnType<typeof gate> | null;
const listAnswer = (url: string) => {
  const u = new URL(url, 'http://x');
  if (u.pathname === '/api/products') return { products: [] };
  if (u.pathname !== '/api/ops/tracking') return {};
  return { orders: PARCELS(), pagination: { total: 5, page: 1, limit: 50, totalPages: 1 }, facts: FACTS };
};

const drawManual = async () => {
  render(<ManualMatching />);
  await screen.findByLabelText('جهة الشحن');
  await waitFor(() => expect(document.querySelector('tbody tr')).not.toBeNull());
};
const refOf = (tr: Element) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').match(/^[A-Z0-9]+/)?.[0]).find(Boolean);
const tick = (...refs: string[]) =>
  refs.forEach((r) =>
    fireEvent.click([...document.querySelectorAll('tbody tr')].find((tr) => refOf(tr) === r)!.querySelector('input[type="checkbox"]')!)
  );
/** The desk's strip is the one place its buttons are drawn on a desk; on a phone they are in the bar. */
const named = (name: RegExp) => screen.getAllByRole('button', { name }).filter((b) => !b.closest('[role="dialog"]'));

describe('«مطابقة يدوية»', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    phone.value = false;
    user.current = ADMIN;
    confirm.mockResolvedValue(true);
    held = null;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (held) await held.p;
        if (url === '/api/finance/statements/manual') {
          return { statementId: 'st9', courier: 'أبو علي', currencyCode: 'JOD', created: true, added: 2, updated: 0, lines: 2, total: 78.625 };
        }
        return { message: 'سُجِّل' };
      }
      return listAnswer(url);
    });
  });

  describe('the figures did not move (frozen from main before this request)', () => {
    const DESK = [
      '1 — اختر الجهة، أو ابحث برقم الطلب أو الباركود أو اسم العميل.',
      '2 — ما سلّمه وما رجع: علّمه واضغط «تم تسليمها» أو «رجعت». يُسجَّل ما حدث فقط، ولا يدخل مالٌ المحفظة.',
      '3 — المال: علّم المسلَّم واضغط «استلمت منه»، واكتب المبلغ الذي استلمته فعلاً. أيّ فرق عن المتوقَّع يُسجَّل كما هو.',
    ];
    it.each([[false], [true]])('— the list, untouched (phone: %s)', async (isPhone) => {
      phone.value = isPhone;
      await drawManual();
      expect(figures()).toEqual(isPhone ? FROZEN.manualPhone : FROZEN.manualDesk);
      if (!isPhone) for (const t of DESK) expect(figures()).toContain(t);
    });

    it('— two delivered parcels ticked, and the dialog of «مطابق يدوي» open with one amount typed', async () => {
      await drawManual();
      tick('D1', 'D2');
      fireEvent.click(named(/مطابق يدوي/)[0]);
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getAllByRole('spinbutton')[0], { target: { value: '50' } });
      expect(figures()).toEqual(FROZEN.manualGathering);
    });
  });

  describe('the requests and the double press', () => {
    it('— «تم تسليمها» asks first, then sends one body per order, and while they run a second press sends nothing', async () => {
      await drawManual();
      tick('M1', 'M3');
      held = gate();
      const deliver = named(/تم تسليمها/)[0] as HTMLButtonElement;
      fireEvent.click(deliver);
      await flush();
      expect(deliver.disabled).toBe(true);
      // The screen's own flag, not the kit's: the handler is wrapped in `void`, so the kit holds no busy state of its own.
      expect(deliver.getAttribute('aria-busy')).toBeNull();
      fireEvent.click(deliver);
      fireEvent.click(named(/رجعت/)[0]);
      await flush();
      expect(confirm).toHaveBeenCalledTimes(1);
      held.open();
      await screen.findByText(/سُجِّل تسليم 2 طلب/);
      expect(posts()).toEqual([
        ['/api/ops/tracking/deliver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: 'id-M1', outcome: 'ALL' }) }],
        ['/api/ops/tracking/deliver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: 'id-M3', outcome: 'ALL' }) }],
      ]);
    });

    it('— «رجعت» sends NONE, asked in the danger tone, and its second press while it runs sends nothing', async () => {
      await drawManual();
      tick('M1');
      held = gate();
      const back = named(/رجعت/)[0] as HTMLButtonElement;
      fireEvent.click(back);
      await flush();
      expect(back.disabled).toBe(true);
      fireEvent.click(back);
      await flush();
      expect(confirm).toHaveBeenCalledTimes(1);
      expect((confirm.mock.calls[0][0] as { tone?: string }).tone).toBe('danger');
      held.open();
      await screen.findByText(/سُجِّل رجوع 1 طلب/);
      expect(posts().map(bodyOf)).toEqual([{ orderId: 'id-M1', outcome: 'NONE' }]);
    });

    it('NEGATIVE: a press the person takes back at the question sends nothing', async () => {
      confirm.mockResolvedValue(false);
      await drawManual();
      tick('M1');
      fireEvent.click(named(/تم تسليمها/)[0]);
      await flush();
      expect(posts()).toEqual([]);
    });

    it('— «مطابق يدوي»: the body is the orders with the amount typed (and none where the field is empty); a second press sends nothing', async () => {
      await drawManual();
      tick('D1', 'D2');
      fireEvent.click(named(/مطابق يدوي/)[0]);
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getAllByRole('spinbutton')[0], { target: { value: '50' } });
      held = gate();
      const add = within(dialog).getByRole('button', { name: /أضف إلى المسوّدة/ }) as HTMLButtonElement;
      fireEvent.click(add);
      await flush();
      const busy = within(dialog).getByRole('button', { name: /جارٍ الإضافة/ }) as HTMLButtonElement;
      expect(busy.disabled).toBe(true);
      fireEvent.click(busy);
      await flush();
      held.open();
      await screen.findByText(/أُضيف 2 طلب إلى مسوّدة كشف أبو علي/);
      expect(posts()).toEqual([
        ['/api/finance/statements/manual', { method: 'POST', body: JSON.stringify({ orders: [{ orderId: 'id-D1', amount: 50 }, { orderId: 'id-D2' }] }) }],
      ]);
      expect(document.body.textContent).toContain('في المسوّدة الآن 2 طلب بإجمالي 78.625 JOD.');
    });

    it('NEGATIVE: a typed amount that is not a number is refused on the screen, and nothing is sent', async () => {
      await drawManual();
      tick('D1', 'D2');
      fireEvent.click(named(/مطابق يدوي/)[0]);
      const dialog = await screen.findByRole('dialog');
      const field = within(dialog).getAllByRole('spinbutton')[1] as HTMLInputElement;
      // jsdom keeps what a number field is given only when it reads as a number: send the submit with the field's value set raw.
      Object.defineProperty(field, 'value', { configurable: true, get: () => 'e' });
      fireEvent.change(field, { target: { value: 'e' } });
      fireEvent.click(within(dialog).getByRole('button', { name: /أضف إلى المسوّدة/ }));
      await flush();
      expect(posts()).toEqual([]);
    });

    it('— «إلغاء» in the dialog does not submit it', async () => {
      await drawManual();
      tick('D1', 'D2');
      fireEvent.click(named(/مطابق يدوي/)[0]);
      const dialog = await screen.findByRole('dialog');
      const cancel = within(dialog).getByRole('button', { name: 'إلغاء' });
      expect(cancel.getAttribute('type')).toBe('button');
      fireEvent.click(cancel);
      await flush();
      expect(posts()).toEqual([]);
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('the presses wear the kit', () => {
    it('— the desk strip: the two text links are quiet, «رجعت» is danger, «تم تسليمها» is the one action', async () => {
      await drawManual();
      const pickDoor = screen.getByRole('button', { name: /اختر كل ما بانتظار التسليم/ });
      const pickOwed = screen.getByRole('button', { name: /اختر كل ما بانتظار التحصيل/ });
      for (const b of [pickDoor, pickOwed]) expect(b.className).toContain('bg-transparent');
      fireEvent.click(pickDoor);
      const cancel = screen.getByRole('button', { name: 'إلغاء الاختيار' });
      expect(cancel.className).toContain('bg-transparent');
      expect(named(/رجعت/)[0].className).toContain('bg-[var(--sys-destructive)]');
      expect(named(/تم تسليمها/)[0].className).toContain('bg-[var(--sys-primary)]');
      // «إلغاء الاختيار» empties the choice, as it did.
      fireEvent.click(cancel);
      expect(screen.queryByRole('button', { name: /تم تسليمها/ })).toBeNull();
    });

    it('— with money ticked: «استلمت منه» is the one action and «مطابق يدوي» is a framed second; each opens its own dialog', async () => {
      await drawManual();
      tick('D1');
      const take = named(/استلمت منه/)[0];
      const gather = named(/مطابق يدوي/)[0];
      expect(take.className).toContain('bg-[var(--sys-primary)]');
      expect(gather.className).toContain('bg-[var(--sys-card)]');
      fireEvent.click(take);
      expect((await screen.findByRole('dialog', { name: 'استلام المبلغ' })).textContent).toBe('id-D1');
    });

    it('NEGATIVE: without the statement key there is no «مطابق يدوي»; without the cash key no box on a delivered parcel and the sentence says why', async () => {
      user.current = { ...ADMIN, permissions: ['ops.track', 'finance.cashbox'] };
      await drawManual();
      tick('D1');
      expect(screen.queryByRole('button', { name: /مطابق يدوي/ })).toBeNull();
      expect(named(/استلمت منه/)).toHaveLength(1);
      cleanup();
      user.current = { ...ADMIN, permissions: ['ops.track'] };
      await drawManual();
      expect(screen.getByText('استلام المبلغ يحتاج صلاحية الصندوق، فلا مربع على الطلبات المسلَّمة.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /اختر كل ما بانتظار التحصيل/ })).toBeNull();
    });

    it('— a phone: the bar holds the same four presses, the two that record take the row between them', async () => {
      phone.value = true;
      await drawManual();
      tick('M1');
      const back = named(/رجعت/);
      const deliver = named(/تم تسليمها/);
      expect(back).toHaveLength(1);
      expect(deliver).toHaveLength(1);
      for (const b of [back[0], deliver[0]]) {
        expect(b.className).toContain('flex-1');
        expect(b.className).toContain('h-11');
      }
      expect(back[0].className).toContain('bg-[var(--sys-destructive)]');
      expect(screen.getAllByRole('button', { name: 'إلغاء الاختيار' })[0].className).toContain('bg-transparent');
    });
  });

  describe('the surfaces', () => {
    it('— the instruction card is the kit’s card; the strip is its plain card (no theme ornament on a bar of controls)', async () => {
      await drawManual();
      const card = screen.getByText('مطابقة يدوية — لشركة أو مندوب لا يرسل كشفاً ولا ملفاً').parentElement!;
      expect(card.className).toContain('zk-card');
      expect(card.className).toContain('p-4');
      expect(card.querySelectorAll('p')).toHaveLength(6);
      const strip = screen.getByText('علّم الطلبات التي تريد تسجيلها.').parentElement!;
      expect(strip.className).not.toContain('zk-card');
      expect(strip.className).toContain('bg-[var(--sys-card)]');
      expect(strip.className).toContain('flex-wrap');
    });
  });
});

/* ═════════════════════════ «اربطه بطلب» ═════════════════════════ */

const LINK = '/api/finance/statements/st1/matches/m1/link';
const candidate = (id: string, orderNumber: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber, merchantRef: null, customer: { id: 'cu', fullName: 'رنا', phone: '933620102' }, shippingStatus: 'SHIPPED',
  settlementStatus: 'PENDING', closed: false, expected: 20.5, distance: 0, otherCourier: false, blockedBy: [] as string[],
  compare: { phone: 'SAME', governorate: 'DIFFERENT', amount: 'UNKNOWN' },
  details: { phone: '0933620102', governorate: 'حماة', address: 'شارع 4', name: 'رنا', shipping: 'قيد الشحن', totalAmount: 23.75, deliveryFee: 3.25 },
  ...over,
});
const LINE = { status: 'تم توصيلها', name: 'رنا', phone: '0933620102', governorate: 'حمص', address: 'شارع 9', net: 20.5, collected: 24, fee: 3.5 };
const BY_PHONE = {
  header: 'لهذا الرقم 2 طلبات قيد الشحن', counts: { total: 2, closed: 0, open: 2 }, hint: null, otherCourierWarning: 'مع شركة ثانية',
  phone: { shown: '0933620102', country: 'SY' }, line: LINE,
  candidates: [candidate('a', 'ORD-A'), candidate('b', 'ORD-B', { expected: 25, otherCourier: true, blockedBy: ['مُسوّى أصلاً'] })],
};
const BY_TEXT = { header: 'لهذا الرقم طلب واحد: مفتوح', counts: { total: 1, closed: 0, open: 1 }, hint: 'تلميح 7', otherCourierWarning: 'w', candidates: [candidate('t', 'ORD-T', { expected: 11 })] };

describe('«اربطه بطلب»', () => {
  let onLinked: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    vi.clearAllMocks();
    onLinked = vi.fn<() => void>();
    held = null;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (held) await held.p;
        return { message: 'رُبط', linked: { result: 'MATCHED' } };
      }
      if (url === `${LINK}?by=phone`) return BY_PHONE;
      if (url.startsWith(`${LINK}?q=`)) return BY_TEXT;
      return {};
    });
  });
  const open = async () => {
    render(<LinkLineDialog statementId="st1" matchId="m1" reference="BC-1" amount={20.5} currency="SYP" onLinked={onLinked} />);
    const trigger = screen.getByRole('button', { name: /اربطه بطلب/ });
    expect(trigger.getAttribute('type')).toBe('button');
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(BY_PHONE.header);
    return dialog;
  };

  it('— the figures did not move: the line, the company’s card, the candidates, and the two sides of the picked one', async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByText('ORD-A').closest('button')!);
    expect(figures()).toEqual(FROZEN.link);
  });

  it('— a link sends the body it sent, and a second press while it runs sends nothing', async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByText('ORD-A').closest('button')!);
    held = gate();
    const go = within(dialog).getByRole('button', { name: 'اربطه بالطلب ORD-A' }) as HTMLButtonElement;
    expect(go.getAttribute('type')).toBe('button');
    fireEvent.click(go);
    fireEvent.click(go);
    await flush();
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    held.open();
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(posts()).toEqual([
      [LINK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: 'a', acceptOtherCourier: false, query: '' }) }],
    ]);
  });

  it('— the free search still submits its form (Enter and the button), and its query is sent with the link', async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('البحث'), { target: { value: ' ORD-T ' } });
    const find = within(dialog).getByRole('button', { name: 'ابحث' });
    expect(find.getAttribute('type')).toBe('submit');
    fireEvent.click(find);
    await within(dialog).findByText(BY_TEXT.header);
    expect(api).toHaveBeenCalledWith(`${LINK}?q=ORD-T`);
    fireEvent.click(within(dialog).getByText('ORD-T').closest('button')!);
    fireEvent.click(within(dialog).getByRole('button', { name: 'اربطه بالطلب ORD-T' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0])).toEqual({ orderId: 't', acceptOtherCourier: false, query: 'ORD-T' });
  });

  it('NEGATIVE: a blocked candidate cannot be picked, and with nothing picked the link is grey', async () => {
    const dialog = await open();
    expect((within(dialog).getByText('ORD-B').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'اختر طلباً' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('— the kit: the trigger and the phone search are framed, the free search and the link are the one action, «إلغاء» is framed', async () => {
    const dialog = await open();
    expect(screen.getAllByRole('button', { name: /اربطه بطلب/ })[0].className).toContain('bg-[var(--sys-card)]');
    const byPhone = within(dialog).getByRole('button', { name: /بهاتف السطر/ });
    expect(byPhone.getAttribute('type')).toBe('button');
    expect(byPhone.className).toContain('border-[var(--sys-primary)]');
    expect(within(dialog).getByRole('button', { name: 'ابحث' }).className).toContain('bg-[var(--sys-primary)]');
    expect(within(dialog).getByRole('button', { name: 'اختر طلباً' }).className).toContain('bg-[var(--sys-primary)]');
    const cancel = within(dialog).getByRole('button', { name: 'إلغاء' });
    expect(cancel.getAttribute('type')).toBe('button');
    expect(cancel.className).toContain('bg-[var(--sys-card)]');
  });

  it('— the company’s line is the kit’s plain card, still a named section', async () => {
    const dialog = await open();
    const section = within(dialog).getByRole('region', { name: 'ما كتبته الشركة' });
    expect(section.parentElement!.className).toContain('bg-[var(--sys-card)]');
    expect(section.parentElement!.className).not.toContain('zk-card');
  });
});

/* ═════════════════════════ «كان من طرد طلب آخر» ═════════════════════════ */

const SWAP = '/api/finance/statements/s1/matches/m2/swap';
const FOUND = {
  box: { orderNumber: 'JO-2026-0002', pieces: 3, products: ['عطر'], blockedBy: [] as string[] },
  hint: 'جرّب 3 أحرف',
  candidates: [
    { id: 'x', orderNumber: 'JO-2026-0001', customer: { id: 'cuA', fullName: 'سارة', phone: '790000001' }, shippingStatus: 'SHIPPED', expected: 17.5, blockedBy: [] as string[] },
    { id: 'z', orderNumber: 'JO-2026-0007', customer: { id: 'cuC', fullName: 'هبة', phone: '790000003' }, shippingStatus: 'DELIVERED', expected: 9, blockedBy: ['مُسوّى أصلاً'] },
  ],
};

describe('«كان من طرد طلب آخر»', () => {
  let onDone: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    vi.clearAllMocks();
    onDone = vi.fn<() => void>();
    held = null;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (held) await held.p;
        return { message: 'سُجِّل التبديل' };
      }
      if (url.startsWith(`${SWAP}?q=`)) return FOUND;
      return {};
    });
  });
  const open = async () => {
    render(<SwapDialog statementId="s1" matchId="m2" reference="R-2" amount={17.5} currency="JOD" onDone={onDone} />);
    const trigger = screen.getByRole('button', { name: /كان من طرد طلب آخر/ });
    expect(trigger.getAttribute('type')).toBe('button');
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('من أخذ البضاعة'), { target: { value: '790000001' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'ابحث' }));
    await within(dialog).findByText('JO-2026-0001');
    fireEvent.click(within(dialog).getByText('JO-2026-0001').closest('button')!);
    return dialog;
  };

  it('— the figures did not move: the line, the box, the candidates, the pieces', async () => {
    await open();
    expect(figures()).toEqual(FROZEN.swap);
  });

  it('— the save sends the body it sent, and a second press while it runs sends nothing', async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('كم قطعة أخذ من الصندوق'), { target: { value: '2' } });
    fireEvent.change(within(dialog).getByLabelText('هل رجع صندوق الزبون نفسه؟'), { target: { value: 'no' } });
    held = gate();
    const save = within(dialog).getByRole('button', { name: 'سجّل التبديل مع الطلب JO-2026-0001' }) as HTMLButtonElement;
    expect(save.getAttribute('type')).toBe('button');
    fireEvent.click(save);
    await flush();
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    held.open();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(posts()).toEqual([
      [SWAP, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerOrderId: 'x', pieces: 2, ownerBoxBack: false }) }],
    ]);
  });

  it('NEGATIVE: more pieces than the box holds greys the save and says the range', async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('كم قطعة أخذ من الصندوق'), { target: { value: '4' } });
    expect((within(dialog).getByRole('button', { name: /سجّل التبديل/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('من 1 إلى 3 — هذا ما في الصندوق')).toBeTruthy();
  });

  it('— the kit: the search submits its form and is the one action; «إلغاء» is framed and does not submit', async () => {
    const dialog = await open();
    const find = within(dialog).getByRole('button', { name: 'ابحث' });
    expect(find.getAttribute('type')).toBe('submit');
    expect(find.className).toContain('bg-[var(--sys-primary)]');
    const cancel = within(dialog).getByRole('button', { name: 'إلغاء' });
    expect(cancel.getAttribute('type')).toBe('button');
    expect(cancel.className).toContain('bg-[var(--sys-card)]');
    expect(screen.getAllByRole('button', { name: /كان من طرد طلب آخر/ })[0].className).toContain('bg-[var(--sys-card)]');
  });
});

/* ═════════════════════════ the answer on a difference, and the company’s reason ═════════════════════════ */

const LINE_ROW = {
  merchantRef: '20001', barcode: 'B000001', amount: '12.5', collected: '15.25', fee: '2.75', status: 'مؤجل',
  rawRow: 'B1 | 20001 | كاش 4', receiverName: 'زبون', receiverPhone: '+963 900000001', receiverAddress: 'شارع 5', receiverCity: 'حماة', receiverArea: 'حماة',
};
const WORD = { phrase: 'مؤجل', outcome: 'POSTPONED', known: true, label: 'تأجيل 2' };
const RESOLVE = '/api/finance/statements/s1/matches/m1/resolve';
const actionProps = (over: Record<string, unknown> = {}) => ({
  statementId: 's1', matchId: 'm1', orderId: 'o1', orderNumber: 'ORD-1', resolution: null, resolutionNote: null, onResolved: vi.fn(), ...over,
});

describe('«DifferenceActions» and «CourierReason»', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    phone.value = false;
    held = null;
    api.mockImplementation(async () => {
      if (held) await held.p;
      return {};
    });
  });

  it('— the figures did not move: the claim on an answered line, and the company’s reason', () => {
    render(<DifferenceActions {...actionProps({ resolution: 'OURS_STANDS', resolutionNote: 'سبب 12', claim: 7.25, currency: 'JOD' })} />);
    render(<CourierReason m={{ courierWord: WORD, statementLine: LINE_ROW }} />);
    expect(figures()).toEqual(FROZEN.answer);
  });

  it.each([
    ['اعتُمد رقم الشركة', { resolution: 'ACCEPTED_COURIER', note: 'قالت الشركة خصم' }],
    ['رقمنا هو المعتمد', { resolution: 'OURS_STANDS', note: 'قالت الشركة خصم' }],
    ['طلب تبديل', { resolution: 'ACCEPTED_COURIER', exchange: true, note: 'قالت الشركة خصم' }],
    ['قيد المراجعة', { resolution: 'UNDER_REVIEW', note: 'قالت الشركة خصم' }],
  ])('— «%s» sends the body it sent, and while it runs every answer is grey: a second press sends nothing', async (name, body) => {
    const onResolved = vi.fn();
    render(<DifferenceActions {...actionProps({ onResolved })} />);
    fireEvent.change(screen.getByLabelText('تفسير القرار'), { target: { value: 'قالت الشركة خصم' } });
    held = gate();
    const button = screen.getByRole('button', { name }) as HTMLButtonElement;
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled, b.textContent ?? '').toBe(true);
    fireEvent.click(button);
    held.open();
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(api.mock.calls).toEqual([[RESOLVE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }]]);
  });

  it('NEGATIVE: with no explanation nothing is sent and the sentence says why', () => {
    render(<DifferenceActions {...actionProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'رقمنا هو المعتمد' }));
    expect(api).not.toHaveBeenCalled();
  });

  it('— the kit: the four answers and «غيّر البتّ» are framed and small, and keep the colour that says which figure (phone: at rest)', () => {
    const tones = () => ({
      ours: screen.getByRole('button', { name: 'اعتُمد رقم الشركة' }).className,
      theirs: screen.getByRole('button', { name: 'رقمنا هو المعتمد' }).className,
    });
    render(<DifferenceActions {...actionProps()} />);
    for (const b of screen.getAllByRole('button')) {
      expect(b.className).toContain('bg-[var(--sys-card)]');
      expect(b.className).toContain('md:h-8');
    }
    expect(tones().ours).toContain('hover:text-[var(--sys-success)]');
    expect(tones().theirs).toContain('hover:text-[var(--sys-warning)]');
    cleanup();
    phone.value = true;
    render(<DifferenceActions {...actionProps()} />);
    expect(tones().ours).toContain('text-[var(--sys-success)]');
    expect(tones().ours).not.toContain('hover:text-[var(--sys-success)]');
    expect(tones().theirs).toContain('text-[var(--sys-warning)]');
    cleanup();
    render(<DifferenceActions {...actionProps({ resolution: 'ACCEPTED_COURIER' })} />);
    const again = screen.getByRole('button', { name: 'غيّر البتّ' });
    expect(again.getAttribute('type')).toBe('button');
    expect(again.className).toContain('bg-[var(--sys-card)]');
    fireEvent.click(again);
    expect(screen.getByLabelText('تفسير القرار')).toBeTruthy();
  });

  it('— the follow-up screen’s «فيه فرق» dialog still draws both, with the props it passes (R11’s file is not touched)', async () => {
    const onDone = vi.fn();
    render(
      <DifferenceDialog
        order={{
          id: 'o1', orderNumber: 'ORD-1', merchantRef: 'M-1', currency: 'JOD',
          difference: {
            matchId: 'm1', statementId: 's1', statement: 'ST-1', ours: 12.5, theirs: 10.75, gap: 1.75, answered: false, resolution: null,
            resolutionKind: null, resolutionNote: null, claim: null, closed: false, note: null,
            decisions: { ACCEPTED_COURIER: { allowed: true, why: null }, OURS_STANDS: { allowed: true, why: null }, UNDER_REVIEW: { allowed: true, why: null } },
            courierWord: WORD, statementLine: { ...LINE_ROW, amount: 12.5, collected: 15.25, fee: 2.75 },
          },
        }}
        mayDecide
        onClose={vi.fn()}
        onDone={onDone}
      />
    );
    const dialog = await screen.findByRole('dialog');
    // CourierReason: the company's word, the phone, the governorate, the address, and the row behind «النص الأصلي».
    expect(within(dialog).getByText('«مؤجل»', { exact: false })).toBeTruthy();
    expect(within(dialog).getByText('النص الأصلي')).toBeTruthy();
    expect(dialog.textContent).toContain('المحافظة: حماة');
    // DifferenceActions: the four answers, and its press reaches the same door.
    for (const n of ['اعتُمد رقم الشركة', 'رقمنا هو المعتمد', 'طلب تبديل', 'قيد المراجعة']) expect(within(dialog).getByRole('button', { name: n })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('تفسير القرار'), { target: { value: 'قالت الشركة خصم' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'رقمنا هو المعتمد' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(api.mock.calls[0][0]).toBe(RESOLVE);
  });
});

/* ═════════════════════════ the six files as text ═════════════════════════ */

describe('the six files', () => {
  it('— write no extra-small size (the caption size is the kit’s)', () => {
    for (const f of FILES) expect(source(f).split(/\r?\n/).filter((l) => l.includes(XS)), f).toEqual([]);
  });

  it('— draw no raw surface and, outside the two chosen-row presses (a list of orders to pick from), no raw button', () => {
    const rawButtons = (f: string) => (source(f).match(/<button\b/g) ?? []).length;
    expect(Object.fromEntries(FILES.map((f) => [f, rawButtons(f)]))).toEqual({
      ManualMatching: 0, ManualStatementDialog: 0, LinkLineDialog: 1, SwapDialog: 1, DifferenceActions: 0, CourierReason: 0,
    });
  });

  it('— a phone: no fixed width wider than the phone in any of the six', () => {
    for (const f of FILES) {
      for (const m of source(f).matchAll(/(?:^|[\s"'`])(?:min-|max-)?w-\[(\d+)px\]/g)) expect(Number(m[1]), f).toBeLessThanOrEqual(375);
    }
  });

  it('— DifferenceActions and CourierReason keep their props (the follow-up dialog draws them as it did)', () => {
    const props = (f: string, name: string) => {
      const src = source(f).replace(/\r\n/g, '\n');
      const at = src.indexOf(`export function ${name}(`);
      return src.slice(at, src.indexOf(')', src.indexOf('}', at)) + 1);
    };
    expect(props('DifferenceActions', 'DifferenceActions')).toContain('parkOnly,\n}: Props)');
    expect(props('CourierReason', 'CourierReason')).toBe('export function CourierReason({ m }: CourierReasonProps)');
  });
});

/*
 * THE FIGURES, FROZEN FROM main (7638cf10, 18/11) BEFORE THIS REQUEST: the fixtures above, rendered by the six files as they were,
 * printed exactly these texts (and field hints) in this order.
 */
const FROZEN: Record<string, string[]> = {
  manualDesk: [
    '1 — اختر الجهة، أو ابحث برقم الطلب أو الباركود أو اسم العميل.', '2 — ما سلّمه وما رجع: علّمه واضغط «تم تسليمها» أو «رجعت». يُسجَّل ما حدث فقط، ولا يدخل مالٌ المحفظة.', '3 — المال: علّم المسلَّم واضغط «استلمت منه»، واكتب المبلغ الذي استلمته فعلاً. أيّ فرق عن المتوقَّع يُسجَّل كما هو.', 'أبو علي (5)', '2', '2',
    'M1', 'زبون M1', '40.00 JOD', 'M3', 'زبون M3', '18.50 JOD',
    'M2', 'زبون M2', '12.25 JOD', 'D1', 'زبون D1', '55.00 JOD',
    '51.50 JOD', 'D2', 'زبون D2', '30.00 JOD', '27.13 JOD', 'M1',
    'زبون M1', '40.00 JOD', 'M3', 'زبون M3', '18.50 JOD', 'M2',
    'زبون M2', '12.25 JOD', 'D1', 'زبون D1', '55.00 JOD', '51.50 JOD',
    'D2', 'زبون D2', '30.00 JOD', '27.13 JOD',
  ],
  manualPhone: [
    '1 اختر الجهة · 2 سجّل التسليم أو الرجوع · 3 استلم المال', '1 — اختر الجهة، أو ابحث برقم الطلب أو الباركود أو اسم العميل.', '2 — ما سلّمه وما رجع: علّمه واضغط «تم تسليمها» أو «رجعت». يُسجَّل ما حدث فقط، ولا يدخل مالٌ المحفظة.', '3 — المال: علّم المسلَّم واضغط «استلمت منه»، واكتب المبلغ الذي استلمته فعلاً. أيّ فرق عن المتوقَّع يُسجَّل كما هو.', 'أبو علي (5)', '2',
    '2', 'M1', 'زبون M1', '40.00 JOD', 'M3', 'زبون M3',
    '18.50 JOD', 'M2', 'زبون M2', '12.25 JOD', 'D1', 'زبون D1',
    '55.00 JOD', '51.50 JOD', 'D2', 'زبون D2', '30.00 JOD', '27.13 JOD',
    'M1', 'زبون M1', '40.00 JOD', 'M3', 'زبون M3', '18.50 JOD',
    'M2', 'زبون M2', '12.25 JOD', 'D1', 'زبون D1', '55.00 JOD',
    '51.50 JOD', 'D2', 'زبون D2', '30.00 JOD', '27.13 JOD',
  ],
  manualGathering: [
    '1 — اختر الجهة، أو ابحث برقم الطلب أو الباركود أو اسم العميل.', '2 — ما سلّمه وما رجع: علّمه واضغط «تم تسليمها» أو «رجعت». يُسجَّل ما حدث فقط، ولا يدخل مالٌ المحفظة.', '3 — المال: علّم المسلَّم واضغط «استلمت منه»، واكتب المبلغ الذي استلمته فعلاً. أيّ فرق عن المتوقَّع يُسجَّل كما هو.', 'أبو علي (5)', 'مختار 2 طلب', '2',
    '2', 'M1', 'زبون M1', '40.00 JOD', 'M3', 'زبون M3',
    '18.50 JOD', 'M2', 'زبون M2', '12.25 JOD', 'D1', 'زبون D1',
    '55.00 JOD', '51.50 JOD', 'D2', 'زبون D2', '30.00 JOD', '27.13 JOD',
    'M1', 'زبون M1', '40.00 JOD', 'M3', 'زبون M3', '18.50 JOD',
    'M2', 'زبون M2', '12.25 JOD', 'D1', 'زبون D1', '55.00 JOD',
    '51.50 JOD', 'D2', 'زبون D2', '30.00 JOD', '27.13 JOD', 'أبو علي · 2 طلب',
    'ORD-D1 · زبون D1', '[51.5]', '[50]', 'ORD-D2 · زبون D2', '[27.125]',
  ],
  link: [
    'BC-1', '20.50 SYP', '0933620102', '0933620102', 'شارع 9', '24.00 SYP',
    '3.50 SYP', '20.50 SYP', 'لهذا الرقم 2 طلبات قيد الشحن', '933620102', '20.50 SYP', '0933620102',
    '0933620102', 'شارع 9', 'شارع 4', '20.50 SYP', '20.50 SYP', '24.00 SYP',
    '23.75 SYP', '3.50 SYP', '3.25 SYP', '1', '2', '933620102',
    '25.00 SYP',
  ],
  swap: [
    'R-2', '17.50 JOD', '[790000001]', 'JO-2026-0002', '3', 'جرّب 3 أحرف',
    'JO-2026-0001', '790000001', '17.50 JOD', 'JO-2026-0007', '790000003', '9.00 JOD',
    '[3]', 'سجّل التبديل مع الطلب JO-2026-0001',
  ],
  answer: [
    '7.25', 'سبب 12', 'تأجيل 2', '0900000001', 'شارع 5', 'B1 | 20001 | كاش 4',
  ],
};

