/**
 * WHICH MENU ITEM IS LIT, DECIDED IN ONE PLACE.
 *
 * Three files asked this question and two of them got it wrong. The
 * sidebar and the phone drawer both read
 *
 *     pathname === r.path || pathname.startsWith(r.path + '/')
 *
 * per item, which is true for MORE THAN ONE item whenever one route's
 * path is a prefix of another's. `/store/landing-pages` lights
 * «صفحات الهبوط» AND «المتجر», so the menu says the person is in two
 * places at once — and the one they are actually in is the less
 * prominent of the two.
 *
 * `ScreenTitle` (deleted 18/11 — its screens read their name from the
 * registry through `PageHeader` now) had it right, and only because it needed a single answer
 * to print a heading: among the matching prefixes, take the LONGEST. That
 * is the rule, and it lives here now so there is one of it.
 *
 * Pure, with no imports: the sidebar and the drawer run in the browser,
 * and the frame is rendered on the server.
 */

/** A route is a match when the path is it, or sits underneath it. */
function matches(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(path + '/');
}

/**
 * The path of the item to light, out of the candidates — or `null`.
 *
 * Candidates are the registry's paths; the caller passes whichever set it
 * draws. The longest match wins, so a nested screen lights itself and
 * nothing above it.
 */
export function activePath(pathname: string, paths: readonly string[]): string | null {
  let best: string | null = null;
  for (const path of paths) {
    if (!matches(pathname, path)) continue;
    if (best === null || path.length > best.length) best = path;
  }
  return best;
}

/**
 * Is THIS item the one to light?
 *
 * `paths` is every path the menu draws — needed because the answer
 * depends on the others: `/store` is lit on `/store/x` only when nothing
 * longer matches.
 */
export function isActiveRoute(pathname: string, path: string, paths: readonly string[]): boolean {
  return activePath(pathname, paths) === path;
}

/**
 * Does a GROUP contain the lit item?
 *
 * The sidebar opens the group the person is inside. Keyed on the same
 * single answer, so a group cannot open because one of its routes is a
 * prefix of the route somebody is actually on.
 */
export function isActiveGroup(
  pathname: string,
  groupPaths: readonly string[],
  allPaths: readonly string[]
): boolean {
  const active = activePath(pathname, allPaths);
  return active !== null && groupPaths.includes(active);
}
