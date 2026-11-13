import { describe, expect, it } from 'vitest';
import {
  applyArrangement,
  cleanLayout,
  EMPTY_LAYOUT,
  parseLayout,
  resolveLayout,
  type NavLayout,
} from './nav-arrangement';
import { mobileNav } from './mobile-nav';
import type { NavGroup } from './route-registry';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE MENU YOU ARRANGE — AND THE LINE ARRANGING MAY NOT CROSS.
 *
 * The owner, 15/10: «ما بقدر أتحكم بالقوائم والنوافذ». His decision: HE
 * sets the base per role, each person adjusts on top of it, «رجّع الأساس»
 * brings the base back.
 *
 * The rule that matters more than any of it: ARRANGING OPENS NOTHING. The
 * groups handed to `applyArrangement` have already been filtered by
 * `visibleNav` per viewer, and every door checks its own permission when
 * it is opened. So the one thing this must never do is ADD a route — and
 * the claim below holds exactly that, because it is the difference between
 * a cosmetic preference and a permission system with a second opinion.
 * ═══════════════════════════════════════════════════════════════════════
 */

const groups = (): NavGroup[] => [
  {
    key: 'main',
    label: 'الرئيسية',
    routes: [
      { path: '/dashboard', label: 'لوحة', icon: 'L', permissions: null },
      { path: '/orders', label: 'الطلبات', icon: 'O', permissions: null },
      { path: '/products', label: 'المنتجات', icon: 'P', permissions: null },
    ],
  },
  {
    key: 'settings',
    label: 'الإعدادات',
    routes: [{ path: '/settings/geo', label: 'البلدان', icon: 'G', permissions: null }],
  },
];

const paths = (gs: NavGroup[]) => gs.flatMap((g) => g.routes.map((r) => r.path));

describe('arranging the menu', () => {
  it('puts the items in the order given', () => {
    const out = applyArrangement(groups(), {
      ...EMPTY_LAYOUT,
      order: ['/products', '/orders', '/dashboard'],
    });
    expect(paths(out).slice(0, 3)).toEqual(['/products', '/orders', '/dashboard']);
  });

  it('lifts a pinned item to the top of its group, whatever the order says', () => {
    const out = applyArrangement(groups(), {
      ...EMPTY_LAYOUT,
      order: ['/dashboard', '/orders', '/products'],
      pinned: ['/products'],
    });
    expect(paths(out)[0]).toBe('/products');
  });

  it('leaves a hidden item out', () => {
    const out = applyArrangement(groups(), { ...EMPTY_LAYOUT, hidden: ['/orders'] });
    expect(paths(out)).not.toContain('/orders');
  });

  it('and drops a group that has nothing left, rather than an empty heading', () => {
    const out = applyArrangement(groups(), { ...EMPTY_LAYOUT, hidden: ['/settings/geo'] });
    expect(out.map((g) => g.key)).not.toContain('settings');
  });

  it('and a route the layout never mentions appears at the end of its group', () => {
    /*
     * The edge case the brief names: a screen added next week is in
     * nobody's stored order. It has to show up for everybody, without any
     * stored arrangement being migrated — which falls out of taking the
     * registry as the source and the layout as an opinion over it.
     */
    const out = applyArrangement(groups(), { ...EMPTY_LAYOUT, order: ['/products'] });
    expect(paths(out)).toEqual(['/products', '/dashboard', '/orders', '/settings/geo']);
  });

  it('and a layout naming a route that no longer exists changes nothing', () => {
    const out = applyArrangement(groups(), { ...EMPTY_LAYOUT, order: ['/deleted-screen'], hidden: ['/gone'] });
    expect(paths(out)).toEqual(paths(groups()));
  });
});

