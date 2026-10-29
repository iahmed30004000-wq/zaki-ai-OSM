// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ONE BOX, AND THE TWO THINGS IT MUST NOT DO.
 *
 * It must not become a way to reach a screen this account cannot open, and
 * it must not become a way to look up a customer this account was never
 * allowed to look up. Both are easy to get wrong in a palette, because the
 * usual way to build one is to list everything and hide the rest — which
 * ships the whole map to anybody who reads the bundle.
 */

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

let viewer: { id: string; role: string; permissions: string[] } | null = null;
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: viewer }) }));

import { CommandPalette, useCommandPalette } from './CommandPalette';
import { ALL_ROUTES } from '@/lib/route-registry';

const GROUPS = [
  {
    key: 'ops',
    label: 'التشغيل',
    routes: [
      { path: '/ops/shipments', label: 'الشحنات', icon: 'Truck', permissions: ['ops.ship'] },
      { path: '/ops/returns', label: 'المرتجعات', icon: 'Package', permissions: ['ops.returns'] },
    ],
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * THE BOX ASKS TWO DOORS NOW, SO «DID IT ASK» HAS TO NAME ONE.
 *
 * K1 gave the palette its own door: `GET /api/palette` on open for the
 * summary, and `POST /api/palette` for the counters a typed word asks for.
 * Both go through `apiFetch`, so a bare `expect(fetch).not.toHaveBeenCalled()`
 * now proves only that the palette opened — not that the RECORD search
 * stayed where it was.
 *
 * Which is the whole point of the four claims below, so they count calls to
 * `/api/orders` specifically. The claim is unchanged: record lookup is the
 * owner's alone, and a barcode is one request.
 */
const ordersCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/orders'));

/** What the palette's own door answers: five counts and what the account may do. */
const SUMMARY = {
  facts: [
    { key: 'today', label: 'طلبات اليوم', count: 6, rule: 'أُنشئت اليوم في هذا المتجر', href: '/orders' },
    { key: 'postponed', label: 'مؤجّلة', count: 2, rule: 'حالتها «مؤجّل»', href: '/orders?state=POSTPONED' },
  ],
  // `today` (PR-5): the server says «لخّصلي اليوم» is for this account — it holds orders.view AND the assistants' key.
  may: { pull: true, people: true, wide: true, today: true },
};

beforeEach(() => {
  viewer = { id: 'u1', role: 'SUPER_ADMIN', permissions: [] };
  fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).startsWith('/api/palette')
        ? SUMMARY
        : { orders: [{ id: 'o1', orderNumber: 'ORD-4821', customer: { fullName: 'سميّة' } }] },
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

function open(props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  return render(
    <CommandPalette
      groups={GROUPS}
      canSearchRecords
      canSwitchStore
      open
      onClose={props.onClose ?? (() => undefined)}
      {...props}
    />
  );
}

async function type(text: string) {
  const box = screen.getByLabelText('ابحث أو انتقل أو نفّذ');
  await act(async () => {
    fireEvent.change(box, { target: { value: text } });
  });
  return box;
}

/** Let the settle timer fire and the response land. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  await act(async () => undefined);
}

describe('the screens it offers', () => {
  it('are the ones it was GIVEN, never a list of its own', () => {
    // The groups arrive already narrowed by the server. If the palette
    // carried its own copy of the menu, a warehouse account would find
    // "الرواتب" in a box that then 404s — and would learn the screen exists.
    const src = readFileSync(join(process.cwd(), 'src/components/shell/CommandPalette.tsx'), 'utf8');
    expect(src, 'الشاشات لا تأتي من الخارج').toMatch(/const screens[^=]*=[\s\S]{0,40}groups[\s\S]{0,20}flatMap/);
  });

  /**
   * AND «أفعال» IS NOT «شاشات» WITH A VERB FOR A NAME.
   *
   * The first list here was «شحنة جديدة», «إغلاق اليوم», «استلام مرتجع» —
   * and every one was already a route, with a noun for a name. Two lists
   * for one set of doors, one of them hand-kept and free to drift from the
   * permissions the real routes carry.
   */
  it('and no action is a route the menu already names', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/shell/CommandPalette.tsx'), 'utf8');
    const actions = src.slice(src.indexOf('const ACTIONS'), src.indexOf('interface Hit'));
    const paths = [...actions.matchAll(/href: '([^']+)'/g)].map((m) => m[1].split('?')[0]);
    const routes = new Set(ALL_ROUTES.map((r) => r.path));
    const dupes = paths.filter((p) => routes.has(p));
    expect(dupes, `فعلٌ هو شاشةٌ باسمٍ آخر: ${dupes.join('، ')}`).toEqual([]);
    expect(paths.length + [...actions.matchAll(/run: \(\)/g)].length, 'لا أفعال أصلاً').toBeGreaterThan(0);
  });

  it('and typing part of a name narrows to it', async () => {
    open();
    await type('مرتجع');
    expect(screen.queryByText('المرتجعات')).toBeTruthy();
    expect(screen.queryByText('الشحنات')).toBeNull();
  });
});

