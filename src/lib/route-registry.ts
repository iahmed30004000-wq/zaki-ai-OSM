import type { SessionUser } from '@/types/auth';

/**
 * WHY THIS FILE IMPORTS NOTHING THAT RUNS ON THE SERVER.
 *
 * It is the one list of screens, and both sides read it: the sidebar and
 * the page titles in the browser, the guard and the notifications on the
 * server. It used to import `can` from authorization.ts, which imports
 * auth.ts, which imports `next/headers` — so the moment a client component
 * read a route's LABEL it dragged the session machinery into the bundle,
 * and the build refused.
 *
 * So the permission CHECK arrives as an argument. The data stays readable
 * from anywhere, which is the whole point of having one list.
 */

/** Does this user hold this permission? Supplied by the caller. */
export type PermissionCheck = (user: SessionUser, permission: string) => boolean;

/**
 * ROUTE REGISTRY — the navigation contract (references/architecture.md).
 *
 * Single source for the sidebar, the server-side page guard and the route
 * tests. A path not listed here does not exist (404). Access is decided by
 * permissions, never by role names: a route opens when the user holds ANY of
 * its permissions (null = every active user). The API behind each screen
 * enforces the same permissions again.
 *
 * There is no "not built yet" marking any more. There was one — a `stage`
 * number whose documentation promised an under-construction page — and
 * nothing ever read it: the guard did not check it, the placeholder
 * component it named was imported by no page, and the one screen still
 * carrying a number (campaigns, seven hundred lines of working screen) wore
 * a "under construction" badge in the sidebar for a year.
 *
 * A registry read as a contract must not contain a clause nobody enforces.
 */

export interface RouteDef {
  path: string;
  label: string;
  /** A NAME, not a component: a route is data. src/components/shell/icons.ts
   *  turns it into a glyph, and decides line or fill. */
  icon: string;
  permissions: string[] | null;
  /**
   * WHERE THIS SCREEN USUALLY FALLS IN A SEQUENCE THE WORK FOLLOWS.
   *
   * Drawn as «3.» before the label, and nothing else. A hint, never a rule:
   * every screen still opens on its own permission, in any order, and a
   * person who may open only the first and the last sees «1.» and «5.» —
   * which is true, those are the first and the last stop.
   *
   * It lives on the ROUTE and not on its position in the group, because a
   * position is not stable: the menu drops what a person may not open,
   * their own arrangement reorders it, and the phone's sheet lifts four
   * screens out into the bar. A number computed from the index would
   * follow all of that around; a number that belongs to the screen does not.
   */
  step?: number;
  /**
   * THIS SCREEN IS THE DETAIL OF ANOTHER — SO IT IS NOT A MENU LINE FOR WHOEVER CAN OPEN THAT ONE.
   *
   * `foldedUnder` names the screen it is the detail of (`/dashboard` for the
   * performance board). `menuNav` leaves the route out of the menu — the
   * sidebar, the pills, the phone bar, the palette — for a person who may open
   * that screen, because the screen carries a link to this one. A person who
   * may NOT open it keeps this route as a line: folding is for the menu, never
   * for access, and nobody loses a screen by it.
   *
   * It is a statement about the MENU only. The route stays in the registry with
   * its path, permissions, guide and title; `visibleNav`, the page guard and
   * every notification link still read it as before.
   */
  foldedUnder?: string;
  /**
   * NOT A MENU LINE FOR ANYBODY — REACHED FROM SOMEWHERE ELSE.
   *
   * For a screen whose real door is not the menu. `menuNav` leaves it out of the
   * sidebar, the pills, the phone bar and the palette for everyone; the route keeps
   * its path, permissions, guide and guard, and every link to it still works. Today
   * that is «المساعد الذكي»: the bubble on every screen IS the assistant, and its
   * header carries «افتح كاملاً» to this page, so a menu line for the same chat was
   * a second door to one room.
   */
  offMenu?: boolean;
}