describe('and it cannot add a route — the line', () => {
  it('a layout naming a screen the viewer may not open adds nothing', () => {
    /*
     * The whole safety argument in one claim. `applyArrangement` reorders
     * and filters what it is HANDED; it has no registry of its own and no
     * way to reach one. So a layout posted by hand with `/finance` in it —
     * a screen this viewer's menu does not contain — yields the same menu.
     */
    const out = applyArrangement(groups(), {
      ...EMPTY_LAYOUT,
      order: ['/finance', '/control/users', '/dashboard'],
      pinned: ['/finance'],
    });
    expect(paths(out), 'الترتيب أضاف باباً').toEqual(['/dashboard', '/orders', '/products', '/settings/geo']);
  });

  it('and the saved layout is filtered down to what the writer may reach', () => {
    // Belt as well as braces: nothing stored that is not already theirs.
    const cleaned = cleanLayout(
      { order: ['/dashboard', '/finance'], hidden: ['/finance'], pinned: ['/orders'] },
      paths(groups())
    );
    expect(cleaned).toEqual({ order: ['/dashboard'], hidden: [], pinned: ['/orders'] });
  });
});

describe('base, then mine on top, then «رجّع الأساس»', () => {
  const base: NavLayout = { order: ['/orders', '/dashboard'], hidden: ['/products'], pinned: [] };
  const own: NavLayout = { order: ['/dashboard', '/orders'], hidden: [], pinned: ['/dashboard'] };

  it('with nothing of mine, the role’s base answers', () => {
    expect(resolveLayout(base, null)).toEqual(base);
  });

  it('with mine, mine answers — per list', () => {
    const r = resolveLayout(base, own);
    expect(r.order).toEqual(own.order);
    expect(r.pinned).toEqual(['/dashboard']);
    /*
     * AND THE BASE'S HIDDEN ITEMS SURVIVE. This is what makes a base a
     * base: I reordered and said nothing about hiding, so the owner's
     * decision about hiding still stands. A merge that replaced the whole
     * object would have quietly un-hidden what he hid.
     */
    expect(r.hidden, 'إخفاءُ المالك ضاع لأنّي رتّبت فقط').toEqual(['/products']);
  });

  it('and «رجّع الأساس» is exactly «I have nothing of my own»', () => {
    // Which is why the store DELETES the row rather than writing an empty
    // layout: an empty one would mean «I deliberately hid nothing».
    expect(resolveLayout(base, null)).toEqual(resolveLayout(base, EMPTY_LAYOUT));
  });

  it('and with neither, the registry order stands', () => {
    expect(resolveLayout(null, null)).toEqual(EMPTY_LAYOUT);
    expect(paths(applyArrangement(groups(), resolveLayout(null, null)))).toEqual(paths(groups()));
  });
});

