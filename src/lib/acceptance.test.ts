import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_ROUTES } from './route-registry';
import { BANDS } from './performance-score';

/**
 * THE ACCEPTANCE LIST, AS TESTS.
 *
 * The rebuild document ends with a list of sentences that must be true of
 * the finished system. A list like that, left as a list, is checked once by
 * whoever remembers it and then quietly stops being true — which is the
 * same fate as the columns that were added and never read, and the prompt
 * that was edited and never saved.
 *
 * So the ones that can be checked by a machine are checked by a machine,
 * every run. The ones that cannot — "a new employee understands the screen
 * from its title" — are not faked here; they are a human's judgement and
 * they belong in the sweep, not in a green tick.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

function walk(dir: string, ext = '.tsx'): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (p.endsWith(ext) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

describe('the numbers are computed where they can be trusted', () => {
  it('days in transit counts from SHIPPED, never from created', () => {
    // An order entered on Sunday and shipped on Thursday is not four days
    // late; it is a day old. Counting from creation makes every slow
    // confirmation look like a slow courier.
    const src = read('src/lib/transit.ts');
    expect(src).toContain('shippedAt');
    expect(src).not.toContain('createdAt');
  });

  it('no screen does money arithmetic — the API says what a thing costs', () => {
    const offenders: string[] = [];
    for (const file of walk(join(process.cwd(), 'src/components/screens'))) {
      const src = readFileSync(file, 'utf8');
      // A total assembled in the browser is a total that disagrees with the
      // invoice the moment a rule changes on the server.
      for (const m of src.matchAll(/\b(cod|total|profit|net|commission)\s*=\s*[^;\n]*[-+*]\s*[a-z]/gi)) {
        if (/price|discount|deliveryFee|shipping/i.test(m[0])) {
          offenders.push(`${file.split(/[\\/]/).pop()}: ${m[0].slice(0, 60)}`);
        }
      }
    }
    expect(offenders, `حساب مال في الواجهة:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('no assistant can act', () => {
  it('none of them touches the business', () => {
    // They propose. Every one of the acts a business is accountable for —
    // a state, a movement, a price, a settlement, a line in the audit —
    // stays with a person.
    //
    // Writing its OWN row is not that: the daily summary caches what it
    // produced so the same day is not paid for twice. The rule is about
    // whose records an assistant may change, not whether it may remember.
    const BUSINESS = [
      'order', 'orderItem', 'wallet', 'walletMovement', 'commissionEntry', 'commissionPayout',
      'penalty', 'payslip', 'inventoryMovement', 'product', 'settlement', 'auditLog', 'user',
    ];
    const offenders: string[] = [];
    for (const file of walk(join(process.cwd(), 'src/app/api/ai'), '.ts')) {
      const src = readFileSync(file, 'utf8');
      for (const table of BUSINESS) {
        const writes = new RegExp(
          `\\b(?:db|tx)\\.${table}\\.(?:create|update|updateMany|delete|deleteMany|upsert)\\s*\\(`
        );
        if (writes.test(src)) offenders.push(`${file.split(/[\\/]/).pop()} → ${table}`);
      }
    }
    expect(offenders, `مساعد يكتب في سجلّ العمل:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and the picking assistant is never handed a customer', () => {
    // The warehouse packs boxes. A name, a phone and an address in that
    // payload is customer data sitting where nobody needs it.
    const payload = read('src/lib/ai-scope.ts');
    expect(payload).not.toMatch(/\bphone\b/);
    expect(payload).not.toMatch(/\baddress\b/);
  });
});

describe('the score is a measurement, not a contract', () => {
  it('its weights appear on no screen as an editable field', () => {
    const offenders: string[] = [];
    for (const file of [...walk(join(process.cwd(), 'src/components/screens')), ...walk(join(process.cwd(), 'src/components/settings'))]) {
      const src = readFileSync(file, 'utf8');
      if (!/weight/i.test(src)) continue;
      // A weight next to an onChange is a weight somebody can move, and a
      // score whose weights move cannot be compared with last month's.
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (/weight/i.test(line) && /onChange|<input|<select/.test(line)) {
          offenders.push(`${file.split(/[\\/]/).pop()}:${i + 1}`);
        }
      });
    }
    expect(offenders, `وزن قابل للتحرير:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and the weights still add to a hundred', () => {
    expect(BANDS.reduce((s, b) => s + b.weight, 0)).toBe(100);
  });
});

describe('every screen in the menu is a screen', () => {
  it('there is no "under construction" placeholder left to render', () => {
    // There was one, and a `stage` number in the registry whose own
    // documentation promised it would be shown. Nothing read that number:
    // the guard ignored it, no page imported the placeholder, and the one
    // screen still carrying a stage — seven hundred working lines of
    // campaigns — wore a "under construction" badge in the sidebar.
    //
    // A registry read as a contract must not carry a clause nobody
    // enforces, so the clause and its placeholder are both gone.
    expect(existsSync(join(process.cwd(), 'src/components/shell/UnderConstruction.tsx'))).toBe(false);
    // The field, not the paragraph explaining why it is gone.
    const registry = readFileSync(join(process.cwd(), 'src/lib/route-registry.ts'), 'utf8');
    expect(registry).not.toMatch(/stage:\s*(?:number|null|\d)/);
  });

  it('and only a person’s own profile is open to everybody', () => {
    // Anything else with no key is a screen nobody decided on.
    const open = ALL_ROUTES.filter((r) => !r.permissions || r.permissions.length === 0);
    expect(open).toHaveLength(1);
    expect(open[0].label).toBe('الملف الشخصي');
  });
});

/**
 * EVERY SCREEN GUARDS ITSELF.
 *
 * The deductions screen shipped without `guardRoute`. The layout checks
 * that somebody is signed in and nothing more, so any ACTIVE employee who
 * typed the path saw their colleagues' names beside the amounts proposed
 * against them — and a button that applies them. The API still refused the
 * write, so no money moved; the leak was the list itself, which is a
 * payroll document.
 *
 * It was the only one, and it was mine. This makes it the last: a page that
 * forgets the guard now fails here instead of in front of somebody's staff.
 */
