// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «أقفل المحدّد بلا حركة مال» — THE DIALOG SHOWS THE NUMBER BEFORE IT ASKS (13/11).
 *
 *   «اقدر اعمل هالحركة هاي لاي طلب حتى لو عليه باركود، بس بدي الزر هاد متاح للمالك فقط» (the owner)
 *
 * It measures the orders he ticked first and only draws; the door is the one that decides (`picked.test.ts`). What is held to here:
 * the numbers are on the screen before the press can be made, the orders it leaves are said ONE BY ONE with the reason, a recent
 * order is warned about, the press needs the tick and sends back exactly what was shown, a refusal is said and the numbers are read
 * again, a press goes once — and what was ticked WHEN IT OPENED is the only thing it ever asks about.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));

import { ClosePickedDialog } from './ClosePickedDialog';
import type { PickedMeasure } from '@/lib/legacy-closeout-words';

const DOOR = '/api/ops/tracking/close-legacy/picked';

const measureOf = (over: Partial<PickedMeasure> = {}): PickedMeasure => ({
  asked: 4,
  closeable: {
    count: 3,
    fingerprint: 'a'.repeat(24),
    oldestAt: '2026-01-05T10:00:00.000Z',
    newestAt: '2026-10-20T10:00:00.000Z',
    byCourier: [
      { name: 'الباشا', count: 2 },
      { name: 'الو دليفيري', count: 1 },
    ],
    value: [{ currency: 'USD', amount: 9050 }],
    withBarcode: 2,
    recent: 0,
  },
  recentDays: 14,
  left: [{ orderNumber: 'ORD-4', why: 'ON_A_STATEMENT', text: 'الطلب ORD-4 بكشف ما انعتمد بعد — مصاريه بتنسجّل لما ينعتمد الكشف' }],
  leftTotal: 1,
  ...over,
});
const withCloseable = (over: Partial<PickedMeasure['closeable']>, rest: Partial<PickedMeasure> = {}) =>
  measureOf({ closeable: { ...measureOf().closeable, ...over }, ...rest });

type Sent = { action: string; orderIds: string[]; fingerprint?: string; count?: number; acknowledged?: boolean };
const sent = (action: string) =>
  api.mock.calls
    .map((c) => JSON.parse((c[1] as { body: string }).body) as Sent)
    .filter((b) => b.action === action);

let onClose: () => void;
let onDone: (message: string) => void;
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const ORDERS = IDS.map((id) => ({ id }));