describe('a stored layout is read defensively', () => {
  it('because a menu is the one thing that must never fail to render', () => {
    // Losing it means the person cannot reach any screen at all.
    for (const bad of [null, undefined, '', 'not json', '{"order":"nope"}', '[]', '42', {}]) {
      expect(parseLayout(bad)).toEqual(EMPTY_LAYOUT);
    }
  });

  it('and keeps only the strings out of a half-written list', () => {
    expect(parseLayout({ order: ['/a', 7, null, '/b'], hidden: null, pinned: ['/c'] })).toEqual({
      order: ['/a', '/b'],
      hidden: [],
      pinned: ['/c'],
    });
  });

  it('and reads the JSON the column actually holds', () => {
    expect(parseLayout(JSON.stringify({ order: ['/a'], hidden: ['/b'], pinned: [] }))).toEqual({
      order: ['/a'],
      hidden: ['/b'],
      pinned: [],
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SAME LINE, HELD FOR THE TWO NEWER OPINIONS (13/11) — THE GROUPS AND THE PHONE'S FOUR.
 *
 * «ترتيب القوائم والخانات الرئيسية» is still ARRANGING, and arranging opens nothing. A group
 * key and a screen's path are both just names in a stored layout; neither is a door. What this
 * holds is that a forged one — a group that is not in this person's menu, a screen they may not
 * open — has nowhere to take effect: it is dropped when saved, and it is inert when read, because
 * the two functions that apply a layout only reorder what they were handed.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('and it cannot add a route — the groups and the phone’s four', () => {
  it('a group key the viewer’s menu does not hold adds no group, and holds no place', () => {
    const out = applyArrangement(groups(), { ...EMPTY_LAYOUT, groups: ['finance', 'control', 'settings', 'main', 'admin'] });
    expect(out.map((g) => g.key), 'الترتيب أضاف مجموعة').toEqual(['settings', 'main']);
    expect(paths(out).sort()).toEqual(paths(groups()).sort());
  });

  it('a screen the viewer may not open adds nothing to the phone’s bar — it is not in the menu the bar is handed', () => {
    const { primary, rest } = mobileNav(groups(), null, ['/finance/wallets', '/control/audit', '/orders', '/ops/shipments/new']);
    const menu = paths(groups());
    for (const r of primary) expect(menu, `${r.path} دخل الشريط من خارج القائمة`).toContain(r.path);
    expect(primary.map((r) => r.path)).not.toContain('/finance/wallets');
    expect(primary.map((r) => r.path)).toContain('/orders');
    // and the whole menu is still exactly the menu: the bar and the sheet together hold what was handed in, once
    expect([...primary.map((r) => r.path), ...paths(rest)].sort()).toEqual([...menu].sort());
  });

  it('a layout full of forged groups and screens yields the very same SET of screens as no layout at all', () => {
    const forged: NavLayout = {
      order: ['/finance/matching', '/dashboard'],
      hidden: [],
      pinned: ['/finance/matching'],
      groups: ['finance', 'settings', 'nope'],
      slots: ['/finance/matching', '/control/audit', '/products', '/nope'],
    };
    const arranged = applyArrangement(groups(), forged);
    expect(paths(arranged).sort()).toEqual(paths(groups()).sort());
    const bar = mobileNav(arranged, null, forged.slots);
    expect([...bar.primary.map((r) => r.path), ...paths(bar.rest)].sort()).toEqual(paths(groups()).sort());
  });

  it('and the saved layout is filtered down to the writer’s own groups and screens — the rest is dropped, not an error', () => {
    const cleaned = cleanLayout(
      {
        order: ['/dashboard', '/finance'],
        hidden: [],
        pinned: [],
        groups: ['settings', 'finance', 'main'],
        slots: ['/finance/wallets', '/orders', '/dashboard'],
      },
      paths(groups()),
      groups().map((g) => g.key)
    );
    expect(cleaned.groups).toEqual(['settings', 'main']);
    expect(cleaned.slots).toEqual(['/orders', '/dashboard']);
  });

  it('and hiding stays stronger than choosing: a screen hidden from the menu cannot hold a slot', () => {
    const layout: NavLayout = { ...EMPTY_LAYOUT, hidden: ['/orders'], slots: ['/orders', '/products'] };
    const bar = mobileNav(applyArrangement(groups(), layout), null, layout.slots);
    expect(bar.primary.map((r) => r.path)).not.toContain('/orders');
  });

  it('and a person who loses the right to open a screen loses it from their bar, with nothing stored changing', () => {
    const stored: NavLayout = { ...EMPTY_LAYOUT, slots: ['/settings/geo', '/orders', '/dashboard', '/products'] };
    const before = mobileNav(groups(), null, stored.slots).primary.map((r) => r.path);
    expect(before).toEqual(['/settings/geo', '/orders', '/dashboard', '/products']);
    // The same stored layout, handed the menu of somebody who can no longer open «البلدان»:
    const lost = groups().map((g) => ({ ...g, routes: g.routes.filter((r) => r.path !== '/settings/geo') })).filter((g) => g.routes.length > 0);
    const after = mobileNav(lost, null, stored.slots).primary.map((r) => r.path);
    expect(after).toEqual(['/orders', '/dashboard', '/products']);
    expect(stored.slots).toEqual(['/settings/geo', '/orders', '/dashboard', '/products']);
  });
});