describe('an open, empty box', () => {
  it('offers the commands that have no route, not the first eight of fifty screens', () => {
    // Fifty screens under an empty query is the menu again in a smaller
    // window, answering a question nobody asked.
    open();
    expect(screen.queryByText('تسجيل الخروج'), 'الصندوق الفارغ لا يعرض الأوامر').toBeTruthy();
    expect(screen.queryByText('الشحنات'), 'الصندوق الفارغ أغرق الأوامر بالشاشات').toBeNull();
  });

  it('and one of them reads itself the other way round once the menu is folded', () => {
    open();
    expect(screen.queryByText('اطوِ القائمة إلى شريط')).toBeTruthy();
    cleanup();
    document.cookie = 'osm_rail=1; path=/';
    open();
    expect(screen.queryByText('وسّع القائمة'), 'الأمر يعِد بطيِّ قائمةٍ مطويّة').toBeTruthy();
    document.cookie = 'osm_rail=; path=/; max-age=0';
  });
});

describe('the commands it offers', () => {
  it('leave out the store switch when there is nothing to switch to', () => {
    // Exactly the header's own condition: one store and one country means
    // a picker with one thing in it.
    open({ canSwitchStore: false });
    expect(screen.queryByText('تبديل المتجر أو البلد'), 'تبديلٌ إلى لا شيء').toBeNull();
    expect(screen.queryByText('تسجيل الخروج'), 'اختفت بقية الأوامر معه').toBeTruthy();
  });

  it('and offer it when there is', () => {
    open();
    expect(screen.queryByText('تبديل المتجر أو البلد')).toBeTruthy();
  });

  it('and the ones that do something here do not pretend to navigate', async () => {
    open();
    const src = readFileSync(join(process.cwd(), 'src/components/shell/CommandPalette.tsx'), 'utf8');
    // `href` and `run` are alternatives; a row carrying both would navigate
    // away from the thing it just did.
    expect(src).toContain('if (row.href) router.push(row.href);');
    expect(src).toContain('else row.run?.();');
  });
});

/**
 * THE PRIVACY RULE THAT CAME WITH THE OLD BOX.
 *
 * The header's search was the owner's alone, deliberately: the results were
 * always role-scoped, but a box inviting everyone to type a phone number is
 * not the same thing as a box only the owner has. Moving the box must not
 * quietly widen it.
 */
describe('record lookup', () => {
  it('does not even ask when this account was not the one allowed to', async () => {
    open({ canSearchRecords: false });
    await type('01234567');
    await settle();
    expect(ordersCalls(), 'البحث في السجلات اتّسع لمن لم يكن يملكه').toEqual([]);
    expect(screen.queryByText('ORD-4821')).toBeNull();
  });

  it('and does when it was', async () => {
    open();
    await type('01234567');
    await settle();
    expect(ordersCalls().length).toBeGreaterThan(0);
    expect(screen.queryByText('ORD-4821')).toBeTruthy();
  });

  it('goes through the orders endpoint, so the server filters by role again', async () => {
    open();
    await type('4821');
    await settle();
    expect(String(ordersCalls()[0][0])).toContain('/api/orders?q=');
  });

  it('and a barcode is one request, not one per character', async () => {
    open();
    const box = screen.getByLabelText('ابحث أو انتقل أو نفّذ');
    // A scanner types the whole code in a few milliseconds.
    for (const value of ['A', 'A1', 'A1B', 'A1B2', 'A1B2C', 'A1B2C3']) {
      await act(async () => {
        fireEvent.change(box, { target: { value } });
      });
    }
    await settle();
    expect(ordersCalls().length, 'كل حرف أطلق طلباً').toBe(1);
  });

  it('and two letters is the floor — one letter asks nothing', async () => {
    open();
    await type('A');
    await settle();
    expect(ordersCalls(), 'حرفٌ واحدٌ أطلق بحثاً في السجلات').toEqual([]);
  });

  it('and a refused request leaves the box usable, not broken', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, json: async () => ({}) }));
    open();
    await type('مرتجع');
    await settle();
    // Only the records half came back empty. The screens the term matches
    // are still listed, so a 403 or a dropped line does not blank the box.
    expect(screen.queryByText('المرتجعات'), 'طلبٌ مرفوض أفرغ الصندوق كلّه').toBeTruthy();
  });
});

