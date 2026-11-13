// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «تراجع عن التسليم» — THE DIALOG SHOWS WHAT IT WILL DO BEFORE IT ASKS (13/11).
 *
 *   «هاد الطلب بالغلط حطيتو تم والشركة بتقول تم ارجاعها لازم يكون في زر تراجع مش محدود بمدة زمنية ويكون عليه صلاحية للمالك متاح» (the owner)
 *
 * It measures the parcel first and only draws; the door is the one that decides (`undo-delivery.test.ts`). What is held to here: the lines
 * the press would reverse and, apart, what it would leave are on the screen before the press can be made; a refusal is shown in the door's
 * words with nothing to press; the press needs a reason of at least five characters AND the tick; it sends back exactly what was shown;
 * a refusal is said, the numbers are read again, the tick is taken back and the reason is KEPT; a press goes once — and what was pressed
 * when it opened is the only thing it ever asks about.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));

import { UndoDeliveryDialog } from './UndoDeliveryDialog';
import { UNDO_REASON_MAX, UNDO_REASON_MIN, UNDO_STAYS_AR, type UndoMeasure } from '@/lib/delivery-undo-words';

const DOOR = '/api/ops/tracking/undo-delivery';
const ID = '11111111-1111-4111-8111-111111111111';
const ORDER = { id: ID, orderNumber: 'ORD-2026-1696', merchantRef: 'MR-1696' };
const REASON = 'انسجّل تسليمو بالغلط — الشركة بتقول تم إرجاعها';

const measureOf = (over: Partial<UndoMeasure> = {}): UndoMeasure => ({
  orderNumber: 'ORD-2026-1696',
  courier: 'الباشا',
  allowed: true,
  refusal: null,
  fingerprint: 'a'.repeat(24),
  from: 'DELIVERED',
  to: 'SHIPPED',
  lines: [
    { key: 'STATUS', text: 'حالة الشحن بترجع من «مسلَّم» لـ«مشحون» (الحالة اللي قبل التسليم مش محفوظة بالسجل)، وتاريخ التسليم بيتمسح.' },
    { key: 'ITEMS', text: '2 بند بيرجعوا لـ«الباب لسا ما حكى» — بتنمسح الكميات المسلَّمة والراجعة اللي انكتبت عليهم.' },
    { key: 'CUSTOMER', text: 'سجل الزبون: «الطلبات المسلَّمة» بتنقص واحد (من 5 لـ4)، وقيمة مشترياتو بتنقص بمقدار التحصيل المتوقَّع وقت التسليم:', amount: { value: 55, currency: 'USD' } },
    { key: 'COMMISSION', text: 'عمولة الطلب (1 قيد) بتنلغي بقيد عكسي — القيد الأصلي بيضل بالسجل.' },
  ],
  stays: [
    { key: 'STOCK', text: 'المخزون ما بيتغيّر: 4 قطعة طلعت من الرف عند التسليم وبتضل طالعة — البضاعة عند الشركة، وبترجع للرف لما تنعدّ بقسم المرتجعات، مش من هون.' },
    { key: 'MONEY', text: 'ما بينكتب ولا قرش: لا حركة محفظة ولا مبلغ محصَّل.' },
    { key: 'HISTORY', text: 'السجل ما بيتمسح منو شي: بيضيف سطر على خط الطلب وملاحظة داخلية فيها السبب.' },
  ],
  ...over,
});
const refusedMeasure = (text: string): UndoMeasure =>
  measureOf({ allowed: false, refusal: { code: 'MONEY_RECORDED', text }, fingerprint: null, to: null, lines: [], stays: [] });

type Sent = { action: string; orderId: string; reason?: string; fingerprint?: string; acknowledged?: boolean };
const sent = (action: string) =>
  api.mock.calls
    .map((c) => JSON.parse((c[1] as { body: string }).body) as Sent)
    .filter((b) => b.action === action);

let onClose: () => void;
let onDone: (message: string) => void;

