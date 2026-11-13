import { BOTTOM_SLOTS } from './mobile-nav';
import type { NavGroup } from './route-registry';

/**
 * THE MENU, ARRANGED — AND WHY ARRANGING OPENS NOTHING.
 *
 * The owner, 15/10: «تصميم الموقع حتى الـ OMS لإلي وللموظفين خرى ومش سهل،
 * وما بقدر أتحكم بالقوائم والنوافذ». His decision: HE sets the base per
 * role, each person adjusts on top of it, and «رجّع الأساس» brings the base
 * back.
 *
 * ── ARRANGING IS COSMETIC, AND THAT IS A RULE, NOT A HOPE ──
 *
 * Nothing in this file decides who may open a screen. The menu it arranges
 * has ALREADY been filtered by `visibleNav`, which asks `canAccessRoute`
 * per route — and every door checks its own permission on the server when
 * it is opened. So hiding an item removes it from a list and nothing else:
 * typing the URL is refused exactly as it was before, and unhiding grants
 * nobody anything. The one thing this must never do is ADD a route, and
 * `apply` cannot: it only reorders and filters what it was handed.
 *
 * ── A LAYOUT IS THREE LISTS OF PATHS, AND TWO MORE OPINIONS — NOTHING ELSE ──
 *
 * Paths, because they are what the registry already keys on and what a URL
 * already is: a layout stored last month still means something after a
 * screen is renamed, and a route that no longer exists is simply absent
 * from the groups and so falls out.
 *
 * And a layout is never the whole menu: it is a PREFERENCE over it. A
 * route added to the registry next week is in nobody's `order`, so it
 * appears at the end of its group — present, for everyone, without
 * anybody's stored arrangement having to be migrated. That is the edge
 * case the brief names, and it falls out of taking the registry as the
 * source and the layout as the opinion.
 *
 * The two more are the owner's of 13/11, «لترتيب القوائم والخانات الرئيسية»:
 * the ORDER OF THE GROUPS (the main entries of the drawer) and the FOUR
 * SCREENS OF THE PHONE'S BOTTOM BAR. Both are the same kind of thing as the
 * three lists — a preference over what the registry and the viewer's menu
 * already hold — and both obey the same rule: a key or a path that is not in
 * the menu being arranged is not a thing this can conjure, it falls out.
 */

export interface NavLayout {
  /** Paths in the order they should appear. Unlisted ones keep registry order, after. */
  order: string[];
  /** Paths to leave out of the menu. Cosmetic — the door is still guarded. */
  hidden: string[];
  /** Paths to lift to the top of their group. */
  pinned: string[];
  /**
   * THE MAIN ENTRIES OF THE MENU, IN THE ORDER THE PERSON WANTS THEM — group KEYS.
   *
   * The drawer's eleven entries were the registry's order for everybody. A KEY, and not a label or a
   * position: it is what a group already is in the registry (`NavGroup.key`), and it survives a group
   * being renamed or a neighbour being added.
   *
   * ABSENT means «as the registry has them» — an old stored layout, a role base that never said, a
   * save from a browser tab that predates this field. It is present only when it holds something, so
   * every layout written before it exists reads back byte for byte as it did. A group nobody listed
   * keeps its registry order AFTER the listed ones (the rule the lines follow), so a group added next
   * week appears for everybody without anybody's layout being migrated; a key that no longer exists
   * falls out.
   */
  groups?: string[];
  /**
   * THE PHONE'S BOTTOM BAR — the PATHS of its slots, in order, at most `BOTTOM_SLOTS`.
   *
   * Without it the four are the system's ranking (`PHONE_ORDER` in mobile-nav.ts), the same for
   * everybody who may open the same screens. ABSENT means that ranking, and it is still what fills a
   * bar whose saved screens the person can no longer open — so the bar never has fewer slots than it
   * can. Each path must be a screen THIS person's menu holds; one that is not simply falls out when the
   * bar is drawn (`mobileNav`), whatever was stored.
   */
  slots?: string[];
  /**
   * NAMED FILTER SETS, FOR A SURFACE THAT HAS THEM — a published view.
   *
   * «المتأخرة أكثر من عشرة أيام، أرامكس، إربد» is what somebody opens the
   * orders screen to see every morning, and it costs six controls before
   * any work starts. A person's own views live in their browser
   * (`SavedViews`); this is the other half the owner asked for — a view HE
   * publishes to a role, so a new agent's first morning already has it.
   *
   * ── A VIEW IS A QUESTION, NEVER AN ANSWER ──
   *
   * It is a query string and a name. No results, no counts, no record ids
   * — nothing about any customer, and nothing that could still be true
   * when the data has moved on. Applying one re-asks the question through
   * the same API, which applies the same scope envelope it always did. So
   * a published view CANNOT widen what a role sees: the most it can do is
   * ask for rows the server then refuses to return.
   */
  views?: { name: string; query: string }[];
}