describe('the keyboard', () => {
  it('walks the list and opens what it lands on', async () => {
    open();
    const box = await type('مرتجع');
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(push).toHaveBeenCalledWith('/ops/returns');
  });

  it('and Escape closes it', async () => {
    const onClose = vi.fn();
    open({ onClose });
    const box = await type('م');
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('and the cursor cannot walk off either end', async () => {
    open();
    const box = await type('مرتجع'); // exactly one row
    // One act per press. Batched into one, every handler would read the
    // same stale cursor and the clamp would never be exercised.
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowDown', 'Enter']) {
      await act(async () => {
        fireEvent.keyDown(box, { key });
      });
    }
    expect(push, 'المؤشر خرج عن القائمة فلم يفتح شيئاً').toHaveBeenCalledWith('/ops/returns');
  });
});

/** Ctrl/Cmd + K, from anywhere, without every screen knowing about it. */
describe('the shortcut', () => {
  function Harness() {
    const { open: isOpen, setOpen } = useCommandPalette();
    return <span data-testid="state">{isOpen ? 'open' : 'shut'}</span>;
  }

  it('is Ctrl+K and Cmd+K, and toggles', async () => {
    render(<Harness />);
    expect(screen.getByTestId('state').textContent).toBe('shut');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    expect(screen.getByTestId('state').textContent).toBe('open');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'K', metaKey: true });
    });
    expect(screen.getByTestId('state').textContent, 'الاختصار لا يُغلق ما فتحه').toBe('shut');
  });

  it('and a bare K still types a K', async () => {
    render(<Harness />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k' });
    });
    expect(screen.getByTestId('state').textContent).toBe('shut');
  });
});

