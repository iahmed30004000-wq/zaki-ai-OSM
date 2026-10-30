import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A LINK THAT CARRIES A FILTER TO A SCREEN THAT CANNOT READ IT.
 *
 * «DEAD means: the control exists and does nothing, or navigates
 * nowhere…» — and this is the version nobody reports, because it DOES
 * navigate. The address bar even shows the filter. Only the screen is
 * wrong, and the person has no way to know something was dropped on the
 * way.
 *
 * Found on the first run, six of them:
 *   · the dashboard's «الإيراد المسلَّم» card, whose own subtitle counts
 *     «N طلب موصّل», went to `/orders?state=DELIVERED` and showed all of
 *     them;
 *   · every order number on تنبيهات الخصم went to
 *     `/orders?highlight=<id>` and showed the unfiltered list;
 *   · «شحنة مفقودة عند شركة الشحن» named one parcel and went to
 *     `/ops/tracking?order=<id>` — an ID, which that screen's search does
 *     not match at all.
 */

const root = process.cwd();

/**
 * KNOWN, AND WAITING ON A DECISION.
 *
 * `/finance/closing?wallet=<id>` — the closing screen lists wallets and
 * has nowhere to put a «this one». The id in the link is also the job's
 * dedupe key («once per WALLET per day, keyed on the wallet's id carried
 * in the link»), so it cannot simply be swapped for a name the screen can
 * search. Either the screen learns to scroll to a wallet, or the
 * notification stops promising one.
 */
const AWAITING_DECISION = ['/finance/closing'];

/**
 * A LINK TO A SCREEN WITH A QUERY, in a string or in a template.
 *
 * The value may be `${...}` and what is inside may be a CALL — `encodeURIComponent(phone)`. The first version of this pattern took
 * `{` and `}` but not `(` and `)`, so every link whose value is built by a function was SKIPPED: the WhatsApp inbox's link to a
 * customer, which the customers screen did not read, stayed dead with this guard green (RV72). A `${...}` is now one opaque token,
 * whatever is inside it.
 */
const LINK = /["'`](\/[a-z][\w/-]*)\?([a-zA-Z](?:[\w=&.-]|\$\{[^}]*\})*)["'`]/g;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(join(root, 'src'));
  return out;
}

const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('a link that carries a filter reaches a screen that reads one', () => {
  const files = sourceFiles();

  /** Every route that has a page, and the files that page pulls in. */
  const pages = new Map<string, string>();
  for (const f of files) {
    const m = f.match(/^src\/app\/\(system\)\/(?:\(shell\)\/)?(.+)\/page\.tsx$/);
    if (m) pages.set('/' + m[1], f);
  }

  function readsAQuery(pageFile: string): boolean {
    const seen = [pageFile];
    const src = readFileSync(join(root, pageFile), 'utf8');
    for (const m of src.matchAll(/from '@\/(.*?)'/g)) {
      for (const ext of ['.tsx', '.ts']) {
        const candidate = 'src/' + m[1] + ext;
        if (files.includes(candidate)) seen.push(candidate);
      }
    }
    return seen.some((f) =>
      /useSearchParams|searchParams|window\.location\.search/.test(readFileSync(join(root, f), 'utf8'))
    );
  }

  const found: string[] = [];
  const dead: string[] = [];
  for (const file of files) {
    if (file.includes('/api/')) continue;
    const lines = code(readFileSync(join(root, file), 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(LINK)) {
        const [, path, query] = m;
        if (path.startsWith('/api/')) continue;
        const page = pages.get(path);
        if (!page) continue;
        found.push(path);
        if (AWAITING_DECISION.includes(path)) continue;
        if (!readsAQuery(page)) dead.push(`${path}?${query}  ←  ${file}:${i + 1}`);
      }
    }
  }

  it('found links to check — a sweep over nothing proves nothing', () => {
    expect(found.length).toBeGreaterThan(8);
  });

  /**
   * THE FIVE THE OLD PATTERN COULD NOT SEE. Twenty-one links were found before the pattern learned to read a call inside `${…}`, and
   * twenty-six after; a floor of twenty-four fails the day somebody narrows it again.
   */
  it('and finds the ones whose value is built by a call, not only those with a plain name', () => {
    expect(found.length).toBeGreaterThanOrEqual(24);
  });

  it('and none of them is dropped on arrival', () => {
    expect(dead, `روابطُ تحمل فلتراً لا تقرؤه الشاشة:\n${dead.join('\n')}`).toEqual([]);
  });

  /** The one on hold is still on hold, and still real. */
  it('and the one awaiting a decision has not quietly been fixed', () => {
    for (const path of AWAITING_DECISION) {
      const page = pages.get(path);
      expect(page, `${path}: لا صفحةَ له`).toBeTruthy();
      expect(readsAQuery(page!), `${path}: صار يقرأ الرابط — احذفه من قائمة الانتظار`).toBe(false);
    }
  });
});