export const EMPTY_LAYOUT: NavLayout = { order: [], hidden: [], pinned: [] };

/**
 * Strings only, none of them empty, each ONCE — the first place wins.
 *
 * For the two lists where a repeat means nothing: a group listed twice is one group, and a screen in two
 * slots of the bar would be one tab drawn twice.
 */
function eachOnce(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))];
}

/**
 * A stored layout, read defensively.
 *
 * It arrives as JSON from a column, so it can be anything: a half-written
 * value, a shape from an older build, `null`. A menu is the one thing that
 * must not fail to render — losing it means the person cannot reach any
 * screen at all — so every field falls back to empty rather than throwing.
 */
export function parseLayout(raw: unknown): NavLayout {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return EMPTY_LAYOUT;
    }
  }
  if (!value || typeof value !== 'object') return EMPTY_LAYOUT;
  const o = value as Record<string, unknown>;
  /*
   * The views, read as defensively as the three lists: a name and a query,
   * both strings, and nothing else kept. A stored view carrying a third
   * field would be a shape from a build that is not this one.
   */
  const views = Array.isArray(o.views)
    ? o.views
        .filter(
          (v): v is { name: string; query: string } =>
            !!v &&
            typeof v === 'object' &&
            typeof (v as { name?: unknown }).name === 'string' &&
            typeof (v as { query?: unknown }).query === 'string'
        )
        .slice(0, 12)
        .map((v) => ({ name: v.name.slice(0, 40), query: v.query.slice(0, 500) }))
    : [];
  /*
   * The two newer opinions are present only when they hold something — the
   * same rule `views` follows — so a layout stored before they existed, and
   * one that says nothing about them, both read as exactly the old three
   * lists. «Said nothing» and «said an empty list» are one thing here.
   */
  const groups = eachOnce(o.groups);
  const slots = eachOnce(o.slots);
  return {
    order: strings(o.order),
    hidden: strings(o.hidden),
    pinned: strings(o.pinned),
    ...(groups.length > 0 ? { groups } : {}),
    ...(slots.length > 0 ? { slots } : {}),
    ...(views.length > 0 ? { views } : {}),
  };
}

/**
 * The role's base, then the person's own on top.
 *
 * Each list is answered by the person when they have said anything about
 * it, and by the base otherwise — PER LIST, not per field of a merged
 * object. A person who reordered but hid nothing keeps the role's hidden
 * items, which is the whole point of a base: the owner's decision stands
 * where the person has not made one.
 *
 * `null` for a person's layout — never saved, or «رجّع الأساس» pressed —
 * is therefore the base, exactly.
 *
 * THE GROUPS AND THE PHONE'S SLOTS FOLLOW THE SAME RULE, EACH ON ITS OWN:
 * a person who put the groups in an order of their own and never touched the
 * bar keeps the owner's four for the bar, and the other way round. «Says
 * anything» is «holds at least one entry» — an empty list is not an opinion,
 * which is also why a layout that says nothing about them carries no key at
 * all (see `parseLayout`).
 */
export function resolveLayout(base: NavLayout | null, own: NavLayout | null): NavLayout {
  const b = base ?? EMPTY_LAYOUT;
  const o = own ?? EMPTY_LAYOUT;
  const said = (list: string[] | undefined): string[] | undefined => (list && list.length > 0 ? list : undefined);
  const groups = said(o.groups) ?? said(b.groups);
  const slots = said(o.slots) ?? said(b.slots);
  return {
    order: o.order.length > 0 ? o.order : b.order,
    hidden: o.hidden.length > 0 ? o.hidden : b.hidden,
    pinned: o.pinned.length > 0 ? o.pinned : b.pinned,
    ...(groups ? { groups } : {}),
    ...(slots ? { slots } : {}),
    /*
     * Views are the one list that ADDS rather than replaces: the owner's
     * published views and a person's own are both offered, because they
     * answer different questions and a person who saved one of their own
     * has not thereby refused his. The person's come first — they chose
     * them — and a name collision keeps theirs.
     */
    ...(() => {
      const mine = o.views ?? [];
      const theirs = (b.views ?? []).filter((v) => !mine.some((m) => m.name === v.name));
      const all = [...mine, ...theirs];
      return all.length > 0 ? { views: all } : {};
    })(),
  };
}