describe('the header it replaced', () => {
  it('no longer carries a search box of its own', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/shell/Header.tsx'), 'utf8');
    expect(/<input/.test(src), 'بحثٌ ثانٍ ما زال في الترويسة').toBe(false);
    expect(src, 'لا باب إلى الصندوق الواحد').toContain('onSearchClick');
  });

  it('and the door is open to everyone, because navigating is not exposure', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/shell/Header.tsx'), 'utf8');
    const trigger = src.slice(src.indexOf('ONE TRIGGER'), src.indexOf('<div className="flex shrink-0'));
    expect(trigger, 'الباب نفسه مشروط بدور').not.toMatch(/SUPER_ADMIN/);
  });

  it('while the rule about records travelled with it, unchanged', () => {
    const shell = readFileSync(join(process.cwd(), 'src/components/shell/Shell.tsx'), 'utf8');
    expect(shell, 'قاعدة البحث في السجلات تغيّرت أثناء النقل').toMatch(
      /canSearchRecords\s*=\s*userRole === 'SUPER_ADMIN'/
    );
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────
 * K1 — THE BOX ANSWERS BEFORE ANYTHING IS TYPED.
 *
 * An empty palette used to be three commands and a sentence telling you to
 * type. It opens on the state of the desk now — and the two things that
 * can go wrong with that are a number without its rule, and a number that
 * belongs to somebody else.
 *
 * The scope itself is asked of the SERVER, in
 * `src/lib/palette-intel.test.ts` and `src/app/api/palette/…`, because
 * that is where it is decided. What is asked here is what the box does
 * with the answer.
 * ───────────────────────────────────────────────────────────────────────
 */
describe('an open box, before a letter is typed', () => {
  /** Let the summary request land. */
  async function opened() {
    const r = open();
    await act(async () => undefined);
    await act(async () => undefined);
    return r;
  }

  it('shows the counts the summary came back with', async () => {
    await opened();
    expect(String(fetchMock.mock.calls[0][0]), 'الصندوق ما سأل بابه').toBe('/api/palette');
    expect(screen.queryByText('طلبات اليوم')).toBeTruthy();
    expect(screen.queryByText('6')).toBeTruthy();
  });

  it('and prints the rule under every one of them', async () => {
    // «متأخرة» is the kind of number two people read two ways. A figure
    // whose rule lives in a comment in a file is a figure somebody argues
    // with at a desk.
    await opened();
    for (const fact of SUMMARY.facts) {
      expect(screen.queryByText(fact.rule), `«${fact.label}» رقمٌ بلا قاعدة على الشاشة`).toBeTruthy();
    }
  });

  it('and the commands are still there under it, not replaced by it', async () => {
    await opened();
    expect(screen.queryByText('تسجيل الخروج'), 'الملخّص أكل الأوامر').toBeTruthy();
    expect(screen.queryByText('الشحنات'), 'الملخّص جاء معه بالشاشات').toBeNull();
  });

  it('and «اسحب» appears only when the server said this account pulls', async () => {
    await opened();
    expect(screen.queryByText('اسحب الطلب التالي')).toBeTruthy();
    cleanup();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...SUMMARY, may: { pull: false, people: false, wide: false } }),
    }));
    await opened();
    expect(screen.queryByText('اسحب الطلب التالي'), 'سحبٌ معروضٌ لمن لا يسحب').toBeNull();
  });
});

describe('«اسحب» from the palette is the pull screen’s own door', () => {
  async function pressPull() {
    open();
    await act(async () => undefined);
    await act(async () => undefined);
    const button = screen.getByText('اسحب الطلب التالي');
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => undefined);
    return button;
  }

  it('so it posts to /api/confirmation/pull and nowhere else', async () => {
    /*
     * There is no second pull path and there must not be: the caps, «سجّل
     * محاولة اتصال أولاً» and «لا توجد طلبات بانتظار التأكيد» all live
     * behind that one route. A palette that picked its own candidate would
     * be a way around every one of them.
     */
    await pressPull();
    const pulls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/confirmation/pull');
    expect(pulls.length, 'السحب ما مرّ من باب السحب').toBe(1);
    expect(pulls[0][1].method).toBe('POST');
  });

  it('and shows the refusal the server gave, in the box, rather than nothing', async () => {
    const REFUSAL = 'سجّل محاولة اتصال على طلبك الحالي قبل سحب طلب جديد';
    fetchMock.mockImplementation(async (url: string) => ({
      ok: !String(url).includes('/confirmation/pull'),
      status: String(url).includes('/confirmation/pull') ? 409 : 200,
      json: async () =>
        String(url).includes('/confirmation/pull') ? { error: REFUSAL } : SUMMARY,
    }));
    await pressPull();
    // The box stays open for it. Closing first would draw the refusal on a
    // sheet that is already gone — «كبست وما صار شي».
    expect(screen.queryByText(REFUSAL), 'الرفض ضاع مع إغلاق الصندوق').toBeTruthy();
    expect(push, 'انتُقِل إلى «طلباتي» بعد رفض').not.toHaveBeenCalled();
  });

  it('and goes to «طلباتي» when the pull was granted', async () => {
    await pressPull();
    expect(push).toHaveBeenCalledWith('/confirmation/mine');
  });
});

describe('«لخّصلي اليوم» is offered only to who the server said it answers (PR-5)', () => {
  async function openedWith(may: Record<string, unknown>) {
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ ...SUMMARY, may }) }));
    open();
    await act(async () => undefined);
    await act(async () => undefined);
  }

  it('is there when `today` is true', async () => {
    await openedWith({ pull: false, people: false, wide: false, today: true });
    expect(screen.queryByText('لخّصلي اليوم')).toBeTruthy();
  });

  it('NEGATIVE: is not there when `today` is false — a button that only answers «لا صلاحية»', async () => {
    await openedWith({ pull: true, people: true, wide: true, today: false });
    expect(screen.queryByText('لخّصلي اليوم'), 'عرضٌ لمن لا يُجاب').toBeNull();
  });

  it('NEGATIVE: is not there in an older answer that never said (absent is not «yes»)', async () => {
    await openedWith({ pull: true, people: true, wide: true });
    expect(screen.queryByText('لخّصلي اليوم')).toBeNull();
  });
});

