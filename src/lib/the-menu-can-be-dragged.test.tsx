// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within as inRow } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE MENU YOU ARRANGE CAN BE DRAGGED — AND THE BUTTONS ARE STILL THERE.
 *
 * The owner asked for «سحب وإفلات». It had been deferred (RV46) for two
 * reasons that were true: a drag needs pointer, touch and keyboard paths to
 * be equal, and on a phone a drag inside a scrolling column fights the
 * scroll. So the claims here are mostly about what drag must NOT take away:
 *
 *   • the up/down buttons — the path a thumb, a keyboard and a screen reader
 *     reach on the first day;
 *   • the scroll — only the grip refuses the browser's own gesture;
 *   • the rule that a screen stays in its group, and that one group's move
 *     never reshuffles another's.
 *
 * And that the grip and the buttons go through ONE function, which is the only
 * way they cannot disagree about what a move means.
 *
 * What jsdom cannot prove is said at the head of the drag section: it has no
 * layout, so the drag below runs against rows whose rectangles are stubbed,
 * and «a thumb on the name still scrolls» is a CSS fact that only a touch
 * screen can confirm.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/profile' }));

import { MenuOrderCard } from '@/components/settings/MenuOrderCard';
import { Sidebar } from '@/components/shell/Sidebar';
import {
  applyArrangement,
  cleanLayout,
  EMPTY_LAYOUT,
  orderAfterDrag,
  reorderWithinGroup,
  resolveLayout,
  type NavLayout,
} from './nav-arrangement';
import { mobileNav } from './mobile-nav';
import { ALL_ROUTES, NAV, isMenuLine } from './route-registry';
import { repoFile, stripComments } from './guard-source';

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

// ───────────────────────── the pure move ─────────────────────────

/** The registry's own draw order, as the card computes `flat`. */
const FLAT = NAV.flatMap((g) => g.routes.map((r) => r.path));
const GROUPS = NAV.map((g) => g.routes.map((r) => r.path));

/**
 * THE MOVE THE BUTTONS MADE BEFORE THIS CHANGE, STEP FOR STEP.
 *
 * Copied from `MenuOrderCard`'s `move()` as it stood at the commit before
 * (the statements are the same; only `setLayout` became `return`): the
 * reference that `reorderWithinGroup` must agree with for every one of the
 * screens, up and down, or «the buttons behave as they did» is a hope rather
 * than a claim.
 */
function oldMove(flat: string[], group: string[], path: string, by: -1 | 1): string[] {
  const within = [...group];
  const at = within.indexOf(path);
  const to = at + by;
  if (to < 0 || to >= within.length) return flat;
  [within[at], within[to]] = [within[to], within[at]];
  const next = flat.filter((p) => !within.includes(p));
  const head = flat.slice(0, flat.indexOf(group[0])).filter((p) => !within.includes(p));
  return [...head, ...within, ...next.slice(head.length)];
}