describe('no screen is reachable without its key', () => {
  it('every page under the shell calls guardRoute', () => {
    const root = join(process.cwd(), 'src/app/(system)/(shell)');
    const missing = walk(root)
      .filter((f) => f.endsWith('page.tsx'))
      .filter((f) => !readFileSync(f, 'utf8').includes('guardRoute'))
      .map((f) => f.slice(root.length).split(/[\\/]/).join('/'));

    expect(missing, `صفحة بلا حارس:\n${missing.join('\n')}`).toEqual([]);
  });
});

/**
 * A SCREEN SAYS ITS NAME, AND SAYS THE MENU'S NAME FOR IT.
 *
 * Seventeen screens rendered no heading at all — their only identity was a
 * word in the sidebar, which is fine for somebody who walked there and
 * useless for everybody else: a link from a notification, a bookmark, a
 * phone where the sidebar is a drawer nobody has opened. A new confirmation
 * agent lands on her own queue, because the system sends her straight
 * there, and had nothing on screen telling her where she was.
 *
 * And five rendered a heading that CONTRADICTED the menu: the menu said
 * «الأرباح» and the page said «المالية والأرباح الحقيقية». Two names for
 * one screen is two screens, to anybody asking a colleague for help.
 *
 * The cure is that no screen writes its own title: it reads the one the
 * sidebar draws from, so the two cannot disagree.
 */
