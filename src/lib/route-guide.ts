import { ALL_ROUTES, NAV, type RouteDef } from './route-registry';
import { activePath } from './active-route';
import { PERMISSION_MODULES } from './permission-catalog';

/**
 * A SCREEN THAT EXPLAINS ITSELF, ONE TAP FROM THE SCREEN.
 *
 * The owner, 21/10: «حاسو معجوق وصعب … شرح داخل السايت». The product had no
 * help at all — no tour, no guide, nothing that said what a screen was for
 * or what to do on it — and a new employee learned it by asking the person
 * at the next desk. The only thing near it was the ⓘ on the storefront
 * panels, which is a different agent's.
 *
 * ── WHAT IS DERIVED AND WHAT IS WRITTEN ──
 *
 * Derived, and so never out of date: the screen's name (the registry's), its
 * place on a numbered road and the stop after it (`next-stop.ts`), and who
 * opens it (the registry's permissions, in the words the roles screen uses).
 *
 * Written, because only a person who has watched the screen used can say it:
 * the steps, in the order they are done, in the names of the buttons that
 * are on the screen. They live in `route-guide-texts.ts`, which is loaded
 * when the sheet is OPENED and not before — fifty screens of Arabic prose is
 * not something every page should download in case somebody is curious.
 *
 * ── WHY AN INDEX, WHEN THE TEXTS COULD SIMPLY BE IMPORTED ──
 *
 * The ⓘ has to decide, on first paint, whether to exist. Asking the texts
 * would mean loading them, which is the thing being avoided. So this file
 * keeps the list of screens that HAVE a guide, and a test holds it equal to
 * the keys of the texts — the one duplication in the design, guarded rather
 * than hoped about.
 *
 * ── NOT THE STOREFRONT'S ──
 *
 * `/store` and the landing pages belong to the storefront's own agent. Their
 * headers are the shared `PageHeader`, so a guide for them would put a button
 * on screens this work was told not to touch; the lookup refuses them.
 */

export interface GuideText {
  /**
   * What to do here, in the order it is done. In the names of the buttons
   * that are on the screen — a step that says «اضغط الزر» teaches nothing.
   */
  steps: readonly string[];
  /** The one thing that goes wrong, or the rule that surprises. */
  watch?: string;
  /**
   * Where this leads when the screen is not a stop of a numbered road (a
   * stop's next is derived from the road and this is ignored). A registry path.
   */
  next?: string;
}

/**
 * The screens that have a written guide. Held equal to the keys of
 * `route-guide-texts.ts` by `the-screen-explains-itself.test.tsx`.
 */
export const GUIDED_PATHS: readonly string[] = [
  // الرئيسية
  '/dashboard',
  '/orders',
  '/abandoned-carts',
  '/customers',
  '/products',
  // مركز التأكيد
  '/confirmation/queue',
  '/confirmation/mine',
  '/confirmation/follow-up',
  '/confirmation/issues',
  '/confirmation/rules',
  // الشحن — the five stops of one parcel's road
  '/ops/preparation',
  '/ops/shipments/new',
  '/ops/batches',
  '/ops/tracking',
  '/ops/returns',
  // المال — the four stops of the courier's money
  '/finance/agents',
  '/finance/collection',
  '/finance/matching',
  '/finance/closing',
  // المخزون
  '/inventory/balances',
  '/manufacturing',
  '/inventory/movements',
  // المال — بقية الشاشات
  '/finance/wallets',
  '/finance/transfers',
  '/finance/profit',
  '/finance/rules',
  // الرقابة
  '/control/change-requests',
  '/control/discount-alerts',
  '/control/penalties',
  '/control/audit',
  '/control/blacklist',
  // النمو والذكاء
  '/growth/performance',
  '/growth/campaigns',
  '/assistant',
  '/growth/intelligence',
  '/growth/bench',
  '/growth/whatsapp/inbox',
  '/growth/telegram/orders',
  '/growth/landing-chats',
  // الإعدادات
  '/settings',
  '/settings/geo',
  '/settings/couriers',
  '/settings/commission',
  '/settings/channels',
  '/settings/tracking',
  '/settings/links',
  '/settings/ai',
  '/apps/store',
  '/apps/installed',
  '/settings/system',
  '/admin/jobs',
  // الإدارة
  '/admin/staff-rules',
  '/admin/users',
  '/admin/permissions',
  '/admin/profile',
];

const GUIDED = new Set(GUIDED_PATHS);
const PATHS = ALL_ROUTES.map((r) => r.path);
const STOREFRONT = new Set(
  NAV.filter((g) => g.key === 'storefront').flatMap((g) => g.routes.map((r) => r.path))
);

/**
 * The screen a pathname is, when that screen has a guide and is ours to give
 * one — or `null`.
 *
 * `activePath` is the menu's own «which item is lit» rule, so a nested address
 * (an order opened over the orders list) is still the screen underneath it.
 */
export function guideRoute(pathname: string | null | undefined): RouteDef | null {
  if (!pathname) return null;
  const at = activePath(pathname, PATHS);
  if (!at || STOREFRONT.has(at) || !GUIDED.has(at)) return null;
  return ALL_ROUTES.find((r) => r.path === at) ?? null;
}

const PERMISSION_AR = new Map<string, string>(
  PERMISSION_MODULES.flatMap((m) => m.items.map((i) => [i.key, i.ar] as const))
);

/** A permission in the words the roles screen uses for it. */
export function permissionName(key: string): string {
  return PERMISSION_AR.get(key) ?? key;
}

/**
 * WHO OPENS THIS SCREEN — in the registry's words, so it cannot drift.
 *
 * `null` means everyone who is signed in. Otherwise the registry lists the
 * permissions and ANY ONE of them opens the screen (that is what
 * `canAccessRoute` checks), so the sentence must say «أو», not «و».
 */
export function whoOpens(route: RouteDef): string[] | null {
  return route.permissions === null ? null : route.permissions.map(permissionName);
}
