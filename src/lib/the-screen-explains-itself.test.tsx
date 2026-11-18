// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A SCREEN THAT EXPLAINS ITSELF — AND NEVER SAYS A WORD THAT IS NOT ON IT.
 *
 * The owner, 21/10: «حاسو معجوق وصعب … شرح داخل السايت». The product had no
 * help at all. This gives the screens a ⓘ that opens a sheet of what to do
 * there — and the sheet is the most dangerous kind of text a product can
 * carry, because it is read by someone who is already lost: if it says
 * «اضغط «حفظ التفسير»» and the button is called something else now, the
 * person concludes THEY are the one who is wrong.
 *
 * So the claims are mostly about the text staying true:
 *
 *   • every name it quotes between «» is a name that is on a screen (or in
 *     the menu), checked against the source — rename a button and this fails
 *     in the name of the guide that quoted it;
 *   • the road stops, which are the screens a new person is walked through,
 *     all have one, and a stop's «next» is never written (it is read from the
 *     menu's own order, so it cannot go stale);
 *   • the button is where an eye looks for «what is this» on the one header
 *     (two kinds until 18/11, when ScreenTitle was folded into PageHeader),
 *     appears only where there is something to open, and is drawn
 *     nowhere on the storefront's screens, which are another agent's;
 *   • the texts are fetched when the sheet is opened and not before.
 * ═══════════════════════════════════════════════════════════════════════
 */

const here = { path: '/orders' };
vi.mock('next/navigation', () => ({ usePathname: () => here.path }));

// The permission question, answered by the test. Everything else is the real thing.
const may = { yes: (_path: string) => true };
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string | { path: string }) => may.yes(typeof target === 'string' ? target : target.path),
}));

import { ScreenGuideProvider, GuideButton } from '@/components/shell/ScreenGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { GUIDED_PATHS, guideRoute, permissionName, whoOpens } from './route-guide';
import { GUIDE_TEXTS } from './route-guide-texts';
import { ALL_ROUTES, NAV, routeLabel } from './route-registry';
import { repoFile, stripComments } from './guard-source';