/**
 * HOW A GROUP IS DRAWN, AND WHY IT IS NOT FIFTY-FOUR LINES.
 *
 * `hub` is a statement about the MENU and never about the routes. Every
 * route below stays in this registry with its own path, permissions, title,
 * guide and notification link — so the page guard, the palette, the road and
 * the phone bar still read the same screens they always did, and no address
 * moved. What changes is how many LINES the sidebar spends on them. The
 * owner, 21/10: «الموقع كثييير معجوق … دمج القوائم بذكاء».
 *
 *   'tabs'  — the whole group is ONE line (its `icon`, its `label`). It opens
 *             the first screen this person may open, and above every screen
 *             of the group a strip of pills lists the others. The strip is
 *             drawn from the same visible, arranged routes the sidebar gets,
 *             so a screen somebody may not open is not a pill, and their own
 *             order and hiding apply to it.
 *   'cards' — one line that opens a page of cards (the group's first route),
 *             and every other screen of the group carries a «← label» link
 *             back to it. For a group of a dozen, where a strip of pills
 *             would only move the clutter one row up.
 *   'loose' — no heading and no folding: each route is its own line. For
 *             what is used all day and should never be a second click.
 *
 * A group with no `hub` is drawn as it always was — a heading that folds.
 */
export type GroupHub = 'tabs' | 'cards' | 'loose';

export interface NavGroup {
  key: string;
  label: string;
  routes: RouteDef[];
  /** The line this group is drawn as when it is a hub of tabs or cards. A NAME, like `RouteDef.icon`. */
  icon?: string;
  hub?: GroupHub;
}

const r = (
  path: string,
  label: string,
  icon: string,
  permissions: string[] | null,
  step?: number
): RouteDef => ({
  path, label, icon, permissions, ...(step ? { step } : {}),
});

/**
 * NINE GROUPS, TEN LINES (18/11, the owner: «القائمة من 16 سطر لـ9»).
 *
 * Each line is one kind of work. What moved is only which group a screen
 * belongs to — every path, every permission, every title stays as it was, so
 * the guard, the pills, the bookmarks and the notification links mean the
 * same screens. Ten and not nine until the storefront's two lines fold into
 * one (its own request): 1+1+1+1+1+1+1+2+1 = 10.
 */
