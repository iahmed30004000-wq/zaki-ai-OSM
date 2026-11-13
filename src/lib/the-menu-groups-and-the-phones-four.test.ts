import { describe, expect, it } from 'vitest';
import { attachGrants, can } from './authorization';
import { BOTTOM_SLOTS, mobileNav } from './mobile-nav';
import {
  applyArrangement,
  carryUnsaid,
  chooseSlot,
  cleanLayout,
  EMPTY_LAYOUT,
  groupsAfterDrag,
  parseLayout,
  reorderGroups,
  reorderSlots,
  resolveLayout,
  type NavLayout,
} from './nav-arrangement';
import { ALL_ROUTES, isMenuLine, menuNav, NAV, visibleNav, type NavGroup } from './route-registry';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE MAIN CELLS OF THE MENU, ARRANGED — THE GROUPS AND THE PHONE'S FOUR (13/11).
 *
 *   «زر رتّب القائمة لترتيب القوائم والخانات الرئيسية» (the owner, from the open drawer)
 *
 * Read as two things the arrangement never held: the ORDER OF THE GROUPS (the drawer's
 * main entries) and WHICH FOUR SCREENS sit in the phone's bottom bar. Both are stored in
 * the layout beside the three lists, and what is held here is the pure half — every
 * function that reads, merges, applies and moves them — by tables, because the cases
 * that matter are the ones nobody thinks to click:
 *
 *   • an old layout, a role base, a tab older than this: «exactly as today»;
 *   • a group or a screen that no longer exists, or that the person cannot open;
 *   • fewer reachable screens than slots, a repeat, an empty list, a layout that names
 *     every group but one;
 *   • and that none of it ADDS anything: arranging reorders what it is handed.
 * ═══════════════════════════════════════════════════════════════════════
 */

const group = (key: string, ...paths: string[]): NavGroup => ({
  key,
  label: key,
  routes: paths.map((path) => ({ path, label: path, icon: 'List', permissions: null })),
});
const MENU = (): NavGroup[] => [
  group('a', '/a1', '/a2'),
  group('b', '/b1'),
  group('c', '/c1', '/c2'),
  group('d', '/d1'),
];
const keys = (gs: NavGroup[]) => gs.map((g) => g.key);
const pathsOf = (gs: NavGroup[]) => gs.flatMap((g) => g.routes.map((r) => r.path));
const lay = (over: Partial<NavLayout> = {}): NavLayout => ({ ...EMPTY_LAYOUT, ...over });

// ───────────────────────── reading a stored layout ─────────────────────────

describe('a stored layout with the two newer opinions, read defensively', () => {
  it('— junk in either field is nothing, never a throw: a menu is the one thing that must render', () => {
    for (const bad of [null, 'x', 7, true, {}, [], 'ops', { x: 1 }, [7, null, ''], { 0: 'a' }]) {
      for (const field of ['groups', 'slots'] as const) {
        const out = parseLayout({ order: [], hidden: [], pinned: [], [field]: bad });
        expect(out, `${field}: ${JSON.stringify(bad)}`).toEqual(EMPTY_LAYOUT);
        expect(field in out, `${field} صار مفتاحاً فاضياً`).toBe(false);
      }
    }
  });

  it('and keeps only the strings of a half-written list, each once, none empty', () => {
    expect(parseLayout({ order: [], hidden: [], pinned: [], groups: ['ops', 7, null, '', 'ops', 'main', {}, 'ops'] }).groups).toEqual([
      'ops',
      'main',
    ]);
    expect(parseLayout({ order: [], hidden: [], pinned: [], slots: ['/orders', '/orders', 9, '', '/products'] }).slots).toEqual([
      '/orders',
      '/products',
    ]);
  });

  it('and an EMPTY list is the same as no list — the key is simply not there', () => {
    const out = parseLayout({ order: ['/a'], hidden: [], pinned: [], groups: [], slots: [] });
    expect(Object.keys(out).sort()).toEqual(['hidden', 'order', 'pinned']);
    expect(out).toEqual({ order: ['/a'], hidden: [], pinned: [] });
  });

  it('and a layout stored before they existed reads as exactly its three lists', () => {
    const old = { order: ['/a', '/b'], hidden: ['/c'], pinned: ['/a'] };
    expect(parseLayout(old)).toEqual(old);
    expect(parseLayout(JSON.stringify(old))).toEqual(old);
    expect(Object.keys(parseLayout(JSON.stringify(old))).sort()).toEqual(['hidden', 'order', 'pinned']);
  });

  it('and reads the JSON the column holds, both fields and all — and writes back the same thing', () => {
    const full: NavLayout = { order: ['/a'], hidden: [], pinned: ['/a'], groups: ['b', 'a'], slots: ['/orders', '/products'] };
    expect(parseLayout(JSON.stringify(full))).toEqual(full);
    expect(parseLayout(parseLayout(JSON.stringify(full)))).toEqual(full);
  });

  it('and the published views are still read, beside them', () => {
    const out = parseLayout({ order: [], hidden: [], pinned: [], groups: ['a'], views: [{ name: 'عرض', query: 'q=1' }] });
    expect(out.groups).toEqual(['a']);
    expect(out.views).toEqual([{ name: 'عرض', query: 'q=1' }]);
  });
});