describe('«لخّصلي اليوم»', () => {
  async function pressSummarise(answer: Record<string, unknown>) {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url) === '/api/palette/today' ? answer : SUMMARY),
    }));
    open();
    await act(async () => undefined);
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByText('لخّصلي اليوم'));
    });
    await act(async () => undefined);
  }

  it('writes the paragraph into the box it was asked from', async () => {
    await pressSummarise({ text: 'اليوم فيه ستّة طلبات جديدة.', from: 'LOCAL_MODEL' });
    expect(screen.queryByText(/ستّة طلبات جديدة/)).toBeTruthy();
  });

  it('and says when the text is the numbers rather than a model', async () => {
    // Silence about it reads as a worse model instead of an unused one —
    // and «المسار ليس LOCAL» is a setting the owner can change.
    await pressSummarise({ text: 'اليوم: ٦ طلبات.', from: 'NUMBERS', why: 'NOT_LOCAL' });
    expect(screen.queryByText(/مسار الذكاء ليس LOCAL/), 'ما قال لماذا النصّ عاديّ').toBeTruthy();
  });
});

describe('it is reachable without a keyboard', () => {
  it('because a phone has no Ctrl and no Esc', () => {
    const header = readFileSync(join(process.cwd(), 'src/components/shell/Header.tsx'), 'utf8');
    // The icon that opens it on a phone…
    expect(header).toMatch(/onSearchClick[\s\S]{0,240}md:hidden/);
    const palette = readFileSync(join(process.cwd(), 'src/components/shell/CommandPalette.tsx'), 'utf8');
    // …and the one that closes it there.
    expect(palette, 'لا مخرج من الصندوق على الهاتف').toMatch(/md:hidden[\s\S]{0,160}RiCloseLine/);
  });
});

/**
 * «+ أنشئ» — THE FORMS THE SERVER TOLD THE BOX ABOUT, AND NOTHING THE BOX KEPT FOR ITSELF (22/10).
 *
 * Seven forms already exist, each behind a button. The box draws the rows that arrive in `may.create`, goes to the screen the form
 * is on with the word in the address, and the screen opens the form. The list and the permissions are the server's
 * (`palette-create.ts`, asked in its own test) — here, that the box draws what it is given, finds it by the words it is given, takes
 * the person there, and invents nothing when it is given nothing.
 */
