import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT AN AGENT'S «طلباتي» COSTS BEFORE SHE CAN WORK — the owner's ruling
 * 4/11 («طلباتي أخف»).
 *
 * The confirmation agents' screens hung. Part of it was the server (the risk
 * lookups, the polls that wrote); part was the screen itself: «طلباتي»
 * imported the order modal, the create-order modal, the assistant and the
 * whole «مؤجّلة» tab statically, so every agent downloaded all of them
 * before the first card was drawn — on a phone, on the line with a
 * customer. They load with `next/dynamic` now, the moment one is opened.
 * (The call-outcome sheet stays static on purpose: it must be there ON the
 * press of «اتصل».)
 *
 * This holds that, the way `public-first-load.test.ts` holds the shop: the
 * route's JavaScript as the browser gets it (the framework floor in
 * `rootMainFiles` + the chunks the route's own client-reference manifest
 * names), gzipped, against a ceiling taken from a measurement.
 *
 * ── AND IT IS LOUD WHEN IT CANNOT MEASURE ──
 *
 * Exactly as there: `REQUIRE_BUILD=1` (the CI «Payload budget» step, after
 * «Build») turns «no build» into a failure; locally, with no flag, it skips
 * and says so, so nobody is made to build before running the suite.
 * ═══════════════════════════════════════════════════════════════════════
 */

const dist = () => join(process.cwd(), process.env.NEXT_DIST_DIR || '.next');
const kb = (b: Buffer) => gzipSync(b, { level: 9 }).length / 1024;

/** The agent's desk, by its directory under `server/app`. */
const MINE = '(system)/(shell)/confirmation/mine';

/**
 * EVERY SCRIPT THE BROWSER FETCHES FOR ONE ROUTE, GZIPPED — the same reading
 * as `public-first-load.test.ts`'s `routeJs`, and the same refusals: a
 * missing or empty manifest THROWS, because «the build changed shape» must
 * never read as «the page got lighter».
 */
function routeJs(route: string): { count: number; total: number } {
  const dir = dist();
  const root = JSON.parse(readFileSync(join(dir, 'build-manifest.json'), 'utf8')) as { rootMainFiles?: string[] };
  const names = new Set<string>(root.rootMainFiles ?? []);
  if (names.size === 0) throw new Error('البيانُ بلا rootMainFiles — تغيّرَ شكلُ البناء، والقياسُ لم يحدث.');

  const manifest = join(dir, 'server', 'app', route, 'page_client-reference-manifest.js');
  if (!existsSync(manifest)) throw new Error(`لا بيانَ عميلٍ للمسار «${route}» — تغيّرَ شكلُ البناء.`);
  const own = [...readFileSync(manifest, 'utf8').matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]);
  if (own.length === 0) throw new Error(`بيانُ «${route}» لا يُسمّي أيَّ قطعة — تغيّرَ شكلُ البناء.`);
  for (const n of own) names.add(n);

  let total = 0;
  let count = 0;
  for (const n of names) {
    const p = join(dir, n);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    total += kb(readFileSync(p));
    count++;
  }
  return { count, total };
}

const measurable = () => existsSync(join(dist(), 'build-manifest.json'));

function noBuild(): true {
  if (process.env.REQUIRE_BUILD === '1') {
    throw new Error(
      'لا يوجد بناءٌ لقياسِه و`REQUIRE_BUILD=1` مطلوبٌ هنا — هذه الخطوة تَجري بعدَ «Build» في ci.yml عن قصد. ' +
        'حارسٌ صامتٌ لأنّه لم يَقِس لا يُفرَّقُ عن حارسٍ نجح.'
    );
  }
  console.log('[طلباتي] لا بناءَ لقياسِه هنا — تخطٍّ محلّيّ. في CI يَجري بعدَ «Build» مع REQUIRE_BUILD=1.');
  return true;
}