beforeEach(() => {
  here.path = '/orders';
  may.yes = () => true;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ───────────────────────── the index and the texts ─────────────────────────

describe('the index says exactly which screens have a guide', () => {
  it('— the same set as the texts, with nothing listed twice', () => {
    expect(new Set(GUIDED_PATHS).size, 'مسار مكرر بالفهرس').toBe(GUIDED_PATHS.length);
    expect([...GUIDED_PATHS].sort()).toEqual(Object.keys(GUIDE_TEXTS).sort());
  });

  it('and each one is a real screen of the menu', () => {
    const paths = new Set(ALL_ROUTES.map((r) => r.path));
    for (const p of GUIDED_PATHS) expect(paths.has(p), `${p} مش بالقائمة`).toBe(true);
  });

  it('and none of them is the storefront’s — those screens are another agent’s', () => {
    const store = NAV.find((g) => g.key === 'storefront')!.routes.map((r) => r.path);
    expect(store.length).toBeGreaterThan(0);
    for (const p of store) {
      expect(GUIDED_PATHS, `${p} للمتجر`).not.toContain(p);
      here.path = p;
      expect(guideRoute(p), p).toBeNull();
    }
  });

  it('and every stop of a numbered road has one — those are the screens a new person is walked through', () => {
    const stops = ALL_ROUTES.filter((r) => r.step !== undefined);
    expect(stops.length, 'ما في محطات').toBeGreaterThanOrEqual(9);
    for (const s of stops) expect(GUIDED_PATHS, `${s.path} محطة بلا شرح`).toContain(s.path);
  });

  it('and so does the whole confirmation desk, the first thing a new agent opens', () => {
    const desk = NAV.find((g) => g.key === 'confirmation')!.routes.map((r) => r.path);
    for (const p of desk) expect(GUIDED_PATHS, `${p} بلا شرح`).toContain(p);
  });
});

describe('what each guide says is short, plain and in Arabic', () => {
  const entries = Object.entries(GUIDE_TEXTS);
  // Letters of the Latin alphabet that are names of things on the screen or in the trade.
  const LATIN_OK = /\b(QR|CSV|Excel|SKU|WhatsApp)\b/g;

  it.each(entries)('%s', (path, g) => {
    expect(g.steps.length, `${path}: عدد الخطوات`).toBeGreaterThanOrEqual(2);
    expect(g.steps.length, `${path}: خطوات كثيرة — يقرؤها من هو تائه`).toBeLessThanOrEqual(6);
    const all = [...g.steps, ...(g.watch ? [g.watch] : [])];
    for (const line of all) {
      expect(line.length, `${path}: سطر طويل: ${line.slice(0, 40)}…`).toBeLessThanOrEqual(220);
      expect(/[؀-ۿ]/.test(line), `${path}: سطر بلا عربي: ${line}`).toBe(true);
      expect(/<\/?[a-z][^>]*>/i.test(line), `${path}: وسم HTML: ${line}`).toBe(false);
      expect(/[A-Za-z]/.test(line.replace(LATIN_OK, '')), `${path}: كلمة إنجليزية: ${line}`).toBe(false);
      expect(line.trim(), `${path}: مسافة زائدة`).toBe(line);
    }
  });

  it('and a stop of a road never writes its own «next» — it is read from the menu', () => {
    for (const r of ALL_ROUTES.filter((x) => x.step !== undefined)) {
      expect(GUIDE_TEXTS[r.path]?.next, `${r.path}: التالي مكتوب بيد`).toBeUndefined();
    }
  });

  it('and a «next» that is written points at a screen of the menu', () => {
    const paths = new Set(ALL_ROUTES.map((r) => r.path));
    for (const [path, g] of entries) {
      if (g.next) expect(paths.has(g.next), `${path} → ${g.next}`).toBe(true);
    }
  });

  it('and every permission it will print has a name the roles screen uses', () => {
    for (const p of GUIDED_PATHS) {
      const route = ALL_ROUTES.find((r) => r.path === p)!;
      for (const key of route.permissions ?? []) {
        expect(permissionName(key), `${p}: صلاحية بلا اسم عربي: ${key}`).not.toBe(key);
      }
    }
  });
});

// ───────────────────────── every quoted name is on a screen ─────────────────────────

/** The route's page file: the directory under src/app with the route groups taken out. */
function pageFileFor(routePath: string): string | null {
  const base = join(process.cwd(), 'src', 'app');
  const walk = (dir: string, parts: string[]): string | null => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      const isGroup = entry.startsWith('(') && entry.endsWith(')');
      const next = isGroup ? parts : [...parts, entry];
      if ('/' + next.join('/') === routePath && existsSync(join(full, 'page.tsx'))) return join(full, 'page.tsx');
      const deeper = walk(full, next);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(base, []);
}

/** A file, the components it imports, and theirs — three levels, which is where a screen’s buttons live. */
function closure(file: string, depth = 3, seen = new Set<string>()): string[] {
  if (seen.has(file) || !existsSync(file)) return [];
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  const out = [text];
  if (depth === 0) return out;
  for (const m of text.matchAll(/from\s+'@\/components\/([^']+)'/g)) {
    for (const cand of [`${m[1]}.tsx`, `${m[1]}/index.tsx`]) {
      const f = join(process.cwd(), 'src', 'components', cand);
      if (existsSync(f) && !f.endsWith('.test.tsx')) out.push(...closure(f, depth - 1, seen));
    }
  }
  return out;
}

describe('every name a guide quotes is a name that is on a screen', () => {
  const screens = GUIDED_PATHS.map((p) => ({ path: p, page: pageFileFor(p) }));
  const registryLabels = new Set(ALL_ROUTES.map((r) => r.label));

  it('— every guided screen has a page to read, or this check would be vacuous', () => {
    for (const s of screens) expect(s.page, `${s.path}: ما لقيت صفحة`).not.toBeNull();
  });

  /*
   * The union of every guided screen's source, not each screen's own: a guide
   * may point at a button on the NEXT screen («استلمت منه» is on tracking, and
   * the agents guide sends you there). A name that has gone from every one of
   * them is the failure this exists for; a name that moved from one guided
   * screen to another is a smaller sin and the guide’s own steps still read.
   */
  const corpus = screens.flatMap((s) => (s.page ? closure(s.page) : [])).join('\n');

  it('and the corpus is big enough to mean something', () => {
    expect(corpus.length, 'ما انقرأ شي').toBeGreaterThan(200_000);
  });

  it.each(Object.entries(GUIDE_TEXTS))('%s', (path, g) => {
    const quoted = [...g.steps, ...(g.watch ? [g.watch] : [])].flatMap((line) =>
      [...line.matchAll(/«([^»]+)»/g)].map((m) => m[1].trim())
    );
    for (const q of quoted) {
      const known = registryLabels.has(q) || corpus.includes(q);
      expect(known, `${path}: «${q}» مش على أي شاشة ولا بالقائمة`).toBe(true);
    }
  });

  /*
   * THE TWO GUIDES WRITTEN ON 22/10 ARE HELD TO THEIR OWN SCREEN, not to the union above. The union is right for a guide that sends
   * you to the next screen; these two send you nowhere, so every name they quote has to be on the screen they sit on. Measured when
   * they were written: «لم يُحصَّل بعد» renamed to «المتبقي» in the dashboard's guide passed the union (other screens say
   * «المتبقي»), and would have sent a person looking for a card that does not exist.
   */
  it.each(['/dashboard', '/settings/tracking'])('%s quotes only names that are on its own screen', (path) => {
    const page = pageFileFor(path);
    expect(page, `${path}: ما لقيت صفحة`).not.toBeNull();
    const own = closure(page!).join('\n');
    expect(own.length, `${path}: ما انقرأ شي`).toBeGreaterThan(5_000);
    const g = GUIDE_TEXTS[path];
    const quoted = [...g.steps, ...(g.watch ? [g.watch] : [])].flatMap((line) =>
      [...line.matchAll(/«([^»]+)»/g)].map((m) => m[1].trim())
    );
    expect(quoted.length, `${path}: ما في أسماء مقتبسة`).toBeGreaterThan(5);
    for (const q of quoted) {
      expect(own.includes(q), `${path}: «${q}» مش على شاشتها هي`).toBe(true);
    }
  });

  it('and the check can fail — a name nobody wrote is refused', () => {
    // The corpus is a string; an invented name must not be found in it. If this
    // ever passes, the test above has stopped being able to tell.
    expect(corpus.includes('زر لا يوجد في أي شاشة منذ الأزل')).toBe(false);
    expect(registryLabels.has('زر لا يوجد في أي شاشة منذ الأزل')).toBe(false);
  });
});

// ───────────────────────── what is derived ─────────────────────────

describe('what is derived rather than written', () => {
  it('— a nested address is still the screen underneath it, as in the menu', () => {
    expect(guideRoute('/orders')?.path).toBe('/orders');
    expect(guideRoute('/orders/3f2b8c1e-7a4d-4e65-9b0a-1c2d3e4f5a6b')?.path).toBe('/orders');
    expect(guideRoute('/ops/tracking')?.path).toBe('/ops/tracking');
  });

  it('and a screen without a guide, an address outside the menu, and no address at all, have none', () => {
    expect(guideRoute('/store')).toBeNull();
    expect(guideRoute('/nowhere')).toBeNull();
    expect(guideRoute('')).toBeNull();
    expect(guideRoute(null)).toBeNull();
    expect(guideRoute(undefined)).toBeNull();
  });

  it('and «who opens it» is the registry’s own permissions, in the roles screen’s words, joined by OR', () => {
    const customers = ALL_ROUTES.find((r) => r.path === '/customers')!;
    expect(customers.permissions!.length, 'الاختبار يفترض صلاحيتين').toBeGreaterThan(1);
    expect(whoOpens(customers)).toEqual(customers.permissions!.map(permissionName));
    expect(whoOpens(customers)).toContain('عرض العملاء');
    // null means «anybody signed in», and is said that way.
    expect(whoOpens({ path: '/x', label: 'x', icon: 'x', permissions: null })).toBeNull();
  });
});

// ───────────────────────── the button and the sheet ─────────────────────────

/*
 * 18/11 (R3): there is one header now. `'title'` used to mount `ScreenTitle`, which read the name from the address; it is
 * deleted, and every screen that drew it draws `PageHeader` with the name READ from the registry — `routeLabel(path)` —
 * which is exactly what `'title'` mounts here, for the address under test.
 */
const mountHeader = (which: 'page' | 'title' = 'page') =>
  render(
    <ScreenGuideProvider>
      {which === 'page' ? <PageHeader title="الطلبات" description="كل الطلبات" /> : <PageHeader title={routeLabel(here.path)} />}
    </ScreenGuideProvider>
  );
const button = () => screen.queryByRole('button', { name: 'اشرح لي هذه الشاشة' });

describe('the ⓘ', () => {
  it('— is beside the title of a screen drawn with PageHeader', () => {
    mountHeader('page');
    const b = button()!;
    expect(b).toBeTruthy();
    expect(b.getAttribute('aria-expanded')).toBe('false');
    const title = screen.getByRole('heading', { level: 1 });
    // Beside it, not somewhere else on the page: they share a parent.
    expect(b.parentElement).toBe(title.parentElement);
  });

  // 18/11 (R3): was «a screen drawn with ScreenTitle» — that header is deleted; its screens draw PageHeader with the registry's name.
  it('and beside the title of a screen whose name is read from the registry', () => {
    here.path = '/ops/preparation';
    mountHeader('title');
    expect(button()).toBeTruthy();
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.textContent).toBe('التجهيز');
    expect(button()!.parentElement).toBe(title.parentElement);
  });

  it('and is not drawn where there is nothing behind it', () => {
    here.path = '/nowhere';
    mountHeader('page');
    expect(button(), 'زر بلا شرح خلفه').toBeNull();
  });

  it('and IS drawn on the two screens that were left without one: the dashboard, and «بكسل الإعلانات» (22/10)', () => {
    for (const path of ['/dashboard', '/settings/tracking']) {
      cleanup();
      here.path = path;
      mountHeader(path === '/dashboard' ? 'page' : 'title');
      expect(button(), `${path}: لا ⓘ`).toBeTruthy();
    }
  });

  it('and is not drawn on the storefront’s screens, even though they use the same header', () => {
    here.path = '/store';
    mountHeader('page');
    expect(button()).toBeNull();
    cleanup();
    here.path = '/store/landing-pages';
    mountHeader('page');
    expect(button()).toBeNull();
  });

  it('and is not drawn outside the shell — a header under test, or on a page with no provider', () => {
    render(<PageHeader title="الطلبات" />);
    expect(button()).toBeNull();
    cleanup();
    render(
      <>
        <GuideButton />
      </>
    );
    expect(button()).toBeNull();
  });
});

