// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OFFERS CAN BE DRAGGED — AND THE ARROWS ARE STILL THERE.
 *
 * The owner asked (21/10) for the offers to be reordered by drag and drop. The order is what a customer is offered first, so
 * what is held here is not «a grip is drawn» but what a move DOES: the list shows the new order at once, the server is written
 * only for the offers whose number changed, and the list is read back — so what stays on the screen is what the server holds.
 *
 * And what a drag must not take away: the arrows (the path a thumb, a keyboard and a screen reader reach on the first day),
 * the scroll (only the grip refuses the browser's gesture), and the rule that somebody without `offers.manage` is offered no
 * way to change the order at all.
 *
 * What jsdom cannot prove is said at the head of the drag section: it has no layout, so the drag runs against rows whose
 * rectangles are stubbed. «A thumb on the name still scrolls» is a CSS fact only a touch screen can confirm.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { screenApi } = vi.hoisted(() => ({ screenApi: vi.fn() }));
vi.mock('@/lib/screen-api', () => ({ screenApi }));

import { ProductOffers } from './ProductOffers';

// jsdom has no ResizeObserver, and the drag library measures its drop zones with one.
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

interface Row {
  id: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  sellingPrice: number;
  compareAtPrice: number | null;
  endsAt: string | null;
  discount: number;
  deliveryIncluded: boolean;
  postOrderOffer: boolean;
  isDefault: boolean;
  sortOrder: number;
  status: string;
}

const offer = (id: string, name: string, quantity: number, sortOrder: number, over: Partial<Row> = {}): Row => ({
  id,
  name,
  quantity,
  freeQuantity: 0,
  sellingPrice: 20 * quantity,
  compareAtPrice: null,
  endsAt: null,
  discount: 0,
  deliveryIncluded: true,
  postOrderOffer: false,
  isDefault: false,
  sortOrder,
  status: 'ACTIVE',
  ...over,
});

const NAMES = ['قطعة واحدة', 'قطعتان', 'ثلاث قطع', 'خمس قطع'];
const fresh = (orders: number[] = [0, 1, 2, 3]): Row[] =>
  NAMES.map((name, i) => offer(`offer-${i}-aaaaaaaa`, name, [1, 2, 3, 5][i], orders[i], i === 1 ? { isDefault: true } : {}));
const ID = (i: number) => `offer-${i}-aaaaaaaa`;

/** The server, held in memory: what a reader gets back is what the writes left. */
let stored: Row[];
let patches: Array<{ id: string; sortOrder: number }>;
let gets: number;
let requests: number;
let gate: Promise<void> | null;
let failOn: ((nth: number) => boolean) | null;

/** The order the offers door answers in. */
const readBack = (rows: Row[]) => [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.quantity - b.quantity);

function serve(rows: Row[]) {
  stored = rows;
  patches = [];
  gets = 0;
  requests = 0;
  gate = null;
  failOn = null;
  screenApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path.startsWith('/api/offers?')) {
      gets++;
      return { offers: JSON.parse(JSON.stringify(readBack(stored))) };
    }
    // ONE request for the whole move, applied ALL OR NONE like the server's transaction: a refusal leaves every offer where it was.
    if (method === 'PATCH' && path === '/api/offers') {
      const body = JSON.parse(String(init?.body)) as { productId: string; order: Array<{ id: string; sortOrder: number }> };
      requests++;
      body.order.forEach((w) => patches.push({ id: w.id, sortOrder: w.sortOrder }));
      if (gate) await gate;
      if (failOn?.(patches.length)) throw new Error('رفضَ الخادمُ الكتابة');
      stored = stored.map((o) => {
        const w = body.order.find((x) => x.id === o.id);
        return w ? { ...o, sortOrder: w.sortOrder } : o;
      });
      return { success: true };
    }
    return {};
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mount = (canManage = true) => render(<ProductOffers productId="prod-aaaaaaaaaa" basePrice={20} currency="JOD" canManage={canManage} />);

const rowsOf = () => screen.getAllByRole('listitem');
/** The order on the screen, by the name each row shows. */
const shown = () => rowsOf().map((li) => li.querySelector('p span.truncate')?.textContent);
const gripOf = (i: number) => within(rowsOf()[i]).getByLabelText(`اسحب «${NAMES[i]}» لتغيير ترتيبه`);
const press = async (label: string, i: number) => {
  await act(async () => {
    fireEvent.click(within(rowsOf()[i]).getByLabelText(label));
  });
};
const until = (check: () => void) => waitFor(check, { timeout: 3000 });
const settle = (ms = 80) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
const idsShown = () => shown().map((n) => ID(NAMES.indexOf(n as string)));

async function ready(canManage = true) {
  serve(fresh());
  mount(canManage);
  await screen.findAllByRole('listitem');
  if (canManage) await until(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]')).toHaveLength(1));
}

describe('the list keeps everything it had', () => {
  it('— every offer has its grip AND the arrows AND the buttons it always had', async () => {
    await ready();
    expect(rowsOf()).toHaveLength(4);
    rowsOf().forEach((li, i) => {
      const row = within(li);
      expect(row.getByLabelText(`اسحب «${NAMES[i]}» لتغيير ترتيبه`), `مقبض ${NAMES[i]}`).toBeTruthy();
      expect(row.getByLabelText('لأعلى'), `لأعلى ${i}`).toBeTruthy();
      expect(row.getByLabelText('لأسفل'), `لأسفل ${i}`).toBeTruthy();
      expect(row.getByLabelText('تعديل'), `تعديل ${i}`).toBeTruthy();
      expect(row.getByLabelText('حذف'), `حذف ${i}`).toBeTruthy();
    });
  });

  it('and ONLY the grip refuses the browser’s scroll gesture — a thumb on the rest of the row scrolls', async () => {
    await ready();
    const noScroll = Array.from(document.querySelectorAll<HTMLElement>('[style*="touch-action"]'));
    expect(noScroll).toHaveLength(4);
    for (const el of noScroll) expect(el.getAttribute('aria-label'), 'غير المقبض بيمنع التمرير').toMatch(/^اسحب «.*» لتغيير ترتيبه$/);
    for (const el of [...rowsOf(), ...Array.from(document.querySelectorAll('ul'))]) {
      expect((el as HTMLElement).style.touchAction, 'الصف أو القائمة بتمنع التمرير').not.toBe('none');
    }
  });

  it('and the grip speaks Arabic to a screen reader — its role, its instructions, no «sortable»', async () => {
    await ready();
    const grip = gripOf(0);
    expect(grip.getAttribute('aria-roledescription'), 'الكلمة الإنجليزية بقيت').toBe('مقبض ترتيب');
    const helpId = grip.getAttribute('aria-describedby') ?? '';
    expect(helpId, 'المقبض ما إله وصف').not.toBe('');
    expect(document.getElementById(helpId)?.textContent ?? '').toContain('اضغط مسافة لتمسكه');
  });

  it('and the first offer cannot go up and the last cannot go down', async () => {
    await ready();
    expect((within(rowsOf()[0]).getByLabelText('لأعلى') as HTMLButtonElement).disabled).toBe(true);
    expect((within(rowsOf()[3]).getByLabelText('لأسفل') as HTMLButtonElement).disabled).toBe(true);
    expect((within(rowsOf()[1]).getByLabelText('لأعلى') as HTMLButtonElement).disabled).toBe(false);
    expect((within(rowsOf()[2]).getByLabelText('لأسفل') as HTMLButtonElement).disabled).toBe(false);
  });

  it('and without `offers.manage` there is no grip, no arrow and not even a drag context — the list only lists', async () => {
    await ready(false);
    expect(shown()).toEqual(NAMES);
    expect(screen.queryByLabelText('لأعلى')).toBeNull();
    expect(screen.queryByLabelText('لأسفل')).toBeNull();
    expect(screen.queryByLabelText(/^اسحب «/)).toBeNull();
    expect(document.querySelectorAll('[id^="DndDescribedBy"]')).toHaveLength(0);
    expect(document.querySelectorAll('[style*="touch-action"]')).toHaveLength(0);
    await settle();
    expect(patches, 'قائمةٌ لا تُعدَّل كتبت شيئاً').toEqual([]);
  });
});

describe('the arrows go through the one move', () => {
  it('— down on the first offer writes the two that traded places, and nothing else', async () => {
    await ready();
    await press('لأسفل', 0);
    await until(() => expect(shown()).toEqual([NAMES[1], NAMES[0], NAMES[2], NAMES[3]]));
    expect(patches).toEqual([
      { id: ID(1), sortOrder: 0 },
      { id: ID(0), sortOrder: 1 },
    ]);
  });

  it('and up on the last offer is the same, from the other side', async () => {
    await ready();
    await press('لأعلى', 3);
    await until(() => expect(shown()).toEqual([NAMES[0], NAMES[1], NAMES[3], NAMES[2]]));
    expect(patches).toEqual([
      { id: ID(3), sortOrder: 2 },
      { id: ID(2), sortOrder: 3 },
    ]);
  });

  it('and what the screen keeps is what the server holds — the list is read back after the writes', async () => {
    await ready();
    expect(gets).toBe(1);
    await press('لأسفل', 1);
    await until(() => expect(gets, 'ما انقرأت القائمة من جديد').toBe(2));
    expect(shown()).toEqual(readBack(stored).map((o) => o.name));
  });

  it('and the new order is on the screen BEFORE the server has answered — and the controls wait', async () => {
    await ready();
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await press('لأسفل', 0);
    // Held in the air: the writes have been SENT and not answered.
    await until(() => expect(patches).toHaveLength(2));
    expect(shown(), 'الترتيب الجديد ما انرسم قبل ردّ الخادم').toEqual([NAMES[1], NAMES[0], NAMES[2], NAMES[3]]);
    expect((within(rowsOf()[0]).getByLabelText('لأسفل') as HTMLButtonElement).disabled, 'الأزرار ما انتظرت').toBe(true);
    expect((within(rowsOf()[2]).getByLabelText('لأعلى') as HTMLButtonElement).disabled, 'زرُّ «لأعلى» ما انتظر').toBe(true);
    // The first row is now the offer that moved up; its grip is the one that must not be draggable while the writes are out.
    expect(within(rowsOf()[0]).getByLabelText(/^اسحب «/).getAttribute('aria-disabled'), 'المقبض ما انتظر').toBe('true');
    await act(async () => release());
    await until(() => expect(gets).toBe(2));
    await until(() => expect((within(rowsOf()[0]).getByLabelText('لأسفل') as HTMLButtonElement).disabled).toBe(false));
  });

  it('and a write the server refuses is SAID, and the list reads back as the server really holds it — not as it was drawn', async () => {
    await ready();
    failOn = (nth) => nth === 2;
    await press('لأسفل', 0);
    expect(await screen.findByText('رفضَ الخادمُ الكتابة')).toBeTruthy();
    await until(() => expect(gets).toBe(2));
    // The move is ONE request, all or none: the server refused it, so it holds the OLD order (not half of each) and the list shows that.
    expect(requests, 'الحركة انقسمت إلى أكثر من طلب').toBe(1);
    expect(shown()).toEqual([NAMES[0], NAMES[1], NAMES[2], NAMES[3]]);
    expect(shown()).toEqual(readBack(stored).map((o) => o.name));
    expect((within(rowsOf()[0]).getByLabelText('لأسفل') as HTMLButtonElement).disabled, 'القائمة بقيت مقفلة بعد الفشل').toBe(false);
  });

  it('and the next move that works clears the message — an old refusal is not left on a list that is now saved', async () => {
    await ready();
    failOn = (nth) => nth === 2;
    await press('لأسفل', 0);
    expect(await screen.findByText('رفضَ الخادمُ الكتابة')).toBeTruthy();
    await until(() => expect(gets).toBe(2));
    failOn = null;
    await press('لأسفل', 2);
    await until(() => expect(gets).toBe(3));
    expect(screen.queryByText('رفضَ الخادمُ الكتابة'), 'رسالةُ الفشلِ القديمةُ بقيت').toBeNull();
  });

  it('and an offer list that carried TIES is numbered 0 … n-1 by the first move made on it', async () => {
    serve(fresh([0, 0, 0, 0]));
    mount();
    await screen.findAllByRole('listitem');
    await until(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]')).toHaveLength(1));
    await press('لأسفل', 0);
    await until(() => expect(gets).toBe(2));
    expect(new Set(stored.map((o) => o.sortOrder)).size, 'بقي تعادلٌ').toBe(4);
    expect(shown()).toEqual(readBack(stored).map((o) => o.name));
  });
});

describe('and a real drag — the pointer, the keyboard and Esc — goes through the same door', () => {
  /*
   * jsdom has no layout: every rectangle is zero, so a drop zone has nowhere to be dropped on. The rows are given the
   * rectangles a browser would give them — 60px tall, stacked in their list, shifted by the `translate3d` the sortable strategy
   * puts on a row — and everything else is the real library and the real card. What this proves is the WIRING: that a pointer or
   * a key press on the grip ends in the one move and the write, and that Esc ends in nothing.
   *
   * WAITS ARE FOR A CONDITION, NEVER A DURATION. A claim that something DID happen waits until it has; a claim that something
   * did NOT happen has nothing to wait for, so it settles for a while and reads the history rather than the last look.
   */
  const ROW = 60;
  let restoreLayout: () => void;
  let heard: string[] = [];
  let watcher: MutationObserver;
  const announced = () =>
    Array.from(document.querySelectorAll('[role="status"]'))
      .map((e) => e.textContent ?? '')
      .join(' ');

  beforeEach(() => {
    heard = [];
    watcher = new MutationObserver(() => {
      const now = announced();
      if (now && heard[heard.length - 1] !== now) heard.push(now);
    });
    watcher.observe(document.body, { subtree: true, childList: true, characterData: true });

    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const rect = (top: number, height: number) =>
        ({ x: 0, y: top, left: 0, top, right: 400, bottom: top + height, width: 400, height, toJSON: () => ({}) }) as DOMRect;
      if (this.tagName === 'LI' && this.parentElement) {
        const slot = Array.from(this.parentElement.children).indexOf(this) * ROW;
        const shift = /translate3d\(\s*[-\d.]+(?:px)?\s*,\s*([-\d.]+)px/.exec((this as HTMLElement).style.transform)?.[1];
        return rect(slot + (shift ? Number(shift) : 0), ROW);
      }
      if (this.tagName === 'UL') return rect(0, this.children.length * ROW);
      return real.call(this);
    };
    restoreLayout = () => {
      Element.prototype.getBoundingClientRect = real;
    };
  });
  afterEach(() => {
    watcher.disconnect();
    restoreLayout();
  });

  const everHeard = () => heard.join(' ');
  const ev = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };

  it('— a pointer drag from the grip puts the offer where it was dropped, writes only what changed, and says so in Arabic', async () => {
    await ready();
    await act(async () => {
      fireEvent.pointerDown(gripOf(0), { ...ev, clientX: 20, clientY: 30 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 42 }); // past the 6px, so it is a drag
    });
    await until(() => expect(announced(), 'ما انقال إنو انمسك').toContain(`أمسكتَ «${NAMES[0]}»`));

    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 150 }); // 120px down: the third row
    });
    await until(() => expect(announced()).toContain(`«${NAMES[0]}» فوق «${NAMES[2]}»`));
    await act(async () => {
      fireEvent.pointerUp(document, { ...ev, clientX: 20, clientY: 150 });
    });

    await until(() => expect(shown(), 'الصف ما وصل مكان الإفلات').toEqual([NAMES[1], NAMES[2], NAMES[0], NAMES[3]]));
    await until(() => expect(gets).toBe(2));
    // The fourth offer holds its place already, so it is not written.
    expect(patches.map((p) => [p.id, p.sortOrder]).sort()).toEqual(
      [[ID(1), 0], [ID(2), 1], [ID(0), 2]].sort()
    );
    expect(shown()).toEqual(readBack(stored).map((o) => o.name));
    await until(() => expect(announced()).toContain(`أُفلت «${NAMES[0]}» مكان «${NAMES[2]}»`));
  });

  it('and a tap on the grip that does not travel moves nothing, writes nothing, and does not even start a drag', async () => {
    await ready();
    await act(async () => {
      fireEvent.pointerDown(gripOf(0), { ...ev, clientX: 20, clientY: 30 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 21, clientY: 33 }); // 3px: a shaky tap
    });
    await act(async () => {
      fireEvent.pointerUp(document, { ...ev, clientX: 21, clientY: 33 });
    });
    await settle();
    expect(shown()).toEqual(NAMES);
    expect(patches).toEqual([]);
    expect(everHeard(), 'نقرة صغيرة بدأت جلسة سحب').not.toContain('أمسكتَ');
  });

  it('and pressing on the NAME, not the grip, starts nothing — that is where a thumb scrolls', async () => {
    await ready();
    const name = within(rowsOf()[0]).getByText(NAMES[0]);
    await act(async () => {
      fireEvent.pointerDown(name, { ...ev, clientX: 20, clientY: 30 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 150 });
    });
    await settle();
    await act(async () => {
      fireEvent.pointerUp(document, { ...ev, clientX: 20, clientY: 150 });
    });
    await settle();
    expect(everHeard(), 'الضغط على الاسم بدأ سحباً').not.toContain('أمسكتَ');
    expect(shown()).toEqual(NAMES);
    expect(patches).toEqual([]);
  });

  it('and the keyboard does the same: Space to pick up, ↓ to move, Space to put down', async () => {
    await ready();
    await act(async () => {
      fireEvent.keyDown(gripOf(0), { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ «${NAMES[0]}»`));
    await settle(); // the sensor starts listening for the next key on the next turn
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await until(() => expect(announced()).toContain(`«${NAMES[0]}» فوق «${NAMES[1]}»`));
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    });
    await until(() => expect(shown(), 'الكيبورد ما حرّك الصف').toEqual([NAMES[1], NAMES[0], NAMES[2], NAMES[3]]));
    await until(() => expect(gets).toBe(2));
    expect(patches).toEqual([
      { id: ID(1), sortOrder: 0 },
      { id: ID(0), sortOrder: 1 },
    ]);
  });

  it('and putting it down where it was picked up says so — and writes nothing', async () => {
    await ready();
    await act(async () => {
      fireEvent.keyDown(gripOf(0), { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ «${NAMES[0]}»`));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أُفلت «${NAMES[0]}» في مكانه`));
    await settle();
    expect(shown()).toEqual(NAMES);
    expect(patches).toEqual([]);
  });

  it('and Esc puts it back, says it was cancelled, and writes nothing', async () => {
    await ready();
    await act(async () => {
      fireEvent.keyDown(gripOf(0), { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ «${NAMES[0]}»`));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await until(() => expect(announced()).toContain(`«${NAMES[0]}» فوق «${NAMES[1]}»`));
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
    });
    await until(() => expect(announced()).toContain(`أُلغي تحريك «${NAMES[0]}»`));
    await settle();
    expect(shown(), 'Esc ما رجّعها').toEqual(NAMES);
    expect(patches).toEqual([]);
  });

  it('and a drag on a list that carried TIES leaves it numbered 0 … n-1, in the order that was shown', async () => {
    serve(fresh([0, 0, 0, 0]));
    mount();
    await screen.findAllByRole('listitem');
    await until(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]')).toHaveLength(1));
    await act(async () => {
      fireEvent.pointerDown(gripOf(0), { ...ev, clientX: 20, clientY: 30 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 42 });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ «${NAMES[0]}»`));
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 210 }); // the last row
    });
    await until(() => expect(announced()).toContain(`«${NAMES[0]}» فوق «${NAMES[3]}»`));
    await act(async () => {
      fireEvent.pointerUp(document, { ...ev, clientX: 20, clientY: 210 });
    });
    await until(() => expect(gets).toBe(2));
    expect(new Set(stored.map((o) => o.sortOrder)).size, 'بقي تعادلٌ').toBe(4);
    expect(shown()).toEqual([NAMES[1], NAMES[2], NAMES[3], NAMES[0]]);
    expect(shown()).toEqual(readBack(stored).map((o) => o.name));
  });
});

describe('and the wiring is the one that holds the rules', () => {
  const src = () => stripComments(repoFile('src/components/products/ProductOffers.tsx'));

  it('— one drop zone, the vertical axis locked and the row kept inside its list', () => {
    const s = src();
    expect(s.match(/<DndContext\b/g)).toHaveLength(1);
    expect(s).toContain('modifiers={[restrictToVerticalAxis, restrictToParentElement]}');
  });

  it('and the drag listeners are on the grip and on nothing else', () => {
    const s = src();
    expect(s.match(/\.\.\.listeners/g)).toHaveLength(1);
    expect(s.match(/\.\.\.attributes/g)).toHaveLength(1);
    // The row itself takes the node ref, never the listeners.
    expect(s).toMatch(/<li\s+ref=\{setNodeRef\}/);
    expect(s).toContain('ref={setActivatorNodeRef}');
  });

  it('and the arrows and the drag both come through the ONE move — the old swap of two numbers is gone', () => {
    const s = src();
    expect(s).toContain('moveOffer(offers, i, i + dir)');
    expect(s).toContain('moveAfterDrag(offers, end)');
    expect(s, 'عاد التبديل القديم').not.toMatch(/stringify\(\{ sortOrder: [ij] \}\)/);
    // The only place a reorder is written: the offers that CHANGED, in ONE `PATCH /api/offers` — never a request per offer.
    expect(s.match(/order: m\.writes/g)).toHaveLength(1);
    expect(s, 'عاد طلب لكل عرض').not.toMatch(/m\.writes\.map/);
  });

  it('and without the permission the frame draws nothing of its own — and the row is the plain one', () => {
    expect(src()).toMatch(/if \(!enabled\) return <>\{children\}<\/>;/);
    expect(src()).toContain('canManage ? SortableLi : PlainLi');
  });
});
