import { describe, expect, it } from 'vitest';
import { activePath, isActiveGroup, isActiveRoute } from './active-route';
import { ALL_ROUTES } from './route-registry';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE MENU SAID THE PERSON WAS IN TWO PLACES AT ONCE.
 *
 * The sidebar and the phone drawer each asked, per item,
 *
 *     pathname === r.path || pathname.startsWith(r.path + '/')
 *
 * which is true for MORE THAN ONE item whenever one route's path is a
 * prefix of another's. On «صفحات الهبوط» (`/store/landing-pages`) both it
 * and «المتجر» (`/store`) lit — and «المتجر» is the parent, drawn higher
 * and read first, so the menu pointed at the screen the person was NOT
 * on.
 *
 * `ScreenTitle` (deleted 18/11) had the rule right — among the matching prefixes, the
 * longest wins — and kept it to itself, which is why the heading and the
 * menu could disagree about where somebody was standing.
 *
 * The rule is one function now. These claims hold it, and hold that the
 * callers use it rather than keeping a copy each (three until 18/11, two now).
 * ═══════════════════════════════════════════════════════════════════════
 */

const PATHS = ['/store', '/store/landing-pages', '/orders', '/settings', '/settings/geo'];

describe('one item is lit, and it is the deepest one', () => {
  it('a nested route lights itself and not its parent', () => {
    expect(isActiveRoute('/store/landing-pages', '/store/landing-pages', PATHS)).toBe(true);
    expect(isActiveRoute('/store/landing-pages', '/store', PATHS), 'المتجر ضلّ مضويّ').toBe(false);
  });

  it('and the parent lights on its own screen', () => {
    expect(isActiveRoute('/store', '/store', PATHS)).toBe(true);
  });

  it('and a screen deeper than any item lights the nearest one above it', () => {
    // /settings/geo/countries/5 is still the countries screen, not nothing.
    expect(activePath('/settings/geo/countries/5', PATHS)).toBe('/settings/geo');
  });

  it('and exactly one item is ever lit', () => {
    for (const pathname of ['/store', '/store/landing-pages', '/settings/geo/x', '/orders/7']) {
      const lit = PATHS.filter((p) => isActiveRoute(pathname, p, PATHS));
      expect(lit.length, `${pathname}: انضوى ${lit.length} عنصر`).toBeLessThanOrEqual(1);
    }
  });

  it('and a path outside the menu lights nothing', () => {
    expect(activePath('/nowhere', PATHS)).toBeNull();
  });

  it('and a prefix that is not a path boundary does not count', () => {
    // `/storefront` is not inside `/store`.
    expect(isActiveRoute('/storefront', '/store', [...PATHS, '/storefront'])).toBe(false);
  });

  it('and the group that opens is the one holding the lit item', () => {
    // Not «a group with any matching route»: `/store` matches on
    // `/store/landing-pages`, so a group holding only `/store` would open
    // beside the group holding the screen the person is actually on.
    expect(isActiveGroup('/store/landing-pages', ['/store/landing-pages'], PATHS)).toBe(true);
    expect(isActiveGroup('/store/landing-pages', ['/store'], PATHS), 'مجموعتان مفتوحتان').toBe(
      false
    );
  });
});

describe('and the real menu, with the real registry', () => {
  it('never lights two items on any route it draws', () => {
    // Measured on every path in the registry rather than on an example:
    // this is the shape of defect that hid in a pair nobody looked at.
    const paths = ALL_ROUTES.map((r) => r.path);
    for (const pathname of paths) {
      const lit = paths.filter((p) => isActiveRoute(pathname, p, paths));
      expect(lit, `${pathname}: ${lit.join(' + ')}`).toHaveLength(1);
    }
  });

  it('and «صفحات الهبوط» lights only itself — the one that was reported', () => {
    const paths = ALL_ROUTES.map((r) => r.path);
    const landing = paths.find((p) => p.includes('landing'));
    expect(landing, 'ما في شاشة صفحات هبوط بالسجلّ').toBeTruthy();
    const lit = paths.filter((p) => isActiveRoute(landing!, p, paths));
    expect(lit).toEqual([landing]);
  });
});

describe('and no screen keeps a copy of the rule', () => {
  it('the two that ask use the shared one', () => {
    /*
     * A second copy is where this fault came from: three files asked the
     * same question and two of them answered it differently. The rule is
     * the import.
     */
    for (const rel of [
      'src/components/shell/Sidebar.tsx',
      'src/components/shell/MobileNav.tsx',
      // 18/11 (R3): 'src/components/shell/ScreenTitle.tsx' was the third — it is deleted (its screens draw PageHeader with
      // the name read from the registry, and ask no address at all), so two callers are left.
    ]) {
      const src = stripComments(repoFile(rel));
      expect(src, `${rel}: ما بيستعمل القاعدة المشتركة`).toMatch(/from '@\/lib\/active-route'/);
      expect(src, `${rel}: لسّا فيه نسخة من القاعدة`).not.toMatch(/startsWith\([a-zA-Z.]*path \+ '\/'\)/);
    }
  });
});