beforeEach(() => {
  vi.clearAllMocks();
  onClose = vi.fn();
  onDone = vi.fn();
  api.mockImplementation(async (_url: string, init?: { body: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as Sent;
    if (body.action === 'undo') return { undone: true, message: 'اتراجع عن تسليم الطلب ORD-2026-1696 — رجع «مشحون»' };
    return measureOf();
  });
});
afterEach(() => cleanup());

const open = async (order = ORDER) => {
  const view = render(<UndoDeliveryDialog order={order} onClose={onClose} onDone={onDone} />);
  await screen.findByText('اللي رح يرجع:');
  return view;
};
const reasonBox = () => screen.getByLabelText('سبب التراجع *') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(reasonBox(), { target: { value: text } });
const tick = () => fireEvent.click(screen.getByRole('checkbox'));
const pressButton = () => screen.getByRole('button', { name: 'تراجع عن التسليم' }) as HTMLButtonElement;
const ready = () => {
  type(REASON);
  tick();
};

describe('what it will do comes before the press', () => {
  it('measures the pressed parcel the moment it opens — one request, writing nothing', async () => {
    await open();
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][0]).toBe(DOOR);
    expect((api.mock.calls[0][1] as { method: string }).method).toBe('POST');
    expect(sent('measure')).toEqual([{ action: 'measure', orderId: ID }]);
    expect(sent('undo')).toEqual([]);
  });

  it('says every line the press would reverse — status, lines, the customer’s record with the figure as money, the commission', async () => {
    await open();
    expect(screen.getByText(/حالة الشحن بترجع من «مسلَّم» لـ«مشحون»/)).toBeTruthy();
    expect(screen.getByText(/2 بند بيرجعوا/)).toBeTruthy();
    expect(screen.getByText(/سجل الزبون: «الطلبات المسلَّمة» بتنقص واحد \(من 5 لـ4\)/)).toBeTruthy();
    expect(screen.getByText(/عمولة الطلب \(1 قيد\) بتنلغي بقيد عكسي/)).toBeTruthy();
    // the one figure is drawn as money, by the shared component — never computed here
    expect(screen.getByText(/55/)).toBeTruthy();
  });

  it('and, said apart, what it will NOT touch: the stock (it comes back when the desk counts it), the money, the history', async () => {
    await open();
    expect(screen.getByText('واللي ما رح يتغيّر:')).toBeTruthy();
    expect(screen.getByText(/المخزون ما بيتغيّر: 4 قطعة طلعت من الرف/)).toBeTruthy();
    expect(screen.getByText(/لما تنعدّ بقسم المرتجعات/)).toBeTruthy();
    expect(screen.getByText('ما بينكتب ولا قرش: لا حركة محفظة ولا مبلغ محصَّل.')).toBeTruthy();
    expect(screen.getByText(/السجل ما بيتمسح منو شي/)).toBeTruthy();
  });

  it('the sentence about the announcement that is not recalled is drawn when the door sends it (a FULL delivery through the order’s own door) and is nowhere on the screen when it does not', async () => {
    api.mockImplementation(async (_url: string, init?: { body: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Sent;
      if (body.action === 'undo') return { undone: true, message: 'تم' };
      const base = measureOf();
      return measureOf({ stays: [...base.stays, { key: 'EVENTS', text: UNDO_STAYS_AR.events }] });
    });
    await open();
    expect(screen.getByText(UNDO_STAYS_AR.events)).toBeTruthy();
    expect(UNDO_STAYS_AR.events).toContain('ما بينسحب');
    cleanup();

    // a partial delivery: the door sends no such line, so the dialog says nothing about an announcement
    api.mockImplementation(async () => measureOf());
    await open();
    expect(screen.queryByText(UNDO_STAYS_AR.events)).toBeNull();
    expect(screen.queryByText(/ما بينسحب/)).toBeNull();
  });

  it('says in plain words there is NO time limit, and what makes it refuse — facts, never a clock', async () => {
    await open();
    expect(screen.getByText(/مفتوح بأي وقت — ما في مدة محددة/)).toBeTruthy();
    expect(screen.getByText(/بيرفض إذا انسوّى حسابو أو ذكرو كشف أو انعدّ مرتجعو أو صارت عمولتو قابلة للدفع/)).toBeTruthy();
  });

  it('the title and the subtitle name the order the way the row does', async () => {
    await open();
    expect(screen.getAllByText('تراجع عن التسليم').length).toBeGreaterThan(0);
    expect(screen.getByText('MR-1696 — بيرجع الطلب لحالتو قبل التسليم')).toBeTruthy();
    cleanup();
    render(<UndoDeliveryDialog order={{ ...ORDER, merchantRef: null }} onClose={onClose} onDone={onDone} />);
    await screen.findByText('اللي رح يرجع:');
    expect(screen.getByText('ORD-2026-1696 — بيرجع الطلب لحالتو قبل التسليم')).toBeTruthy();
  });

  it('real controls only: one text box, one tick, two buttons — no menu to choose from, nothing to compute, no date to pick', async () => {
    await open();
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(document.querySelectorAll('textarea')).toHaveLength(1);
    expect([...document.querySelectorAll('input')].map((i) => i.type)).toEqual(['checkbox']);
    expect(document.querySelectorAll('input[type=date], input[type=time], input[type=datetime-local], input[type=number]')).toHaveLength(0);
  });

  it('a delivery that cannot be taken back says WHY in the door’s words — an alert, no tick, no text box, and the press stays shut', async () => {
    api.mockImplementation(async () => refusedMeasure('تسوية الطلب بحالة «مسوّى» — فيها مصاري أو مسكّرة، وما بيتراجع عن تسليمو من هون.'));
    render(<UndoDeliveryDialog order={ORDER} onClose={onClose} onDone={onDone} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('ما بيتراجع عن هالتسليم');
    expect(alert.textContent).toContain('تسوية الطلب بحالة «مسوّى»');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByLabelText('سبب التراجع *')).toBeNull();
    expect(pressButton().disabled).toBe(true);
    expect(screen.queryByText('اللي رح يرجع:')).toBeNull();
  });

  it('the measure fails: the door’s sentence is shown, and the press stays shut', async () => {
    api.mockRejectedValue(Object.assign(new Error('التراجع عن تسجيل التسليم مش من صلاحياتك — اطلبو من المالك.'), { status: 403 }));
    render(<UndoDeliveryDialog order={ORDER} onClose={onClose} onDone={onDone} />);
    expect(await screen.findByText(/مش من صلاحياتك/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(pressButton().disabled).toBe(true);
  });
});

describe('the press — a reason and a tick, and not before', () => {
  it('is shut until BOTH are given: neither, only the tick, only a reason', async () => {
    await open();
    expect(pressButton().disabled).toBe(true);
    tick();
    expect(pressButton().disabled).toBe(true);
    tick(); // taken back
    type(REASON);
    expect(pressButton().disabled).toBe(true);
    tick();
    expect(pressButton().disabled).toBe(false);
  });

  it('a reason shorter than five characters, or blank, does not open it — and five does, not one character sooner', async () => {
    await open();
    tick();
    for (const short of ['', '   ', 'غلط', 'غلطا']) {
      type(short);
      expect(pressButton().disabled, JSON.stringify(short)).toBe(true);
    }
    expect([...'غلطان']).toHaveLength(UNDO_REASON_MIN);
    type('غلطان');
    expect(pressButton().disabled).toBe(false);
    type('  غلط  '); // spaces are not letters
    expect(pressButton().disabled).toBe(true);
  });

  it('the text box carries the door’s own limit', async () => {
    await open();
    expect(reasonBox().maxLength).toBe(UNDO_REASON_MAX);
  });

  it('sends back EXACTLY what was shown — the pressed order, the trimmed reason, the fingerprint and the tick — and tells the screen what the door said', async () => {
    await open();
    type(`   ${REASON}   `);
    tick();
    fireEvent.click(pressButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('اتراجع عن تسليم الطلب ORD-2026-1696 — رجع «مشحون»'));
    expect(sent('undo')).toEqual([{ action: 'undo', orderId: ID, reason: REASON, fingerprint: 'a'.repeat(24), acknowledged: true }]);
  });

  it('goes ONCE: two quick presses send one request', async () => {
    await open();
    ready();
    const btn = pressButton();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(sent('undo')).toHaveLength(1);
  });

  it('after a success the press stays shut even when the parent is slow to close the dialog: a second click sends nothing', async () => {
    await open();
    ready();
    fireEvent.click(pressButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pressButton().disabled).toBe(false));
    fireEvent.click(pressButton());
    await new Promise((r) => setTimeout(r, 30));
    expect(sent('undo')).toHaveLength(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a refusal is said, the numbers are read again, the tick is taken back — and the reason typed is KEPT', async () => {
    api.mockImplementation(async (_url: string, init?: { body: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Sent;
      if (body.action === 'undo') {
        throw Object.assign(new Error('تغيّرت الأرقام من لما فتحت النافذة — افتحها من جديد وراجعها قبل ما تتراجع.'), { status: 409 });
      }
      return measureOf();
    });
    await open();
    ready();
    fireEvent.click(pressButton());

    expect((await screen.findByText(/تغيّرت الأرقام من لما فتحت النافذة/)).textContent).toContain('افتحها من جديد');
    await waitFor(() => expect(sent('measure')).toHaveLength(2));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    expect(pressButton().disabled).toBe(true);
    expect(reasonBox().value).toBe(REASON);
    expect(onDone).not.toHaveBeenCalled();
    // the refusal is still on the screen after the re-read: that is exactly when it is read
    expect(screen.getByText(/تغيّرت الأرقام من لما فتحت النافذة/)).toBeTruthy();
  });

  it('after the re-read the press works again with the NEW fingerprint, once the tick is given again', async () => {
    let round = 0;
    api.mockImplementation(async (_url: string, init?: { body: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Sent;
      if (body.action === 'undo') {
        round += 1;
        if (round === 1) throw Object.assign(new Error('تغيّر وضع الطلب وقت التراجع. ما انتراجع عن شي — افتح النافذة من جديد.'), { status: 409 });
        return { undone: true, message: 'تمّ' };
      }
      return measureOf({ fingerprint: round === 0 ? 'a'.repeat(24) : 'b'.repeat(24) });
    });
    await open();
    ready();
    fireEvent.click(pressButton());
    await screen.findByText(/تغيّر وضع الطلب وقت التراجع/);
    await waitFor(() => expect(sent('measure')).toHaveLength(2));
    await waitFor(() => expect(pressButton().disabled).toBe(true));
    tick();
    await waitFor(() => expect(pressButton().disabled).toBe(false));
    fireEvent.click(pressButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('تمّ'));
    expect(sent('undo').map((b) => b.fingerprint)).toEqual(['a'.repeat(24), 'b'.repeat(24)]);
  });

  it('a refused press is a FAILED press on the button — never a success tick over the refusal', async () => {
    api.mockImplementation(async (_url: string, init?: { body: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Sent;
      if (body.action === 'undo') throw Object.assign(new Error('انتراجع عن تسليم هالطلب من قبل — حالتو هلّق «مشحون».'), { status: 409 });
      return measureOf();
    });
    await open();
    ready();
    fireEvent.click(pressButton());
    await screen.findByText(/انتراجع عن تسليم هالطلب من قبل/);

    const btn = document.querySelector('button.flex-1') as HTMLButtonElement;
    await waitFor(() => expect(btn.getAttribute('aria-busy')).toBeNull());
    expect(btn.querySelector('svg'), 'a success tick over a refusal').toBeNull();
  });

  it('cancel closes without a press', async () => {
    await open();
    ready();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sent('undo')).toHaveLength(0);
  });
});

describe('what was pressed WHEN IT OPENED is the only thing it asks about', () => {
  it('the list behind may be read again with another parcel: the dialog does not ask a new question, and the press carries the original id', async () => {
    const view = await open();
    expect(sent('measure')).toHaveLength(1);

    view.rerender(<UndoDeliveryDialog order={{ id: '99999999-9999-4999-8999-999999999999', orderNumber: 'ORD-9', merchantRef: null }} onClose={onClose} onDone={onDone} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent('measure')).toHaveLength(1);

    ready();
    fireEvent.click(pressButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(sent('undo')[0].orderId).toBe(ID);
    expect(JSON.stringify(api.mock.calls)).not.toContain('99999999-9999-4999-8999-999999999999');
  });
});

describe('the dialog says nothing a person cannot read — no English, no jargon', () => {
  it('every word the dialog itself draws is Arabic (the door’s sentences and the order’s own number aside)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/tracking/UndoDeliveryDialog.tsx'), 'utf8');
    const jsxText = [...src.matchAll(/>\s*([^<>{}\n]*[؀-ۿ][^<>{}\n]*)\s*</g)].map((m) => m[1]);
    const props = [...src.matchAll(/(?:title|subtitle|label|placeholder|helperText)="([^"]+)"/g)].map((m) => m[1]);
    expect(jsxText.length + props.length).toBeGreaterThan(8);
    for (const s of [...jsxText, ...props]) expect(s, s).not.toMatch(/[A-Za-z]{2,}/);
  });
});

describe('NO NEW CSS — every class the dialog uses is one the product already ships', () => {
  /*
   * The dashboard's first-load stylesheet is under a ratchet (`quality-gates.test.ts`, measured only on CI's build): a class
   * nobody else ships grows it. So the dialog is written from classes the other tracking dialogs already use, and this holds it
   * to that — the same scan the closing dialogs are held to.
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

  it('`UndoDeliveryDialog`’s classes all appear in another source file', () => {
    const own = join(root, 'components/screens/tracking/UndoDeliveryDialog.tsx');
    const used = new Set(classesOf(readFileSync(own, 'utf8')));
    expect(used.size, 'the dialog has classes').toBeGreaterThan(20);
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });

  it('the button in `TrackingScreen` wears the very classes of «تحويل» beside it — and builds no token of its own', () => {
    const src = readFileSync(join(root, 'components/screens/TrackingScreen.tsx'), 'utf8');
    const KNOWN = 'inline-flex min-h-11 items-center text-xs text-[var(--sys-primary)] hover:underline md:min-h-0${quiet}';
    const at = src.indexOf('تراجع عن التسليم…');
    expect(at, 'the button is on the screen').toBeGreaterThan(0);
    // the button's own class is the LAST one before its label
    const before = [...src.slice(Math.max(0, at - 400), at).matchAll(/className=\{`([^`]+)`\}/g)];
    expect(before[before.length - 1]?.[1]).toBe(KNOWN);
    // …and the transfer button carries exactly the same string
    expect(src.split(KNOWN).length - 1, 'two buttons, one string').toBe(2);
  });
});
