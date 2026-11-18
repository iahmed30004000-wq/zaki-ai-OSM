import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_ROUTES, NAV } from './route-registry';
import { repoFile } from './guard-source';

/**
 * THE GUARD'S CONTRACT MUST NAME ONLY WHAT EXISTS (18/11, R0 of the restructure).
 *
 * `.claude/skills/crm-oms-guard/references/architecture.md` is what a builder reads BEFORE touching a screen. For two months it
 * named `/confirmation/postponed` and `/inventory/receiving` — both are redirects now, neither is a page — and a hand limit of 40
 * and 120 where the code says 40 and 500. A builder who followed it would have put back what the owner took out. A contract
 * nobody checks against the code is a contract that rots at the pace the code changes.
 *
 * So it is checked: every path the file mentions must be a page (a registry entry, or a `page.tsx` under `src/app`); every page
 * of the registry must be mentioned (a screen not listed does not exist); the three numbers of the menu and the queue's limits
 * must be the code's. When this fails, FIX THE FILE, in the same pull request as the change that broke it.
 */

const GUIDE = '.claude/skills/crm-oms-guard/references/architecture.md';

/** A path as the document writes it: `/a/b/c`, with `[id]` for a dynamic segment. A slash after a word character is a fraction or «and/or», not a path. */
const PATH = /(?<![\w.\/:<>-])\/[a-z][a-z0-9-]*(?:\/(?:\[[a-z]+\]|[a-z0-9-]+))*/g;

export const pathsNamedBy = (text: string): string[] => [...new Set(text.match(PATH) ?? [])];

/** Every page under `src/app`, as a URL: route groups `(…)` are not part of it. */
function pagesOfTheApp(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string, segs: string[]) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, /^\(.*\)$/.test(name) ? segs : [...segs, name]);
      else if (name === 'page.tsx') out.add(`/${segs.join('/')}`.replace(/\/$/, '') || '/');
    }
  };
  walk(join(process.cwd(), 'src', 'app'), []);
  return out;
}

const pages = pagesOfTheApp();
const doc = repoFile(GUIDE);

/** The menu's line count, as `the-menu-is-one-line-a-group.test.tsx` counts it: a hub is one line, a loose group is one per screen. */
const lines = NAV.reduce((n, g) => n + (g.hub === 'loose' ? g.routes.length : 1), 0);

describe('the guard contract names only routes that are pages', () => {
  it('every path architecture.md mentions is a page — no redirect, no 404', () => {
    const gone = pathsNamedBy(doc).filter((p) => !pages.has(p));
    expect(gone, `${GUIDE} يسمّي مسارات ليست صفحات (تحويل أو 404):\n${gone.join('\n')}`).toEqual([]);
  });

  it('every page of the registry is mentioned — a screen not listed does not exist', () => {
    const named = new Set(pathsNamedBy(doc));
    const unlisted = ALL_ROUTES.map((r) => r.path).filter((p) => !named.has(p));
    expect(unlisted, `صفحات في السجل لا يذكرها ${GUIDE}:\n${unlisted.join('\n')}`).toEqual([]);
  });

  it('says the registry’s own numbers: pages, groups and menu lines', () => {
    const m = doc.match(/\*\*(\d+) pages in (\d+) groups\*\*; the menu draws them as \*\*(\d+) lines\*\*/);
    expect(m, 'الجملة «N pages in N groups … N lines» غير موجودة').not.toBeNull();
    expect([Number(m![1]), Number(m![2]), Number(m![3])]).toEqual([ALL_ROUTES.length, NAV.length, lines]);
  });

  it('says the confirmation queue’s limits as the code has them', () => {
    const src = repoFile('src/lib/confirmation-queue.ts');
    const caps = src.match(/CLAIM_CAPS = \{ withoutAttempt: (\d+), total: (\d+) \}/)!;
    const pace = src.match(/PULL_PACE = \{ perHour: (\d+)/)!;
    const hand = src.match(/RETURNS_MODE = \{ handLimit: (\d+)/)!;
    const release = src.match(/AUTO_RELEASE_BUSINESS_MINUTES = (\d+)/)!;
    expect(doc).toContain(`${caps[1]} owned with no attempt, ${caps[2]} owned in`);
    expect(doc).toContain(`at most ${pace[1]} pulls in any rolling hour`);
    expect(doc).toContain(`— ${hand[1]}, where the`);
    expect(doc).toContain(`(${release[1]} business minutes`);
  });
});

describe('the checker itself catches what it is for', () => {
  it('finds a path in a sentence, in a code fence and in a table, and nothing in a fraction or a file path', () => {
    const text = 'the `/orders` page\n```\nطلباتي   /confirmation/mine\n```\n| `/finance/profit` |\nand/or 1/2 and src/lib/route-registry.ts and a/b';
    expect(pathsNamedBy(text).sort()).toEqual(['/confirmation/mine', '/finance/profit', '/orders']);
  });

  it('flags the two routes the old contract named, which are redirects and have no page', () => {
    const old = 'الطلبات المؤجلة    /confirmation/postponed\nاستلام بضاعة جاهزة   /inventory/receiving';
    expect(pathsNamedBy(old).filter((p) => !pages.has(p))).toEqual(['/confirmation/postponed', '/inventory/receiving']);
  });

  it('knows a dynamic page when the document writes it with its bracket', () => {
    expect(pages.has('/products/[id]')).toBe(true);
    expect(pathsNamedBy('`/products/[id]`')).toEqual(['/products/[id]']);
  });
});
