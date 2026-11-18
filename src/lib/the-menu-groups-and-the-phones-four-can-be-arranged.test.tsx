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
 * CHANGED ON PURPOSE (18/11, R7) — «رتّب القائمة» is drag and the eye, nothing else:
 *
 *   • A PERSON'S CARD (the profile page): each group by its heading's grip, each screen by its own grip, an eye per
 *     screen. The group arrows LEFT — what they held («a move goes through `reorderGroups`», «the first cannot go up»)
 *     is now held through the KEYBOARD (Space, ↓, Space), the path without a mouse. No role picker, no phone's four.
 *   • THE ROLE'S BASE (the roles screen, `RoleMenuPanel`): a role picker → the same card in role mode, which also draws
 *     THE PHONE'S FOUR (four rows, a real select each, two kit arrows) — and the role's opening look. Everything the
 *     four were held to before is held here, on the panel, where they moved.
 *
 * What is held here is the screen as a person meets it, in jsdom: the real card, the real drag library, the real pure
 * functions — and only the network faked. The drag runs with the rectangles a browser would give (jsdom has none), and
 * says what that cannot prove: that a thumb on the name scrolls is a `touch-action` fact only a touch screen can confirm,
 * so what is held is where it is set.
 *
 * AND ARRANGING STILL OPENS NOTHING: every screen a slot can hold is one the menu already draws as a line, and nothing
 * here adds a route to anyone.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, user } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  user: { current: { id: 'u1', name: 'المالك', role: 'CUSTOM', permissions: ['roles.view', 'roles.edit'], status: 'ACTIVE' } },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/profile' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current, locale: 'ar', isRtl: true, t: {} }) }));

import { MenuOrderCard } from '@/components/settings/MenuOrderCard';
import { RoleMenuPanel } from '@/components/settings/RoleMenuPanel';
import { PermissionsScreen } from '@/components/screens/PermissionsScreen';
import { mobileNav } from '@/lib/mobile-nav';
import { applyArrangement, cleanLayout, EMPTY_LAYOUT, reorderGroups, reorderSlots, reorderWithinGroup, resolveLayout, type NavLayout } from '@/lib/nav-arrangement';
import { ALL_ROUTES, NAV, findRoute } from '@/lib/route-registry';
import { repoFile, stripComments } from '@/lib/guard-source';

// ───────────────────────── the layout jsdom does not have ─────────────────────────

/*
 * jsdom has no layout: every rectangle is zero, so a drop zone has nowhere to be dropped on. The groups are given the
 * rectangles a browser would give them — a hundred pixels tall, stacked in their list, shifted by the `translate3d` the
 * sortable strategy puts on one — and a line is forty, as in `the-menu-can-be-dragged`. Everything else is the real
 * library and the real card. (18/11, R7: for the whole file now — the keyboard moves of a group replaced the arrows.)
 */
const GROUP = 100;
const ROW = 40;
let restoreLayout: () => void;

beforeEach(() => {
  // jsdom has no ResizeObserver, and the drag library measures its drop zones with one.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
  restoreLayout();
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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
  /** A role's base, by role id — what the roles screen's panel reads. */
  roleBase: Record<string, NavLayout>;
  roles: { id: string; name: string }[];
}
const fresh = (): Server => ({
  resolved: EMPTY_LAYOUT,
  own: null,
  base: null,
  paths: ALL_PATHS,
  maySetRoleBase: false,
  afterReset: { resolved: EMPTY_LAYOUT, base: null },
  roleBase: {},
  roles: [{ id: 'role-mod', name: 'مشرف' }],
});
let server = fresh();

function serve(over: Partial<Server>) {
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
    if (url === '/api/roles') return { roles: server.roles };
    return {};
  });
}

/** A person's own card — the profile page. */
function mountCard(over: Partial<Server> = {}) {
  serve(over);
  return render(<MenuOrderCard />);
}

/** The roles screen's panel, with a role picked: the role's base in the same card, the four, the look. */
async function mountRole(over: Partial<Server> = {}, roleId = 'role-mod') {
  serve({ maySetRoleBase: true, ...over });
  render(<RoleMenuPanel />);
  const picker = (await screen.findByLabelText('الدور')) as HTMLSelectElement;
  await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1));
  await act(async () => {
    fireEvent.change(picker, { target: { value: roleId } });
  });
  await screen.findAllByRole('listitem');
}

const puts = () => apiJson.mock.calls.filter((c) => c[1]?.method === 'PUT' && String(c[0]).startsWith('/api/nav/'));
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
const SLOTS_TITLE = 'خانات الهاتف الأربعة — اللي بتظهر تحت الشاشة';

// ───────────────────────── the drag library, driven ─────────────────────────

const announced = () =>
  Array.from(document.querySelectorAll('[role="status"]'))
    .map((e) => e.textContent ?? '')
    .join(' ');
const until = (check: () => void) => waitFor(check, { timeout: 3000 });
const settle = (ms = 80) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
/** The library draws its hidden instructions one render after it mounts — a press before that is heard by nobody. */
const ready = () => until(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]')).toHaveLength(groupOrder().length + 1));

