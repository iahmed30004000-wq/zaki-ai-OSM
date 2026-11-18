import { NAV, type NavGroup, type RouteDef } from './route-registry';
import { activePath } from './active-route';

/**
 * WHAT A HUB IS ASKED, AND ANSWERED IN ONE PLACE.
 *
 * The sidebar draws a hub as one line and the strip above a screen draws its
 * siblings, and both have to agree about three things: which hub a page is in,
 * where the line leads, and what the line is called. Asked separately they
 * would drift — the line would say «الإدارة» while the strip said something
 * else — so the sidebar and the strip both read this.
 *
 * Pure, and it takes the groups it is GIVEN: the menu this person actually
 * has, already stripped of what they may not open and already arranged the
 * way they arranged it. So a pill never appears for a screen they cannot
 * open, and their own order and hiding apply to the strip as they do to the
 * sidebar. See `NavGroup.hub` for what the three kinds of group are.
 */

export interface HubAt {
  group: NavGroup;
  /** The screen the person is standing on. */
  here: RouteDef;
}

/** Is this group drawn as a single line (and so a hub), rather than as a folding heading or loose lines? */
export const isHub = (group: NavGroup): boolean => group.hub === 'tabs' || group.hub === 'cards';

/**
 * The hub the current page belongs to, or null — a page in a loose group,
 * in a heading that folds, or in none (a detail page, the profile of nobody).
 *
 * «Belongs to» is the same single answer the sidebar lights an item by: the
 * LONGEST matching path. `/settings` is a prefix of every settings screen,
 * and standing on `/settings/geo` must not read as standing on the front door.
 */
export function hubAt(groups: readonly NavGroup[], pathname: string): HubAt | null {
  const drawn = groups.flatMap((g) => g.routes.map((r) => r.path));
  const at = activePath(pathname, drawn);
  if (!at) return null;
  const group = groups.find((g) => g.routes.some((r) => r.path === at));
  if (!group || !isHub(group)) return null;
  return { group, here: group.routes.find((r) => r.path === at)! };
}

/**
 * The page of cards a 'cards' group opens on — its FIRST screen in the registry, whether or not this person
 * may open it (18/11). Somebody who may open a screen of «الإدارة» but not its door (`/settings`) has no page of
 * cards to go back to: the strip above their screens is then pills, like any group of tabs, so a second
 * screen they may open is never left without a way in.
 */
export function cardsDoor(group: NavGroup): string | undefined {
  return NAV.find((g) => g.key === group.key)?.routes[0]?.path;
}

/** Where a hub's one line leads: the first screen this person may open in it. */
export function hubHref(group: NavGroup): string {
  return group.routes[0]?.path ?? '/';
}

/**
 * What the line is called.
 *
 * A group of tabs of which only ONE is left to this person is not a group any
 * more — a packer's «الشحن» holds nothing but «التجهيز» —
 * so the line takes that screen's own name and says what is actually behind
 * it. A page of cards keeps its group's name: its first screen IS the group.
 */
export function hubLabel(group: NavGroup): string {
  return group.hub === 'tabs' && group.routes.length === 1 ? group.routes[0].label : group.label;
}