export const NAV: NavGroup[] = [
  {
    // «اليوم»: the first screen of the day, alone on its line.
    key: 'today',
    label: 'اليوم',
    icon: 'LayoutDashboard',
    hub: 'loose',
    routes: [r('/dashboard', 'لوحة التحكم', 'LayoutDashboard', ['dashboard.view'])],
  },
  {
    // «الطلبات»: every door an order comes in by, one line. The key stays `main` — the arrangement door's
    // canary builds a real menu for a holder of `orders.view` and expects it.
    key: 'main',
    label: 'الطلبات',
    icon: 'ShoppingCart',
    hub: 'tabs',
    routes: [
      r('/orders', 'الطلبات', 'ShoppingCart', ['orders.view']),
      // Beside the orders, on the same key: whoever sees the orders sees the carts (contract oms-lp.v1 §9, 15/11).
      // 18/11 (R10c): named «زبائن ما كمّلوا» — the carts AND the pages' leads, three tabs of one screen. Label only.
      r('/abandoned-carts', 'زبائن ما كمّلوا', 'CartAbandoned', ['orders.view']),
      r('/customers', 'العملاء', 'Users', ['customers.view', 'customers.view_basic']),
      // The two inboxes: a conversation that arrives is somebody who wants to order. Their SETUP stays with
      // the rest of the setup (`/settings/links`) — an operation sits with the work, its configuration apart.
      r('/growth/telegram/orders', 'طلبات تلجرام', 'Send', ['telegram.view']),
      r('/growth/whatsapp/inbox', 'صندوق الواتساب', 'MessageCircle', ['whatsapp.view']),
      // The landing chat (18/11): every conversation of Zaki pages' assistant, answered here. The WhatsApp inbox's own
      // permission, so the same people see it and no role has to change (contract oms-lp.v1 §11).
      r('/growth/landing-chats', 'رسائل اللاندينج', 'Inbox', ['whatsapp.view']),
    ],
  },
  {
    key: 'confirmation',
    label: 'التأكيد',
    icon: 'ClipboardList',
    hub: 'tabs',
    routes: [
      // The SUPERVISOR's view of the pool. An agent pulls from the top of «طلباتي»
      // (`PullPanel`), so this entry is not hers: its page sends her there.
      // Moderators never hold confirmation.supervise either.
      r('/confirmation/queue', 'الطلبات الجديدة', 'Inbox', ['confirmation.supervise']),
      // `confirmation.pull` too: the pull panel is at the top of this screen, so whoever may
      // pull must be able to open it (the list under it still asks `confirmation.work`).
      r('/confirmation/mine', 'طلباتي', 'ClipboardList', ['confirmation.work', 'confirmation.pull']),
      // «المتابعة»: the postponed orders and the cancelled-before ones, two tabs of one
      // screen (owner, 24/10). The supervisor's — the win-back tab is a discount, which is
      // money, and the agent meets the result of it as an ordinary new order in her queue.
      // An agent's postponed orders are a tab of «طلباتي»; the old addresses redirect.
      r('/confirmation/follow-up', 'المتابعة', 'CalendarClock', ['confirmation.supervise']),
      r('/confirmation/issues', 'الإشكالات', 'AlertTriangle', ['confirmation.issues']),
      // «قواعد مركز التأكيد» (18/11): the eight cards of the confirmation rules, moved here from «إعدادات النظام». On `settings.view`, the key those cards' own doors already read —
      // a holder of it who holds no `confirmation.*` key opens this page, and the cards behave as they always did (each asks its own key again).
      r('/confirmation/rules', 'قواعد مركز التأكيد', 'ShieldCheck', ['settings.view']),
    ],
  },
  {
    key: 'ops',
    // «الشحن» and not «التشغيل»: «operations» is every group in this menu.
    // What stands here is one parcel's road — picked, shipped, printed,
    // followed, and brought back — and the five stops are numbered so the
    // road can be read off the menu. The owner, 21/10: «كل خطوة بتودّي
    // للي بعدها».
    label: 'الشحن',
    icon: 'Truck',
    hub: 'tabs',
    routes: [
      r('/ops/preparation', 'التجهيز', 'PackageCheck', ['ops.prepare'], 1),
      r('/ops/shipments/new', 'إنشاء شحنة', 'Truck', ['ops.ship'], 2),
      r('/ops/batches', 'دفعات الشحن', 'Boxes', ['ops.batches'], 3),
      r('/ops/tracking', 'متابعة الشحن', 'MapPin', ['ops.track'], 4),
      r('/ops/returns', 'المرتجعات', 'Undo2', ['ops.returns'], 5),
    ],
  },
  {
    key: 'inventory',
    label: 'المخزون والمنتجات',
    icon: 'Boxes',
    hub: 'tabs',
    // The goods, in one place: what we sell, what we have, the door for the
    // goods we make, and the history. Production used to sit beside "Products"
    // as if it were a different subject; it is the door for the goods you make.
    routes: [
      r('/products', 'المنتجات', 'Package', ['products.view']),
      r('/inventory/balances', 'أرصدة المخزون', 'Boxes', ['inventory.view']),
      r('/manufacturing', 'تشغيلات الإنتاج', 'Factory', ['production.view']),
      r('/inventory/movements', 'حركات المخزون', 'ArrowLeftRight', ['inventory.view']),
      // «نقل البضاعة» (20/11, W3b): moving units between two warehouses of one store — send, on the road, received by count. Opens on
      // `inventory.view` like its two neighbours; every press asks its own key (inventory.transfer · transfer_receive · difference_approve).
      r('/inventory/transfers', 'نقل البضاعة', 'Repeat', ['inventory.view']),
    ],
  },
  {
    key: 'finance',
    label: 'المال',
    icon: 'Wallet',
    hub: 'tabs',
    // The first four are ONE errand, in the order it is usually walked: see
    // what each courier is holding, take it in (by statement or by hand),
    // match the statement against the orders, close the day. They sat as
    // «collection, matching, custody» with the closing two entries away,
    // and no screen linked to the next — so the errand was learned by
    // being taught. The wallets, the transfers and the profit are not part
    // of it; they are where the money ends up and what it earned.
    routes: [
      r('/finance/agents', 'عهدة المندوبين', 'Bike', ['settlement.view', 'settlement.review'], 1),
      r('/finance/collection', 'التحصيل والكشوف', 'FileSpreadsheet', ['settlement.upload', 'settlement.view'], 2),
      r('/finance/matching', 'المطابقة', 'GitCompare', ['settlement.review'], 3),
      r('/finance/closing', 'الإغلاق اليومي', 'Lock', ['finance.cashbox_view'], 4),
      r('/finance/wallets', 'المحافظ والحركات', 'Wallet', ['finance.cashbox_view']),
      r('/finance/transfers', 'التحويلات', 'Repeat', ['finance.cashbox_view']),
      r('/finance/profit', 'الأرباح', 'TrendingUp', ['finance.view']),
      // Commission is money owed to the staff, so it is a tab of «المال» (18/11). Its address stays under
      // /settings — the one screen under /settings that is not in «الإدارة».
      r('/settings/commission', 'العمولات', 'Percent', ['commission.view']),
      // «قواعد المال» (19/11, R13i): the two money cards of «إعدادات النظام» (the clean-line settlement, the partners), moved here unchanged. On `settings.view`, the key of
      // the page they came from — nobody gains or loses them; each card still asks its own key.
      r('/finance/rules', 'قواعد المال', 'ShieldCheck', ['settings.view']),
    ],
  },
  {
    key: 'growth',
    // «التقارير» (18/11): what happened and what to try next — the numbers, the
    // campaigns, the intelligence centre and the bench.
    label: 'التقارير',
    icon: 'Gauge',
    hub: 'tabs',
    routes: [
      // The DETAIL of the dashboard (owner, 24/10): a link there («التفاصيل»), not a second
      // menu line, for whoever can open the dashboard. Whoever cannot keeps it as a line — the first tab here.
      // (18/11: the fold STAYS for now — the arrangement door's canary pins it unedited; see the PR of R6.)
      { ...r('/growth/performance', 'لوحة الأداء', 'Gauge', ['reports.view']), foldedUnder: '/dashboard' },
      r('/growth/campaigns', 'الحملات', 'Megaphone', ['campaigns.view']),
      r('/growth/intelligence', 'مركز الذكاء', 'Lightbulb', ['growth.intelligence']),
      /*
       * THE BENCH, BESIDE THE INTELLIGENCE CENTRE AND NOT UNDER PRODUCTS.
       *
       * «منتج تيست» is a growth question — what to try next — and its
       * numbers are deliberately outside every figure the products and
       * inventory screens show. Putting it under «المنتجات» would invite
       * exactly the reading the whole feature refuses: that these products
       * are part of the catalogue's totals.
       *
       * Same permission as the intelligence centre: both answer «what
       * should I do next», and both are read by the person who decides it.
       */
      r('/growth/bench', 'منصّة التجريب', 'FlaskConical', ['growth.intelligence']),
      /**
       * THE AI'S WORK IS HERE; ITS WIRING IS IN THE SETTINGS.
       *
       * An OPERATION sits with the work and its CONFIGURATION sits in
       * settings. The provider, the key, the address of a server on the
       * owner's own machine and the house prompts are configuration
       * (`/settings/ai`). Asking the assistant a question is work.
       */
      // The bubble on every screen is the same chat; this page is its «افتح كاملاً» (owner, 24/10).
      { ...r('/assistant', 'المساعد الذكي', 'Bot', ['ai.use']), offMenu: true },
    ],
  },
  {
    // The shop's own face. Named «واجهة المتجر» and not «المتجر», because
    // «متجر التطبيقات» sits in «الإدارة» and two menu entries that both
    // read "store" are two entries nobody can tell apart.
    //
    // The rule that divides this group from /settings: anything about how
    // the shop LOOKS or what it SAYS lives here; anything about how the
    // system RUNS lives there. No field appears in both.
    key: 'storefront',
    label: 'واجهة المتجر',
    hub: 'loose',
    routes: [
      /**
       * TWO ENTRIES, WHERE TEN STOOD.
       *
       * `/store` first: every shop on one card each — which are live,
       * which sell anything, and the way into each one. The old
       * single-product address redirects here permanently (next.config.ts)
       * instead of living on as a second entry for the same thing.
       *
       * AND THE EIGHT THAT USED TO FOLLOW IT ARE NOW ITS TABS.
       *
       * «التصميم» «القوالب» «القوائم» «الصفحات التعريفية والسياسات»
       * «البحث والفلاتر» «اللغات» «المسارات» «الدومين» were eight menu
       * entries for one shop, and the owner's word for the result was
       * «معجّق … بتضيع». They are the three tabs of `/store?tab=…` now —
       * الواجهة · المحتوى · العنوان — defined once in
       * `src/lib/store-admin.ts`, and every one of the eight addresses
       * redirects permanently to the tab that holds it.
       *
       * NOT A SCREEN WAS DELETED: the same nine components render, in
       * panels. A menu entry is not a feature, and this group is a menu.
       *
       * TWO AND NOT THREE. §7.1 of docs/storefront/AUDIT.md proposed three
       * and §10 corrected itself in writing: «منصّة التجريب stays under
       * النمو — the storefront group is المتجر + صفحات الهبوط, two
       * entries, not three.» The bench is still where it was.
       */
      r('/store', 'المتجر', 'Store', ['storefront.view', 'storefront.manage', 'geo.manage']),
      r('/store/landing-pages', 'صفحات الهبوط', 'PanelsTopLeft', ['landing_pages.view']),
    ],
  },
  {
    /**
     * «الإدارة»: HOW THE SYSTEM RUNS, AND WHO RUNS IT — ONE LINE, A PAGE OF CARDS.
     *
     * The settings, the apps, the schedule, the staff and their permissions,
     * and the control screens (18/11: «الإعدادات» «الرقابة» «الإدارة» were three
     * lines). The line opens the first screen this person may open here — the
     * door `/settings` for whoever may open it, else their own first screen
     * (`hubHref`) — and every other screen carries «← الإدارة» back to it.
     */
    key: 'admin',
    label: 'الإدارة',
    icon: 'UserCog',
    hub: 'cards',
    routes: [
      /**
       * THE FRONT DOOR.
       *
       * A strip of twenty pills above every screen here would be the same
       * clutter moved up a row. So the menu holds ONE line, and this page is
       * what it opens: cards, each naming what it holds and linking to the
       * screens a person may open — and a card with nothing they may open is
       * not drawn.
       *
       * Its permissions are the union of the SETTINGS screens it fronts (as on
       * 18/11, pinned): whoever may open any one of them may open the door. The
       * staff, permissions and control screens are cards on it too, and somebody
       * who may open one of those but not the door reaches it through the line.
       */
      r('/settings', 'الإعدادات', 'Settings', ['geo.view', 'settings.view', 'commission.view', 'whatsapp.manage', 'telegram.connect', 'apps.view']),
      r('/settings/geo', 'البلدان والمتاجر', 'Globe', ['geo.view']),

      /**
       * ONE SCREEN FOR THE COURIER AND ITS FEES — and one entry for both.
       *
       * They were two: «شركات الشحن» and «أجور التوصيل», each linking to the
       * other because neither is usable alone. A fee row already carries
       * `deliveryProviderId`; in the data a fee has always been «this
       * courier, this region», and only the screens were split.
       *
       * It sits right after «البلدان والمتاجر» because that screen defines
       * the regions this one prices: you cannot set an Aleppo fee before
       * Aleppo exists, and the two now read in that order.
       */
      r('/settings/couriers', 'شركات الشحن وأجورها', 'Truck', ['settings.view']),
      r('/settings/channels', 'قنوات الطلبات', 'Radio', ['settings.view']),
      r('/settings/tracking', 'بكسل الإعلانات', 'Radar', ['settings.view']),
      // «الربط»: WhatsApp and Telegram, one card each (owner, 24/10). Each card is drawn only
      // for whoever holds ITS key; the page opens for either. The old addresses redirect.
      // Telegram's card asks the connection key, not the day's message work (T-09, 3/11).
      r('/settings/links', 'الربط', 'MessageCircle', ['whatsapp.manage', 'telegram.connect']),

      /**
       * WHAT WAS CONFIGURED FROM OTHER GROUPS, CONFIGURED HERE.
       *
       *   • «الذكاء الاصطناعي والنصوص» — the assistant's wiring; asking it is in «التقارير».
       *   • «متجر التطبيقات» and «التطبيقات المثبتة» — installing an app and
       *     wiring it up IS configuration.
       *   • «المهام المجدولة» — the schedule the system runs itself by; its own
       *     gate is `settings.view`, and it sits on the system card.
       *
       * The contract had said «apps appear ONCE». What it was protecting was
       * the ONCE — the same two screens in a main menu, in settings and in a
       * group of their own — and that holds: they are here and nowhere else.
       */
      r('/settings/ai', 'الذكاء الاصطناعي والنصوص', 'Bot', ['settings.view']),
      r('/apps/store', 'متجر التطبيقات', 'LayoutGrid', ['apps.view']),
      r('/apps/installed', 'التطبيقات المثبتة', 'Blocks', ['apps.view']),
      r('/settings/system', 'إعدادات النظام', 'Settings', ['settings.view']),
      r('/admin/jobs', 'المهام المجدولة', 'Timer', ['settings.view']),
      // «قواعد الموظفين» (19/11, R15a): «سكور الموظفين» and «قواعد الخصم» from «إعدادات النظام», moved unchanged, beside the staff. On `settings.view`, the key of the
      // page they came from — nobody gains or loses them; each card still asks its own key to edit.
      r('/admin/staff-rules', 'قواعد الموظفين', 'Award', ['settings.view']),
      r('/admin/users', 'الموظفين', 'UserCog', ['users.view']),
      r('/admin/permissions', 'الصلاحيات', 'ShieldCheck', ['roles.view']),
      // The control screens — what was asked to change, what was given off, what was taken from a salary,
      // who did what, and who is refused.
      r('/control/change-requests', 'طلبات التعديل', 'FilePen', ['control.change_requests']),
      r('/control/discount-alerts', 'تنبيهات الخصم', 'BadgePercent', ['control.discount_alerts']),
      // «خصومات الموظفين», not «الخصومات»: it sat beside «تنبيهات الخصم», and
      // one is money taken off a salary while the other is a price cut
      // given to a customer. Two words from one root, one row apart.
      r('/control/penalties', 'خصومات الموظفين', 'ShieldQuestion', ['penalties.view']),
      r('/control/audit', 'سجل التدقيق', 'ScrollText', ['audit.view']),
      r('/control/blacklist', 'القائمة السوداء', 'Ban', ['control.blacklist']),
      // Everybody's own page, so not a line of anybody's menu: its door is the name in the header and the
      // line in the phone's «المزيد» sheet. It stays in this group (and in the registry) for its guard and title.
      { ...r('/admin/profile', 'الملف الشخصي', 'CircleUser', null), offMenu: true },
    ],
  },
];