/**
 * The groups as the menu should draw them.
 *
 * Order inside a group: pinned first (in the layout's own order), then the
 * rest by `order`, then whatever the layout never mentions — in registry
 * order, at the end.
 *
 * A group left with nothing visible is dropped, the same way `visibleNav`
 * drops a group a role cannot enter: an empty heading is a dead row.
 *
 * And the GROUPS themselves go in the order `layout.groups` names, by the
 * same rule as the lines inside them: the listed ones first, in the listed
 * order, then every group nobody listed in the order it arrived. The drop of
 * an empty group comes first, so a listed group with nothing left in it is
 * not drawn and does not hold a place. Still only a reordering of what was
 * handed in — a key this was not given is a rank nobody uses.
 */
export function applyArrangement(groups: NavGroup[], layout: NavLayout | null): NavGroup[] {
  if (!layout) return groups;
  const hidden = new Set(layout.hidden);
  const pinned = new Set(layout.pinned);
  const rank = new Map(layout.order.map((path, i) => [path, i]));

  const arranged = groups
    .map((group) => {
      const kept = group.routes.filter((r) => !hidden.has(r.path));
      const sorted = kept
        .map((route, i) => ({ route, i }))
        .sort((a, b) => {
          const ap = pinned.has(a.route.path) ? 0 : 1;
          const bp = pinned.has(b.route.path) ? 0 : 1;
          if (ap !== bp) return ap - bp;
          const ar = rank.get(a.route.path);
          const br = rank.get(b.route.path);
          // Unmentioned routes go last, among themselves in registry order.
          if (ar === undefined && br === undefined) return a.i - b.i;
          if (ar === undefined) return 1;
          if (br === undefined) return -1;
          return ar - br;
        })
        .map(({ route }) => route);
      return { ...group, routes: sorted };
    })
    .filter((g) => g.routes.length > 0);

  const wanted = layout.groups ?? [];
  if (wanted.length === 0) return arranged;
  // The FIRST place a key is listed is its place: a key listed twice is one group.
  const place = new Map<string, number>();
  wanted.forEach((key, i) => {
    if (!place.has(key)) place.set(key, i);
  });
  return arranged
    .map((group, i) => ({ group, i }))
    .sort((a, b) => {
      const ap = place.get(a.group.key);
      const bp = place.get(b.group.key);
      if (ap === undefined && bp === undefined) return a.i - b.i;
      if (ap === undefined) return 1;
      if (bp === undefined) return -1;
      return ap - bp;
    })
    .map(({ group }) => group);
}

/**
 * A layout kept to the paths and the group keys that still exist.
 *
 * Saved when the person presses save, so a stored layout does not grow a
 * tail of paths from screens that were removed — and so a path somebody
 * posted by hand, for a screen they may not open, is dropped instead of
 * stored. It cannot grant anything either way (see the note at the top),
 * but a store that holds only real paths is a store that can be read.
 *
 * THE KEYS IT IS TOLD ABOUT ARE THE ONLY GROUPS IT KEEPS. `groupKeys` is the
 * groups of the menu being arranged; without it there is nothing to check a
 * key against, and an unchecked key is dropped rather than trusted — a caller
 * that forgot to pass it loses the groups loudly (a test) instead of storing
 * whatever was posted. The slots are held to `BOTTOM_SLOTS`, each screen once —
 * the first place wins — and the cut comes AFTER the screens that fell out, so
 * one stale entry does not cost a slot.
 *
 * A SLOT IS A SCREEN THE DRAWER DRAWS AS A LINE, and that is a smaller set than «what may be opened»: the
 * assistant's page is openable and is no line of anybody's menu, and the board folded under the dashboard
 * is a line only for somebody who cannot open the dashboard. `menuLines` is that set (the door builds it
 * with `isMenuLine`); the three lists still follow `allowed`, as they always did, because arranging a
 * screen that is folded away today must survive the day it comes back. A caller that does not tell the
 * two apart passes nothing and gets `allowed` for both. A slot has to be BOTH, so a list handed in wrong
 * can never put a screen in the bar that its owner may not open.
 */