describe('moving one screen within its group', () => {
  it('— gives the SAME answer the buttons always gave, for every screen, up and down', () => {
    let checked = 0;
    for (const group of GROUPS) {
      group.forEach((path, i) => {
        for (const by of [-1, 1] as const) {
          const expected = oldMove(FLAT, group, path, by);
          const got = reorderWithinGroup(FLAT, group, i, i + by);
          expect(got, `${path} ${by > 0 ? 'down' : 'up'}`).toEqual(expected);
          checked++;
        }
      });
    }
    // Every screen, both ways — so the loop above cannot pass by looking at nothing.
    expect(checked).toBe(ALL_ROUTES.length * 2);
  });

  it('and a long drag lands where it was dropped, not one step along', () => {
    const group = GROUPS.find((g) => g.length >= 5)!;
    const out = reorderWithinGroup(FLAT, group, 0, group.length - 1);
    const at = out.indexOf(group[1]);
    expect(out.slice(at, at + group.length)).toEqual([...group.slice(1), group[0]]);
  });

  it('and one group’s move never reshuffles another — every other path keeps its place', () => {
    for (const group of GROUPS.filter((g) => g.length >= 2)) {
      const out = reorderWithinGroup(FLAT, group, 0, group.length - 1);
      const others = (xs: string[]) => xs.filter((p) => !group.includes(p));
      expect(others(out), group[0]).toEqual(others(FLAT));
      // …and the group is still ONE block, in the same place in the menu.
      const at = FLAT.indexOf(group[0]);
      expect(new Set(out.slice(at, at + group.length))).toEqual(new Set(group));
    }
  });

  it('and it is a permutation: nothing lost, nothing doubled', () => {
    // A deterministic walk of 200 moves through the whole menu.
    let order = [...FLAT];
    let seed = 7;
    const next = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 200; i++) {
      const group = GROUPS[next(GROUPS.length)];
      order = reorderWithinGroup(order, group, next(group.length), next(group.length));
      expect(order).toHaveLength(FLAT.length);
    }
    expect([...order].sort()).toEqual([...FLAT].sort());
  });

  it.each([
    ['the same place', 2, 2],
    ['before the start', 1, -1],
    ['past the end', 1, 999],
    ['from nowhere', -1, 1],
  ])('and dropping %s moves nothing', (_name, from, to) => {
    const group = GROUPS.find((g) => g.length >= 4)!;
    expect(reorderWithinGroup(FLAT, group, from, to)).toEqual(FLAT);
  });
});

describe('what a finished drag may do', () => {
  const group = GROUPS.find((g) => g.length >= 4)!;
  const other = GROUPS.find((g) => g !== group)!;

  it('— moves the screen to where it was dropped', () => {
    const out = orderAfterDrag(FLAT, group, { active: { id: group[0] }, over: { id: group[2] } });
    expect(out).toEqual(reorderWithinGroup(FLAT, group, 0, 2));
  });

  it.each([
    ['a drop on nothing', (g: string[]) => ({ active: { id: g[0] }, over: null })],
    ['a drop on itself', (g: string[]) => ({ active: { id: g[1] }, over: { id: g[1] } })],
    ['a drop onto ANOTHER GROUP’s screen', (g: string[], o: string[]) => ({ active: { id: g[0] }, over: { id: o[0] } })],
    ['a screen from another group dropped here', (g: string[], o: string[]) => ({ active: { id: o[0] }, over: { id: g[1] } })],
  ])('and %s moves nothing', (_name, make) => {
    /*
     * THE RULE, HELD EVEN IF THE LIBRARY IS SET UP WRONG.
     *
     * A per-group drop zone cannot produce the third and fourth, and they are
     * refused anyway: «a screen does not change what it is about by being
     * dragged under another heading» must not depend on a context being
     * configured right.
     */
    expect(orderAfterDrag(FLAT, group, make(group, other))).toBeNull();
  });
});

// ───────────────────────── the card ─────────────────────────

function mountCard() {
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/nav/arrangement' && !init?.method) {
      return { resolved: EMPTY_LAYOUT, own: null, paths: ALL_ROUTES.map((r) => r.path), maySetRoleBase: false };
    }
    return {};
  });
  return render(<MenuOrderCard />);
}

/** The rows in draw order — which, with nothing arranged, is the registry's. */
const NAV_ROUTES = NAV.flatMap((g) => g.routes);
const rowsOf = () => screen.getAllByRole('listitem');
/** Which screen each row is, by the name it shows. */
const pathsInOrder = () =>
  rowsOf().map((li) => {
    const shown = li.querySelector('span')?.firstChild?.textContent;
    return NAV_ROUTES.find((r) => r.label === shown)?.path;
  });