/** One group one place down by the KEYBOARD: Space on its grip, ↓, Space — what the «انزل» arrow did before 18/11. */
async function groupDown(key: string) {
  await ready();
  const name = labelOfGroup(key);
  const handle = screen.getByLabelText(`اسحب مجموعة ${name} لتغيير ترتيبها`);
  await act(async () => {
    fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
  });
  await until(() => expect(announced()).toContain(`أمسكتَ مجموعة «${name}»`));
  await settle(); // the sensor starts listening for the next key on the next turn
  await act(async () => {
    fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
  });
  await until(() => expect(announced()).toContain(`مجموعة «${name}» فوق مجموعة`));
  await act(async () => {
    fireEvent.keyDown(document, { code: 'Space', key: ' ' });
  });
  await until(() => expect(announced()).toContain(`أُفلتت مجموعة «${name}»`));
}

// ───────────────────────── a person's card, as a person meets it ─────────────────────────

describe('a person’s card: a grip and a name per group, a grip and an eye per screen', () => {
  it('— every group has a heading with its name and a grip, and NO arrows; every screen has a grip and an eye, no more', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    expect(groupOrder()).toEqual(REGISTRY_KEYS);
    for (const g of NAV) {
      const block = within(document.querySelector(`[data-menu-group="${g.key}"]`) as HTMLElement);
      expect(block.getByRole('heading', { level: 3, name: g.label }), g.key).toBeTruthy();
      expect(block.getByLabelText(`اسحب مجموعة ${g.label} لتغيير ترتيبها`), `مقبض ${g.key}`).toBeTruthy();
      // NEGATIVE (18/11, R7): the group arrows left.
      expect(block.queryByLabelText(`ارفع مجموعة ${g.label}`), g.key).toBeNull();
      expect(block.queryByLabelText(`انزل مجموعة ${g.label}`), g.key).toBeNull();
      expect(block.getAllByRole('listitem'), g.key).toHaveLength(g.routes.length);
      for (const r of g.routes) {
        expect(block.getByLabelText(`اسحب ${r.label} لتغيير ترتيبه`)).toBeTruthy();
        expect(block.getByLabelText(`اخفِ ${r.label}`)).toBeTruthy();
        for (const verb of ['ارفع', 'انزل', 'ثبّت']) expect(block.queryByLabelText(`${verb} ${r.label}`), `${verb} ${r.label}`).toBeNull();
      }
    }
    // the rows are still exactly the screens
    expect(screen.getAllByRole('listitem')).toHaveLength(ALL_ROUTES.length);
  });

  it('and the line under the heading says the truth: drag from the grip or the keyboard, the eye hides, hiding opens nothing', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    const text = document.getElementById('menu-order')!.textContent!;
    // CHANGED ON PURPOSE (18/11, R7): was «رتّب أربع شاشات الهاتف، والمجموعات الكبيرة…» and «…أو استعمل السهمين» — the four
    // and the arrows left this card.
    expect(text).toContain('اسحب من المقبض');
    expect(text).toContain('مسافة، ثم الأسهم، ثم مسافة');
    expect(text).toContain('العين بتخفي الشاشة');
    expect(text).toContain('الإخفاء لا يفتح ولا يغلق أي صلاحية');
    expect(text).not.toContain('السهمين');
    expect(text).not.toContain('ثبّت');
  });

  it('NEGATIVE: no phone’s four and no role picker on a person’s card — not even the owner’s', async () => {
    mountCard({ paths: AGENT_PATHS, maySetRoleBase: true });
    await screen.findAllByRole('listitem');
    expect(slotSelects()).toHaveLength(0);
    expect(screen.queryByText(SLOTS_TITLE)).toBeNull();
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(apiJson.mock.calls.some((c) => c[0] === '/api/roles')).toBe(false);
  });

  it('and a response from before the two fields existed still draws', async () => {
    mountCard({ resolved: { order: [], hidden: [], pinned: [] } });
    await screen.findAllByRole('listitem');
    expect(groupOrder()).toEqual(REGISTRY_KEYS);
  });

  it('and a person whose saved four exist keeps them: a save posts them back as they stand, untouched', async () => {
    const own: NavLayout = { ...EMPTY_LAYOUT, slots: ['/orders', '/finance/wallets'] };
    mountCard({ paths: AGENT_PATHS, resolved: own, own });
    await screen.findAllByRole('listitem');
    expect((await save()).body.slots).toEqual(['/orders', '/finance/wallets']);
  });
});