export const ALL_ROUTES: RouteDef[] = NAV.flatMap((g) => g.routes);

/** Exact contract route for a path, or undefined (= 404). */
/**
 * The screen's name, as the menu says it.
 *
 * A page title and a menu item that disagree cost a moment every time
 * somebody clicks one and lands on the other, so screens read their own
 * name from the registry. `findRoute` returns `undefined` for a path the
 * registry does not name — which is a bug, and a blank heading hides it.
 * The path is shown instead: wrong, and impossible to miss.
 */
export function routeLabel(path: string): string {
  return findRoute(path)?.label ?? path;
}

export function findRoute(path: string): RouteDef | undefined {
  return ALL_ROUTES.find((route) => route.path === path);
}

/** Whether the user may open this route (server truth; the sidebar reuses it). */
export function canAccessRoute(user: SessionUser, route: RouteDef, can: PermissionCheck): boolean {
  if (user.status !== 'ACTIVE') return false;
  if (route.permissions === null) return true;
  return route.permissions.some((p) => can(user, p));
}

/** The navigation as this user sees it: forbidden routes and empty groups removed. */
export function visibleNav(user: SessionUser, can: PermissionCheck): NavGroup[] {
  return NAV.map((g) => ({ ...g, routes: g.routes.filter((route) => canAccessRoute(user, route, can)) })).filter(
    (g) => g.routes.length > 0
  );
}