describe('the card: a grip and an eye per screen, and nothing else', () => {
  /*
   * CHANGED ON PURPOSE (18/11, R7). Was «every screen has its grip AND its four buttons» (grip, up, down, pin, hide).
   * The owner asked for drag and the eye only. Now: «grip and eye; the keyboard sensor still moves a row» — the arrows'
   * job (a path without a mouse) is the keyboard sensor's, held in «a real drag» below (Space, ↓, Space).
   */
  it('— every screen has its grip AND its eye, and no arrow and no pin', async () => {
    mountCard();
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(NAV_ROUTES.length);
    // By POSITION, not by name: two groups may one day call a screen the same
    // thing, and a query by label would then find two and fail for the wrong reason.
    NAV_ROUTES.forEach((route, i) => {
      const row = inRow(rows[i]);
      expect(row.getByLabelText(`اسحب ${route.label} لتغيير ترتيبه`), `مقبض ${route.label}`).toBeTruthy();
      expect(row.getByLabelText(`اخفِ ${route.label}`), `اخفِ ${route.label}`).toBeTruthy();
      // NEGATIVE: what left.
      expect(row.queryByLabelText(`ارفع ${route.label}`), `ارفع ${route.label}`).toBeNull();
      expect(row.queryByLabelText(`انزل ${route.label}`), `انزل ${route.label}`).toBeNull();
      expect(row.queryByLabelText(`ثبّت ${route.label}`), `ثبّت ${route.label}`).toBeNull();
      // two controls, no more
      expect(row.getAllByRole('button'), route.label).toHaveLength(2);
    });
  });

  it('and the eye hides a screen and brings it back — and a save sends it in `hidden`', async () => {
    mountCard();
    const rows = await screen.findAllByRole('listitem');
    const route = NAV_ROUTES[0];
    await act(async () => {
      fireEvent.click(inRow(rows[0]).getByLabelText(`اخفِ ${route.label}`));
    });
    expect(inRow(rowsOf()[0]).getByLabelText(`أظهر ${route.label}`)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ'));
    });
    const put = apiJson.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(JSON.parse(put[1].body).hidden).toEqual([route.path]);
  });

  it('and no role picker and no phone’s four on a person’s card — even for whoever may set a role’s base', async () => {
    apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/nav/arrangement' && !init?.method) {
        return { resolved: EMPTY_LAYOUT, own: null, paths: ALL_ROUTES.map((r) => r.path), maySetRoleBase: true };
      }
      if (url === '/api/roles') return { roles: [{ id: 'r1', name: 'دور' }] };
      return {};
    });
    render(<MenuOrderCard />);
    await screen.findAllByRole('listitem');
    expect(screen.queryByDisplayValue('قائمتي أنا')).toBeNull();
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(apiJson.mock.calls.some((c) => c[0] === '/api/roles'), 'البطاقة لسا بتجيب الأدوار').toBe(false);
  });

  it('and ONLY the grip refuses the browser’s scroll gesture — a thumb on the rest of the row scrolls', async () => {
    /*
     * THE ANSWER TO «A DRAG INSIDE A SCROLLING COLUMN FIGHTS THE SCROLL».
     *
     * `touch-action: none` on a row would make the whole list unscrollable
     * by touch. On the grip alone, a thumb on the name, the buttons or the
     * gap between rows scrolls the page exactly as it did before there was
     * a grip.
     */
    mountCard();
    await screen.findAllByRole('listitem');
    const noScroll = Array.from(document.querySelectorAll<HTMLElement>('[style*="touch-action"]'));
    // CHANGED ON PURPOSE (13/11): the groups got a grip of their own — one more per group, besides one per line.
    expect(noScroll).toHaveLength(NAV_ROUTES.length + NAV.length);
    for (const el of noScroll) {
      expect(el.getAttribute('aria-label'), 'غير المقبض بيمنع التمرير').toMatch(/^اسحب .* لتغيير ترتيب(?:ه|ها)$/);
    }
    // …and never the row or the list around them.
    for (const el of [...rowsOf(), ...Array.from(document.querySelectorAll('ul'))]) {
      expect((el as HTMLElement).style.touchAction, 'الصف أو القائمة بتمنع التمرير').not.toBe('none');
    }
  });

  it('and the grip speaks Arabic to a screen reader — its role, its instructions, no «sortable»', async () => {
    mountCard();
    const rows = await screen.findAllByRole('listitem');
    const route = NAV_ROUTES[0];
    const grip = inRow(rows[0]).getByLabelText(`اسحب ${route.label} لتغيير ترتيبه`);
    expect(grip.getAttribute('aria-roledescription'), 'الكلمة الإنجليزية بقيت').toBe('مقبض ترتيب');
    const helpId = grip.getAttribute('aria-describedby') ?? '';
    expect(helpId, 'المقبض ما إله وصف').not.toBe('');
    // The library draws its hidden instructions one render after it mounts.
    await waitFor(() =>
      expect(document.getElementById(helpId)?.textContent ?? '', 'ما في تعليمات للقارئ').toContain('اضغط مسافة لتمسكها')
    );
  });

  /*
   * CHANGED ON PURPOSE (18/11, R7). Three tests stood here that pressed the arrows: «the down button still moves a row
   * down — through the shared function», «saving sends the flat order, with the moved screen where it was put», and
   * «the first row cannot go up and the last cannot go down». The arrows left the card. The first two are now made by
   * the KEYBOARD (Space, ↓, Space) in «a real drag» below, with the same assertions, still ending in `reorderWithinGroup`;
   * the third has nothing left to hold — there is no arrow to disable — and the keyboard at the edge is held there
   * instead («↓ on the last row moves nothing»).
   */
});