describe('the sheet', () => {
  const open = async () => {
    mountHeader('page');
    await act(async () => {
      fireEvent.click(button()!);
    });
    return screen.getByRole('dialog');
  };

  it('— opens as a dialog named for the screen, with the steps in order', async () => {
    const dialog = await open();
    expect(dialog.getAttribute('aria-label')).toBe('الطلبات');
    // The button says what it did: open, while the sheet is.
    expect(button()!.getAttribute('aria-expanded')).toBe('true');
    const first = GUIDE_TEXTS['/orders'].steps[0];
    expect(await within(dialog).findByText(first)).toBeTruthy();
    const items = within(dialog).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.replace(/^\d+\./, ''))).toEqual(GUIDE_TEXTS['/orders'].steps);
    // Numbered by the sheet, in order.
    expect(items[0].textContent).toMatch(/^1\./);
    expect(items[items.length - 1].textContent).toMatch(new RegExp(`^${items.length}\\.`));
  });

  it('and carries the screen’s warning, and who opens it', async () => {
    const dialog = await open();
    expect(await within(dialog).findByText(GUIDE_TEXTS['/orders'].watch!)).toBeTruthy();
    expect(within(dialog).getByText('انتبه:')).toBeTruthy();
    expect(dialog.textContent).toContain('تفتحها صلاحية: «عرض الطلبات».');
  });

  it('and joins several permissions with «أو» — any ONE of them opens the screen', async () => {
    here.path = '/customers';
    mountHeader('page');
    await act(async () => {
      fireEvent.click(button()!);
    });
    const names = whoOpens(ALL_ROUTES.find((r) => r.path === '/customers')!)!;
    expect(names.length, 'الاختبار يفترض أكثر من صلاحية').toBeGreaterThan(1);
    expect(screen.getByRole('dialog').textContent).toContain(`تفتحها صلاحية: ${names.map((n) => `«${n}»`).join(' أو ')}.`);
  });

  it('and closes on Escape', async () => {
    await open();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button()!.getAttribute('aria-expanded')).toBe('false');
  });

  it('and does not follow the person to the next screen', async () => {
    const { rerender } = render(
      <ScreenGuideProvider>
        <PageHeader title="الطلبات" />
      </ScreenGuideProvider>
    );
    await act(async () => {
      fireEvent.click(button()!);
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    here.path = '/customers';
    rerender(
      <ScreenGuideProvider>
        <PageHeader title="العملاء" />
      </ScreenGuideProvider>
    );
    expect(screen.queryByRole('dialog'), 'الشرح تبع الشاشة القديمة ظل مفتوح').toBeNull();
    expect(button(), 'الشاشة الجديدة إلها شرحها').toBeTruthy();
  });
});