// ───────────────────────── the role's base, then mine ─────────────────────────

describe('resolveLayout — the person’s own wins when it says anything, field by field', () => {
  const base = lay({ groups: ['c', 'a'], slots: ['/c1', '/a1'] });

  it.each([
    ['the person has nothing: the base answers both', null, { groups: ['c', 'a'], slots: ['/c1', '/a1'] }],
    ['an own row that says nothing about them: the base answers both', lay({ order: ['/a1'] }), { groups: ['c', 'a'], slots: ['/c1', '/a1'] }],
    ['own groups only: the groups are theirs, the four are the base’s', lay({ groups: ['d'] }), { groups: ['d'], slots: ['/c1', '/a1'] }],
    ['own slots only: the four are theirs, the groups are the base’s', lay({ slots: ['/d1'] }), { groups: ['c', 'a'], slots: ['/d1'] }],
    ['both own: both theirs, not merged with the base', lay({ groups: ['d', 'b'], slots: ['/b1', '/d1'] }), { groups: ['d', 'b'], slots: ['/b1', '/d1'] }],
    ['an EMPTY list is not an opinion (a layout built by hand with one)', lay({ groups: [], slots: [] }), { groups: ['c', 'a'], slots: ['/c1', '/a1'] }],
  ])('%s', (_name, own, want) => {
    const r = resolveLayout(base, own);
    expect(r.groups).toEqual(want.groups);
    expect(r.slots).toEqual(want.slots);
  });

  it('and with no base, the person’s own stands; with neither, there is no key at all', () => {
    expect(resolveLayout(null, lay({ groups: ['b'], slots: ['/b1'] }))).toEqual(lay({ groups: ['b'], slots: ['/b1'] }));
    const none = resolveLayout(null, null);
    expect(none).toEqual(EMPTY_LAYOUT);
    expect(Object.keys(none).sort()).toEqual(['hidden', 'order', 'pinned']);
    // …and a base that has none either, with a person who has none either: the same.
    expect(Object.keys(resolveLayout(lay({ order: ['/a1'] }), lay({ pinned: ['/a1'] }))).sort()).toEqual(['hidden', 'order', 'pinned']);
  });

  it('two people of one role: each their own — and the one who said nothing gets the base', () => {
    const salwa = resolveLayout(base, lay({ groups: ['d'] }));
    const hana = resolveLayout(base, null);
    expect(salwa.groups).toEqual(['d']);
    expect(hana.groups).toEqual(['c', 'a']);
    // the base object itself is not touched by either
    expect(base.groups).toEqual(['c', 'a']);
  });

  it('«رجّع الأساس» is exactly «I have nothing of my own», for the new fields too', () => {
    expect(resolveLayout(base, null)).toEqual(resolveLayout(base, EMPTY_LAYOUT));
  });

  it('and the three older lists and the views still resolve as they did', () => {
    const b = lay({ order: ['/a1'], hidden: ['/b1'], views: [{ name: 'الأساس', query: 'x=1' }] });
    const o = lay({ order: [], hidden: [], pinned: ['/c1'], views: [{ name: 'عرضي', query: 'y=2' }], groups: ['b'] });
    const r = resolveLayout(b, o);
    expect(r.order).toEqual(['/a1']);
    expect(r.hidden).toEqual(['/b1']);
    expect(r.pinned).toEqual(['/c1']);
    expect(r.views!.map((v) => v.name)).toEqual(['عرضي', 'الأساس']);
    expect(r.groups).toEqual(['b']);
  });
});

// ───────────────────────── the groups, in the order the person put them ─────────────────────────