// ───────────────────────── a layout saved before (18/11, R7) ─────────────────────────

describe('a layout saved BEFORE the arrows and the pin left draws the same menu after a save from the new card', () => {
  /*
   * The stored rows written by the old card can carry `pinned`, the phone's four (`slots`) and group keys that the
   * nine groups of R6 no longer have. The card no longer writes pins (it folds them into `order`) and no longer lets a
   * person edit the four — so the question is only: does pressing «احفظ» on such a row change the menu that person
   * sees? It must not. The «menu» is what the shell draws: the groups and their lines (`applyArrangement`, after the
   * door's `cleanLayout`) and the phone's bar (`mobileNav` over the drawn lines with the stored four).
   */
  const ALL = ALL_ROUTES.map((r) => r.path);
  const KEYS = NAV.map((g) => g.key);
  const open = new Set(ALL);
  const LINES = NAV.flatMap((g) => g.routes.filter((r) => isMenuLine(r, open)).map((r) => r.path));
  const stored = (l: NavLayout) => cleanLayout(l, ALL, KEYS, LINES);
  const drawn = (l: NavLayout) => {
    const groups = applyArrangement(NAV, l);
    const lines = applyArrangement(
      NAV.map((g) => ({ ...g, routes: g.routes.filter((r) => isMenuLine(r, open)) })).filter((g) => g.routes.length > 0),
      l
    );
    return {
      groups: groups.map((g) => [g.key, g.routes.map((r) => r.path)]),
      bar: mobileNav(lines, null, l.slots).primary.map((r) => r.path),
    };
  };

  // A group of three screens or more: pin its LAST screen and another group's second, so a pin really moves something.
  const big = NAV.filter((g) => g.routes.length >= 3);
  const OLD: NavLayout = {
    order: [...ALL],
    hidden: [big[0].routes[1].path],
    pinned: [big[1].routes[big[1].routes.length - 1].path, big[0].routes[big[0].routes.length - 1].path],
    // `control`, `chats`, `settings`: keys from before R6, which `cleanLayout` drops.
    groups: ['control', big[1].key, 'chats', big[0].key, 'settings'],
    slots: [big[0].routes[2].path, '/orders'],
  };

  async function saveFrom(resolved: NavLayout, own: NavLayout | null) {
    apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/nav/arrangement' && !init?.method) return { resolved, own, paths: ALL, maySetRoleBase: false };
      return {};
    });
    render(<MenuOrderCard />);
    await screen.findAllByRole('listitem');
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ'));
    });
    const put = apiJson.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    return JSON.parse(put[1].body) as NavLayout;
  }

  it('— with pins, the four and old group keys: the same groups, the same lines, the same bar; and no pin written', async () => {
    const before = stored(OLD);
    // the fixture means something: the pin moved a line, and the old keys were dropped
    expect(drawn(before).groups).not.toEqual(drawn({ ...before, pinned: [] }).groups);
    const body = await saveFrom(before, before);
    expect(body.pinned).toEqual([]);
    expect(body.slots, 'الخانات الأربعة المحفوظة انمسحت').toEqual(before.slots);
    expect(drawn(stored(body))).toEqual(drawn(before));
  });

  it('and the RAW old row (unknown keys still in it, as the screen would receive it unchanged) draws the same after too', async () => {
    const body = await saveFrom(OLD, OLD);
    expect(drawn(stored(body))).toEqual(drawn(stored(OLD)));
  });

  it('and a person with NO row of their own, under a base with pins and four, keeps the same menu after a save', async () => {
    const base = stored(OLD);
    const body = await saveFrom(base, null);
    // what the door resolves for them afterwards: their new row over the same base
    expect(drawn(resolveLayout(base, stored(body)))).toEqual(drawn(base));
    // and the base's four stay the base's — not copied into their row
    expect(body.slots).toEqual([]);
  });

  it('NEGATIVE: posting the old order with the pins merely dropped WOULD change the menu — the fold is what keeps it', () => {
    const before = stored(OLD);
    expect(drawn({ ...before, pinned: [] })).not.toEqual(drawn(before));
  });
});