beforeEach(() => {
  vi.clearAllMocks();
  onClose = vi.fn();
  onDone = vi.fn();
  api.mockImplementation(async (_url: string, init?: { body: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as Sent;
    if (body.action === 'close') return { closed: 3, message: 'اتقفل 3 طلب كمحصَّل — بلا أي حركة مصاري' };
    return measureOf();
  });
});
afterEach(() => cleanup());

const open = async (orders = ORDERS) => {
  const view = render(<ClosePickedDialog orders={orders} onClose={onClose} onDone={onDone} />);
  await screen.findByText('طلب رح ينقفل كمحصَّل');
  return view;
};
const tick = () => fireEvent.click(screen.getByRole('checkbox'));
const pressButton = () => screen.getByRole('button', { name: /^أقفل \d+ طلب$/ }) as HTMLButtonElement;

describe('the numbers come before the press', () => {
  it('measures the ticked orders the moment it opens — one request, writing nothing — and says how many, whose and what they are worth', async () => {
    await open();

    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][0]).toBe(DOOR);
    expect((api.mock.calls[0][1] as { method: string }).method).toBe('POST');
    expect(sent('measure')).toEqual([{ action: 'measure', orderIds: IDS }]);
    expect(sent('close')).toEqual([]);

    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('الباشا')).toBeTruthy();
    expect(screen.getByText('الو دليفيري')).toBeTruthy();
    // What it is worth is said as the orders' value, never as money that moves.
    expect(screen.getByText(/قيمة الطلبات، مش مصاري رح تنزل/)).toBeTruthy();
    expect(screen.getByText(/9,050/)).toBeTruthy();
  });

  it('says in plain words WHAT STATUS they get — «مسوّى», with the shipping status staying «مسلَّم» — and that NO money moves and the commission does not become payable', async () => {
    await open();
    expect(screen.getByText(/بتحوّل الطلبات المحدّدة لـ«مسوّى» \(تم تحصيلها\) — أي طلب، عليه باركود أو لأ/)).toBeTruthy();
    expect(screen.getByText(/ما بينزل ولا قرش بأي محفظة، وعمولتها ما بتصير قابلة للدفع. حالة الشحن بتضل «مسلَّم»/)).toBeTruthy();
    expect(screen.getByText(/بتطلع من «بانتظار التحصيل» ومن حساب «عند شركات الشحن»/)).toBeTruthy();
  });

  it('says how many of them carry a barcode, and what a statement will say about them later', async () => {
    await open();
    expect(screen.getByText(/منها عليها باركود — لو ذكرها كشف بعدين بيطلع «حُصّل يدوياً»/)).toBeTruthy();
    cleanup();
    api.mockImplementation(async () => withCloseable({ withBarcode: 0 }));
    render(<ClosePickedDialog orders={ORDERS} onClose={onClose} onDone={onDone} />);
    await screen.findByText('طلب رح ينقفل كمحصَّل');
    expect(screen.queryByText(/منها عليها باركود/)).toBeNull();
  });

  it('says the orders it will LEAVE one by one, each with its reason in words — the owner is never left asking «ليش ما انقفل؟»', async () => {
    await open();
    expect(screen.getByText('اللي ما رح ينقفل:')).toBeTruthy();
    expect(screen.getByText('الطلب ORD-4 بكشف ما انعتمد بعد — مصاريه بتنسجّل لما ينعتمد الكشف')).toBeTruthy();
  });

  it('shows the first eight refusals and folds the rest into «و N كمان» — the count is the TRUE one, not the number of lines the door sent', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({ orderNumber: `ORD-${i + 10}`, why: 'MONEY_RECORDED' as const, text: `ORD-${i + 10} — تسويته بحالة فيها مصاري` }));
    api.mockImplementation(async () => measureOf({ left: lines, leftTotal: 45 }));
    render(<ClosePickedDialog orders={ORDERS} onClose={onClose} onDone={onDone} />);
    await screen.findByText('طلب رح ينقفل كمحصَّل');
    expect(screen.getByText(/ORD-17 — تسويته/)).toBeTruthy();
    expect(screen.queryByText(/ORD-18 — تسويته/)).toBeNull();
    expect(screen.getByText('37')).toBeTruthy();
    expect(screen.getByText(/كمان\./)).toBeTruthy();
  });

  it('shows the first six companies and folds the rest into one line', async () => {
    const counts = [100, 91, 82, 73, 64, 55, 46, 37, 28];
    const many = counts.map((count, i) => ({ name: `شركة ${i + 1}`, count }));
    api.mockImplementation(async () => withCloseable({ byCourier: many }));
    render(<ClosePickedDialog orders={ORDERS} onClose={onClose} onDone={onDone} />);
    await screen.findByText('طلب رح ينقفل كمحصَّل');
    expect(screen.getByText('شركة 6')).toBeTruthy();
    expect(screen.queryByText('شركة 7')).toBeNull();
    expect(screen.getByText('شركات تانية')).toBeTruthy();
    // The companies 7..9 are folded into one line: 46 + 37 + 28.
    expect(screen.getByText('111')).toBeTruthy();
  });

  it('asks for NO amount, NO wallet, NO age and NO barcode rule: one tick, nothing to type, nothing to choose', async () => {
    await open();
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect([...document.querySelectorAll('input')].map((i) => i.type)).toEqual(['checkbox']);
  });
});