describe('the groups — by the keyboard (the arrows’ job since 18/11)', () => {
  // CHANGED ON PURPOSE (18/11, R7): this section was «the groups — by the arrows». The same moves, by Space/↓/Space.
  it('— ↓ moves a group one place down: the same order `reorderGroups` gives', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    await groupDown('today');
    await until(() => expect(groupOrder()).toEqual(reorderGroups(REGISTRY_KEYS, 0, 1)));
  });

  it('and ↓ on the LAST group moves nothing — the edge the disabled arrow held', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    await ready();
    const last = REGISTRY_KEYS[REGISTRY_KEYS.length - 1];
    const name = labelOfGroup(last);
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText(`اسحب مجموعة ${name} لتغيير ترتيبها`), { code: 'Space', key: ' ' });
    });
    await until(() => expect(announced()).toContain(`أمسكتَ مجموعة «${name}»`));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    });
    await settle();
    expect(groupOrder()).toEqual(REGISTRY_KEYS);
  });

  it('and moving a group takes its screens with it, untouched — it never reshuffles a line', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    const before = Object.fromEntries(REGISTRY_KEYS.map((k) => [k, linesOf(k)]));
    await groupDown('ops');
    await until(() => expect(groupOrder()).not.toEqual(REGISTRY_KEYS));
    for (const k of REGISTRY_KEYS) expect(linesOf(k), k).toEqual(before[k]);
  });

  it('and a save sends the new group order, and the flat order of the screens follows it', async () => {
    mountCard();
    await screen.findAllByRole('listitem');
    await groupDown('today');
    await until(() => expect(groupOrder()).toEqual(reorderGroups(REGISTRY_KEYS, 0, 1)));
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
    expect(body.pinned).toEqual([]);
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['order', 'hidden', 'pinned', 'groups', 'slots']));
  });

  it('and a person who arranged the groups before sees them in that order — and saving without touching them sends them back', async () => {
    const mine = ['admin', 'ops', ...REGISTRY_KEYS.filter((k) => k !== 'admin' && k !== 'ops')];
    mountCard({ resolved: { ...EMPTY_LAYOUT, groups: mine }, own: { ...EMPTY_LAYOUT, groups: mine } });
    await screen.findAllByRole('listitem');
    expect(groupOrder()).toEqual(mine);
    expect((await save()).body.groups).toEqual(mine);
  });

  it('and a group that was added after somebody saved appears last, not lost — and an old key draws nothing', async () => {
    const saved = ['control', 'ops', 'chats', 'main', 'settings'];
    mountCard({ resolved: { ...EMPTY_LAYOUT, groups: saved }, own: { ...EMPTY_LAYOUT, groups: saved } });
    await screen.findAllByRole('listitem');
    expect(groupOrder().slice(0, 2)).toEqual(['ops', 'main']);
    expect(groupOrder().slice(2)).toEqual(REGISTRY_KEYS.filter((k) => k !== 'ops' && k !== 'main'));
  });

  it('and a person who may open only some groups arranges only those', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    expect(groupOrder()).toEqual(['main', 'confirmation', 'ops', 'finance', 'admin']);
    await groupDown('main');
    await until(() => expect(groupOrder()).toEqual(['confirmation', 'main', 'ops', 'finance', 'admin']));
    expect((await save()).body.groups).toEqual(['confirmation', 'main', 'ops', 'finance', 'admin']);
  });
});

describe('the groups — by the hand', () => {
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
  });
  afterEach(() => {
    watcher.disconnect();
  });

  const everHeard = () => heard.join(' ');
  const ev = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };

  /** Mounts, waits until the library has drawn its hidden instructions for EVERY context, and hands back a group's grip. */
  async function grip(key: string, over: Partial<Server> = {}) {
    mountCard(over);
    await screen.findAllByRole('listitem');
    await ready();
    return screen.getByLabelText(`اسحب مجموعة ${labelOfGroup(key)} لتغيير ترتيبها`);
  }

  // 18/11 (R6): the grip is the FIRST group's, `today` now (was `main`).
  it('— a pointer drag from a group’s grip puts the group where it was dropped, and says so in Arabic', async () => {
    const handle = await grip('today');
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

  it('and the keyboard does the same: Space to pick up, ↓ to move, Space to put down — the order `reorderGroups` gives', async () => {
    const handle = await grip('today'); // 18/11 (R6): the first group (was `main`)
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
    // CHANGED ON PURPOSE (18/11, R7): this used to remount and press the «انزل» arrow to compare; the arrow left, and the
    // pure function it asked is the reference instead.
    await until(() => expect(groupOrder(), 'الكيبورد ما حرّك المجموعة').toEqual(reorderGroups(REGISTRY_KEYS, 0, 1)));
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
    // 18/11 (R6): was NAV[0] — the first group is «اليوم», one screen; the lines of `main` are the second group's.
    const main = NAV.find((g) => g.key === 'main')!;
    const [first, second] = main.routes;
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
    const paths = main.routes.map((r) => r.path);
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
    // …and the property is `none` on every one of them.
    for (const el of noScroll) expect(el.style.touchAction, el.getAttribute('aria-label') ?? '').toBe('none');
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

// ───────────────────────── the role's base, on the roles screen ─────────────────────────

describe('the roles screen: the panel is the owner’s, and it holds the role’s three decisions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ roles: [] }) })));
  });

  it('— the roles screen mounts the panel, and for the holder of the role key it draws a picker of the roles', async () => {
    serve({ maySetRoleBase: true });
    render(<PermissionsScreen />);
    const picker = (await screen.findByLabelText('الدور')) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['اختر دور', 'مشرف']));
    expect(screen.getByText('قائمة كل دور')).toBeTruthy();
  });

  it('NEGATIVE: for whoever the door says may not set a role’s base, nothing is drawn — and the roles are not even asked for', async () => {
    serve({ maySetRoleBase: false });
    render(<PermissionsScreen />);
    await waitFor(() => expect(apiJson.mock.calls.some((c) => c[0] === '/api/nav/arrangement')).toBe(true));
    await settle();
    expect(screen.queryByText('قائمة كل دور')).toBeNull();
    expect(screen.queryByLabelText('الدور')).toBeNull();
    expect(apiJson.mock.calls.some((c) => c[0] === '/api/roles')).toBe(false);
  });

  it('and with ZERO roles it says so, and draws no picker', async () => {
    serve({ maySetRoleBase: true, roles: [] });
    render(<RoleMenuPanel />);
    await screen.findByText(/^ما في أدوار بعد\./);
    expect(screen.queryByLabelText('الدور')).toBeNull();
  });

  it('and nothing of the role is drawn until a role is picked', async () => {
    serve({ maySetRoleBase: true });
    render(<RoleMenuPanel />);
    await screen.findByLabelText('الدور');
    await settle();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByLabelText('المظهر الذي يفتح عليه هذا الدور')).toBeNull();
  });

  it('and a picked role draws its base menu (the same card), the four, and the look it opens on', async () => {
    await mountRole({ paths: AGENT_PATHS });
    expect(groupOrder()).toEqual(['main', 'confirmation', 'ops', 'finance', 'admin']);
    expect(slotSelects()).toHaveLength(4);
    expect(screen.getByLabelText('المظهر الذي يفتح عليه هذا الدور').tagName).toBe('SELECT');
    expect(screen.getByText(/^هذا أساس الدور/)).toBeTruthy();
    // the role card has no «رجّع الأساس»: that is a person's own row
    expect(screen.queryByText('رجّع الأساس')).toBeNull();
  });

  it('and the look saves to the role, by its own door', async () => {
    await mountRole({ paths: AGENT_PATHS });
    const look = screen.getByLabelText('المظهر الذي يفتح عليه هذا الدور') as HTMLSelectElement;
    const choice = within(look).getAllByRole('option')[1] as HTMLOptionElement;
    await act(async () => {
      fireEvent.change(look, { target: { value: choice.value } });
    });
    await screen.findByText('انحفظ.');
    const call = apiJson.mock.calls.find((c) => c[0] === '/api/roles/role-mod/theme')!;
    expect(call[1].method).toBe('PUT');
    expect(JSON.parse(call[1].body)).toEqual({ theme: choice.value });
  });
});