// ───────────────────────── a drag that really happens ─────────────────────────

describe('and a real drag — the pointer, the keyboard and Esc — goes through the same door', () => {
  /*
   * jsdom has no layout: every rectangle is zero, so a drop zone has nowhere
   * to be dropped on. The rows are given the rectangles a browser would give
   * them — 40px tall, stacked in their list, shifted by the `translate3d` the
   * sortable strategy puts on a row — and everything else is the real library
   * and the real card. What this proves is the WIRING: that a pointer or a key
   * press on the grip ends in `orderAfterDrag`, and that Esc ends in nothing.
   * What it cannot prove — that a touch screen scrolls where it should — is
   * `touch-action`, covered above as the fact it is.
   *
   * WAITS ARE FOR A CONDITION, NEVER A DURATION. The first version of these
   * slept 25ms between steps, which passes on a quiet machine and failed once
   * on a busy one — the worst kind of red, because it says nothing about the
   * code. A claim that something DID happen waits until it has; a claim that
   * something did NOT happen has nothing to wait for, so it settles for a
   * while and reads the history rather than the last look.
   */
  const ROW = 40;
  let restoreLayout: () => void;

  // Every group is its own drag context with its own live region.
  const announced = () =>
    Array.from(document.querySelectorAll('[role="status"]'))
      .map((e) => e.textContent ?? '')
      .join(' ');

  // Everything the screen reader was told, in order. The live region keeps only
  // the LAST sentence, so a drag that started and finished between two looks
  // leaves nothing in it — and «nothing was picked up» could not be told from
  // «something was picked up and put back». That blindness let two mutations
  // through the first version of this section.
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

  const until = (check: () => void) => waitFor(check, { timeout: 3000 });
  const settle = (ms = 80) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  const everHeard = () => heard.join(' ');

  // A group of three screens or more: grip on the first, drop on the third.
  const group = NAV.find((g) => g.routes.length >= 3)!;
  const [a, b, c] = group.routes;
  const groupPaths = group.routes.map((r) => r.path);
  const at = NAV.slice(0, NAV.indexOf(group)).reduce((n, g) => n + g.routes.length, 0);
  const mine = (xs: (string | undefined)[]) => xs.slice(at, at + group.routes.length);
  const ev = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };

  async function grabFirst() {
    mountCard();
    const rows = await screen.findAllByRole('listitem');
    /*
     * The library registers its screen-reader listener in an effect, and its
     * hidden instructions are drawn one render after THAT — so «they are in
     * the document» is the moment a press can be heard. Pressing before it
     * is a race: the drag starts, the announcement is made to nobody, and the
     * claim below waits for a sentence that will not come again. It lost that
     * race one run in a dozen; a person cannot press within a microsecond of
     * the screen appearing, so it was never a fault in the card.
     */
    // CHANGED ON PURPOSE (13/11): one context per group for its lines, and now one more around the groups.
    await until(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]')).toHaveLength(NAV.length + 1));
    return inRow(rows[at]).getByLabelText(`اسحب ${a.label} لتغيير ترتيبه`);
  }

  it('— a pointer drag from the grip puts the row where it was dropped, and says so in Arabic', async () => {
    const grip = await grabFirst();
    await act(async () => {
      fireEvent.pointerDown(grip, { ...ev, clientX: 20, clientY: 20 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 32 }); // past the 6px, so it is a drag
    });
    await until(() => expect(announced(), 'ما انقال إنو انمسكت').toContain(`أمسكتَ «${a.label}»`));

    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 100 }); // 80px down: the third row
    });
    await until(() => expect(announced()).toContain(`«${a.label}» فوق «${c.label}»`));
    await act(async () => {
      fireEvent.pointerUp(document, { ...ev, clientX: 20, clientY: 100 });
    });

    const expected = mine(reorderWithinGroup(FLAT, groupPaths, 0, 2));
    await until(() => expect(mine(pathsInOrder()), 'الصف ما وصل مكان الإفلات').toEqual(expected));
    expect(mine(pathsInOrder())[2]).toBe(a.path);
    await until(() => expect(announced()).toContain(`أُفلتت «${a.label}» مكان «${c.label}»`));
  });

  it('and a tap on the grip that does not travel moves nothing — and does not even start a drag', async () => {
    const grip = await grabFirst();
    await act(async () => {
      fireEvent.pointerDown(grip, { ...ev, clientX: 20, clientY: 20 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 21, clientY: 23 }); // 3px: a shaky tap
    });
    await act(async () => {
      fireEvent.pointerUp(document, { ...ev, clientX: 21, clientY: 23 });
    });
    await settle();
    expect(mine(pathsInOrder())).toEqual(groupPaths);
    // A screen reader user who taps the grip is not told a row was picked up
    // and put back. Read from the history: the last sentence alone would say
    // «put back» and hide that anything was ever picked up.
    expect(everHeard(), 'نقرة صغيرة بدأت جلسة سحب').not.toContain('أمسكتَ');
  });

  it('and pressing on the NAME, not the grip, starts nothing — that is where a thumb scrolls', async () => {
    /*
     * THE BEHAVIOUR BEHIND «ONLY THE GRIP».
     *
     * A source claim can say the listeners are on the button; this says what
     * that is FOR. If they were on the row, a press on the name would bubble
     * up to them and start a drag exactly as the grip does — and on a phone
     * that is the scroll being fought, which is what the grip exists to avoid.
     */
    await grabFirst();
    const name = inRow(screen.getAllByRole('listitem')[at]).getByText(a.label);
    await act(async () => {
      fireEvent.pointerDown(name, { ...ev, clientX: 20, clientY: 20 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { ...ev, clientX: 20, clientY: 100 });
    });
    await settle();
    await act(async () => {
      fireEvent.pointerUp(document, { ...ev, clientX: 20, clientY: 100 });
    });
    await settle();
    expect(everHeard(), 'الضغط على الاسم بدأ سحباً').not.toContain('أمسكتَ');
    expect(mine(pathsInOrder())).toEqual(groupPaths);
  });

  it('and the keyboard does the same: Space to pick up, ↓ to move, Space to put down', async () => {
    const grip = await grabFirst();
    await act(async () => {
      fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ «${a.label}»`));
    await settle(); // the sensor starts listening for the next key on the next turn
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await until(() => expect(announced()).toContain(`«${a.label}» فوق «${b.label}»`));
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    });

    const expected = mine(reorderWithinGroup(FLAT, groupPaths, 0, 1));
    await until(() => expect(mine(pathsInOrder()), 'الكيبورد ما حرّك الصف').toEqual(expected));
    expect(mine(pathsInOrder())[1]).toBe(a.path);
    expect(mine(pathsInOrder())[0]).toBe(b.path);
  });

  it('and Esc puts it back, and says it was cancelled', async () => {
    const grip = await grabFirst();
    await act(async () => {
      fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ «${a.label}»`));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await until(() => expect(announced()).toContain(`«${a.label}» فوق «${b.label}»`));
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
    });
    await until(() => expect(announced()).toContain(`أُلغي تحريك «${a.label}»`));
    await settle();
    expect(mine(pathsInOrder()), 'Esc ما رجّعها').toEqual(groupPaths);
  });

  /*
   * 18/11 (R7): WHAT THE ARROWS HELD, HELD THROUGH THE KEYBOARD. The rows are pinned on «الطلبات» (the second group;
   * the first, «اليوم», is one screen), counted from where its first row stands — as the arrow tests were.
   */
  const second = NAV[1];
  const secondAt = NAV[0].routes.length;
  /** Space on a row's grip, ↓, Space — and wait until the library has finished saying so. */
  async function keyboardDown(rowAt: number, label: string, overLabel: string | null) {
    mountCard();
    const rows = await screen.findAllByRole('listitem');
    await until(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]')).toHaveLength(NAV.length + 1));
    const grip = inRow(rows[rowAt]).getByLabelText(`اسحب ${label} لتغيير ترتيبه`);
    await act(async () => {
      fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ «${label}»`));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    if (overLabel) await until(() => expect(announced()).toContain(`«${label}» فوق «${overLabel}»`));
    else await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أُفلتت «${label}»`));
  }

  it('and the keyboard still moves a row down — through the shared function (was: «the down button»)', async () => {
    const [x, y] = second.routes;
    await keyboardDown(secondAt, x.label, y.label);
    const paths = second.routes.map((r) => r.path);
    const expected = reorderWithinGroup(FLAT, paths, 0, 1).slice(secondAt, secondAt + paths.length);
    await until(() => expect(pathsInOrder().slice(secondAt, secondAt + paths.length), 'الكيبورد ما نزّل الصف').toEqual(expected));
    expect(rowsOf()[secondAt].textContent, 'الأول ما نزل').toContain(y.label);
    expect(rowsOf()[secondAt + 1].textContent).toContain(x.label);
  });

  it('and saving after it sends the flat order, with the moved screen where it was put', async () => {
    const [x, y] = second.routes;
    await keyboardDown(secondAt, x.label, y.label);
    await until(() => expect(rowsOf()[secondAt].textContent).toContain(y.label));
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ'));
    });
    const put = apiJson.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    const sent = JSON.parse(put[1].body).order as string[];
    expect(sent.indexOf(y.path), 'ما انحفظ الترتيب الجديد').toBeLessThan(sent.indexOf(x.path));
    expect(sent).toHaveLength(ALL_ROUTES.length);
  });

  it('and ↓ on the LAST row of a group moves nothing — the edge the disabled arrow used to hold', async () => {
    const last = second.routes[second.routes.length - 1];
    await keyboardDown(secondAt + second.routes.length - 1, last.label, null);
    await settle();
    expect(pathsInOrder().slice(secondAt, secondAt + second.routes.length)).toEqual(second.routes.map((r) => r.path));
  });
});