describe('an order of the last fortnight is warned about before the press', () => {
  const recentOf = (n: number) => withCloseable({ recent: n });

  it('says how many are recent, in an alert: the cash may still be with the courier, and a settled order can no longer be collected', async () => {
    api.mockImplementation(async () => recentOf(2));
    render(<ClosePickedDialog orders={ORDERS} onClose={onClose} onDone={onDone} />);
    await screen.findByText('طلب رح ينقفل كمحصَّل');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('2');
    expect(alert.textContent).toContain('أقل من 14 يوم');
    expect(alert.textContent).toContain('ما بتقدر تسجّل استلامها بعدين');
  });

  it('and the tick then says it too — «وإنو 2 منها حديثة وبقفلها بحكمي» — so it is not the same tick as for old orders', async () => {
    api.mockImplementation(async () => recentOf(2));
    render(<ClosePickedDialog orders={ORDERS} onClose={onClose} onDone={onDone} />);
    await screen.findByText('طلب رح ينقفل كمحصَّل');
    expect(screen.getByText('أقرّ: القفل بلا حركة مصاري وما بيرجع من الشاشة، وإنو 2 منها حديثة وبقفلها بحكمي.')).toBeTruthy();
  });

  it('NEGATIVE: with no recent order there is no alert and the plain tick', async () => {
    await open();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('أقرّ: القفل بلا حركة مصاري، وما بيرجع من الشاشة.')).toBeTruthy();
  });
});

describe('the press', () => {
  it('is shut until the tick is given — and says how many it closes', async () => {
    await open();
    expect(pressButton().disabled).toBe(true);
    tick();
    expect(pressButton().disabled).toBe(false);
    expect(pressButton().textContent).toBe('أقفل 3 طلب');
  });

  it('sends back EXACTLY what was shown — the ticked ids, the fingerprint, the count and the tick — and tells the screen what the door said', async () => {
    await open();
    tick();
    fireEvent.click(pressButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('اتقفل 3 طلب كمحصَّل — بلا أي حركة مصاري'));
    expect(sent('close')).toEqual([{ action: 'close', orderIds: IDS, fingerprint: 'a'.repeat(24), count: 3, acknowledged: true }]);
  });

  it('goes ONCE: two quick presses send one request', async () => {
    await open();
    tick();
    const btn = pressButton();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(sent('close')).toHaveLength(1);
  });

  it('after a success the press stays shut even when the parent is slow to close the dialog: a second click sends nothing', async () => {
    await open();
    tick();
    fireEvent.click(pressButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pressButton().disabled).toBe(false));
    fireEvent.click(pressButton());
    await new Promise((r) => setTimeout(r, 30));
    expect(sent('close')).toHaveLength(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a refusal is said, the numbers are read again, and the tick is taken back — nothing is closed on the screen’s say-so', async () => {
    api.mockImplementation(async (_url: string, init?: { body: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Sent;
      if (body.action === 'close') {
        throw Object.assign(new Error('تغيّر وضع طلب أو أكثر من المحدّدين وقت القفل (انحصّل أو انربط بكشف). ما انقفل شي — افتح النافذة من جديد.'), { status: 409 });
      }
      return measureOf();
    });
    await open();
    tick();
    fireEvent.click(pressButton());

    expect((await screen.findByRole('alert')).textContent).toContain('تغيّر وضع طلب أو أكثر');
    await waitFor(() => expect(sent('measure')).toHaveLength(2));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    expect(pressButton().disabled).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    // The refusal is still on the screen after the re-read: that is exactly when it is read.
    expect(screen.getByRole('alert').textContent).toContain('تغيّر وضع طلب أو أكثر');
  });

  it('a refused press is a FAILED press on the button — never a success tick over the refusal', async () => {
    api.mockImplementation(async (_url: string, init?: { body: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Sent;
      if (body.action === 'close') throw Object.assign(new Error('تغيّرت الأرقام من لما فتحت النافذة — افتحها من جديد وراجعها قبل ما تقفل.'), { status: 409 });
      return measureOf();
    });
    await open();
    tick();
    fireEvent.click(pressButton());
    await screen.findByRole('alert');

    const btn = document.querySelector('button.flex-1') as HTMLButtonElement;
    await waitFor(() => expect(btn.getAttribute('aria-busy')).toBeNull());
    expect(btn.querySelector('svg'), 'a success tick over a refusal').toBeNull();
  });

  it('cancel closes without a press', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sent('close')).toHaveLength(0);
  });
});