describe('what an agent downloads before «طلباتي» draws', () => {
  /**
   * ── THE CEILING, AND THE MEASUREMENTS BEHIND IT ──
   *
   * MEASURED 2026-11-04 on this branch, gzipped, under Turbopack (what CI
   * and the production image build with), from a worktree with
   * `NEXT_TURBOPACK_ROOT=<the main checkout> NEXT_DIST_DIR=.next-verify
   * npx next build`:
   *
   *     before (static imports)   440.1 KB of JavaScript (28 files, floor and shell included)
   *     after  (next/dynamic)     405.5 KB (27 files)            −34.6 KB
   *
   * The order window, the create window, the assistant and the «مؤجّلة»
   * tab were checked absent from the after chunks by strings only they
   * carry (`/timeline`, `/lock`, `/api/orders/form-options`,
   * `/api/ai/confirmation`, `/api/confirmation/postponed`). Most of what is
   * left is the shell every staff screen pays and the desk itself.
   *
   * The ceiling sits a little over the measured «after», so the modals
   * creeping back into the first load trips it, and an ordinary change to
   * the screen does not.
   */
  const CEILING_KB = 410;

  it(`keeps /confirmation/mine at or under ${CEILING_KB} KB of JS, gzipped`, () => {
    if (!measurable()) return noBuild();
    const js = routeJs(MINE);
    console.log(
      `[طلباتي] JS ${js.total.toFixed(1)} (${js.count} ملف) ك.ب مضغوطة — السقف ${CEILING_KB}، ` +
        `المتبقّي ${(CEILING_KB - js.total).toFixed(1)}`
    );
    expect(
      js.total,
      `«طلباتي» صارت ${js.total.toFixed(1)} ك.ب — السقف ${CEILING_KB} مقياسٌ لا رقمٌ مستدير. ` +
        'هل رجعت نافذةٌ كبيرة استيراداً ثابتاً؟'
    ).toBeLessThanOrEqual(CEILING_KB);
  });

  it('and the measurement is of something — the floor alone is not a page', () => {
    if (!measurable()) return noBuild();
    const js = routeJs(MINE);
    expect(js.count, 'القياسُ ما لقِيَ غيرَ الأرضيّة').toBeGreaterThan(5);
    expect(js.total, 'القياسُ بلا بايتات').toBeGreaterThan(60);
  });
});

/**
 * AND THE CAUSE, HELD WITHOUT A BUILD — so a plain `npm test` catches a big
 * window coming back as a static import, before the budget step measures
 * what it costs.
 */
describe('«طلباتي» opens its big windows on demand', () => {
  const LAZY: Record<string, string> = {
    OrderDetailModal: '@/components/orders/OrderDetailModal',
    CreateOrderModal: '@/components/orders/CreateOrderModal',
    AssistantDialog: './confirmation/AssistantDialog',
    ConfirmationPostponedScreen: '@/components/screens/ConfirmationPostponedScreen',
  };
  const src = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));

  it.each(Object.entries(LAZY))('%s is a next/dynamic import, never a static one', (name, from) => {
    const esc = from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    expect(src, `${name} رجع استيراداً ثابتاً`).not.toMatch(new RegExp(`^import \\{[^}]*\\b${name}\\b[^}]*\\} from '${esc}';`, 'm'));
    expect(src, `${name} ليس dynamic`).toMatch(new RegExp(`const ${name} = dynamic\\(`));
    expect(src).toMatch(new RegExp(`import\\('${esc}'\\)`));
  });

  it('and the screen imports next/dynamic itself', () => {
    expect(src).toMatch(/^import dynamic from 'next\/dynamic';$/m);
  });

  it('but the call sheet stays static — «شو صار؟» is there ON the press, not a chunk later', () => {
    expect(src).toMatch(/^import \{ CallOutcomeSheet, type LoggedOutcome \} from '@\/components\/confirmation\/CallOutcomeSheet';$/m);
    expect(src).not.toMatch(/const CallOutcomeSheet = dynamic\(/);
  });
});
