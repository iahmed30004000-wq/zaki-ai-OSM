// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «رتّب القائمة» ARRANGES THE MAIN CELLS TOO — THE GROUPS AND THE PHONE'S FOUR (13/11).
 *
 *   «زر رتّب القائمة لترتيب القوائم والخانات الرئيسية» (the owner, from the open drawer on his phone)
 *
 * The card the link opens had one level: the screens inside each group. It has two more now:
 *
 *   • EACH GROUP, by its heading — a grip and two arrows, one level above a line's;
 *   • THE PHONE'S FOUR — four rows, each a real select of the screens the other rows do not hold.
 *
 * What is held here is the screen as a person meets it, in jsdom: the real card, the real drag
 * library, the real pure functions — and only the network faked. The drag runs the way
 * `the-menu-can-be-dragged.test.tsx` runs it for lines, with the rectangles a browser would give
 * (jsdom has none), and says what that cannot prove: that a thumb on the name scrolls is a
 * `touch-action` fact only a touch screen can confirm, so what is held is where it is set.
 *
 * AND ARRANGING STILL OPENS NOTHING: every screen a slot can hold is one the person's menu already
 * draws as a line, and nothing here adds a route to anyone.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/profile' }));

import { MenuOrderCard } from '@/components/settings/MenuOrderCard';
import { mobileNav } from '@/lib/mobile-nav';
import { EMPTY_LAYOUT, reorderGroups, reorderSlots, reorderWithinGroup, type NavLayout } from '@/lib/nav-arrangement';
import { ALL_ROUTES, NAV, findRoute } from '@/lib/route-registry';
import { repoFile, stripComments } from '@/lib/guard-source';

// jsdom has no ResizeObserver, and the drag library measures its drop zones with one.
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ───────────────────────── the fake server ─────────────────────────

const ALL_PATHS = ALL_ROUTES.map((r) => r.path);
/** An agent at her desk: the screens she may open, in the groups that hold them. */
const AGENT_PATHS = [
  '/orders',
  '/confirmation/mine',
  '/confirmation/queue',
  '/ops/preparation',
  '/ops/tracking',
  '/finance/wallets',
  '/admin/profile',
];

interface Server {
  resolved: NavLayout;
  own: NavLayout | null;
  base: NavLayout | null;
  paths: string[];
  maySetRoleBase: boolean;
  /** What «رجّع الأساس» answers. */
  afterReset: { resolved: NavLayout; base: NavLayout | null };
  /** A role's base, by role id — what the owner's «الترتيب لـ» reads. */
  roleBase: Record<string, NavLayout>;
}
const fresh = (): Server => ({
  resolved: EMPTY_LAYOUT,
  own: null,
  base: null,
  paths: ALL_PATHS,
  maySetRoleBase: false,
  afterReset: { resolved: EMPTY_LAYOUT, base: null },
  roleBase: {},
});
let server = fresh();

function mountCard(over: Partial<Server> = {}) {
  server = { ...fresh(), ...over };
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/nav/arrangement' && method === 'GET') {
      return { resolved: server.resolved, own: server.own, base: server.base, paths: server.paths, maySetRoleBase: server.maySetRoleBase };
    }
    if (url === '/api/nav/arrangement' && method === 'DELETE') return { reset: true, ...server.afterReset };
    if (url.startsWith('/api/nav/arrangement?roleId=') && method === 'POST') {
      const id = url.split('=')[1];
      return { role: id, layout: server.roleBase[id] ?? EMPTY_LAYOUT };
    }
    if (url === '/api/roles') return { roles: [{ id: 'role-mod', name: 'MODERATOR' }] };
    return {};
  });
  return render(<MenuOrderCard />);
}

const puts = () => apiJson.mock.calls.filter((c) => c[1]?.method === 'PUT');
const lastPut = () => {
  const call = puts()[puts().length - 1];
  return { url: call[0] as string, body: JSON.parse(call[1].body) as NavLayout };
};
const save = async () => {
  await act(async () => {
    fireEvent.click(screen.getByText('احفظ'));
  });
  return lastPut();
};

// ───────────────────────── what is on the screen ─────────────────────────

const groupOrder = () => Array.from(document.querySelectorAll('[data-menu-group]')).map((e) => e.getAttribute('data-menu-group')!);
const linesOf = (key: string) =>
  Array.from(document.querySelector(`[data-menu-group="${key}"]`)!.querySelectorAll('li')).map((li) => li.querySelector('span')?.firstChild?.textContent);
const slotSelects = () => Array.from(document.querySelectorAll<HTMLSelectElement>('select[aria-label^="الخانة "]'));
const slotValues = () => slotSelects().map((s) => s.value);
const optionsOf = (select: HTMLSelectElement) => Array.from(select.querySelectorAll('option')).map((o) => o.value);
const labelOfGroup = (key: string) => NAV.find((g) => g.key === key)!.label;
const ORDINAL = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة'];
const slot = (i: number) => screen.getByLabelText(`الخانة ${ORDINAL[i]}`) as HTMLSelectElement;
const click = async (label: string) => {
  await act(async () => {
    fireEvent.click(screen.getByLabelText(label));
  });
};
const choose = async (i: number, path: string) => {
  await act(async () => {
    fireEvent.change(slot(i), { target: { value: path } });
  });
};
const REGISTRY_KEYS = NAV.map((g) => g.key);
/** The four the bar would draw for these screens with nothing chosen — `mobileNav` itself, which is the spec of «the system's four». */
const systemFour = (paths: string[]) =>
  mobileNav(
    NAV.map((g) => ({ ...g, routes: g.routes.filter((r) => paths.includes(r.path) && !r.offMenu && !(r.foldedUnder && paths.includes(r.foldedUnder))) })).filter(
      (g) => g.routes.length > 0
    ),
    null
  ).primary.map((r) => r.path);