describe('and the wiring is the one that holds the rules', () => {
  const src = () => stripComments(repoFile('src/components/settings/MenuOrderCard.tsx'));

  it('— one drop zone per group, so a row cannot be dropped under another heading', () => {
    const s = src();
    // CHANGED ON PURPOSE (13/11): TWO `<DndContext` in the markup now — the one around the groups, which sits BEFORE the
    // per-group map, and the one for a group's lines, which sits INSIDE it (and is still the only one a screen can be dropped in).
    expect(s.match(/<DndContext\b/g)).toHaveLength(2);
    const mapAt = s.indexOf('ordered.map((group)');
    expect(mapAt, 'ما لقيت حلقة المجموعات').toBeGreaterThan(-1);
    expect(s.lastIndexOf('<DndContext'), 'الـDndContext تبع الأسطر خارج حلقة المجموعات').toBeGreaterThan(mapAt);
    expect(s.indexOf('<DndContext'), 'الـDndContext تبع المجموعات جوّا الحلقة').toBeLessThan(mapAt);
  });

  it('and the vertical axis is locked and the row kept inside its list', () => {
    const s = src();
    expect(s).toContain('modifiers={[restrictToVerticalAxis, restrictToParentElement]}');
  });

  it('and the drag listeners are on the grip and on nothing else', () => {
    const s = src();
    // CHANGED ON PURPOSE (13/11): one grip for a line and one for a group — each carries its own, and nothing else does.
    expect(s.match(/\.\.\.listeners/g)).toHaveLength(2);
    expect(s.match(/\.\.\.attributes/g)).toHaveLength(2);
    // The row itself takes the node ref, never the listeners.
    expect(s).toMatch(/<li\s+ref=\{setNodeRef\}/);
    expect(s).toContain('ref={setActivatorNodeRef}');
  });

  // CHANGED ON PURPOSE (18/11, R7): was «the buttons and the drag both go through reorderWithinGroup». The buttons left;
  // the pointer and the keyboard are ONE drag (`onDragEnd`), and it ends in `orderAfterDrag`, which is `reorderWithinGroup`.
  it('and the drag and the keyboard both go through reorderWithinGroup', () => {
    const s = src();
    expect(s).toContain('orderAfterDrag(flat, groupPaths, end)');
    expect(s).toContain('onDragEnd={(end) => dropped(groupPaths, end)}');
    expect(s).toContain('useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })');
    const lib = stripComments(repoFile('src/lib/nav-arrangement.ts'));
    const body = lib.slice(lib.indexOf('export function orderAfterDrag'));
    expect(body.slice(0, body.indexOf('\n}'))).toContain('return reorderWithinGroup(flat, group, from, to)');
    // No second copy of the splice that the buttons used to carry, and no arrow left behind.
    expect(s).not.toMatch(/\[within\[at\], within\[to\]\]/);
    expect(s).not.toContain('reorderWithinGroup(');
  });

  it('and a save folds the pins into the order — the server still reads `pinned`, this client no longer writes it', () => {
    const s = src();
    expect(s).toContain('order: flat,');
    expect(s).toContain('pinned: [],');
    expect(s).not.toMatch(/'pinned'/);
  });

  it('and a screen reader is spoken to in Arabic, with the screen’s own name', () => {
    const s = src();
    expect(s).toContain('أمسكتَ «');
    expect(s).toContain('أُلغي تحريك «');
    expect(s).toContain('اضغط مسافة لتمسكها');
    // The names come from the registry, not from an address.
    expect(s).toContain('ALL_LABELS');
  });
});