describe('what was ticked WHEN IT OPENED is the only thing it asks about', () => {
  it('the list behind may be read again with other rows ticked: the dialog does not ask a new question, and the press carries the original ids', async () => {
    const view = await open();
    expect(sent('measure')).toHaveLength(1);

    // The screen re-renders the dialog with a different selection (the list was read again behind it).
    view.rerender(<ClosePickedDialog orders={[{ id: '99999999-9999-4999-8999-999999999999' }]} onClose={onClose} onDone={onDone} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent('measure')).toHaveLength(1);

    tick();
    fireEvent.click(pressButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(sent('close')[0].orderIds).toEqual(IDS);
    expect(JSON.stringify(api.mock.calls)).not.toContain('99999999-9999-4999-8999-999999999999');
  });

  it('the subtitle says how many were ticked', async () => {
    await open();
    expect(screen.getByText('4 طلب محدّد — بلا أي حركة مصاري')).toBeTruthy();
  });
});

describe('when nothing the owner ticked can be closed', () => {
  it('says so, gives every reason, and there is no tick and no press', async () => {
    api.mockImplementation(async () =>
      measureOf({
        closeable: { ...measureOf().closeable, count: 0, byCourier: [], value: [], oldestAt: null, newestAt: null, withBarcode: 0 },
        left: [
          { orderNumber: 'ORD-1', why: 'ALREADY_SETTLED', text: 'ORD-1 — مسوّى من قبل.' },
          { orderNumber: 'ORD-2', why: 'ON_A_STATEMENT', text: 'مصاري الطلب ORD-2 دخلت مع كشف ST-1' },
        ],
        leftTotal: 2,
      })
    );
    render(<ClosePickedDialog orders={ORDERS} onClose={onClose} onDone={onDone} />);
    expect(await screen.findByText('ما في ولا طلب من المحدّدين ينقفل — شوف السبب جنب كل طلب.')).toBeTruthy();
    expect(screen.getByText('ORD-1 — مسوّى من قبل.')).toBeTruthy();
    expect(screen.getByText('مصاري الطلب ORD-2 دخلت مع كشف ST-1')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'أقفل' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the measure fails: the door’s sentence is shown, and the press stays shut', async () => {
    api.mockRejectedValue(Object.assign(new Error('قفل الطلبات القديمة بلا باركود مش من صلاحياتك — اطلبها من المالك.'), { status: 403 }));
    render(<ClosePickedDialog orders={ORDERS} onClose={onClose} onDone={onDone} />);
    expect(await screen.findByText(/مش من صلاحياتك/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'أقفل' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('NO NEW CSS — every class the dialog uses is one the product already ships', () => {
  /*
   * The dashboard's first-load stylesheet is under a ratchet (`quality-gates.test.ts`, measured only on CI's build): a class
   * nobody else ships grows it. So the dialog is written from classes the other tracking dialogs already use, and this holds it
   * to that — the same scan the old-ones dialog is held to.
   */
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);
  const classesOf = (src: string) => [...src.matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean));

  it('`ClosePickedDialog`’s classes all appear in another source file', () => {
    const own = join(root, 'components/screens/tracking/ClosePickedDialog.tsx');
    const used = new Set(classesOf(readFileSync(own, 'utf8')));
    expect(used.size, 'the dialog has classes').toBeGreaterThan(20);
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });

  it('the two new buttons in `TrackingScreen` wear the very classes of «اختر الكل» beside them', () => {
    const src = readFileSync(join(root, 'components/screens/TrackingScreen.tsx'), 'utf8');
    const KNOWN = 'min-h-11 md:min-h-0 text-xs text-[var(--sys-primary)] hover:underline';
    let from = 0;
    let found = 0;
    for (;;) {
      const at = src.indexOf('أقفل المحدّد بلا حركة مال…', from);
      if (at < 0) break;
      found += 1;
      // The button's own class is the LAST one before its label (an earlier button may sit inside the window).
      const before = [...src.slice(Math.max(0, at - 260), at).matchAll(/className="([^"]+)"/g)];
      expect(before[before.length - 1]?.[1], `button ${found}`).toBe(KNOWN);
      from = at + 1;
    }
    expect(found, 'the desk strip and the phone bar each carry one').toBe(2);
  });
});