describe('the pattern that finds the links', () => {
  const read = (text: string) => [...text.matchAll(LINK)].map((m) => `${m[1]}?${m[2]}`);

  it('reads a link in a plain string', () => {
    expect(read(`href="/orders?state=DELIVERED"`)).toEqual(['/orders?state=DELIVERED']);
  });

  it('and one whose value is a plain name in a template', () => {
    expect(read('`/orders?state=${state}`')).toEqual(['/orders?state=${state}']);
  });

  it('and one whose value is built by a CALL — the case RV72 skipped', () => {
    expect(read('`/customers?search=${encodeURIComponent(selected.customerPhone)}`')).toEqual([
      '/customers?search=${encodeURIComponent(selected.customerPhone)}',
    ]);
  });

  it('and several `${…}` in one query, with a call in each', () => {
    expect(read('`/orders?a=${f(x)}&b=${g(y, z)}`')).toEqual(['/orders?a=${f(x)}&b=${g(y, z)}']);
  });

  it('but not a path with no query, and not a query that does not start with a name', () => {
    expect(read('`/orders`')).toEqual([]);
    expect(read('`/orders?${params}`')).toEqual([]);
  });

  it('and a link is cut at its closing quote — the text after it is not part of the query', () => {
    expect(read('`/orders?x=1` + "/customers?y=2"')).toEqual(['/orders?x=1', '/customers?y=2']);
  });
});

/**
 * AND THE TWO THE ORDERS LIST NOW HONOURS, NAMED.
 *
 * A screen that merely imports `useSearchParams` satisfies the sweep
 * above. These say which keys, because the link on the other side says
 * them too.
 */
describe('the orders list honours what points at it', () => {
  const src = readFileSync(join(root, 'src/components/screens/OrdersScreen.tsx'), 'utf8');

  it('reads the state the dashboard sends', () => {
    expect(src).toMatch(/asked\.get\('state'\)/);
    // And refuses one that is not ours: a URL is typed by anyone, and an
    // unknown state comes back from the API as 400 «حالة غير معروفة».
    // The allow-list is STATUS_FILTER_OPTIONS — FILTERABLE_STATES plus the
    // derived «مغلق» zone filter, which the API's ordersWhere accepts.
    expect(src).toMatch(/STATUS_FILTER_OPTIONS\.includes\(askedState\)/);
  });

  it('opens the order the discount alert names', () => {
    expect(src).toMatch(/useState<string \| null>\(asked\.get\('highlight'\)\)/);
  });
});

/**
 * AND THE LOST-PARCEL ALERT, BOTH ENDS OF IT.
 *
 * The sweep above only asks whether a screen reads SOME query — an import
 * left behind satisfies it, which a mutation proved. These two say which
 * key, on both sides, so the link and the screen cannot drift apart.
 */
describe('the lost-parcel alert lands on the parcel', () => {
  it('sends the order number, which that search can match', () => {
    const job = readFileSync(join(root, 'src/lib/jobs/definitions/sync-courier-status.ts'), 'utf8');
    expect(job).toMatch(/\/ops\/tracking\?order=\$\{order\.orderNumber\}/);
    // An id matches nothing in that screen's search — it landed on every
    // parcel in the store instead of the one the alert named.
    expect(job, 'عاد الرابطُ يحمل مُعرِّفاً لا يبحث به أحد').not.toMatch(
      /\/ops\/tracking\?order=\$\{order\.id\}/
    );
  });

  it('and the screen opens on it', () => {
    const screen = readFileSync(join(root, 'src/components/screens/TrackingScreen.tsx'), 'utf8');
    expect(screen).toMatch(/useSearchParams\(\)\.get\('order'\)/);
  });
});

/**
 * AND A NOTIFICATION ABOUT ONE ORDER OPENS THAT ORDER.
 *
 * Five notifications named an order in their own message — «الطلب #1234
 * أصبح بالحالة …», «طُبِّق تعديلك على 1234» — and linked to `/orders`,
 * the list of everything, leaving the reader to find it by hand. The list
 * has read `?highlight=<id>` since the dashboard's own dead filters were
 * fixed, and `DiscountAlertsScreen` already links that way.
 */
describe('a notification about an order carries the order', () => {
  const routeFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('route.ts')) out.push(p);
      }
    };
    walk(join(process.cwd(), 'src', 'app', 'api'));
    return out;
  };

  it('never sends the reader to the whole list instead', () => {
    const bare: string[] = [];
    for (const file of routeFiles()) {
      const src = readFileSync(file, 'utf8');
      if (src.includes("link: '/orders',")) bare.push(file.split('src')[1]);
    }
    expect(
      bare,
      `إشعاراتٌ تُسمّي طلباً وتُرسل إلى القائمة كاملة:\n${bare.join('\n')}`
    ).toEqual([]);
  });

  it('and the list still reads the parameter they send', () => {
    const screen = readFileSync(join(process.cwd(), 'src/components/screens/OrdersScreen.tsx'), 'utf8');
    expect(screen).toContain("asked.get('highlight')");
    // …into the dialog, not into a variable nothing renders.
    expect(screen).toMatch(/orderId=\{selectedOrderId\}/);
  });
});