describe('the phone’s four — what the rows show (on the roles screen)', () => {
  it('— four rows, each a real select; with nothing chosen they show the SYSTEM’s four, and say so', async () => {
    await mountRole({ paths: AGENT_PATHS });
    expect(slotSelects()).toHaveLength(4);
    for (const s of slotSelects()) expect(s.tagName).toBe('SELECT');
    // The ranking puts the desk, the queue, the preparation and the tracking first — written out, so this is not `mobileNav` agreeing with itself.
    expect(slotValues()).toEqual(['/confirmation/mine', '/confirmation/queue', '/ops/preparation', '/ops/tracking']);
    expect(slotValues()).toEqual(systemFour(AGENT_PATHS));
    expect(screen.getByText(/^ترتيب النظام\. غيّر أي خانة/)).toBeTruthy();
    expect(slotSelects().map((s) => s.getAttribute('aria-label'))).toEqual(['الخانة الأولى', 'الخانة الثانية', 'الخانة الثالثة', 'الخانة الرابعة']);
  });

  it('and they come FIRST — four rows are not buried under a long page of groups', async () => {
    await mountRole({ paths: AGENT_PATHS });
    const slots = screen.getByText(SLOTS_TITLE);
    const firstGroup = document.querySelector('[data-menu-group]')!;
    expect(slots.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('and the section is named as the owner named it, says which side the first is on, and that the page you are on takes the last', async () => {
    await mountRole({ paths: AGENT_PATHS });
    expect(screen.getByRole('heading', { level: 3, name: SLOTS_TITLE })).toBeTruthy();
    expect(screen.getByText(/الأولى على اليمين/)).toBeTruthy();
    expect(screen.getByText('لما تفتح شاشة مش من الأربعة، بتاخد الخانة الأخيرة وإنت فيها.')).toBeTruthy();
  });

  it('and every select offers the screens the OTHER rows do not hold — so a screen cannot sit in two slots', async () => {
    await mountRole({ paths: AGENT_PATHS });
    const values = slotValues();
    // 18/11 (R6): the profile is no drawer line any more (`offMenu`).
    const menu = AGENT_PATHS.filter((p) => p !== '/admin/profile');
    slotSelects().forEach((s, i) => {
      const offered = optionsOf(s);
      for (const other of values.filter((_, j) => j !== i)) expect(offered, `الخانة ${i + 1} بتعرض ${other} وهي بخانة ثانية`).not.toContain(other);
      expect(offered).toContain(values[i]);
      expect(new Set(offered).size, 'خيار مكرّر').toBe(offered.length);
      expect([...offered].sort()).toEqual(menu.filter((p) => p === values[i] || !values.includes(p)).sort());
    });
  });

  it('and the choices are grouped as the drawer groups them, under their names', async () => {
    await mountRole({ paths: AGENT_PATHS });
    const groups = Array.from(slotSelects()[0].querySelectorAll('optgroup')).map((g) => g.getAttribute('label'));
    expect(groups).toEqual(expect.arrayContaining(['التأكيد'])); // 18/11 (R6): was «مركز التأكيد»
    expect(groups.every((g) => !!g && !/[A-Za-z]/.test(g))).toBe(true);
    expect(new Set(groups).size, 'عنوان مكرّر').toBe(groups.length);
  });

  it('and only a screen the DRAWER draws can take a slot — never the assistant’s page, the folded board or the profile', async () => {
    await mountRole(); // every screen openable
    const everything = new Set(slotSelects().flatMap(optionsOf));
    expect(everything.has('/assistant'), 'المساعد مش سطر بالقائمة').toBe(false);
    expect(everything.has('/growth/performance'), 'اللوحة مطويّة تحت لوحة التحكم').toBe(false);
    expect(everything.has('/admin/profile'), 'الملف الشخصي مش سطر بالقائمة').toBe(false);
    expect(everything.has('/dashboard')).toBe(true);
    const menu = ALL_PATHS.filter((p) => p !== '/assistant' && p !== '/growth/performance' && p !== '/admin/profile');
    expect([...everything].sort()).toEqual([...menu].sort());
  });

  it('and the board IS offered when the dashboard cannot be opened — it is a line of that drawer', async () => {
    await mountRole({ paths: ['/growth/performance', '/orders', '/admin/profile', '/customers', '/products'] });
    expect(new Set(slotSelects().flatMap(optionsOf)).has('/growth/performance')).toBe(true);
  });

  it('and fewer reachable screens than slots: as many rows as there are screens, each with only its own', async () => {
    await mountRole({ paths: ['/orders', '/customers'] });
    expect(slotSelects()).toHaveLength(2);
    expect(slotValues().sort()).toEqual(['/customers', '/orders']);
    for (const s of slotSelects()) expect(optionsOf(s)).toHaveLength(1);
    expect((screen.getByLabelText('انزل الخانة الثانية') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('ارفع الخانة الأولى') as HTMLButtonElement).disabled).toBe(true);
  });

  // RESTORED 18/11 (R7 review): it had been dropped in the move to the roles screen — the same claim, on the role panel.
  it('and ONE reachable screen is still a bar of one — the section is drawn, with nowhere for its arrows to go', async () => {
    await mountRole({ paths: ['/orders'] });
    expect(slotSelects()).toHaveLength(1);
    expect(slotValues()).toEqual(['/orders']);
    expect((screen.getByLabelText('ارفع الخانة الأولى') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('انزل الخانة الأولى') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('heading', { level: 3, name: SLOTS_TITLE })).toBeTruthy();
  });

  it('and with no screen the drawer draws there is nothing to arrange — the section is not drawn at all', async () => {
    await mountRole({ paths: ['/assistant'] });
    expect(slotSelects()).toHaveLength(0);
    expect(screen.queryByText(SLOTS_TITLE)).toBeNull();
  });
});

describe('the phone’s four — choosing, ordering, saving (to the ROLE)', () => {
  it('— picking a screen for a row changes that row, and a save sends the four exactly as the rows show them, to the role', async () => {
    await mountRole({ paths: AGENT_PATHS });
    await choose(3, '/orders');
    expect(slotValues()).toEqual(['/confirmation/mine', '/confirmation/queue', '/ops/preparation', '/orders']);
    const { url, body } = await save();
    expect(url).toBe('/api/nav/arrangement?roleId=role-mod');
    expect(body.slots).toEqual(['/confirmation/mine', '/confirmation/queue', '/ops/preparation', '/orders']);
    expect(body.groups).toEqual([]);
  });

  it('and the note stops saying «ترتيب النظام» the moment one changes — and says it is the role’s base', async () => {
    await mountRole({ paths: AGENT_PATHS });
    expect(screen.getByText(/^ترتيب النظام\./)).toBeTruthy();
    await choose(0, '/orders');
    expect(screen.queryByText(/^ترتيب النظام\./)).toBeNull();
    expect(screen.getByText(/^هاي خانات أساس الدور/)).toBeTruthy();
  });

  it('and a screen that left a row is offered again to the others — nothing is used up', async () => {
    await mountRole({ paths: AGENT_PATHS });
    await choose(0, '/orders');
    expect(optionsOf(slot(1))).toContain('/confirmation/mine');
    expect(optionsOf(slot(1))).not.toContain('/orders');
  });

  it('and the kit’s arrows swap two rows — and a swap at the edges is not even possible', async () => {
    await mountRole({ paths: AGENT_PATHS });
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

  it('and nothing is saved until one is changed — a ranking improved next month still reaches whoever never chose', async () => {
    await mountRole({ paths: AGENT_PATHS });
    fireEvent.change(slot(0), { target: { value: slot(0).value } });
    expect((await save()).body.slots).toEqual([]);
  });

  it('and a screen HIDDEN in the role’s base leaves the rows at once — it is out of the drawer, so out of the bar', async () => {
    await mountRole({ paths: AGENT_PATHS });
    expect(slotValues()).toContain('/ops/tracking');
    await click(`اخفِ ${findRoute('/ops/tracking')!.label}`);
    expect(slotValues()).not.toContain('/ops/tracking');
    expect(slotValues()).toHaveLength(4);
    expect(slotSelects().flatMap(optionsOf)).not.toContain('/ops/tracking');
    await click(`أظهر ${findRoute('/ops/tracking')!.label}`);
    expect(slotSelects().flatMap(optionsOf)).toContain('/ops/tracking');
  });

  it('and hiding does not erase a choice: the four saved come back when the screen does', async () => {
    const chosen = ['/ops/tracking', '/orders', '/confirmation/mine', '/ops/preparation'];
    await mountRole({ paths: AGENT_PATHS, roleBase: { 'role-mod': { ...EMPTY_LAYOUT, slots: chosen } } });
    expect(slotValues()).toEqual(chosen);
    await click(`اخفِ ${findRoute('/ops/tracking')!.label}`);
    expect(slotValues()).not.toContain('/ops/tracking');
    await click(`أظهر ${findRoute('/ops/tracking')!.label}`);
    expect(slotValues()).toEqual(chosen);
  });

  it('and a saved screen that cannot be opened is not shown — the row holds the next best, and the four are still four', async () => {
    const chosen = ['/finance/matching', '/orders', '/confirmation/mine', '/gone'];
    await mountRole({ paths: AGENT_PATHS, roleBase: { 'role-mod': { ...EMPTY_LAYOUT, slots: chosen } } });
    expect(slotValues()).toEqual(['/orders', '/confirmation/mine', '/confirmation/queue', '/ops/preparation']);
  });
});

describe('the owner, setting a role’s base — the groups and the four, for everybody in the role', () => {
  const ROLE_BASE: NavLayout = { ...EMPTY_LAYOUT, groups: ['ops', 'main'], slots: ['/ops/tracking', '/orders'], pinned: ['/orders'] };

  it('— a picked role loads ITS groups and four into the rows, and the note says they are the role’s', async () => {
    await mountRole({ paths: AGENT_PATHS, roleBase: { 'role-mod': ROLE_BASE } });
    await waitFor(() => expect(groupOrder().slice(0, 2)).toEqual(['ops', 'main']));
    expect(slotValues().slice(0, 2)).toEqual(['/ops/tracking', '/orders']);
    expect(screen.getByText(/^هاي خانات أساس الدور/)).toBeTruthy();
  });

  it('and saving writes to the ROLE, with both lists and its pins kept — not to the owner’s own row', async () => {
    await mountRole({ paths: AGENT_PATHS, roleBase: { 'role-mod': ROLE_BASE } });
    await groupDown('ops');
    await until(() => expect(groupOrder().slice(0, 2)).toEqual(['main', 'ops']));
    await choose(2, '/ops/preparation');
    const { url, body } = await save();
    expect(url).toBe('/api/nav/arrangement?roleId=role-mod');
    expect(body.groups).toEqual(['main', 'ops', 'confirmation', 'finance', 'admin']);
    expect(body.slots).toEqual(['/ops/tracking', '/orders', '/ops/preparation', '/confirmation/queue']);
    // CHANGED 18/11 (R7 review, last round): was toEqual([]) — a role's base keeps its pins (its members draw them).
    expect(body.pinned).toEqual(['/orders']);
  });

  /*
   * 18/11 (R7 review, last round): the role's base KEEPS its pins on a save. A member with a row of their own (an order,
   * no pins) draws the base's pins through `resolveLayout`; a save that posted the base's pins empty would reorder that
   * member's menu the moment the owner pressed «احفظ», with nothing changed.
   */
  it('and a role save with NO edits keeps the base’s pins — and a member’s menu draws the same after it', async () => {
    const base: NavLayout = { ...EMPTY_LAYOUT, pinned: ['/finance/wallets'] };
    const member: NavLayout = { ...EMPTY_LAYOUT, order: ['/finance/profit', '/finance/wallets'] };
    await mountRole({ roleBase: { 'role-mod': base } });
    const { url, body } = await save();
    expect(url).toBe('/api/nav/arrangement?roleId=role-mod');
    expect(body.pinned).toEqual(['/finance/wallets']);
    const keys = NAV.map((g) => g.key);
    const draw = (l: NavLayout) => applyArrangement(NAV, l).map((g) => [g.key, g.routes.map((r) => r.path)]);
    const before = draw(resolveLayout(base, member));
    const after = draw(resolveLayout(cleanLayout(body, ALL_PATHS, keys), member));
    expect(after).toEqual(before);
    const finance = after.find(([k]) => k === 'finance')![1] as string[];
    expect(finance.indexOf('/finance/wallets'), 'المحافظ نزلت تحت الأرباح').toBeLessThan(finance.indexOf('/finance/profit'));
  });

  it('and a role base with nothing chosen is saved as «no opinion», not as the system’s four frozen into it', async () => {
    await mountRole({ paths: AGENT_PATHS, roleBase: { 'role-mod': EMPTY_LAYOUT } });
    const { url, body } = await save();
    expect(url).toBe('/api/nav/arrangement?roleId=role-mod');
    expect(body.slots).toEqual([]);
    expect(body.groups).toEqual([]);
  });
});

describe('the owner’s base reaches whoever has no choice of their own', () => {
  const BASE: NavLayout = { ...EMPTY_LAYOUT, groups: ['ops', 'main'], slots: ['/orders', '/ops/tracking'] };

  it('— they see the owner’s groups first', async () => {
    mountCard({ paths: AGENT_PATHS, resolved: BASE, base: BASE, own: null });
    await screen.findAllByRole('listitem');
    expect(groupOrder().slice(0, 2)).toEqual(['ops', 'main']);
  });

  it('and saving for some OTHER reason (the eye) does not copy the owner’s choice into their own row — they stay attached to it', async () => {
    mountCard({ paths: AGENT_PATHS, resolved: BASE, base: BASE, own: null });
    await screen.findAllByRole('listitem');
    // CHANGED ON PURPOSE (18/11, R7): was a press of «ثبّت» — the pin left; the eye is the other reason to save now.
    await click(`اخفِ ${findRoute('/orders')!.label}`);
    const { body } = await save();
    expect(body.slots, 'الأساس انتسخ لصفّها').toEqual([]);
    expect(body.groups, 'الأساس انتسخ لصفّها').toEqual([]);
    expect(body.hidden).toContain('/orders');
  });

  /*
   * 18/11 (R7 review) — «the moment they change one, THAT part is theirs — the other stays the owner's» stood here: the
   * person changed one of the FOUR and owned the four while the groups stayed the base's. A person no longer edits the
   * four (they moved to the roles screen), so that half cannot happen; its other half — change ONE part and only that
   * part becomes yours — is held by the test below (the groups become theirs, the four stay the base's), and «saving for
   * some other reason does not copy» above.
   */
  it('and a person who moved the groups owns the groups, and still shares the owner’s four', async () => {
    mountCard({ paths: AGENT_PATHS, resolved: BASE, base: BASE, own: null });
    await screen.findAllByRole('listitem');
    await groupDown('ops');
    await until(() => expect(groupOrder().slice(0, 2)).toEqual(['main', 'ops']));
    const { body } = await save();
    expect(body.groups).toEqual(['main', 'ops', 'confirmation', 'finance', 'admin']);
    expect(body.slots).toEqual([]);
  });

  it('and their OWN choice, already saved, is theirs and is sent back whole', async () => {
    const own: NavLayout = { ...EMPTY_LAYOUT, groups: ['admin', 'main'], slots: ['/orders', '/finance/wallets'] };
    mountCard({ paths: AGENT_PATHS, resolved: own, base: BASE, own });
    await screen.findAllByRole('listitem');
    const { body } = await save();
    expect(body.groups).toEqual(['admin', 'main']);
    expect(body.slots).toEqual(['/orders', '/finance/wallets']);
  });
});

describe('«رجّع الأساس» brings the groups back too', () => {
  const OWN: NavLayout = { ...EMPTY_LAYOUT, groups: ['admin', 'ops'], slots: ['/orders', '/ops/tracking', '/finance/wallets', '/confirmation/mine'] };

  it('— it is offered only when there is something of their own, and one press sends the delete', async () => {
    mountCard({ paths: AGENT_PATHS });
    await screen.findAllByRole('listitem');
    expect(screen.queryByText('رجّع الأساس')).toBeNull();
    cleanup();

    mountCard({ paths: AGENT_PATHS, resolved: OWN, own: OWN });
    await screen.findAllByRole('listitem');
    expect(groupOrder().slice(0, 2)).toEqual(['admin', 'ops']);
    await act(async () => {
      fireEvent.click(screen.getByText('رجّع الأساس'));
    });
    const deletes = apiJson.mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toBe('/api/nav/arrangement');
  });

  it('and afterwards the screen is the system’s again — registry order for the groups, and the button is gone', async () => {
    mountCard({ paths: AGENT_PATHS, resolved: OWN, own: OWN });
    await screen.findAllByRole('listitem');
    await act(async () => {
      fireEvent.click(screen.getByText('رجّع الأساس'));
    });
    await waitFor(() => expect(groupOrder()).toEqual(['main', 'confirmation', 'ops', 'finance', 'admin']));
    expect(screen.queryByText('رجّع الأساس'), 'الزر ظل بعد الإرجاع').toBeNull();
  });

  it('and when the owner has a base, it is THAT that comes back — and a save after it does not copy it', async () => {
    const base: NavLayout = { ...EMPTY_LAYOUT, groups: ['finance'], slots: ['/finance/wallets', '/orders'] };
    mountCard({ paths: AGENT_PATHS, resolved: OWN, own: OWN, base, afterReset: { resolved: base, base } });
    await screen.findAllByRole('listitem');
    await act(async () => {
      fireEvent.click(screen.getByText('رجّع الأساس'));
    });
    await waitFor(() => expect(groupOrder()[0]).toBe('finance'));
    const { body } = await save();
    expect(body.groups).toEqual([]);
    expect(body.slots).toEqual([]);
  });
});

// ───────────────────────── phone first, Arabic only, real controls ─────────────────────────

describe('built for a thumb, in Arabic, from real controls', () => {
  it('— every grip is a real button with the 44px minimum on a phone; the four’s arrows are the kit’s; every select the product’s own', async () => {
    await mountRole({ paths: AGENT_PATHS });
    const grips = Array.from(document.querySelectorAll<HTMLElement>('[data-menu-group] > div > div:first-child button'));
    expect(grips).toHaveLength(5);
    for (const b of grips) {
      expect(b.getAttribute('type'), b.getAttribute('aria-label') ?? '').toBe('button');
      expect(b.className, b.getAttribute('aria-label') ?? '').toContain('min-h-11');
      expect(b.className).toContain('md:min-h-0');
    }
    const arrows = slotSelects().flatMap((s) => Array.from((s.parentElement!.parentElement as HTMLElement).querySelectorAll<HTMLElement>('button')));
    expect(arrows).toHaveLength(2 * 4);
    for (const b of arrows) {
      expect(b.tagName).toBe('BUTTON');
      // the kit's square: 44 on a phone, both ways
      expect(b.className, b.getAttribute('aria-label') ?? '').toContain('h-11');
      expect(b.className).toContain('w-11');
      expect(b.getAttribute('title')).toBe(b.getAttribute('aria-label'));
    }
    for (const s of slotSelects()) {
      expect(s.className).toContain('h-11');
      expect(s.className).toContain('md:h-10');
    }
  });

  it('and nothing a person can see or hear is in English — the card and the panel', async () => {
    await mountRole({ paths: AGENT_PATHS });
    const container = document.body;
    /*
     * WHAT A PERSON SEES — NOT WHAT THE LIBRARY HIDES. The drag library draws its hidden instructions and its live region
     * INLINE, and only after its own first effect; they are held separately below (they are read aloud, not seen).
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
    await waitFor(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]').length).toBeGreaterThan(0));
    const spoken = Array.from(document.querySelectorAll('[id^="DndDescribedBy"]')).map((e) => e.textContent ?? '');
    expect(spoken.some((t) => t.includes('لتغيير ترتيب هذه المجموعة'))).toBe(true);
    for (const t of spoken) expect(t.replace('Esc', ''), t).not.toMatch(/[A-Za-z]/);
  });

  it('and no new CSS: every class the card and the panel use is one the product already ships', () => {
    /*
     * NO NEW CSS — the first-load stylesheet is under a ratchet (`quality-gates.test.ts`): a class nobody else ships grows
     * it. So the card and the panel (18/11, R7) are held to the classes their siblings already wear. The scan reads
     * `className="…"` literals, which is the only way either writes a class.
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
    const own = [join(root, 'components/settings/MenuOrderCard.tsx'), join(root, 'components/settings/RoleMenuPanel.tsx')];
    const used = new Set(own.flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    expect(used.size, 'the card has classes').toBeGreaterThan(30);
    const elsewhere = new Set(files.filter((f) => !own.includes(f)).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
    for (const f of ['src/components/settings/MenuOrderCard.tsx', 'src/components/settings/RoleMenuPanel.tsx']) {
      expect(stripComments(repoFile(f)), `${f}: a class built at run time escapes the scan`).not.toMatch(/className=\{[^}]*(`|clsx|cn\()/);
    }
  });
});

// ───────────────────────── how it is wired ─────────────────────────

describe('and the wiring is the one that holds the rules', () => {
  const src = () => stripComments(repoFile('src/components/settings/MenuOrderCard.tsx'));
  const panel = () => stripComments(repoFile('src/components/settings/RoleMenuPanel.tsx'));

  // CHANGED ON PURPOSE (18/11, R7): was «the arrows and the drag of a GROUP both go through reorderGroups». The group arrows left;
  // the drag (pointer and keyboard alike) goes through `groupsAfterDrag`, which is `reorderGroups`.
  it('— the drag of a GROUP goes through groupsAfterDrag, the arrows and the pick of a SLOT through the pure slot functions', () => {
    const s = src();
    expect(s).not.toContain('reorderGroups(');
    expect(s).toContain('groupsAfterDrag(groupKeys, end)');
    expect(s).toContain('onDragEnd={droppedGroup}');
    expect(s).toContain('chooseSlot(shownSlots, i, e.target.value)');
    expect(s).toContain('reorderSlots(shownSlots, i, i - 1)');
    expect(s).toContain('reorderSlots(shownSlots, i, i + 1)');
    expect(s).not.toMatch(/\.splice\(/);
  });

  it('and the four are drawn for a role’s base only', () => {
    expect(src()).toContain('{forRole && shownSlots.length > 0 && (');
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
    expect(s.match(/sensors=\{sensors\}/g)).toHaveLength(2);
  });

  it('and a save always carries both keys — empty is «no opinion», absent would be «an older tab»', () => {
    const s = src();
    expect(s).toContain('groups: inherited.groups ? [] : (layout.groups ?? [])');
    expect(s).toContain('slots: inherited.slots ? [] : (layout.slots ?? [])');
  });

  it('and each group is ONE sortable block, tagged with the group it is', () => {
    const s = src();
    expect(s.match(/<SortableGroup\b/g)).toHaveLength(1);
    expect(s).toMatch(/<div\s+ref=\{setNodeRef\}\s+data-menu-group=\{group\.key\}/);
  });

  it('and the panel is not a second editor: it draws the same card in role mode, and has no drag of its own', () => {
    const p = panel();
    expect(p.match(/<MenuOrderCard\b/g)).toHaveLength(1);
    // 18/11 (R7 review): the card and the look are siblings — each needs a key of its own, or React keeps the old card.
    expect(p).toContain('<MenuOrderCard key={`card-${roleId}`} forRole={roleId} />');
    expect(p).toContain('<RoleOpeningTheme key={`look-${roleId}`} roleId={roleId} />');
    expect(p).not.toContain('DndContext');
    expect(p).not.toContain('useSortable');
    // the door's own flag, no new check
    expect(p).toContain('maySetRoleBase');
    expect(p).not.toMatch(/userCan\(|can\(/);
  });

  it('and the roles screen mounts it ONCE', () => {
    const screenSrc = stripComments(repoFile('src/components/screens/PermissionsScreen.tsx'));
    expect(screenSrc.match(/<RoleMenuPanel \/>/g)).toHaveLength(1);
  });
});