export function cleanLayout(
  layout: NavLayout,
  allowed: readonly string[],
  groupKeys: readonly string[] = [],
  menuLines: readonly string[] = allowed
): NavLayout {
  const ok = new Set(allowed);
  const lines = new Set(menuLines);
  const knownGroups = new Set(groupKeys);
  const groups = eachOnce(layout.groups).filter((key) => knownGroups.has(key));
  const slots = eachOnce(layout.slots)
    .filter((path) => lines.has(path) && ok.has(path))
    .slice(0, BOTTOM_SLOTS);
  return {
    order: layout.order.filter((p) => ok.has(p)),
    hidden: layout.hidden.filter((p) => ok.has(p)),
    pinned: layout.pinned.filter((p) => ok.has(p)),
    ...(groups.length > 0 ? { groups } : {}),
    ...(slots.length > 0 ? { slots } : {}),
  };
}

/**
 * WHAT A SAVE DID NOT SAY IS NOT WHAT A SAVE ERASES.
 *
 * A browser tab opened before this shipped knows three lists, and when its
 * owner presses save it posts three lists. The door replaces the stored layout
 * with what it was handed — so without this, that one save would quietly wipe
 * the group order and the phone's four the person had chosen, in a tab they
 * did not know was out of date.
 *
 * `said` is what the POST carried, by key. A key that was absent keeps what
 * is stored; a key that was there — even an empty list, which is how a current
 * client says «no opinion» — replaces it. So the three older lists are always
 * the post's, and only the two newer ones can be carried over.
 */