describe('applyArrangement — the groups', () => {
  it('puts the groups in the order named', () => {
    expect(keys(applyArrangement(MENU(), lay({ groups: ['d', 'c', 'b', 'a'] })))).toEqual(['d', 'c', 'b', 'a']);
  });

  it('and a group nobody listed comes AFTER the listed ones, in the order it arrived — a group added next week appears without a migration', () => {
    expect(keys(applyArrangement(MENU(), lay({ groups: ['c'] })))).toEqual(['c', 'a', 'b', 'd']);
    expect(keys(applyArrangement(MENU(), lay({ groups: ['d', 'b'] })))).toEqual(['d', 'b', 'a', 'c']);
  });

  it('and a layout that lists every group but one puts the missing one LAST — even the one that was first', () => {
    expect(keys(applyArrangement(MENU(), lay({ groups: ['d', 'c', 'b'] })))).toEqual(['d', 'c', 'b', 'a']);
    expect(keys(applyArrangement(MENU(), lay({ groups: ['b', 'c', 'd'] })))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('and a key that no longer exists falls out, and does not hold a place', () => {
    expect(keys(applyArrangement(MENU(), lay({ groups: ['gone', 'b', 'also-gone'] })))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('and an empty `groups`, or none, is the registry’s order — exactly', () => {
    const plain = keys(MENU());
    expect(keys(applyArrangement(MENU(), lay({ groups: [] })))).toEqual(plain);
    expect(keys(applyArrangement(MENU(), lay()))).toEqual(plain);
    expect(keys(applyArrangement(MENU(), lay({ order: ['/b1'] })))).toEqual(plain);
  });

  it('and a group listed twice is one group, at the first place', () => {
    expect(keys(applyArrangement(MENU(), lay({ groups: ['c', 'a', 'c', 'd'] })))).toEqual(['c', 'a', 'd', 'b']);
  });

  it('and a listed group that has nothing left is dropped, and holds no place', () => {
    const out = applyArrangement(MENU(), lay({ groups: ['a', 'b', 'c'], hidden: ['/a1', '/a2'] }));
    expect(keys(out)).toEqual(['b', 'c', 'd']);
  });

  it('and the lines inside are still arranged on their own — the two do not meet', () => {
    const out = applyArrangement(MENU(), lay({ groups: ['c', 'a'], order: ['/c2', '/c1'], pinned: ['/a2'] }));
    expect(keys(out)).toEqual(['c', 'a', 'b', 'd']);
    expect(out[0].routes.map((r) => r.path)).toEqual(['/c2', '/c1']);
    expect(out[1].routes.map((r) => r.path)).toEqual(['/a2', '/a1']);
  });

  it('and with no layout at all it hands back what it was given, the very same list', () => {
    const menu = MENU();
    expect(applyArrangement(menu, null)).toBe(menu);
  });

  it('and it only reorders: the same groups, the same routes, nothing added, nothing doubled, the input untouched', () => {
    const menu = MENU();
    const before = JSON.stringify(menu);
    const out = applyArrangement(menu, lay({ groups: ['zzz', 'd', 'a', 'a', 'forged'] }));
    expect(JSON.stringify(menu)).toBe(before);
    expect([...keys(out)].sort()).toEqual([...keys(menu)].sort());
    expect([...pathsOf(out)].sort()).toEqual([...pathsOf(menu)].sort());
  });

  it('and it is idempotent — arranging what is already arranged changes nothing', () => {
    const layout = lay({ groups: ['d', 'b'], order: ['/c2'] });
    const once = applyArrangement(MENU(), layout);
    expect(applyArrangement(once, layout)).toEqual(once);
  });

  it('and it holds for the real registry: every hub and loose group, moved to the front one by one', () => {
    const all = NAV.map((g) => g.key);
    for (const key of all) {
      const out = applyArrangement(NAV, lay({ groups: [key] }));
      expect(out[0].key, key).toBe(key);
      // the group keeps what it was — its hub, its icon, every route
      const was = NAV.find((g) => g.key === key)!;
      expect(out[0].hub).toBe(was.hub);
      expect(out[0].icon).toBe(was.icon);
      expect(out[0].routes.map((r) => r.path).sort()).toEqual(was.routes.map((r) => r.path).sort());
      expect(out.map((g) => g.key).sort()).toEqual([...all].sort());
    }
    expect(keys(applyArrangement(NAV, lay({ groups: [...all].reverse() })))).toEqual([...all].reverse());
  });
});

// ───────────────────────── moving one group or one slot ─────────────────────────

describe('reorderGroups and reorderSlots', () => {
  const K = ['a', 'b', 'c', 'd'];

  it.each([
    ['down by one', 0, 1, ['b', 'a', 'c', 'd']],
    ['up by one', 2, 1, ['a', 'c', 'b', 'd']],
    ['to the end', 0, 3, ['b', 'c', 'd', 'a']],
    ['to the start', 3, 0, ['d', 'a', 'b', 'c']],
    ['the middle two', 1, 2, ['a', 'c', 'b', 'd']],
  ])('%s', (_name, from, to, want) => {
    expect(reorderGroups(K, from, to)).toEqual(want);
    expect(reorderSlots(K, from, to)).toEqual(want);
  });

  it.each([
    ['the same place', 2, 2],
    ['before the start', 1, -1],
    ['past the end', 1, 4],
    ['from nowhere', -1, 1],
    ['from past the end', 9, 1],
    ['no place at all (NaN)', Number.NaN, 1],
    ['a place between two', 0.5, 2],
    ['an infinite place', 1, Infinity],
  ])('and a move %s leaves it as it was — and hands back a copy, not the same list', (_name, from, to) => {
    const out = reorderGroups(K, from, to);
    expect(out).toEqual(K);
    expect(out).not.toBe(K);
    expect(reorderSlots(K, from, to)).toEqual(K);
  });

  it('and an empty list, or one item, has nowhere to go', () => {
    expect(reorderGroups([], 0, 1)).toEqual([]);
    expect(reorderGroups(['a'], 0, 0)).toEqual(['a']);
    expect(reorderGroups(['a'], 0, 1)).toEqual(['a']);
  });

  it('and it never changes the list it was given', () => {
    const k = [...K];
    reorderGroups(k, 0, 3);
    reorderSlots(k, 3, 0);
    expect(k).toEqual(K);
  });

  it('and it is a permutation: nothing lost, nothing doubled, over a long walk', () => {
    let order = [...K, 'e', 'f'];
    let seed = 11;
    const next = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 300; i++) {
      order = reorderGroups(order, next(order.length), next(order.length));
      expect(order).toHaveLength(6);
    }
    expect([...order].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('groupsAfterDrag — a finished drag, refused unless it names two groups of this list', () => {
  const K = ['a', 'b', 'c', 'd'];

  it('— moves the group to where it was dropped', () => {
    expect(groupsAfterDrag(K, { active: { id: 'a' }, over: { id: 'c' } })).toEqual(['b', 'c', 'a', 'd']);
    expect(groupsAfterDrag(K, { active: { id: 'd' }, over: { id: 'a' } })).toEqual(['d', 'a', 'b', 'c']);
  });

  it.each([
    ['a drop on nothing', { active: { id: 'a' }, over: null }],
    ['a drop on itself', { active: { id: 'b' }, over: { id: 'b' } }],
    ['a group that is not in the list, dragged', { active: { id: 'nope' }, over: { id: 'b' } }],
    ['a drop on a group that is not in the list', { active: { id: 'a' }, over: { id: 'nope' } }],
    ['a SCREEN’s path dragged onto the groups', { active: { id: '/a1' }, over: { id: 'b' } }],
    ['a group dropped on a screen’s path', { active: { id: 'a' }, over: { id: '/b1' } }],
  ])('and %s moves nothing', (_name, end) => {
    expect(groupsAfterDrag(K, end)).toBeNull();
  });

  it('and the buttons and the drag cannot disagree: every move, both ways, gives the same list', () => {
    let checked = 0;
    K.forEach((key, i) => {
      for (const by of [-1, 1]) {
        const to = i + by;
        if (to < 0 || to >= K.length) continue;
        expect(groupsAfterDrag(K, { active: { id: key }, over: { id: K[to] } }), `${key} ${by}`).toEqual(reorderGroups(K, i, to));
        checked++;
      }
    });
    // Six real moves in a list of four — so the loop above cannot pass by looking at nothing.
    expect(checked).toBe(6);
  });

  it('and it accepts the numeric ids the library may hand over', () => {
    expect(groupsAfterDrag(['1', '2', '3'], { active: { id: 1 }, over: { id: 3 } })).toEqual(['2', '3', '1']);
  });
});

describe('chooseSlot — the four after a screen is picked for one of them', () => {
  const four = ['/p', '/q', '/r', '/s'];

  it('— replaces what the slot held', () => {
    expect(chooseSlot(four, 1, '/z')).toEqual(['/p', '/z', '/r', '/s']);
  });

  it('and a screen already in ANOTHER slot swaps places with it — one tab is never drawn twice', () => {
    expect(chooseSlot(four, 0, '/r')).toEqual(['/r', '/q', '/p', '/s']);
    expect(chooseSlot(four, 3, '/p')).toEqual(['/s', '/q', '/r', '/p']);
    for (let at = 0; at < 4; at++) {
      for (const path of ['/p', '/q', '/r', '/s', '/z']) {
        const out = chooseSlot(four, at, path);
        expect(new Set(out).size, `${at} ← ${path}`).toBe(4);
        expect(out[at]).toBe(path);
      }
    }
  });

  it('and the screen it already holds changes nothing', () => {
    expect(chooseSlot(four, 2, '/r')).toEqual(four);
  });

  it.each([
    ['a slot that does not exist', 9, '/z'],
    ['a negative slot', -1, '/z'],
    ['no slot (NaN)', Number.NaN, '/z'],
    ['an empty path', 1, ''],
  ])('and %s changes nothing, and is handed back as a copy', (_name, at, path) => {
    const out = chooseSlot(four, at, path);
    expect(out).toEqual(four);
    expect(out).not.toBe(four);
  });

  it('and it never changes the list it was given', () => {
    const copy = [...four];
    chooseSlot(copy, 0, '/r');
    expect(copy).toEqual(four);
  });
});

// ───────────────────────── what is saved ─────────────────────────

describe('cleanLayout — what a save keeps', () => {
  const allowed = ['/a1', '/a2', '/b1', '/c1', '/d1', '/orders', '/products', '/customers', '/dashboard'];
  const groupKeys = ['a', 'b', 'c', 'd'];

  it('— the old call, with two arguments, gives exactly the old answer', () => {
    const out = cleanLayout({ order: ['/a1', '/gone'], hidden: ['/gone'], pinned: ['/b1'] }, allowed);
    expect(out).toEqual({ order: ['/a1'], hidden: [], pinned: ['/b1'] });
    expect(Object.keys(out).sort()).toEqual(['hidden', 'order', 'pinned']);
  });

  it('and a group key it was not told about is dropped, the rest kept in their order', () => {
    expect(cleanLayout(lay({ groups: ['d', 'forged', 'a', 'x'] }), allowed, groupKeys).groups).toEqual(['d', 'a']);
  });

  it('and a group listed twice is kept once', () => {
    expect(cleanLayout(lay({ groups: ['b', 'a', 'b'] }), allowed, groupKeys).groups).toEqual(['b', 'a']);
  });

  it('and without the keys to check against, the groups are DROPPED, not trusted — a caller that forgot loses them loudly', () => {
    expect(cleanLayout(lay({ groups: ['a', 'b'] }), allowed).groups).toBeUndefined();
    expect(cleanLayout(lay({ groups: ['a', 'b'] }), allowed, []).groups).toBeUndefined();
  });

  it('and a slot that is not a screen of this person is dropped', () => {
    expect(cleanLayout(lay({ slots: ['/finance/wallets', '/orders', '/forged', '/products'] }), allowed, groupKeys).slots).toEqual([
      '/orders',
      '/products',
    ]);
  });

  it('and a slot repeated is kept once — the first place wins', () => {
    expect(cleanLayout(lay({ slots: ['/orders', '/products', '/orders', '/customers'] }), allowed, groupKeys).slots).toEqual([
      '/orders',
      '/products',
      '/customers',
    ]);
  });

  it('and the slots are cut at what the bar holds — AFTER the stale ones fell out, so one forged entry costs no slot', () => {
    const six = ['/orders', '/products', '/customers', '/dashboard', '/a1', '/b1'];
    expect(cleanLayout(lay({ slots: six }), allowed, groupKeys).slots).toEqual(six.slice(0, BOTTOM_SLOTS));
    const withStale = ['/forged', '/orders', '/products', '/customers', '/dashboard', '/a1'];
    expect(cleanLayout(lay({ slots: withStale }), allowed, groupKeys).slots).toEqual(['/orders', '/products', '/customers', '/dashboard']);
  });

  it('and what is left empty is not stored as an empty list — the key is not there', () => {
    const out = cleanLayout(lay({ groups: ['nope'], slots: ['/nope'] }), allowed, groupKeys);
    expect(Object.keys(out).sort()).toEqual(['hidden', 'order', 'pinned']);
  });

  it('and it never changes what it was given', () => {
    const input = lay({ groups: ['d', 'nope'], slots: ['/orders', '/nope'] });
    const before = JSON.stringify(input);
    cleanLayout(input, allowed, groupKeys);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('carryUnsaid — a save that did not mention them is not a save that erases them', () => {
  const stored = lay({ order: ['/old'], groups: ['c', 'a'], slots: ['/c1', '/a1'] });
  const posted = lay({ order: ['/new'], hidden: ['/h'], pinned: ['/p'] });

  it('— an older tab posts the three lists: the groups and the four it has never heard of are kept', () => {
    const out = carryUnsaid(stored, posted, { groups: false, slots: false });
    expect(out.groups).toEqual(['c', 'a']);
    expect(out.slots).toEqual(['/c1', '/a1']);
    // …and the three it DID post are the post’s, never the stored ones
    expect(out.order).toEqual(['/new']);
    expect(out.hidden).toEqual(['/h']);
    expect(out.pinned).toEqual(['/p']);
  });

  it('and a current client that posts BOTH — even empty — replaces them, which is how it says «no opinion»', () => {
    const out = carryUnsaid(stored, posted, { groups: true, slots: true });
    expect(out.groups).toBeUndefined();
    expect(out.slots).toBeUndefined();
    expect('groups' in out || 'slots' in out).toBe(false);
  });

  it('and one of them said, the other not: each is answered on its own', () => {
    const saidGroups = carryUnsaid(stored, lay({ ...posted, groups: ['d'] }), { groups: true, slots: false });
    expect(saidGroups.groups).toEqual(['d']);
    expect(saidGroups.slots).toEqual(['/c1', '/a1']);
    const saidSlots = carryUnsaid(stored, lay({ ...posted, slots: ['/d1'] }), { groups: false, slots: true });
    expect(saidSlots.groups).toEqual(['c', 'a']);
    expect(saidSlots.slots).toEqual(['/d1']);
  });

  it('and with nothing stored there is nothing to carry — the post stands as it is', () => {
    expect(carryUnsaid(null, posted, { groups: false, slots: false })).toEqual(posted);
    expect(carryUnsaid(EMPTY_LAYOUT, posted, { groups: false, slots: false })).toEqual(posted);
    expect(carryUnsaid(lay({ groups: [], slots: [] }), posted, { groups: false, slots: false })).toEqual(posted);
  });

  it('and it never changes the layouts it was given', () => {
    const s = JSON.stringify(stored);
    const p = JSON.stringify(posted);
    carryUnsaid(stored, posted, { groups: false, slots: false });
    expect(JSON.stringify(stored)).toBe(s);
    expect(JSON.stringify(posted)).toBe(p);
  });
});

// ───────────────────────── the phone's bottom bar ─────────────────────────

describe('mobileNav with the person’s own four', () => {
  // A menu with a real spread of ranked and unranked screens, in the groups a drawer would hold.
  const WORKER = (): NavGroup[] => [
    group('main', '/dashboard', '/orders', '/customers', '/products'),
    group('confirmation', '/confirmation/queue', '/confirmation/mine', '/confirmation/issues'),
    group('ops', '/ops/preparation', '/ops/tracking', '/ops/returns', '/ops/batches'),
    group('settings', '/settings/system'),
  ];
  const prim = (groups: NavGroup[], current?: string | null, slots?: readonly string[]) =>
    mobileNav(groups, current, slots).primary.map((r) => r.path);

  it('— with no choice, the four are the ranking, exactly as they were (none, undefined and empty are one thing)', () => {
    const plain = mobileNav(WORKER(), '/orders');
    for (const slots of [undefined, []] as const) {
      const out = mobileNav(WORKER(), '/orders', slots);
      expect(out.primary.map((r) => r.path)).toEqual(plain.primary.map((r) => r.path));
      expect(out.rest.map((g) => g.routes.map((r) => r.path))).toEqual(plain.rest.map((g) => g.routes.map((r) => r.path)));
    }
    expect(prim(WORKER())).toEqual(['/confirmation/mine', '/confirmation/queue', '/ops/preparation', '/ops/tracking']);
  });

  it('— the saved four come in the order the person put them, and the sheet holds the rest', () => {
    const slots = ['/products', '/ops/returns', '/dashboard', '/customers'];
    const { primary, rest } = mobileNav(WORKER(), null, slots);
    expect(primary.map((r) => r.path)).toEqual(slots);
    const inSheet = pathsOf(rest);
    for (const path of slots) expect(inSheet).not.toContain(path);
    expect([...inSheet, ...slots].sort()).toEqual(pathsOf(WORKER()).sort());
  });

  it('and fewer than four saved: the ranking fills the rest, best first, never repeating a saved one', () => {
    expect(prim(WORKER(), null, ['/settings/system'])).toEqual([
      '/settings/system',
      '/confirmation/mine',
      '/confirmation/queue',
      '/ops/preparation',
    ]);
    // the ranked one the person already chose is not offered again as a filler
    expect(prim(WORKER(), null, ['/confirmation/mine', '/products'])).toEqual([
      '/confirmation/mine',
      '/products',
      '/confirmation/queue',
      '/ops/preparation',
    ]);
  });

  it('and a saved screen this menu no longer holds falls out silently — and the bar is filled, never short', () => {
    expect(prim(WORKER(), null, ['/finance/wallets', '/products', '/gone', '/customers'])).toEqual([
      '/products',
      '/customers',
      '/confirmation/mine',
      '/confirmation/queue',
    ]);
    expect(prim(WORKER(), null, ['/a', '/b', '/c', '/d'])).toEqual(prim(WORKER()));
  });

  it('and a stale entry at the front does not cost a slot: four valid ones still fit', () => {
    expect(prim(WORKER(), null, ['/gone', '/products', '/customers', '/dashboard', '/orders'])).toEqual([
      '/products',
      '/customers',
      '/dashboard',
      '/orders',
    ]);
  });

  it('and a screen saved twice takes one slot', () => {
    expect(prim(WORKER(), null, ['/orders', '/orders', '/products'])).toEqual([
      '/orders',
      '/products',
      '/confirmation/mine',
      '/confirmation/queue',
    ]);
  });

  it('and more than four saved: the first four that this menu holds', () => {
    const six = ['/products', '/customers', '/dashboard', '/orders', '/ops/returns', '/ops/batches'];
    expect(prim(WORKER(), null, six)).toEqual(six.slice(0, BOTTOM_SLOTS));
  });

  it('and fewer reachable screens than slots: every screen, once, and nothing invented to pad the bar', () => {
    const tiny = [group('main', '/orders'), group('admin', '/admin/profile')];
    const out = mobileNav(tiny, null, ['/admin/profile', '/orders', '/finance/wallets']);
    expect(out.primary.map((r) => r.path)).toEqual(['/admin/profile', '/orders']);
    expect(out.primary).toHaveLength(2);
    expect(out.primary.every(Boolean)).toBe(true);
    expect(out.rest).toEqual([]);
    expect(mobileNav([], null, ['/orders']).primary).toEqual([]);
  });

  it('and the page you are on is forced into the bar, in the last slot, when it is not one of the four — as it always was', () => {
    const slots = ['/products', '/customers', '/dashboard', '/orders'];
    expect(prim(WORKER(), '/ops/returns', slots)).toEqual(['/products', '/customers', '/dashboard', '/ops/returns']);
    // a sub-page counts as its screen
    expect(prim(WORKER(), '/ops/returns/12', slots)).toEqual(['/products', '/customers', '/dashboard', '/ops/returns']);
    // and the screen it displaced is in the sheet, not lost
    expect(pathsOf(mobileNav(WORKER(), '/ops/returns', slots).rest)).toContain('/orders');
  });

  it('and it displaces nothing when the page is already one of the four', () => {
    const slots = ['/products', '/customers', '/dashboard', '/orders'];
    for (const here of slots) expect(prim(WORKER(), here, slots), here).toEqual(slots);
  });

  it('and a page that is not in this menu at all is not forced in — it is not a screen the bar can draw', () => {
    const slots = ['/products', '/customers', '/dashboard', '/orders'];
    expect(prim(WORKER(), '/somewhere/else', slots)).toEqual(slots);
  });

  it('and the sheet is every other screen, once, in the groups’ own order and with no empty heading', () => {
    const slots = ['/confirmation/queue', '/confirmation/mine', '/confirmation/issues', '/orders'];
    const { primary, rest } = mobileNav(WORKER(), null, slots);
    expect(primary.map((r) => r.path)).toEqual(slots);
    expect(rest.map((g) => g.key)).toEqual(['main', 'ops', 'settings']);
    expect(rest.every((g) => g.routes.length > 0)).toBe(true);
    expect(rest[0].routes.map((r) => r.path)).toEqual(['/dashboard', '/customers', '/products']);
  });

  it('and a screen the person HID is not in the menu the bar is handed, so it cannot take a slot — however it was saved', () => {
    const layout = lay({ hidden: ['/products'], slots: ['/products', '/customers', '/orders'] });
    const arranged = applyArrangement(WORKER(), layout);
    expect(pathsOf(arranged)).not.toContain('/products');
    expect(prim(arranged, null, layout.slots)).toEqual(['/customers', '/orders', '/confirmation/mine', '/confirmation/queue']);
  });

  it('and over any list of saved screens, good or forged: no screen twice, no screen from outside the menu, as many as the menu can fill', () => {
    const menu = WORKER();
    const menuPaths = pathsOf(menu);
    const pool = [...menuPaths, '/finance/wallets', '/forged', '/orders', '', '/orders'];
    let seed = 5;
    const next = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let round = 0; round < 400; round++) {
      const slots = Array.from({ length: next(9) }, () => pool[next(pool.length)]);
      const out = prim(menu, null, slots);
      expect(new Set(out).size, `${JSON.stringify(slots)} → ${out}`).toBe(out.length);
      for (const path of out) expect(menuPaths, `${path} ليس من القائمة`).toContain(path);
      expect(out).toHaveLength(Math.min(BOTTOM_SLOTS, menuPaths.length));
    }
  });

  it('and the choice is a preference over the groups, whichever order the groups are drawn in', () => {
    const slots = ['/ops/returns', '/orders'];
    const a = prim(WORKER(), null, slots).slice(0, 2);
    const b = prim(applyArrangement(WORKER(), lay({ groups: ['settings', 'ops', 'confirmation', 'main'] })), null, slots).slice(0, 2);
    expect(a).toEqual(slots);
    expect(b).toEqual(slots);
  });
});

// ───────────────────────── what counts as a line of the menu ─────────────────────────

describe('isMenuLine — one rule for «is this screen a line of the drawer», asked on the server and in the card', () => {
  const route = (over: Record<string, unknown> = {}) => ({ path: '/x', label: 'x', icon: 'List', permissions: null, ...over });

  it('— an ordinary screen is a line, an off-menu one never is', () => {
    expect(isMenuLine(route(), new Set())).toBe(true);
    expect(isMenuLine(route({ offMenu: true }), new Set(['/x']))).toBe(false);
  });

  it('and a folded screen is a line only for a person who cannot open the screen it is folded under', () => {
    const folded = route({ foldedUnder: '/dashboard' });
    expect(isMenuLine(folded, new Set(['/dashboard']))).toBe(false);
    expect(isMenuLine(folded, new Set(['/orders']))).toBe(true);
    expect(isMenuLine(folded, new Set())).toBe(true);
    // folded under a screen that is not in the registry at all: nothing folds it away
    expect(isMenuLine(route({ foldedUnder: '/no/such/screen' }), new Set(['/dashboard']))).toBe(true);
  });

  /** A person holding exactly these keys — the same builder the performance-board tests use. */
  const userWith = (keys: string[], role = 'MODERATOR') =>
    attachGrants({ id: 'u1', role, status: 'ACTIVE', permissions: keys } as never, {
      fullAccess: false,
      grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])),
    });
  const everyKey = [...new Set(ALL_ROUTES.flatMap((r) => r.permissions ?? []))];

  it('and `menuNav` is exactly `visibleNav` asked that rule — for people with and without the dashboard, the board, the assistant, everything', () => {
    const people = [
      userWith(['dashboard.view', 'reports.view', 'campaigns.view']),
      userWith(['reports.view']),
      userWith(['dashboard.view']),
      userWith(['ai.use', 'growth.intelligence']),
      userWith(['orders.view']),
      userWith([]),
      userWith(everyKey, 'SUPER_ADMIN'),
      userWith(everyKey.filter((k) => k !== 'dashboard.view')),
    ];
    for (const person of people) {
      const visible = visibleNav(person, can);
      const openable = new Set(visible.flatMap((g) => g.routes.map((r) => r.path)));
      const expected = visible
        .map((g) => ({ ...g, routes: g.routes.filter((r) => isMenuLine(r, openable)) }))
        .filter((g) => g.routes.length > 0);
      expect(menuNav(person, can)).toEqual(expected);
    }
    // …and the rule really removes something, or the loop above proves nothing.
    const all = userWith(everyKey, 'SUPER_ADMIN');
    expect(pathsOf(menuNav(all, can))).not.toContain('/assistant');
    expect(pathsOf(menuNav(all, can))).not.toContain('/growth/performance');
    expect(pathsOf(visibleNav(all, can))).toContain('/assistant');
  });
});