describe('the stop after this one', () => {
  const openOn = async (path: string) => {
    here.path = path;
    mountHeader('title');
    await act(async () => {
      fireEvent.click(button()!);
    });
    return screen.getByRole('dialog');
  };

  it('— on a stop of a road, says which stop it is and offers the next, read from the menu', async () => {
    const dialog = await openOn('/ops/preparation');
    expect(dialog.textContent).toContain('الشحن · الخطوة 1 من 5');
    const next = within(dialog).getByRole('link', { name: /التالي: إنشاء شحنة/ });
    expect(next.getAttribute('href')).toBe('/ops/shipments/new');
  });

  it('and offers it only to somebody who may open it', async () => {
    may.yes = (p) => p !== '/ops/shipments/new';
    const dialog = await openOn('/ops/preparation');
    expect(dialog.textContent).toContain('الخطوة 1 من 5');
    expect(within(dialog).queryByRole('link'), 'رابط لشاشة ممنوعة').toBeNull();
  });

  it('and the last stop has none to offer', async () => {
    const dialog = await openOn('/ops/returns');
    expect(dialog.textContent).toContain('الخطوة 5 من 5');
    expect(within(dialog).queryByRole('link')).toBeNull();
  });

  it('and a screen that is not a stop may say where it leads — and only to those who may go there', async () => {
    const dialog = await openOn('/confirmation/queue');
    expect(within(dialog).getByRole('link', { name: /التالي: طلباتي/ }).getAttribute('href')).toBe('/confirmation/mine');
    cleanup();
    may.yes = (p) => p !== '/confirmation/mine';
    const again = await openOn('/confirmation/queue');
    expect(within(again).queryByRole('link')).toBeNull();
  });

  it('and following it closes the sheet', async () => {
    const dialog = await openOn('/ops/preparation');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('link', { name: /التالي/ }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// ───────────────────────── a new screen cannot skip it ─────────────────────────

describe('a screen cannot be added to the menu without explaining itself', () => {
  const storefront = NAV.find((g) => g.key === 'storefront')!.routes.map((r) => r.path);

  /**
   * NO SCREEN IS EXCUSED ANY MORE. Two were, on 21/10 — the dashboard («شغلك اليوم» was not there yet) and `/settings/tracking`
   * (it drew no title, so there was nowhere to hang the button) — and this list was where they waited. Both are written, so the only
   * exemption left is the storefront's, which is another agent's. A screen added to the menu without a guide fails here.
   */
  it('— every screen of the menu has a guide, except the storefront’s', () => {
    const want = ALL_ROUTES.map((r) => r.path).filter((p) => !storefront.includes(p)).sort();
    expect([...GUIDED_PATHS].sort(), 'شاشة بلا شرح — اكتبه').toEqual(want);
  });

  it('and every guided screen draws a title for the ⓘ to hang on — a guide on a screen with no title is a button nobody can reach', () => {
    expect(GUIDED_PATHS.length, 'ما في شاشات').toBeGreaterThan(40);
    for (const path of GUIDED_PATHS) {
      const page = pageFileFor(path);
      expect(page, `${path}: ما لقيت صفحة`).not.toBeNull();
      const source = closure(page!).join('\n');
      // 18/11 (R2c): `<PageShell` counts too — it draws the same `PageHeader` (its own test holds that) and the screens move onto it from R3.
      // 18/11 (R3): `<ScreenTitle` no longer counts — the component is deleted, so a screen still naming it would not even build.
      expect(/<PageHeader\b|<PageShell\b/.test(source), `${path}: بلا عنوان — لا مكان للزر`).toBe(true);
    }
  });
});

// ───────────────────────── how it is wired ─────────────────────────

describe('how it is wired', () => {
  const code = (file: string) => stripComments(repoFile(file));

  // 18/11 (R3): was «both kinds of header hold the button» (PageHeader and ScreenTitle). ScreenTitle is deleted; one header is left,
  // and it holds the button once — and the deleted file stays deleted.
  it('— the one header holds the button, once', () => {
    expect(code('src/components/ui/PageHeader.tsx').match(/<GuideButton\s*\/>/g)).toHaveLength(1);
    expect(existsSync(join(process.cwd(), 'src/components/shell/ScreenTitle.tsx')), 'رجع رأس صفحة ثاني').toBe(false);
  });

  it('and PageHeader does not ask the router where it is — thirty tests mock next/navigation without it', () => {
    expect(code('src/components/ui/PageHeader.tsx')).not.toContain('next/navigation');
  });

  it('and the shell draws the sheet, once, and nothing else does', () => {
    expect(code('src/components/shell/Shell.tsx').match(/<ScreenGuideProvider>/g)).toHaveLength(1);
    const src = join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e) && !/\.test\./.test(e) && !full.endsWith('ScreenGuide.tsx')) {
          if (/<ScreenGuideProvider/.test(stripComments(readFileSync(full, 'utf8'))) && !full.endsWith('Shell.tsx')) offenders.push(full);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });

  it('and the texts are fetched when the sheet opens — never imported statically', () => {
    expect(code('src/components/shell/ScreenGuide.tsx')).toMatch(/import\('@\/lib\/route-guide-texts'\)/);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e) && !/\.test\./.test(e)) {
          const text = stripComments(readFileSync(full, 'utf8'));
          if (/from\s+['"](@\/lib|\.)\/route-guide-texts['"]/.test(text)) offenders.push(full);
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders, 'استيراد ثابت للنصوص يحمّلها بكل صفحة').toEqual([]);
  });
});