/**
 * THE MENU: `visibleNav` minus what folds under a screen this person can open.
 *
 * `visibleNav` answers «what may this person open» — the arrangement API, the
 * guard and the landing page ask THAT. The shell's menu asks this: a route marked
 * `foldedUnder` is not a line for somebody who can open the screen it is the detail
 * of, because that screen links to it. Someone who cannot open that screen keeps
 * the route as a line, so folding never takes a screen away.
 */
export function menuNav(user: SessionUser, can: PermissionCheck): NavGroup[] {
  const visible = visibleNav(user, can);
  // «May open the screen it is the detail of» is «that screen is in what this person may open».
  const openable = new Set(visible.flatMap((g) => g.routes.map((route) => route.path)));
  return visible
    .map((g) => ({ ...g, routes: g.routes.filter((route) => isMenuLine(route, openable)) }))
    .filter((g) => g.routes.length > 0);
}

/**
 * IS THIS SCREEN A LINE OF THE MENU — FOR A CALLER THAT KNOWS ONLY WHICH SCREENS THIS PERSON MAY OPEN.
 *
 * Two reasons a route is not a line: it is the DETAIL of a screen this person can open (`foldedUnder`),
 * or its door is not the menu at all (`offMenu`). This is that rule, written once: `menuNav` asks it on
 * the server, and the arrangement card asks it in the browser — which has the list of openable paths
 * (the arrangement door sends it) and no session to run `can` against. Two copies of «what is a menu
 * line» would drift the first time a third reason is added, and the card would then offer, for the phone's
 * bottom bar, a screen the bar can never draw.
 */
