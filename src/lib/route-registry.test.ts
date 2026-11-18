import { describe, expect, it, vi } from 'vitest';
import { can } from './authorization';

vi.mock('./db', () => ({ db: {} }));

import { ALL_ROUTES, NAV, canAccessRoute, findRoute, landingRoute, visibleNav } from './route-registry';
import { attachGrants } from './authorization';
import { ALL_CATALOG_KEYS } from './permission-catalog';

function userWith(keys: string[], role = 'MODERATOR') {
  const user = { id: 'u1', role, status: 'ACTIVE', permissions: keys } as any;
  return attachGrants(user, {
    fullAccess: false,
    grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])),
  });
}

describe('navigation contract', () => {
  it('has the nine groups in contract order', () => {
    // 18/11 (R6, the owner: «القائمة من 16 سطر لـ9»): ELEVEN → NINE, and the old names below are history.
    // Was: الرئيسية · مركز التأكيد · الشحن · المخزون · المال · الرقابة · النمو والذكاء · المحادثات · واجهة المتجر · الإعدادات · الإدارة.
    // Now each line is one kind of work: «اليوم» (the dashboard, new key `today`), «الطلبات» (key `main`: the orders, the carts,
    // the customers and the two inboxes — «المحادثات» folded in), «التأكيد», «الشحن», «المخزون والمنتجات» (the products joined),
    // «المال» (+ «العمولات»), «التقارير» (was «النمو والذكاء»), «واجهة المتجر», «الإدارة» (the settings, «الرقابة» and the staff:
    // three lines became one). Only group membership, keys, labels and order changed — no path, permission or title.
    // «واجهة المتجر» is the store section: how the shop looks and what it
    // says, as against /settings, which is how the system runs.
    //
    // Eleven until 21/10, when «التطبيقات» — a group of two entries —
    // joined the settings it configures, «التشغيل» became «الشحن» (it is
    // one parcel's road, not «operations»), and «النمو» became
    // «النمو والذكاء». See `the-menu-follows-the-work.test.ts` for why.
    //
    // Eleven and not ten from the day the two inboxes became «المحادثات»:
    // a conversation that arrives is not a growth question. The MENU does
    // not draw eleven headings, though — it draws fifteen lines, because a
    // group is one line (`NavGroup.hub`); see `the-menu-is-one-line-a-group`.
    expect(NAV.map((g) => g.label)).toEqual([
      'اليوم', 'الطلبات', 'التأكيد', 'الشحن', 'المخزون والمنتجات', 'المال', 'التقارير', 'واجهة المتجر', 'الإدارة',
    ]);
    expect(NAV.map((g) => g.key)).toEqual([
      'today', 'main', 'confirmation', 'ops', 'inventory', 'finance', 'growth', 'storefront', 'admin',
    ]);
    // The keys that went: a saved arrangement naming them simply loses those entries (`knownGroups`, nav-arrangement.ts).
    for (const gone of ['control', 'chats', 'settings']) expect(NAV.some((g) => g.key === gone), gone).toBe(false);
  });

  it('lists 54 unique routes', () => {
    // 52 until /ops/labels was folded into the shipping batches screen:
    // printing, the sizes and the courier CSV all live where the batch is.
    // 59 with the store section's seven screens, all live. 60 with
    // /control/penalties, where a human decides what the deduction job
    // proposed. 61 with /confirmation/winback, where a supervisor offers a
    // lost order back at a discount. 60 when «أجور التوصيل» stopped being a
    // screen: a courier's fees are a panel inside the courier, because a fee
    // row has always belonged to one company. 61 with /store/search —
    // the shop's own words and the questions each category is described
    // by, which are one job and so one screen. 62 with /growth/bench,
    // the test bench's results table — a growth screen whose numbers are
    // deliberately outside every figure the rest of the product shows.
    // 63 with /store/reviews — «الآراء», owner decision D8: what buyers
    // said after delivery, and the three things done about it (publish,
    // hide with a recorded reason, choose the product's source).
    // A screen is registered when it is real — the
    // store section's remaining screens join this count as they ship, and
    // nothing here renders "قيد الإنشاء".
    //
    // 54 when the storefront group went from eleven entries to two. NINE
    // screens stopped being MENU ENTRIES and became the three tabs of
    // `/store` (src/lib/store-admin.ts) — the eight that dressed the shop,
    // and «الآراء», which arrived as a third entry while that was being
    // built and whose own comment here said it belongs with the shop's
    // CONTENT. Not one of them was deleted, and each old address redirects
    // to its panel permanently. A registry entry is a place in the menu,
    // and nine places in the menu for one shop is what the owner called
    // «معجّق … بتضيع».
    //
    // 55 when `/settings` joined — the page of cards that the menu's ONE
    // settings line opens, where twelve entries stood. The other fifty-four
    // are exactly the ones that were here, at the same addresses.
    //
    // 54 when «استلام بضاعة جاهزة» (`/inventory/receiving`) became a button on
    // each product's card on `/inventory/balances`: it read the SAME
    // `/api/inventory` as the balances and offered a second list of the same
    // products for one form. The address redirects permanently (and carries
    // `?product=`), and the dialog is `ReceiveDialog`.
    const paths = ALL_ROUTES.map((route) => route.path);
    //
    // 53 when «الطلبات المؤجلة» and «استرجاع الملغى» became the two tabs of «المتابعة»
    // (`/confirmation/follow-up`, the supervisor's), and an agent's postponed orders a tab
    // of «طلباتي». Both old addresses redirect permanently.
    //
    // 52 when «إعدادات واتساب» and «إعدادات تلجرام» became the two cards of «الربط»
    // (`/settings/links`): the same errand — read the status, test, reconnect — seen once,
    // at set-up. Each card is drawn only for the key that owns it; both old addresses
    // redirect permanently.
    //
    // 53 with `/abandoned-carts` (15/11): the carts Zaki pages sends (contract oms-lp.v1 §9), a loose line beside
    // the orders on the same key (`orders.view`).
    //
    // 18/11 (C1): 54 with `/confirmation/rules` «قواعد مركز التأكيد» — the eight confirmation-rule cards moved there from «إعدادات النظام», the last tab of the confirmation hub, on `settings.view`. Not one address moved.
    expect(paths).toHaveLength(54);
    expect(new Set(paths).size).toBe(54);
  });

  it('the store section is its own group, and reads as one', () => {
    const group = NAV.find((g) => g.key === 'storefront')!;
    expect(group.label).toBe('واجهة المتجر');
    // Not «المتجر»: «متجر التطبيقات» is a different thing one group below.
    expect(group.label).not.toBe('المتجر');
    // `/store` itself is the group's head — every other entry lives under it.
    for (const route of group.routes) {
      expect(route.path === '/store' || route.path.startsWith('/store/')).toBe(true);
    }
  });

  it('no longer carries a separate labels page', () => {
    // Deleting a screen is only done when nothing was lost with it — the
    // print run, the paper size and the CSV are all on the batch now.
    expect(ALL_ROUTES.map((r) => r.path)).not.toContain('/ops/labels');
  });

  it('only references permissions that exist in the catalog', () => {
    for (const route of ALL_ROUTES) {
      for (const p of route.permissions ?? []) expect(ALL_CATALOG_KEYS.has(p), `${route.path}: ${p}`).toBe(true);
    }
  });

  it('a path outside the contract resolves to nothing (404)', () => {
    expect(findRoute('/dashboards/crm')).toBeUndefined();
    expect(findRoute('/offers')).toBeUndefined();
    expect(findRoute('/confirmation/queue')).toBeDefined();
  });

  it('apps appear once — in «الإدارة», beside the settings they configure', () => {
    // «Once» is the half of the old rule that mattered: two screens that
    // used to be a group of their own, with a heading you opened to find
    // two links. They are in settings now and nowhere else.
    // 18/11 (R6): the settings group is «الإدارة» (key `admin`; the key `settings` went) — the home was ['settings'], now ['admin'].
    // «Once» is unchanged: the two screens, one group, one card (`apps` on the door).
    const appRoutes = ALL_ROUTES.filter((route) => route.path.startsWith('/apps/'));
    expect(appRoutes).toHaveLength(2);
    expect(NAV.find((g) => g.key === 'apps')).toBeUndefined();
    const home = NAV.filter((g) => g.routes.some((route) => route.path.startsWith('/apps/')));
    expect(home.map((g) => g.key)).toEqual(['admin']);
  });

  it('/assistant and /growth/intelligence stay two distinct screens', () => {
    expect(findRoute('/assistant')!.permissions).not.toEqual(findRoute('/growth/intelligence')!.permissions);
  });
});