describe('a page title', () => {
  /**
   * IT IS A NAME, NOT MARKUP.
   *
   * `title` is a string prop. A sweep that lifted a heading's whole
   * contents into it put an icon element there too — and the users screen
   * printed «RiGroupLine className="w-6 h-6 …" /><span>{findRoute(…)}»
   * across the top of the page, at heading size, to whoever opened it.
   *
   * The guard that was supposed to catch that only looked at titles
   * containing ARABIC, and this one contained none. So it looks at all of
   * them now, and asks one thing: a name has no angle brackets in it.
   */
  it('never contains markup', () => {
    const offenders: string[] = [];
    const walkAll = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkAll(p);
        else if (p.endsWith('.tsx') && !p.includes('.test.')) {
          const src = readFileSync(p, 'utf8');
          for (const m of src.matchAll(/<PageHeader[\s\S]{0,200}?title=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
            const text = m[1] ?? m[2] ?? '';
            if (/[<>]/.test(text)) offenders.push(`${p.split(/[\/]/).pop()}: ${text.slice(0, 50)}`);
          }
        }
      }
    };
    walkAll(join(process.cwd(), 'src', 'components'));
    walkAll(join(process.cwd(), 'src', 'app'));
    expect(offenders, `عنوانٌ يحمل ترميزاً: ${offenders.join(' | ')}`).toEqual([]);
  });
});

describe('every screen names itself', () => {
  const ROOT = join(process.cwd(), 'src/components/screens');

  it('every screen renders a heading of some kind', () => {
    const silent = walk(ROOT)
      .filter((f) => f.endsWith('Screen.tsx'))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        // `<PageHeader>` renders the h1 now. The invariant is unchanged —
        // a screen must name itself — but it no longer writes the tag.
        //
        // `<PanelHeader>` is the storefront panels' own header
        // (src/components/store-admin/PanelHeader.tsx) and renders the
        // same h1, plus the one line and the ONE primary action those
        // screens are now held to. Nine screens read it.
        //
        // `<PageShell>` (18/11, C1 — the first screen on it is «قواعد مركز
        // التأكيد»): the kit's screen frame. Its `title` is required and it
        // always renders `PageHeader` (its own test, #321) — the same
        // acceptance the-screen-explains-itself.test.tsx gave it in #321.
        //
        // 18/11 (R3): `<ScreenTitle` no longer counts — the component is deleted and its 26 screens draw `<PageHeader`.
        return (
          !src.includes('<h1') &&
          !src.includes('<PageHeader') &&
          !src.includes('<PanelHeader') &&
          !src.includes('<PageShell')
        );
      })
      .map((f) => f.split(/[\/]/).pop());

    expect(silent, `شاشة بلا عنوان:\n${silent.join('\n')}`).toEqual([]);
  });

  it('and no heading contradicts the menu entry that opened it', () => {
    // The real question — not "is the title read from the registry" but
    // "does the screen call itself something the menu does not". Five did:
    // the menu said «الأرباح» and the page said «المالية والأرباح
    // الحقيقية». Two names for one screen is two screens, to anybody asking
    // a colleague for help.
    //
    // The page files give the mapping: each calls guardRoute('/path') and
    // imports exactly one screen, so the label the menu uses and the words
    // the screen prints can be compared directly.
    const shell = join(process.cwd(), 'src/app/(system)/(shell)');
    const registry = readFileSync(join(process.cwd(), 'src/lib/route-registry.ts'), 'utf8');
    const labels = new Map<string, string>();
    for (const m of registry.matchAll(/r\('([^']+)', '([^']+)'/g)) labels.set(m[1], m[2]);

    const screens = walk(join(process.cwd(), 'src/components/screens'));
    const offenders: string[] = [];

    for (const page of walk(shell).filter((f) => f.endsWith('page.tsx'))) {
      // A DETAIL page guards the list's route but is not the list: the
      // landing-page editor lives under `[id]` and guards
      // `/store/landing-pages`, and calling itself «صفحات الهبوط» would be
      // the opposite of helpful. Only a route's own page is compared.
      if (/[\\/]\[[^\\/]+\][\\/]/.test(page)) continue;

      const src = readFileSync(page, 'utf8');
      const path = src.match(/guardRoute\('([^']+)'\)/)?.[1];
      const comp = src.match(/import \{ (\w+Screen) \}/)?.[1];
      const label = path ? labels.get(path) : undefined;
      if (!path || !comp || !label) continue;

      const file = screens.find((f) => f.endsWith(`${comp}.tsx`));
      if (!file) continue;
      const body = readFileSync(file, 'utf8');
      const printed: string[] = [];

      // The tag, for the screens that still write one.
      const open = body.indexOf('<h1');
      if (open !== -1) {
        const head = body.slice(open, body.indexOf('</h1>', open)) + '<';
        printed.push(
          ...[...head.matchAll(new RegExp('>([^<>{}\n]*[\u0600-\u06FF][^<>{}\n]*)<', 'g'))]
            .map((m) => m[1].trim())
            .filter(Boolean)
        );
      }

      // And the component, for the screens that use it. The title is a
      // PROP now, so the words sit in an attribute rather than between two
      // tags \u2014 and a guard that only read tags would pass every converted
      // screen without looking at anything.
      const ph = body.match(/<PageHeader[\s\S]{0,140}?title="([^"]+)"/);
      if (ph && /[\u0600-\u06FF]/.test(ph[1])) printed.push(ph[1].trim());

      if (printed.length > 0 && !printed.includes(label)) {
        offenders.push(`${comp}: القائمة «${label}» والشاشة «${printed[0]}»`);
      }
    }

    expect(offenders, ['عنوان يخالف القائمة:', ...offenders].join(' | ')).toEqual([]);
  });
});