// ───────────────────────── the parts, as a person meets them ─────────────────────────

describe('the card keeps what it had, and says what each part arranges', () => {
  it('— every group has a heading with its name, a grip and two arrows; every screen still has its own five', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    expect(groupOrder()).toEqual(REGISTRY_KEYS);
    for (const g of NAV) {
      const block = within(document.querySelector(`[data-menu-group="${g.key}"]`) as HTMLElement);
      expect(block.getByRole('heading', { level: 3, name: g.label }), g.key).toBeTruthy();
      expect(block.getByLabelText(`اسحب مجموعة ${g.label} لتغيير ترتيبها`), `مقبض ${g.key}`).toBeTruthy();
      expect(block.getByLabelText(`ارفع مجموعة ${g.label}`)).toBeTruthy();
      expect(block.getByLabelText(`انزل مجموعة ${g.label}`)).toBeTruthy();
      expect(block.getAllByRole('listitem'), g.key).toHaveLength(g.routes.length);
      for (const r of g.routes) {
        for (const verb of ['اسحب', 'ارفع', 'انزل', 'ثبّت', 'اخفِ']) {
          const label = verb === 'اسحب' ? `اسحب ${r.label} لتغيير ترتيبه` : `${verb} ${r.label}`;
          expect(block.getByLabelText(label), label).toBeTruthy();
        }
      }
    }
    // the rows are still exactly the screens — nothing in the new parts is a list item
    expect(screen.getAllByRole('listitem')).toHaveLength(ALL_ROUTES.length);
  });

  it('and the line under the heading names what each part arranges, in plain words', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    const text = document.getElementById('menu-order')!.textContent!;
    expect(text).toContain('رتّب أربع شاشات الهاتف، والمجموعات الكبيرة، والشاشات جوّا كل مجموعة');
    // …and what was said before is still said
    expect(text).toContain('اسحب من المقبض، أو استعمل السهمين');
    expect(text).toContain('الإخفاء لا يفتح ولا يغلق أي صلاحية');
  });

  it('and the phone’s four come FIRST — four rows are not buried under a long page of groups', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    const slots = screen.getByText('خانات الهاتف الأربعة — اللي بتظهر تحت الشاشة');
    const firstGroup = document.querySelector('[data-menu-group]')!;
    // `DOCUMENT_POSITION_FOLLOWING`: the group comes after the slots heading.
    expect(slots.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('and a response from before the two fields existed still draws — they are optional on the wire as in the store', async () => {
    mountCard({ resolved: { order: [], hidden: [], pinned: [] } });
    await screen.findAllByRole('listitem');
    expect(groupOrder()).toEqual(REGISTRY_KEYS);
    expect(slotValues()).toHaveLength(4);
  });
});

describe('the groups — by the arrows', () => {
  it('— «انزل» moves a group one place down, and «ارفع» brings it back', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    await click(`انزل مجموعة ${labelOfGroup('main')}`);
    expect(groupOrder()).toEqual(reorderGroups(REGISTRY_KEYS, 0, 1));
    await click(`ارفع مجموعة ${labelOfGroup('main')}`);
    expect(groupOrder()).toEqual(REGISTRY_KEYS);
  });

  it('and the first cannot go up and the last cannot go down — hubs and ordinary groups alike', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    const first = REGISTRY_KEYS[0];
    const last = REGISTRY_KEYS[REGISTRY_KEYS.length - 1];
    expect((screen.getByLabelText(`ارفع مجموعة ${labelOfGroup(first)}`) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(`انزل مجموعة ${labelOfGroup(last)}`) as HTMLButtonElement).disabled).toBe(true);
    for (const key of REGISTRY_KEYS.slice(1)) expect((screen.getByLabelText(`ارفع مجموعة ${labelOfGroup(key)}`) as HTMLButtonElement).disabled, key).toBe(false);
    // a hub of tabs, a hub of cards and a loose group each move
    for (const key of ['ops', 'settings', 'storefront']) {
      const before = groupOrder();
      const at = before.indexOf(key);
      await click(`انزل مجموعة ${labelOfGroup(key)}`);
      expect(groupOrder(), key).toEqual(reorderGroups(before, at, at + 1));
    }
  });

  it('and moving a group takes its screens with it, untouched — it never reshuffles a line', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    const before = Object.fromEntries(REGISTRY_KEYS.map((k) => [k, linesOf(k)]));
    await click(`انزل مجموعة ${labelOfGroup('ops')}`);
    await click(`ارفع مجموعة ${labelOfGroup('admin')}`);
    for (const k of REGISTRY_KEYS) expect(linesOf(k), k).toEqual(before[k]);
  });

  it('and a save sends the new group order, and the flat order of the screens follows it', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    await click(`انزل مجموعة ${labelOfGroup('main')}`);
    const { url, body } = await save();
    expect(url).toBe('/api/nav/arrangement');
    expect(body.groups).toEqual(reorderGroups(REGISTRY_KEYS, 0, 1));
    const expectedFlat = body.groups!.flatMap((k) => NAV.find((g) => g.key === k)!.routes.map((r) => r.path));
    expect(body.order).toEqual(expectedFlat);
  });

  it('and a group that nobody has moved is saved as «no opinion» — the key is there, and empty', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    const { body } = await save();
    expect(body.groups).toEqual([]);
    expect(body.slots).toEqual([]);
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['order', 'hidden', 'pinned', 'groups', 'slots']));
  });

  it('and a person who arranged the groups before sees them in that order — and saving without touching them sends them back', async () => {
    const mine = ['admin', 'ops', ...REGISTRY_KEYS.filter((k) => k !== 'admin' && k !== 'ops')];
    mountCard({ resolved: { ...EMPTY_LAYOUT, groups: mine }, own: { ...EMPTY_LAYOUT, groups: mine } });
    await screen.findAllByRole('listitem');
    expect(groupOrder()).toEqual(mine);
    expect((await save()).body.groups).toEqual(mine);
  });

  it('and a group that was added after somebody saved appears last, not lost', async () => {
    const saved = ['ops', 'main'];
    mountCard({ resolved: { ...EMPTY_LAYOUT, groups: saved }, own: { ...EMPTY_LAYOUT, groups: saved } });
    await screen.findAllByRole('listitem');
    expect(groupOrder().slice(0, 2)).toEqual(saved);
    expect(groupOrder().slice(2)).toEqual(REGISTRY_KEYS.filter((k) => !saved.includes(k)));
  });

  it('and a person who may open only some groups arranges only those', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    expect(groupOrder()).toEqual(['main', 'confirmation', 'ops', 'finance', 'admin']);
    await click(`انزل مجموعة ${labelOfGroup('main')}`);
    expect((await save()).body.groups).toEqual(['confirmation', 'main', 'ops', 'finance', 'admin']);
  });
});