export function isMenuLine(route: RouteDef, openable: ReadonlySet<string>): boolean {
  if (route.offMenu) return false;
  if (!route.foldedUnder) return true;
  return !openable.has(route.foldedUnder);
}

/**
 * Where "/" sends this user.
 *
 * The dashboard is the first screen for anyone who may open it, but a
 * narrowly-scoped account (a moderator who only works his own orders) does
 * not hold dashboard.view — sending him there lands him on a 403 the moment
 * he logs in. He goes to the first screen he may actually open instead,
 * which is the first item of his own sidebar.
 */
export function landingRoute(user: SessionUser, can: PermissionCheck): string {
  const first = visibleNav(user, can)[0]?.routes[0];
  return first?.path ?? NO_ACCESS;
}

/**
 * WHERE A PERSON WITH NOTHING TO OPEN IS SENT — AND THAT IT IS A PAGE.
 *
 * `landingRoute` returned the string `'/no-access'` for years and nothing
 * answered at that address, so the one case it was written for — somebody
 * whose menu is empty — would have been met by a 404. It could not happen
 * in practice (the profile has no permission and every ACTIVE user opens
 * it), which is exactly why nobody noticed: a fallback that is never taken
 * is a fallback nobody tests.
 *
 * It is a constant now so the page, the redirect and the claim that the
 * page exists all say the same word. The page itself sends a person who
 * HAS something to open back to it — so «تحديث» after the manager grants a
 * role takes them in, and the two can never send each other round a loop.
 */
export const NO_ACCESS = '/no-access';