describe('role visibility', () => {
  const moderator = () => userWith(['orders.view', 'orders.create', 'orders.edit', 'orders.claim', 'orders.confirm', 'customers.view', 'confirmation.issues']);

  it('a moderator is refused /confirmation/queue even with order claim/confirm grants', () => {
    expect(canAccessRoute(moderator(), findRoute('/confirmation/queue')!, can)).toBe(false);
  });

  it('a moderator may open /confirmation/issues and /orders', () => {
    expect(canAccessRoute(moderator(), findRoute('/confirmation/issues')!, can)).toBe(true);
    expect(canAccessRoute(moderator(), findRoute('/orders')!, can)).toBe(true);
  });

  it('a confirmation agent reaches only «طلباتي» — not the supervisor’s queue or follow-up, nor issues', () => {
    const agent = userWith(['confirmation.pull', 'confirmation.work'], 'CONFIRMATION_AGENT');
    expect(canAccessRoute(agent, findRoute('/confirmation/mine')!, can)).toBe(true);
    // The pull is at the top of «طلباتي», and her postponed orders are a tab of it.
    for (const p of ['/confirmation/queue', '/confirmation/follow-up', '/confirmation/issues']) {
      expect(canAccessRoute(agent, findRoute(p)!, can), p).toBe(false);
    }
    // The old addresses are not registry routes any more — they redirect.
    for (const p of ['/confirmation/postponed', '/confirmation/winback']) expect(findRoute(p), p).toBeUndefined();
  });

  it('a supervisor reaches the queue and «المتابعة»', () => {
    const supervisor = userWith(['confirmation.supervise'], 'CONFIRMATION_AGENT');
    for (const p of ['/confirmation/queue', '/confirmation/follow-up']) {
      expect(canAccessRoute(supervisor, findRoute(p)!, can), p).toBe(true);
    }
  });

  it('whoever may pull may open «طلباتي» — the panel is there — and a supervisor opens the queue', () => {
    const puller = userWith(['confirmation.pull'], 'CONFIRMATION_AGENT');
    expect(canAccessRoute(puller, findRoute('/confirmation/mine')!, can)).toBe(true);
    const supervisor = userWith(['confirmation.supervise'], 'CONFIRMATION_AGENT');
    expect(canAccessRoute(supervisor, findRoute('/confirmation/queue')!, can)).toBe(true);
    const moderator = userWith(['orders.view'], 'MODERATOR');
    for (const p of ['/confirmation/queue', '/confirmation/mine']) {
      expect(canAccessRoute(moderator, findRoute(p)!, can), p).toBe(false);
    }
  });

  it('warehouse never reaches money or customer screens', () => {
    const wh = userWith(['ops.prepare', 'ops.labels', 'ops.returns', 'inventory.view', 'inventory.adjust'], 'WAREHOUSE');
    for (const p of ['/finance/profit', '/customers', '/ops/tracking']) {
      expect(canAccessRoute(wh, findRoute(p)!, can), p).toBe(false);
    }
  });

  it('an inactive user opens nothing, not even the profile', () => {
    const pending = { ...userWith(['orders.view']), status: 'PENDING' };
    expect(canAccessRoute(pending, findRoute('/admin/profile')!, can)).toBe(false);
  });

  it('sends a user without dashboard.view to the first screen he may open', () => {
    // A moderator scoped to his own orders holds no dashboard.view: landing
    // him on /dashboard is a 403 at login.
    const mod = userWith(['orders.view', 'customers.view', 'confirmation.issues']);
    expect(landingRoute(mod, can)).toBe('/orders');
    expect(canAccessRoute(mod, findRoute('/dashboard')!, can)).toBe(false);
  });

  it('still sends everyone who holds dashboard.view to the dashboard', () => {
    expect(landingRoute(userWith(['dashboard.view', 'orders.view']), can)).toBe('/dashboard');
  });

  it('the visible navigation drops empty groups', () => {
    const nav = visibleNav(userWith(['confirmation.pull', 'confirmation.work'], 'CONFIRMATION_AGENT'), can);
    expect(nav.map((g) => g.key)).toEqual(['confirmation', 'admin']);
  });
});