/**
 * THE LIST OF SCREENS IS READABLE FROM BOTH SIDES.
 *
 * `route-registry.ts` is the one list, and both sides read it: the sidebar
 * and the page titles in the browser, the guard and the notifications on
 * the server. It imported `can` from authorization.ts, which imports
 * auth.ts, which imports `next/headers` — so the moment a client component
 * read a route's LABEL it dragged the session machinery into the bundle and
 * the production build refused.
 *
 * The tests did not catch it; the build did, after the code was written.
 * This is the test that would have.
 */
describe('the route registry stays free of server-only code', () => {
  it('imports nothing that reaches next/headers', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/route-registry.ts'), 'utf8');
    const imports = [...src.matchAll(/^import\s+(?:type\s+)?.*?from\s+'([^']+)'/gm)]
      .filter((m) => !m[0].startsWith('import type'))
      .map((m) => m[1]);

    // The chain that broke the build. `import type` is erased and harmless.
    for (const forbidden of ['./authorization', './auth', './db', 'next/headers']) {
      expect(imports, `route-registry imports ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('and the permission check arrives as an argument instead', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/route-registry.ts'), 'utf8');
    expect(src).toContain('PermissionCheck');
    expect(src).toContain('can: PermissionCheck');
  });
});

/**
 * NO SCREEN INVENTS A BUSINESS FACT.
 *
 * Two were written into the browser and both were wrong for most of the
 * company: a default governorate of «دمشق», in a system running Syrian,
 * Jordanian and Egyptian stores — so a customer added in Amman was born in
 * Damascus unless somebody noticed, and nobody notices a field that is
 * already filled in. And a "$" beside every production cost, so a batch
 * costing twelve thousand Syrian pounds read as twelve thousand dollars.
 */
describe('a screen does not invent a country', () => {
  it('no hardcoded governorate as a default', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/CustomersScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/useState\('دمشق'\)/);
  });

  it('and no hardcoded currency symbol where money is shown', () => {
    const MONEY_SCREENS = ['ManufacturingScreen.tsx', 'FinanceProfitScreen.tsx'];
    for (const name of MONEY_SCREENS) {
      const src = readFileSync(join(process.cwd(), 'src/components/screens', name), 'utf8');
      // A literal dollar printed into JSX, not a template expression.
      expect(src.includes('>$') || src.includes('($)'), `${name} prints a hardcoded $`).toBe(false);
    }
  });
});