describe('the groups — by the hand', () => {
  /*
   * jsdom has no layout: every rectangle is zero, so a drop zone has nowhere to be dropped on. The groups are given the
   * rectangles a browser would give them — a hundred pixels tall, stacked in their list, shifted by the `translate3d` the
   * sortable strategy puts on one — and a line is forty, as in `the-menu-can-be-dragged`. Everything else is the real
   * library and the real card. What this proves is the WIRING: that a pointer or a key on the GROUP's grip ends in the same
   * function the arrows ask, that a press anywhere else starts nothing, and that Esc ends in nothing.
   */
  const GROUP = 100;
  const ROW = 40;
  let restoreLayout: () => void;

  const announced = () =>
    Array.from(document.querySelectorAll('[role="status"]'))
      .map((e) => e.textContent ?? '')
      .join(' ');
  // The live region keeps only the LAST sentence; a drag that started and finished between two looks leaves nothing in it.
  let heard: string[] = [];
  let watcher: MutationObserver;

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
      const shifted = /translate3d\(\s*[-\d.]+(?:px)?\s*,\s*([-\d.]+)px/.exec((this as HTMLElement).style.transform)?.[1];
      const dy = shifted ? Number(shifted) : 0;
      if (this.hasAttribute('data-menu-group') && this.parentElement) {
        return rect(Array.from(this.parentElement.children).indexOf(this) * GROUP + dy, GROUP);
      }
      if (Array.from(this.children).some((c) => c.hasAttribute('data-menu-group'))) return rect(0, this.children.length * GROUP);
      if (this.tagName === 'LI' && this.parentElement) return rect(Array.from(this.parentElement.children).indexOf(this) * ROW + dy, ROW);
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

  const until = (check: () => void) => waitFor(check, { timeout: 3000 });
  const settle = (ms = 80) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  const everHeard = () => heard.join(' ');
  const ev = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };

  /** Mounts, waits until the library has drawn its hidden instructions for EVERY context, and hands back a group's grip. */
  async function grip(key: string, over: Partial<Server> = {}) {
    mountCard(over);
    await screen.findAllByRole('listitem');
    await until(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]')).toHaveLength(groupOrder().length + 1));
    return screen.getByLabelText(`اسحب مجموعة ${labelOfGroup(key)} لتغيير ترتيبها`);
  }

  it('— a pointer drag from a group’s grip puts the group where it was dropped, and says so in Arabic', async () => {
    const handle = await grip('main');
    const [a, , c] = REGISTRY_KEYS.map(labelOfGroup);
    await act(async () => {
      fireEvent.pointerDown(handle, { ...ev, clientX: 20, clientY: 20 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 32 }); // past the 6px, so it is a drag
    });
    await until(() => expect(announced(), 'ما انقال إنها انمسكت').toContain(`أمسكتَ مجموعة «${a}»`));
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 232 }); // 212px down: the third group
    });
    await until(() => expect(announced()).toContain(`مجموعة «${a}» فوق مجموعة «${c}»`));
    await act(async () => {
      fireEvent.pointerUp(document, { ...ev, clientX: 20, clientY: 232 });
    });
    await until(() => expect(groupOrder(), 'المجموعة ما وصلت مكان الإفلات').toEqual(reorderGroups(REGISTRY_KEYS, 0, 2)));
    await until(() => expect(announced()).toContain(`أُفلتت مجموعة «${a}» مكان مجموعة «${c}»`));
  });

  it('and the keyboard does the same: Space to pick up, ↓ to move, Space to put down — the same order the arrow gives', async () => {
    const handle = await grip('main');
    const [a, b] = REGISTRY_KEYS.map(labelOfGroup);
    await act(async () => {
      fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ مجموعة «${a}»`));
    await settle(); // the sensor starts listening for the next key on the next turn
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await until(() => expect(announced()).toContain(`مجموعة «${a}» فوق مجموعة «${b}»`));
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    });
    const byKeyboard = reorderGroups(REGISTRY_KEYS, 0, 1);
    await until(() => expect(groupOrder(), 'الكيبورد ما حرّك المجموعة').toEqual(byKeyboard));
    // …which is exactly what the arrow would have done.
    cleanup();
    mountCard();
    await screen.findAllByRole('listitem');
    await click(`انزل مجموعة ${a}`);
    expect(groupOrder()).toEqual(byKeyboard);
  });

  it('and Esc puts it back, and says it was cancelled', async () => {
    const handle = await grip('main');
    const a = labelOfGroup('main');
    await act(async () => {
      fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ مجموعة «${a}»`));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await until(() => expect(announced()).toContain('فوق مجموعة'));
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
    });
    await until(() => expect(announced()).toContain(`أُلغي تحريك مجموعة «${a}»`));
    await settle();
    expect(groupOrder(), 'Esc ما رجّعها').toEqual(REGISTRY_KEYS);
  });

  it('and a tap on the grip that does not travel moves nothing — and does not even start a drag', async () => {
    const handle = await grip('main');
    await act(async () => {
      fireEvent.pointerDown(handle, { ...ev, clientX: 20, clientY: 20 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 21, clientY: 23 }); // 3px: a shaky tap
    });
    await act(async () => {
      fireEvent.pointerUp(document, { ...ev, clientX: 21, clientY: 23 });
    });
    await settle();
    expect(groupOrder()).toEqual(REGISTRY_KEYS);
    expect(everHeard(), 'نقرة صغيرة بدأت جلسة سحب').not.toContain('أمسكتَ');
  });

  it('and pressing on the group’s NAME, not its grip, starts nothing — that is where a thumb scrolls', async () => {
    await grip('main');
    const name = screen.getByRole('heading', { level: 3, name: labelOfGroup('main') });
    await act(async () => {
      fireEvent.pointerDown(name, { ...ev, clientX: 20, clientY: 20 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 232 });
    });
    await settle();
    await act(async () => {
      fireEvent.pointerUp(document, { ...ev, clientX: 20, clientY: 232 });
    });
    await settle();
    expect(everHeard(), 'الضغط على الاسم بدأ سحباً').not.toContain('أمسكتَ');
    expect(groupOrder()).toEqual(REGISTRY_KEYS);
  });

  it('and a drag of a LINE moves the line inside its group and not a group — the two contexts do not meet', async () => {
    await grip('main');
    const [first, second] = NAV[0].routes;
    const before = linesOf('main');
    const handle = screen.getByLabelText(`اسحب ${first.label} لتغيير ترتيبه`);
    await act(async () => {
      fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ «${first.label}»`));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await until(() => expect(announced()).toContain(`«${first.label}» فوق «${second.label}»`));
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    });
    const paths = NAV[0].routes.map((r) => r.path);
    const moved = reorderWithinGroup(paths, paths, 0, 1);
    await until(() => expect(linesOf('main'), 'السطر ما تحرّك').toEqual(moved.map((p) => findRoute(p)!.label)));
    expect(linesOf('main')).not.toEqual(before);
    expect(groupOrder(), 'سحب سطر حرّك مجموعة').toEqual(REGISTRY_KEYS);
    // and the sentence a screen reader heard was about a screen, not about a group
    expect(everHeard()).not.toContain('مجموعة «');
  });

  it('and ONLY the grips refuse the browser’s scroll gesture — a line’s and a group’s — never a heading, a row or a list', async () => {
    await grip('main');
    const noScroll = Array.from(document.querySelectorAll<HTMLElement>('[style*="touch-action"]'));
    expect(noScroll).toHaveLength(ALL_ROUTES.length + NAV.length);
    const groupGrips = noScroll.filter((el) => /^اسحب مجموعة /.test(el.getAttribute('aria-label') ?? ''));
    expect(groupGrips, 'مقبض لكل مجموعة').toHaveLength(NAV.length);
    for (const el of noScroll) expect(el.tagName, 'غير زر بيمنع التمرير').toBe('BUTTON');
    for (const el of [...Array.from(document.querySelectorAll('[data-menu-group]')), ...Array.from(document.querySelectorAll('h3, ul, li'))]) {
      expect((el as HTMLElement).style.touchAction, 'عنوان أو صف أو قائمة بتمنع التمرير').not.toBe('none');
    }
  });

  it('and the grip speaks Arabic to a screen reader — its role, its instructions, no «sortable»', async () => {
    const handle = await grip('ops');
    expect(handle.getAttribute('aria-roledescription')).toBe('مقبض ترتيب');
    const helpId = handle.getAttribute('aria-describedby') ?? '';
    expect(helpId, 'المقبض ما إله وصف').not.toBe('');
    await waitFor(() => expect(document.getElementById(helpId)?.textContent ?? '').toContain('لتغيير ترتيب هذه المجموعة'));
    expect(document.getElementById(helpId)!.textContent).toContain('اضغط مسافة لتمسكها');
  });
});

// ───────────────────────── the phone's four ─────────────────────────

describe('the phone’s four — what the rows show', () => {
  it('— four rows, each a real select; with nothing chosen they show the SYSTEM’s four, and say so', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    expect(slotSelects()).toHaveLength(4);
    for (const s of slotSelects()) expect(s.tagName).toBe('SELECT');
    // The ranking puts the desk, the queue, the preparation and the tracking first — written out, so this is not `mobileNav` agreeing with itself.
    expect(slotValues()).toEqual(['/confirmation/mine', '/confirmation/queue', '/ops/preparation', '/ops/tracking']);
    expect(slotValues()).toEqual(systemFour(AGENT_PATHS));
    expect(screen.getByText(/^ترتيب النظام:/)).toBeTruthy();
    // the rows are named, in order, and numbered
    expect(slotSelects().map((s) => s.getAttribute('aria-label'))).toEqual(['الخانة الأولى', 'الخانة الثانية', 'الخانة الثالثة', 'الخانة الرابعة']);
  });

  it('and the section is named as the owner named it, and says which side the first is on', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    expect(screen.getByRole('heading', { level: 3, name: 'خانات الهاتف الأربعة — اللي بتظهر تحت الشاشة' })).toBeTruthy();
    expect(screen.getByText(/الأولى على اليمين/)).toBeTruthy();
  });

  it('and the page you are on takes the last slot — said once, under the rows', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    expect(screen.getByText('لما تفتح شاشة مش من الأربعة، بتاخد الخانة الأخيرة وإنت فيها.')).toBeTruthy();
  });

  it('and every select offers the screens the OTHER rows do not hold — so a screen cannot sit in two slots', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    const values = slotValues();
    const menu = AGENT_PATHS;
    slotSelects().forEach((s, i) => {
      const offered = optionsOf(s);
      for (const other of values.filter((_, j) => j !== i)) expect(offered, `الخانة ${i + 1} بتعرض ${other} وهي بخانة ثانية`).not.toContain(other);
      expect(offered).toContain(values[i]);
      expect(new Set(offered).size, 'خيار مكرّر').toBe(offered.length);
      // …and every screen nobody holds is offered, so nothing the person could want is missing
      expect([...offered].sort()).toEqual(menu.filter((p) => p === values[i] || !values.includes(p)).sort());
    });
  });

  it('and the choices are grouped as the drawer groups them, under their names', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    const groups = Array.from(slotSelects()[0].querySelectorAll('optgroup')).map((g) => g.getAttribute('label'));
    // «الشحن» holds the preparation and the tracking: both are taken by the rows, but the first row still offers its own
    expect(groups).toEqual(expect.arrayContaining(['مركز التأكيد']));
    expect(groups.every((g) => !!g && !/[A-Za-z]/.test(g))).toBe(true);
    expect(new Set(groups).size, 'عنوان مكرّر').toBe(groups.length);
  });

  it('and only a screen the DRAWER draws can take a slot — never the assistant’s page, and never the board folded under the dashboard', async () => {
    mountCard(); // every screen openable, the dashboard and the assistant among them
    await screen.findAllByRole('listitem');
    const everything = new Set(slotSelects().flatMap(optionsOf));
    expect(everything.has('/assistant'), 'المساعد مش سطر بالقائمة').toBe(false);
    expect(everything.has('/growth/performance'), 'اللوحة مطويّة تحت لوحة التحكم').toBe(false);
    expect(everything.has('/dashboard')).toBe(true);
    expect(everything.has('/orders')).toBe(true);
    // …all the others: the registry less exactly those two, as the four rows can reach them between them
    const menu = ALL_PATHS.filter((p) => p !== '/assistant' && p !== '/growth/performance');
    expect([...everything].sort()).toEqual([...menu].sort());
  });

  it('and the board IS offered to somebody who cannot open the dashboard — it is a line of THEIR drawer', async () => {
    mountCard({ paths: ['/growth/performance', '/orders', '/admin/profile', '/customers', '/products'] });
    await screen.findAllByRole('listitem');
    expect(new Set(slotSelects().flatMap(optionsOf)).has('/growth/performance')).toBe(true);
  });

  it('and fewer reachable screens than slots: as many rows as there are screens, each with only its own', async () => {
    mountCard({ paths: ['/orders', '/admin/profile'] });
    await screen.findAllByRole('listitem');
    expect(slotSelects()).toHaveLength(2);
    expect(slotValues().sort()).toEqual(['/admin/profile', '/orders']);
    for (const s of slotSelects()) expect(optionsOf(s)).toHaveLength(1);
    expect((screen.getByLabelText('انزل الخانة الثانية') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('ارفع الخانة الأولى') as HTMLButtonElement).disabled).toBe(true);
  });

  it('and ONE reachable screen is still a bar of one — the section is drawn, with nowhere for its arrows to go', async () => {
    mountCard({ paths: ['/admin/profile'] });
    await screen.findAllByRole('listitem');
    expect(slotSelects()).toHaveLength(1);
    expect(slotValues()).toEqual(['/admin/profile']);
    expect((screen.getByLabelText('ارفع الخانة الأولى') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('انزل الخانة الأولى') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('heading', { level: 3, name: 'خانات الهاتف الأربعة — اللي بتظهر تحت الشاشة' })).toBeTruthy();
  });

  it('and with no screen the drawer draws there is nothing to arrange — the section is not drawn at all', async () => {
    mountCard({ paths: ['/assistant'] });
    await screen.findAllByRole('listitem');
    expect(slotSelects()).toHaveLength(0);
    expect(screen.queryByText('خانات الهاتف الأربعة — اللي بتظهر تحت الشاشة')).toBeNull();
  });
});

describe('the phone’s four — choosing, ordering, saving', () => {
  it('— picking a screen for a row changes that row, and a save sends the four exactly as the rows show them', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    await choose(3, '/orders');
    expect(slotValues()).toEqual(['/confirmation/mine', '/confirmation/queue', '/ops/preparation', '/orders']);
    const { url, body } = await save();
    expect(url).toBe('/api/nav/arrangement');
    expect(body.slots).toEqual(['/confirmation/mine', '/confirmation/queue', '/ops/preparation', '/orders']);
    expect(body.groups).toEqual([]);
  });

  it('and the note stops saying «ترتيب النظام» the moment the person changes one — and says whose it is', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    expect(screen.getByText(/^ترتيب النظام:/)).toBeTruthy();
    await choose(0, '/orders');
    expect(screen.queryByText(/^ترتيب النظام:/)).toBeNull();
    expect(screen.getByText(/^اختيارك أنت\./)).toBeTruthy();
  });

  it('and a screen that left a row is offered again to the others — nothing is used up', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    await choose(0, '/orders'); // the desk leaves the first row
    expect(optionsOf(slot(1))).toContain('/confirmation/mine');
    expect(optionsOf(slot(1))).not.toContain('/orders');
  });

  it('and the arrows swap two rows — and a swap that changes nothing at the edges is not even possible', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    const before = slotValues();
    await click('انزل الخانة الأولى');
    expect(slotValues()).toEqual(reorderSlots(before, 0, 1));
    await click('ارفع الخانة الرابعة');
    expect(slotValues()).toEqual(reorderSlots(reorderSlots(before, 0, 1), 3, 2));
    expect((screen.getByLabelText('ارفع الخانة الأولى') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('انزل الخانة الرابعة') as HTMLButtonElement).disabled).toBe(true);
    const { body } = await save();
    expect(body.slots).toEqual(slotValues());
  });

  it('and nothing is saved until the person changes one — a ranking improved next month still reaches whoever never chose', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    // pressing the arrows at the edge, or choosing what a row already holds, is not a choice
    fireEvent.change(slot(0), { target: { value: slot(0).value } });
    expect((await save()).body.slots).toEqual([]);
  });

  it('and a screen the person HIDES leaves the rows at once — it is out of the drawer, so out of the bar', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    expect(slotValues()).toContain('/ops/tracking');
    await click(`اخفِ ${findRoute('/ops/tracking')!.label}`);
    expect(slotValues()).not.toContain('/ops/tracking');
    expect(slotValues()).toHaveLength(4);
    expect(slotSelects().flatMap(optionsOf)).not.toContain('/ops/tracking');
    // …and un-hiding brings it back to the offer
    await click(`أظهر ${findRoute('/ops/tracking')!.label}`);
    expect(slotSelects().flatMap(optionsOf)).toContain('/ops/tracking');
  });

  it('and hiding does not erase a choice: the four the person saved come back when the screen does', async () => {
    const chosen = ['/ops/tracking', '/orders', '/confirmation/mine', '/ops/preparation'];
    mountCard({ paths: AGENT_PATHS, resolved: { ...EMPTY_LAYOUT, slots: chosen }, own: { ...EMPTY_LAYOUT, slots: chosen } });
    await screen.findAllByRole('listitem');
    expect(slotValues()).toEqual(chosen);
    await click(`اخفِ ${findRoute('/ops/tracking')!.label}`);
    expect(slotValues()).not.toContain('/ops/tracking');
    await click(`أظهر ${findRoute('/ops/tracking')!.label}`);
    expect(slotValues()).toEqual(chosen);
  });

  it('and a saved screen the person can no longer open is not shown — the row holds the next best, and the four are still four', async () => {
    const chosen = ['/finance/matching', '/orders', '/confirmation/mine', '/gone'];
    mountCard({ paths: AGENT_PATHS, resolved: { ...EMPTY_LAYOUT, slots: chosen }, own: { ...EMPTY_LAYOUT, slots: chosen } });
    await screen.findAllByRole('listitem');
    expect(slotValues()).toEqual(['/orders', '/confirmation/mine', '/confirmation/queue', '/ops/preparation']);
  });
});

describe('the owner’s base for the phone’s four and the groups reaches whoever has no choice of their own', () => {
  const BASE: NavLayout = { ...EMPTY_LAYOUT, groups: ['ops', 'main'], slots: ['/orders', '/ops/tracking'] };

  it('— they see the owner’s four, filled out by the ranking, and the note says whose they are', async () => {
    mountCard({ paths: AGENT_PATHS, resolved: BASE, base: BASE, own: null });
    await screen.findAllByRole('listitem');
    expect(slotValues()).toEqual(['/orders', '/ops/tracking', '/confirmation/mine', '/confirmation/queue']);
    expect(screen.getByText(/^ترتيب المالك لدورك\./)).toBeTruthy();
    expect(screen.queryByText(/^ترتيب النظام:/)).toBeNull();
    expect(groupOrder().slice(0, 2)).toEqual(['ops', 'main']);
  });

  it('and saving for some OTHER reason does not copy the owner’s choice into their own row — they stay attached to it', async () => {
    mountCard({ paths: AGENT_PATHS, resolved: BASE, base: BASE, own: null });
    await screen.findAllByRole('listitem');
    await click(`ثبّت ${findRoute('/orders')!.label}`);
    const { body } = await save();
    expect(body.slots, 'الأساس انتسخ لصفّها').toEqual([]);
    expect(body.groups, 'الأساس انتسخ لصفّها').toEqual([]);
    expect(body.pinned).toContain('/orders');
  });

  it('and the moment they change one, THAT part is theirs — the other stays the owner’s', async () => {
    mountCard({ paths: AGENT_PATHS, resolved: BASE, base: BASE, own: null });
    await screen.findAllByRole('listitem');
    await choose(2, '/ops/preparation');
    expect(screen.getByText(/^اختيارك أنت\./)).toBeTruthy();
    const { body } = await save();
    expect(body.slots).toEqual(['/orders', '/ops/tracking', '/ops/preparation', '/confirmation/queue']);
    expect(body.groups, 'المجموعات انتسخت وما غيّرتها').toEqual([]);
  });

  it('and a person who moved the groups owns the groups, and still shares the owner’s four', async () => {
    mountCard({ paths: AGENT_PATHS, resolved: BASE, base: BASE, own: null });
    await screen.findAllByRole('listitem');
    await click(`انزل مجموعة ${labelOfGroup('ops')}`);
    const { body } = await save();
    expect(body.groups).toEqual(['main', 'ops', 'confirmation', 'finance', 'admin']);
    expect(body.slots).toEqual([]);
  });

  it('and their OWN choice, already saved, is theirs and is sent back whole', async () => {
    const own: NavLayout = { ...EMPTY_LAYOUT, groups: ['admin', 'main'], slots: ['/orders', '/finance/wallets'] };
    mountCard({ paths: AGENT_PATHS, resolved: own, base: BASE, own });
    await screen.findAllByRole('listitem');
    expect(screen.getByText(/^اختيارك أنت\./)).toBeTruthy();
    const { body } = await save();
    expect(body.groups).toEqual(['admin', 'main']);
    expect(body.slots).toEqual(['/orders', '/finance/wallets']);
  });
});

describe('«رجّع الأساس» brings the groups and the four back too', () => {
  const OWN: NavLayout = { ...EMPTY_LAYOUT, groups: ['admin', 'ops'], slots: ['/orders', '/ops/tracking', '/finance/wallets', '/confirmation/mine'] };

  it('— it is offered only when there is something of their own, and one press sends the delete', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    expect(screen.queryByText('رجّع الأساس')).toBeNull();
    cleanup();

    mountCard({ paths: AGENT_PATHS, resolved: OWN, own: OWN });
    await screen.findAllByRole('listitem');
    expect(groupOrder().slice(0, 2)).toEqual(['admin', 'ops']);
    expect(slotValues()).toEqual(OWN.slots);
    await act(async () => {
      fireEvent.click(screen.getByText('رجّع الأساس'));
    });
    const deletes = apiJson.mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toBe('/api/nav/arrangement');
  });

  it('and afterwards the screen is the system’s again — registry order for the groups, the ranking for the four, «ترتيب النظام» under them', async () => {
    mountCard({ paths: AGENT_PATHS, resolved: OWN, own: OWN });
    await screen.findAllByRole('listitem');
    await act(async () => {
      fireEvent.click(screen.getByText('رجّع الأساس'));
    });
    await waitFor(() => expect(screen.getByText(/^ترتيب النظام:/)).toBeTruthy());
    expect(groupOrder()).toEqual(['main', 'confirmation', 'ops', 'finance', 'admin']);
    expect(slotValues()).toEqual(systemFour(AGENT_PATHS));
    expect(screen.queryByText('رجّع الأساس'), 'الزر ظل بعد الإرجاع').toBeNull();
  });

  it('and when the owner has a base, it is THAT that comes back — and the note says so', async () => {
    const base: NavLayout = { ...EMPTY_LAYOUT, groups: ['finance'], slots: ['/finance/wallets', '/orders'] };
    mountCard({ paths: AGENT_PATHS, resolved: OWN, own: OWN, base, afterReset: { resolved: base, base } });
    await screen.findAllByRole('listitem');
    await act(async () => {
      fireEvent.click(screen.getByText('رجّع الأساس'));
    });
    await waitFor(() => expect(screen.getByText(/^ترتيب المالك لدورك\./)).toBeTruthy());
    expect(groupOrder()[0]).toBe('finance');
    expect(slotValues().slice(0, 2)).toEqual(['/finance/wallets', '/orders']);
  });
});

describe('the owner, setting a role’s base — the same two parts, for everybody in the role', () => {
  const ROLE_BASE: NavLayout = { ...EMPTY_LAYOUT, groups: ['ops', 'main'], slots: ['/ops/tracking', '/orders'] };

  async function pickRole() {
    mountCard({ paths: AGENT_PATHS, maySetRoleBase: true, roleBase: { 'role-mod': ROLE_BASE } });
    await screen.findAllByRole('listitem');
    const picker = await screen.findByDisplayValue('قائمتي أنا');
    await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1));
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'role-mod' } });
    });
    await waitFor(() => expect(groupOrder().slice(0, 2)).toEqual(['ops', 'main']));
  }

  it('— choosing a role loads ITS groups and four into the rows, and the note says it is the role’s', async () => {
    await pickRole();
    expect(slotValues().slice(0, 2)).toEqual(['/ops/tracking', '/orders']);
    expect(screen.getByText(/^هاي خانات أساس الدور/)).toBeTruthy();
  });

  it('and saving writes to the ROLE, with both lists — not to the owner’s own row', async () => {
    await pickRole();
    await click(`انزل مجموعة ${labelOfGroup('ops')}`);
    await choose(2, '/ops/preparation');
    const { url, body } = await save();
    expect(url).toBe('/api/nav/arrangement?roleId=role-mod');
    expect(body.groups).toEqual(['main', 'ops', 'confirmation', 'finance', 'admin']);
    expect(body.slots).toEqual(['/ops/tracking', '/orders', '/ops/preparation', '/confirmation/queue']);
  });

  it('and a role base with nothing chosen is saved as «no opinion», not as the system’s four frozen into it', async () => {
    mountCard({ paths: AGENT_PATHS, maySetRoleBase: true, roleBase: { 'role-mod': EMPTY_LAYOUT } });
    await screen.findAllByRole('listitem');
    const picker = await screen.findByDisplayValue('قائمتي أنا');
    await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1));
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'role-mod' } });
    });
    await waitFor(() => expect(screen.getByText(/^ترتيب النظام\. غيّر أي خانة/)).toBeTruthy());
    const { url, body } = await save();
    expect(url).toBe('/api/nav/arrangement?roleId=role-mod');
    expect(body.slots).toEqual([]);
    expect(body.groups).toEqual([]);
  });
});

// ───────────────────────── phone first, Arabic only, real controls ─────────────────────────

describe('built for a thumb, in Arabic, from real controls', () => {
  it('— every button the new parts add is a real button with the 44px minimum on a phone; every select is the product’s own', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    const mine = [
      ...Array.from(document.querySelectorAll<HTMLElement>('[data-menu-group] > div > div:first-child button')), // the group headings
      ...slotSelects().flatMap((s) => Array.from((s.parentElement!.parentElement as HTMLElement).querySelectorAll<HTMLElement>('button'))),
    ];
    expect(mine.length).toBeGreaterThanOrEqual(3 * 5 + 2 * 4);
    for (const b of mine) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('type'), b.getAttribute('aria-label') ?? '').toBe('button');
      expect(b.className, b.getAttribute('aria-label') ?? '').toContain('min-h-11');
      expect(b.className).toContain('md:min-h-0');
    }
    for (const s of slotSelects()) {
      expect(s.className).toContain('h-11');
      expect(s.className).toContain('md:h-10');
    }
  });

  it('and nothing a person can see or hear is in English — headings, notes, names, titles, labels', async () => {
    // (A role’s own NAME is data the owner typed, in whatever language he typed it — what is held is what the card itself says.)
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    const container = document.getElementById('menu-order')!;
    /*
     * WHAT A PERSON SEES — NOT WHAT THE LIBRARY HIDES.
     *
     * The drag library draws its hidden instructions and its live region INLINE, inside each context, and only after its own
     * first effect (`mounted`). So whether they are in the container's text depends on how fast the machine was when this
     * read it — the first version of this test failed one run in four for that reason, naming «Esc» six times. They are held
     * separately below (they are read aloud, not seen); the text a person SEES is the card's own.
     */
    const seen = container.cloneNode(true) as HTMLElement;
    seen.querySelectorAll('[id^="DndDescribedBy"], [id^="DndLiveRegion"]').forEach((e) => e.remove());
    const text = seen.textContent!;
    expect(text, `كلمة إنجليزية بالنص الظاهر: ${(text.match(/[A-Za-z]+/g) ?? []).join(' ')}`).not.toMatch(/[A-Za-z]/);
    for (const el of Array.from(container.querySelectorAll('[aria-label], [title]'))) {
      for (const attr of ['aria-label', 'title', 'aria-roledescription']) {
        const v = el.getAttribute(attr);
        if (v) expect(v, `${attr}: ${v}`).not.toMatch(/[A-Za-z]/);
      }
    }
    // what the library reads aloud for the groups is Arabic too
    await waitFor(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]').length).toBeGreaterThan(0));
    const spoken = Array.from(document.querySelectorAll('[id^="DndDescribedBy"]')).map((e) => e.textContent ?? '');
    expect(spoken.some((t) => t.includes('لتغيير ترتيب هذه المجموعة'))).toBe(true);
    for (const t of spoken) expect(t.replace('Esc', ''), t).not.toMatch(/[A-Za-z]/);
  });

  it('and no new CSS: every class the card uses is one the product already ships', () => {
    /*
     * NO NEW CSS — the dashboard's first-load stylesheet is under a ratchet (`quality-gates.test.ts`, measured only on CI's build):
     * a class nobody else ships grows it. So the new parts are written from the classes the card and its siblings already wear, and
     * this holds the whole card to that — the same scan the tracking dialogs are held to. The scan reads `className="…"` literals,
     * which is the only way this card writes a class.
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
    const own = join(root, 'components/settings/MenuOrderCard.tsx');
    const used = new Set(classesOf(readFileSync(own, 'utf8')));
    expect(used.size, 'the card has classes').toBeGreaterThan(40);
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
    // …and the card writes every class as a plain string, so the scan above cannot be walked around by a template or a helper
    const src = stripComments(repoFile('src/components/settings/MenuOrderCard.tsx'));
    expect(src, 'a class built at run time escapes the scan').not.toMatch(/className=\{[^}]*(`|clsx|cn\()/);
  });
});