export function carryUnsaid(
  stored: NavLayout | null,
  posted: NavLayout,
  said: { groups: boolean; slots: boolean }
): NavLayout {
  const out: NavLayout = { ...posted };
  if (!said.groups) {
    if (stored?.groups && stored.groups.length > 0) out.groups = stored.groups;
    else delete out.groups;
  }
  if (!said.slots) {
    if (stored?.slots && stored.slots.length > 0) out.slots = stored.slots;
    else delete out.slots;
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * MOVING ONE SCREEN, WITHIN ITS OWN GROUP — BY BUTTON OR BY HAND.
 *
 * The menu arrangement had two buttons per row, up and down, and the owner
 * asked for dragging («سحب وإفلات»). The reasons it had been deferred are in
 * `MenuOrderCard`: a drag needs pointer, touch and keyboard paths to be
 * equal, and on a 390px screen a drag inside a scrolling column fights the
 * scroll. Both are answered there, by a library built for exactly that and by
 * keeping the buttons.
 *
 * What is HERE is the part that is the same whichever way it was moved: given
 * the whole menu's order and one group, where does the screen end up. Pure
 * and free of any drag library, so the buttons and the drag run through ONE
 * function and cannot disagree about what «move this one down» means.
 *
 * ── WITHIN ITS OWN GROUP, AND THAT IS A RULE ──
 *
 * A screen does not change what it is about by being dragged under another
 * heading. It was true of the buttons, which cannot leave the group, and it
 * stays true of the drag: each group is its own drop zone, and a drop that
 * names something outside the group moves nothing.
 *
 * ── AND ONE GROUP NEVER RESHUFFLES ANOTHER ──
 *
 * `order` is a flat list of paths across the whole menu (see `NavLayout`),
 * and a group is sorted by the rank of its own members. So the new order is
 * «everything before this group, then this group in its new order, then
 * everything after» — the other groups' paths keep their places exactly.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function reorderWithinGroup(
  flat: readonly string[],
  group: readonly string[],
  from: number,
  to: number
): string[] {
  const last = group.length - 1;
  // Nothing to do, or an index that is not in the group: leave the menu as it was.
  if (from === to || from < 0 || to < 0 || from > last || to > last) return [...flat];

  const moved = [...group];
  const [one] = moved.splice(from, 1);
  moved.splice(to, 0, one);

  const inGroup = new Set(group);
  const outside = flat.filter((p) => !inGroup.has(p));
  // How many of the others sit before this group's first member — those keep
  // their place, and the group goes in right after them.
  const firstAt = flat.findIndex((p) => inGroup.has(p));
  const before = firstAt < 0 ? outside.length : flat.slice(0, firstAt).filter((p) => !inGroup.has(p)).length;
  return [...outside.slice(0, before), ...moved, ...outside.slice(before)];
}

/** The two things a finished drag tells us, as the drag library reports them. */
export interface DragEnd {
  active: { id: string | number };
  over: { id: string | number } | null;
}

/**
 * The new order after a drag — or `null` when nothing moved.
 *
 * `null` for a drop on nothing, a drop on yourself, and a drop on something
 * that is not in this group (which a per-group drop zone cannot produce, and
 * which is refused here regardless: the rule does not depend on the library
 * being set up right).
 */
export function orderAfterDrag(
  flat: readonly string[],
  group: readonly string[],
  end: DragEnd
): string[] | null {
  if (!end.over || end.over.id === end.active.id) return null;
  const from = group.indexOf(String(end.active.id));
  const to = group.indexOf(String(end.over.id));
  if (from < 0 || to < 0) return null;
  return reorderWithinGroup(flat, group, from, to);
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * MOVING ONE GROUP, AND ONE SLOT OF THE PHONE'S BAR — BY BUTTON OR BY HAND.
 *
 * The lines inside a group have `reorderWithinGroup`; these are the same
 * promise for the two lists the owner added on 13/11. One function per
 * list, each asked by the buttons AND by the drag, so a finished drag and a
 * press of «انزل» cannot disagree about what a move means.
 *
 * They take the list as the person SEES it and give back the whole list
 * again, because that is what is stored: the card shows the groups that are in
 * this person's menu, and the order it hands back is that list, moved.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** One item to another place. An index outside the list, or the same place, leaves it as it was. */
function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const last = list.length - 1;
  // `Number.isInteger` and not just the range: `splice(NaN, …)` reads NaN as 0, which would move the
  // FIRST item for a drop that named no place at all.
  if (!Number.isInteger(from) || !Number.isInteger(to)) return [...list];
  if (from === to || from < 0 || to < 0 || from > last || to > last) return [...list];
  const moved = [...list];
  const [one] = moved.splice(from, 1);
  moved.splice(to, 0, one);
  return moved;
}

/** The group KEYS, one group moved from where it is to where it was put. */
export function reorderGroups(keys: readonly string[], from: number, to: number): string[] {
  return moveItem(keys, from, to);
}

/** The bar's slot PATHS, one slot moved from where it is to where it was put. */
export function reorderSlots(paths: readonly string[], from: number, to: number): string[] {
  return moveItem(paths, from, to);
}

/**
 * The new order of the groups after a drag — or `null` when nothing moved.
 *
 * `null` for a drop on nothing, a drop on itself, and a drop that names a key
 * which is not in the list (a screen's path dragged by mistake onto the
 * groups, a group that was never drawn): refused here regardless of how the
 * drag library was set up, as `orderAfterDrag` does for the lines.
 */
export function groupsAfterDrag(keys: readonly string[], end: DragEnd): string[] | null {
  if (!end.over || end.over.id === end.active.id) return null;
  const from = keys.indexOf(String(end.active.id));
  const to = keys.indexOf(String(end.over.id));
  if (from < 0 || to < 0) return null;
  return reorderGroups(keys, from, to);
}

/**
 * The bar's slots after the person picked a screen for one of them.
 *
 * The card offers each slot only the screens the other slots do not hold, so
 * a repeat cannot be picked from it. This is the same promise held in the
 * function and not in the markup: a screen that is already in another slot
 * SWAPS places with it (one tab drawn twice is not a bar), and a slot that does
 * not exist, or an empty path, changes nothing. Whether the path is a screen
 * of the person's menu is not asked here — the card offers only those, and
 * the bar (`mobileNav`) and the door (`cleanLayout`) each drop what is not.
 */
export function chooseSlot(shown: readonly string[], at: number, path: string): string[] {
  if (!Number.isInteger(at) || at < 0 || at >= shown.length || path === '') return [...shown];
  const there = shown.indexOf(path);
  const next = [...shown];
  if (there === at) return next;
  if (there >= 0) next[there] = shown[at];
  next[at] = path;
  return next;
}