// ───────────────────────── and the way to it ─────────────────────────

describe('«رتّب القائمة» is where the menu is', () => {
  const groups = [
    {
      key: 'main',
      label: 'الرئيسية',
      routes: [
        { path: '/orders', label: 'الطلبات', icon: 'ShoppingCart', permissions: null },
        { path: '/products', label: 'المنتجات', icon: 'Package', permissions: null },
      ],
    },
  ];

  it('— a link in the sidebar to the card, on the profile page', async () => {
    await act(async () => {
      render(<Sidebar groups={groups} />);
    });
    const link = screen.getByRole('link', { name: 'رتّب القائمة' });
    expect(link.getAttribute('href')).toBe('/admin/profile#menu-order');
  });

  it('and the card is what that address lands on', () => {
    expect(repoFile('src/components/settings/MenuOrderCard.tsx')).toContain('id="menu-order"');
  });

  it('and it folds away with the other labels when the menu is a rail', async () => {
    await act(async () => {
      render(<Sidebar groups={groups} />);
    });
    expect(screen.getByRole('link', { name: 'رتّب القائمة' }).className).toContain('rail-hide');
  });

  it('and the profile page it points at is open to everybody', () => {
    // A link to a screen the person may not open would be the dashboard's old
    // mistake. `permissions: null` is «every signed-in person».
    const profile = ALL_ROUTES.find((r) => r.path === '/admin/profile')!;
    expect(profile.permissions).toBeNull();
  });
});