// ───────────────────────── how it is wired ─────────────────────────

describe('and the wiring is the one that holds the rules', () => {
  const src = () => stripComments(repoFile('src/components/settings/MenuOrderCard.tsx'));

  it('— the arrows and the drag of a GROUP both go through reorderGroups, the arrows and the pick of a SLOT through the pure slot functions', () => {
    const s = src();
    expect(s).toContain('reorderGroups(groupKeys, at, at + by)');
    expect(s).toContain('groupsAfterDrag(groupKeys, end)');
    expect(s).toContain('onDragEnd={droppedGroup}');
    expect(s).toContain('chooseSlot(shownSlots, i, e.target.value)');
    expect(s).toContain('reorderSlots(shownSlots, i, i - 1)');
    expect(s).toContain('reorderSlots(shownSlots, i, i + 1)');
    // no second copy of a splice for either
    expect(s).not.toMatch(/\.splice\(/);
  });

  it('and the rows are what the bar itself would draw: the same function, over the groups the shell would hand it', () => {
    const s = src();
    expect(s).toContain('mobileNav(barGroups, null, layout.slots)');
    expect(s).toContain('isMenuLine(r, openable)');
    expect(s).toContain('applyArrangement(');
  });

  it('and BOTH drag contexts lock the vertical axis and keep the item inside its list — the groups’ as well as the lines’', () => {
    const s = src();
    expect(s.match(/modifiers=\{\[restrictToVerticalAxis, restrictToParentElement\]\}/g), 'سياق بلا قفل عمودي').toHaveLength(2);
    expect(s.match(/<DndContext\b/g)).toHaveLength(2);
    // …and both use the one set of sensors, so a press means the same thing at both levels
    expect(s.match(/sensors=\{sensors\}/g)).toHaveLength(2);
  });

  it('and a save always carries both keys — empty is «no opinion», absent would be «an older tab»', () => {
    const s = src();
    expect(s).toContain('groups: inherited.groups ? [] : (layout.groups ?? [])');
    expect(s).toContain('slots: inherited.slots ? [] : (layout.slots ?? [])');
  });

  it('and each group is ONE sortable block, tagged with the group it is — the hook that finds it by what it is, not by where it sits', () => {
    const s = src();
    expect(s.match(/<SortableGroup\b/g)).toHaveLength(1);
    expect(s).toMatch(/<div\s+ref=\{setNodeRef\}\s+data-menu-group=\{group\.key\}/);
  });
});