describe('«+ أنشئ»', () => {
  const CREATE_ROWS = [
    { key: 'order', label: 'إدخال طلب سريع', hint: 'الطلبات', icon: 'ShoppingCart', words: ['طلب', 'أنشئ', 'جديد'], href: '/orders?new=order' },
    { key: 'import-orders', label: 'استيراد طلبات', hint: 'الطلبات — من ملف', icon: 'FileSpreadsheet', words: ['استورد', 'ملف', 'أنشئ'], href: '/orders?new=import-orders' },
    { key: 'product', label: 'إضافة منتج', hint: 'المنتجات', icon: 'PackagePlus', words: ['منتج', 'صنف', 'أنشئ'], href: '/products?new=product' },
  ];

  function toldAbout(create?: unknown) {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).startsWith('/api/palette')
          ? { ...SUMMARY, may: { ...SUMMARY.may, ...(create === undefined ? {} : { create }) } }
          : { orders: [] },
    }));
  }

  async function opened(props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
    open(props);
    await act(async () => undefined);
    await act(async () => undefined);
  }

  const before = (a: string, b: string) =>
    !!(screen.getByText(a).compareDocumentPosition(screen.getByText(b)) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('leads the open box — the question people open it with — under its own heading, before the commands', async () => {
    toldAbout(CREATE_ROWS);
    await opened();
    expect(screen.queryByText('+ أنشئ'), 'ما في عنوان').toBeTruthy();
    for (const row of CREATE_ROWS) expect(screen.queryByText(row.label), row.label).toBeTruthy();
    expect(before('+ أنشئ', 'إضافة منتج')).toBe(true);
    expect(before('إضافة منتج', 'أفعال'), 'الأوامر قبل النماذج').toBe(true);
    expect(before('إضافة منتج', 'تسجيل الخروج')).toBe(true);
  });

  it('shows the screen each one is on, so two buttons with one verb are not confused', async () => {
    toldAbout(CREATE_ROWS);
    await opened();
    expect(screen.queryByText('الطلبات — من ملف')).toBeTruthy();
    expect(screen.queryByText('المنتجات')).toBeTruthy();
  });

  it('draws NOTHING when it was told nothing — no heading, no guess', async () => {
    toldAbout(); // an answer with no `create` at all (the shape before this existed)
    await opened();
    expect(screen.queryByText('+ أنشئ')).toBeNull();
    toldAbout([]);
    cleanup();
    await opened();
    expect(screen.queryByText('+ أنشئ'), 'عنوان لمجموعة فاضية').toBeNull();
    expect(screen.queryByText('تسجيل الخروج'), 'الأوامر اختفت معه').toBeTruthy();
  });

  it('and when the summary itself failed, there are no forms either', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await opened();
    expect(screen.queryByText('+ أنشئ')).toBeNull();
    expect(screen.queryByText('إضافة منتج')).toBeNull();
  });

  it('is found by its own name — a word that is in the NAME and in none of the words the server gave', async () => {
    toldAbout(CREATE_ROWS);
    await opened();
    await type('إضافة');
    expect(screen.queryByText('إضافة منتج')).toBeTruthy();
    expect(screen.queryByText('استيراد طلبات')).toBeNull();
  });

  it('…and by the other words the server gave it, which are not in its name', async () => {
    toldAbout(CREATE_ROWS);
    await opened();
    await type('ملف');
    expect(screen.queryByText('استيراد طلبات')).toBeTruthy();
    expect(screen.queryByText('إضافة منتج')).toBeNull();
  });

  it('…and the word «أنشئ» alone lists every form it was told about', async () => {
    toldAbout(CREATE_ROWS);
    await opened();
    await type('أنشئ');
    for (const row of CREATE_ROWS) expect(screen.queryByText(row.label), row.label).toBeTruthy();
  });

  it('comes after the screens a typed word matches, and before the commands', async () => {
    toldAbout([{ ...CREATE_ROWS[2], words: ['مرتجع'] }]);
    await opened();
    await type('مرتجع');
    expect(before('المرتجعات', 'إضافة منتج'), 'النماذج قبل الشاشات').toBe(true);
  });

  it('…and before the commands that match the same word', async () => {
    toldAbout([{ ...CREATE_ROWS[2], words: ['خروج'] }]);
    await opened();
    await type('خروج');
    expect(screen.queryByText('تسجيل الخروج'), 'الأمر ما ظهر').toBeTruthy();
    expect(before('إضافة منتج', 'تسجيل الخروج'), 'الأوامر قبل النماذج').toBe(true);
  });

  it('takes the person to the screen the form is on, with the word, and closes the box', async () => {
    toldAbout(CREATE_ROWS);
    const onClose = vi.fn();
    await opened({ onClose });
    await act(async () => {
      fireEvent.click(screen.getByText('إضافة منتج'));
    });
    expect(push).toHaveBeenCalledWith('/products?new=product');
    expect(onClose).toHaveBeenCalled();
  });

  it('and Enter does the same from the keyboard', async () => {
    toldAbout(CREATE_ROWS);
    await opened();
    const box = await type('استورد');
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(push).toHaveBeenCalledWith('/orders?new=import-orders');
  });

  it('and a row is a link, never a command: it carries an address and nothing to run', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/shell/CommandPalette.tsx'), 'utf8');
    const asCreate = src.slice(src.indexOf('const asCreate'), src.indexOf('if (!term) return [...creatable'));
    expect(asCreate).toContain("kind: 'create'");
    expect(asCreate).toContain('href: c.href');
    expect(asCreate, 'صفّ نموذجٍ ينفّذ شيئاً').not.toMatch(/run:/);
  });
});
