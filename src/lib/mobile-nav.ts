import type { NavGroup, RouteDef } from './route-registry';

/**
 * THE FIVE THINGS A PHONE SHOWS — AND WHY THEY ARE NOT THE SAME FIVE.
 *
 * A bottom bar has room for five. Picking the same five for everybody means
 * a confirmation agent's phone opens on a dashboard she cannot act on, with
 * the one screen she uses all day behind a menu.
 *
 * So the five are chosen from what THIS person may open, ordered by how
 * close each screen is to work they actually do on a phone:
 *
 *   a screen they act on standing up, with a customer waiting, outranks
 *   a screen they read sitting down, which outranks a screen they
 *   configure once a month.
 *
 * Everything else is still reachable — the sixth slot is "المزيد" and it
 * opens the whole list. Nothing is hidden; the frequent things are simply
 * not behind a menu.
 *
 * The server has already removed every route this person may not open, so
 * nothing here decides access. It only decides order.
 */

/**
 * How near a screen is to work done on a phone. Lower comes first.
 *
 * Written as a list of paths rather than a number per route so the ordering
 * can be read top to bottom and argued with: "why is the picking screen
 * above the products list" has an answer you can see.
 */
const PHONE_ORDER = [
  // Work done standing, with somebody waiting.
  '/confirmation/mine',
  '/confirmation/queue',
  '/ops/preparation',
  '/ops/tracking',
  '/orders',
  '/confirmation/follow-up',
  '/ops/shipments/new',
  '/ops/returns',
  '/finance/collection',
  // Looked at often, acted on sometimes.
  '/dashboard',
  '/confirmation/issues',
  '/control/change-requests',
  '/inventory/balances',
  '/customers',
  '/products',
  // Read, rarely typed into on a phone.
  '/growth/performance',
  '/finance/wallets',
  '/assistant',
];

const rank = (path: string): number => {
  const i = PHONE_ORDER.indexOf(path);
  // Anything unlisted sits after everything listed, in registry order —
  // a new screen appears in "المزيد" rather than silently taking a slot
  // from a screen somebody uses every hour.
  return i === -1 ? PHONE_ORDER.length + 1 : i;
};

/** How many fit across the bottom of a phone beside "المزيد". */
export const BOTTOM_SLOTS = 4;

export interface MobileNav {
  /** The ones with their own tab, best first. */
  primary: RouteDef[];
  /** Everything else, grouped as the sidebar groups it. */
  rest: NavGroup[];
}

/**
 * Split what this person can reach into a bottom bar and a sheet.
 *
 * `current` is the page they are on. It is forced into the bar even when it
 * did not earn a slot: a tab bar that does not contain the page you are
 * looking at reads as broken, and somebody taps around trying to find where
 * they already are.
 *
 * `slots` is the person's own choice of the bar — paths, in the order they
 * put them (the owner, 13/11: «الخانات الرئيسية»). It is a preference over
 * `groups`, never a source of screens: only a path THIS menu holds can take a
 * slot, each screen once, and what is left over is filled from the ranking
 * above, so the bar is never shorter than the screens the person can reach.
 * A screen the person may no longer open, or hid from the menu, is simply not
 * in `groups` and so falls out without anybody being told. Without `slots`
 * (or with an empty list) the bar is the ranking alone, exactly as it was.
 */
export function mobileNav(
  groups: NavGroup[],
  current?: string | null,
  slots?: readonly string[]
): MobileNav {
  const all = groups.flatMap((g) => g.routes);
  const byRank = [...all].sort((a, b) => rank(a.path) - rank(b.path));

  // The person's own first, in the order they put them — only screens THIS menu holds — then the ranking fills
  // what is left. A `Set` keeps each screen once, at its first place; the cut comes after the stale ones fell out.
  const wanted = (slots ?? []).flatMap((path) => all.filter((r) => r.path === path));
  const primary = [...new Set([...wanted, ...byRank])].slice(0, BOTTOM_SLOTS);

  if (current) {
    const here = all.find((r) => current === r.path || current.startsWith(r.path + '/'));
    if (here && !primary.some((r) => r.path === here.path)) {
      // Takes the last slot — the one that earned its place least.
      primary[primary.length - 1] = here;
    }
  }

  const taken = new Set(primary.map((r) => r.path));
  const rest = groups
    .map((g) => ({ ...g, routes: g.routes.filter((r) => !taken.has(r.path)) }))
    .filter((g) => g.routes.length > 0);

  return { primary, rest };
}
