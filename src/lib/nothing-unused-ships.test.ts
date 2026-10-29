import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, sep } from 'node:path';

/**
 * المرحلة ٥ — «التبعيات والمكوّنات والمسارات غير المستخدمة، مع إثباتٍ أنها
 * غير مستخدمة».
 *
 * THE EMPHASIS IS THE WHOLE THING: «with proof they are unused».
 *
 * A list of guesses about dead code is worse than no list, because the next
 * person deletes from it. So this file does not hold a verdict — it holds a
 * METHOD, and the same closed partition `every-money-writer-is-known` uses:
 * sweep broadly, force every item onto one of two sides, machine-check the
 * side that can be checked, and make a PERSON write the reason on the side
 * that cannot. A name that falls off both sides fails the suite.
 *
 * WHY THE HUMAN SIDE EXISTS AT ALL, SAID PLAINLY.
 *
 * Three kinds of use cannot be seen by reading import statements, and each
 * one has burned a sweep like this before:
 *
 *   1. A package nothing imports and everything needs — a peer dependency
 *      (`vite` under vitest, `@testing-library/dom` under its react
 *      binding), a CLI invoked by a line in `package.json` or by
 *      `docker-entrypoint.sh`, a name resolved from a STRING
 *      (`@tailwindcss/postcss` in postcss.config.mjs, `@import
 *      "tailwindcss"` in globals.css), or a `@types/*` whose consumer
 *      imports no symbol from it.
 *
 *   2. A URL assembled rather than written. `/api/geo/stores/${id}/${kind}`
 *      reaches `.../logo` and `.../favicon`; `${orderEndpoint}/${n}/add-product`
 *      reaches a public landing route; `'/api/public/store-logo/'` is a
 *      constant with the rest concatenated on. No regular expression over
 *      the source sees the path these produce, so the route LOOKS dead and
 *      is live.
 *
 *   3. A caller that is not in this repository at all — the uptime monitor
 *      on `/api/health`, a `<script src>` inside HTML a seller uploaded.
 *
 * And the mirror of the same partition catches the opposite, rarer defect:
 * a package the tree IMPORTS and `package.json` never declares. `dotenv`
 * was exactly that — `scripts/worker.ts` imports it, the production
 * entrypoint runs that worker with `tsx`, and the only thing putting it in
 * `node_modules` was `@prisma/config → c12`. It worked until a dedupe.
 *
 * WHAT THIS FILE DOES NOT DO: it deletes nothing and it is not allowed to.
 * Routes and components on the «no caller found» side are REPORTED, with
 * the reason a person gave for leaving them, because «nothing calls it» and
 * «it should not exist» are different sentences and only the owner of the
 * product may say the second one.
 */

const ROOT = process.cwd();
const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

/* ──────────────────────────── the sweep ──────────────────────────── */

const SWEPT_DIRS = ['src', 'scripts', 'prisma', 'packages/zaki-ui/scripts'];
const SWEPT_FILES = ['next.config.ts', 'eslint.config.mjs', 'postcss.config.mjs', 'vitest.config.ts'];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p)) out.push(p);
  }
  return out;
}

const SWEPT = [
  ...SWEPT_DIRS.flatMap((d) => filesUnder(join(ROOT, ...d.split('/')))),
  ...SWEPT_FILES.map((f) => join(ROOT, f)).filter((f) => { try { return statSync(f).isFile(); } catch { return false; } }),
];

const isTest = (p: string) => /\.test\.(ts|tsx)$/.test(p);

/**
 * COMMENTS ARE NOT CALLS, AND THIS COST A FALSE NEGATIVE ALREADY.
 *
 * `OrderDetailModal.tsx` carries the sentence «`/api/orders/[id]/call-logs`
 * lived here and NOTHING RENDERED ANY OF IT». An earlier version of this
 * sweep read that comment as a caller and declared the route reached — the
 * one route whose own epitaph was written in the file that stopped calling
 * it. Comments are stripped before anything is matched.
 */
const LINE_COMMENT = new RegExp('(^|[^:"\'`\\\\])//[^\\n]*', 'g');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(LINE_COMMENT, '$1');

const TEXT = new Map<string, string>(SWEPT.map((p) => [rel(p), stripComments(readFileSync(p, 'utf8'))]));
const PROD_TEXT = [...TEXT].filter(([n]) => !isTest(n));

/* ═══════════════════ 1 · DEPENDENCIES ═══════════════════ */

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const DECLARED = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];

const BARE_SPEC = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
/** `@scope/name` or `name` — never a relative path, an alias or a sentence. */
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w./-]*)?$/i;

/** package name -> the swept files that import it. */
const IMPORTED_BY = new Map<string, string[]>();
for (const [name, src] of TEXT) {
  for (const re of BARE_SPEC) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (/^[.@/]/.test(spec) && !spec.startsWith('@') ) continue;   // ./x  ../x  /x
      if (spec.startsWith('@/') || spec.startsWith('node:')) continue; // the alias, and a flagged builtin
      if (!PACKAGE_NAME.test(spec)) continue;
      const p = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (builtinModules.includes(p)) continue;
      const list = IMPORTED_BY.get(p) ?? [];
      if (!list.includes(name)) list.push(name);
      IMPORTED_BY.set(p, list);
    }
  }
}

/**
 * DECLARED, IMPORTED BY NOTHING, AND STILL REQUIRED — each with the reason,
 * because «nothing imports it» is exactly what was true of `vite` on the
 * afternoon somebody nearly removed it and took the whole test suite with it.
 */
const KEPT_WITHOUT_AN_IMPORT: Record<string, string> = {
  '@tailwindcss/postcss': 'يُسمَّى نصّاً في postcss.config.mjs — لا يستورده ملف',
  '@testing-library/dom': 'peer لـ@testing-library/react و user-event معاً، وليس تبعيةً لأيٍّ منهما',
  '@types/node': 'في tsconfig.types، وpeer لـvitest — تعريفاتٌ لا رموز',
  '@types/qrcode': 'qrcode لا يشحن تعريفاته، فبدونه tsc يرفض waybill.ts و2fa/start',
  '@types/react': 'في tsconfig.types، وpeer لـ@testing-library/react',
  '@types/react-dom': 'في tsconfig.types، وpeer لـ@testing-library/react',
  jsdom: 'peer لـvitest، وبيئةُ كلِّ اختبارِ مكوّنٍ يُسمّى نصّاً بـenvironment: jsdom',
  prisma: 'أداةُ سطرِ أوامر: prisma generate وmigrate deploy في docker-entrypoint.sh',
  /*
   * The reason here is written with Arabic quotation marks on purpose. With
   * straight ones it read `@import "tailwindcss"`, and the sweep's own
   * bare-specifier pattern matched this very line — the file declared
   * `tailwindcss` imported by itself and then failed its own staleness
   * check. A guard that can be satisfied by its own prose is not a guard.
   */
  tailwindcss: 'يُستورَد من CSS: السطر @import «tailwindcss» في globals.css',
  tsx: 'يشغّل scripts/worker.ts في الإنتاج من docker-entrypoint.sh، وseed وworker في package.json',
  typescript: 'يشغّله tsc وnext build — لا يستورده ملف أبداً',
  vite: 'peerDependency لـvitest (^6|^7|^8) وليس تبعيةً له؛ حذفه يُسقط كلَّ الاختبارات',
};

describe('كلُّ تبعيةٍ معلَنة إمّا تُستورَد أو يُقال لماذا تبقى بلا استيراد', () => {
  it('sweeps a real tree, not an empty one', () => {
    expect(SWEPT.length).toBeGreaterThanOrEqual(1200);
    expect(DECLARED.length).toBeGreaterThanOrEqual(25);
  });

  it('and not one declared package is unaccounted for', () => {
    const orphans = DECLARED.filter((d) => !IMPORTED_BY.has(d) && !(d in KEPT_WITHOUT_AN_IMPORT));
    expect(
      orphans,
      `تبعيةٌ لا يستوردها شيء ولم يُقَل لماذا تبقى — إمّا أن تُحذَف أو أن يُكتَب سببُ بقائها:\n${orphans.join('\n')}`
    ).toEqual([]);
  });

  it('and the reasoning side has not gone stale by keeping a name the tree now imports', () => {
    // A reason that is no longer true is a reason nobody is reading.
    const stale = Object.keys(KEPT_WITHOUT_AN_IMPORT).filter((d) => IMPORTED_BY.has(d));
    expect(stale, `اسمٌ قيل إنه بلا استيراد، والشجرةُ تستورده الآن:\n${stale.join('\n')}`).toEqual([]);
  });

  it('and does not name a package package.json no longer declares', () => {
    const ghosts = Object.keys(KEPT_WITHOUT_AN_IMPORT).filter((d) => !DECLARED.includes(d));
    expect(ghosts, `اسمٌ في قائمة الأسباب غير معلَنٍ في package.json:\n${ghosts.join('\n')}`).toEqual([]);
  });

  it('and every reason is a sentence a reviewer can check, not a shrug', () => {
    for (const [name, why] of Object.entries(KEPT_WITHOUT_AN_IMPORT)) {
      expect([...why].length, `${name}: السبب أقصر من أن يُراجَع`).toBeGreaterThan(20);
    }
  });

  /**
   * THE MIRROR — and it is the half that fails in production rather than in
   * a build. `dotenv` passed every check above by being imported; what it
   * failed was being DECLARED, and a package only in the tree because
   * something else happens to depend on it is one dedupe away from gone.
   */
  it('and every package the tree imports is declared, not merely present', () => {
    const undeclared = [...IMPORTED_BY.keys()]
      .filter((p) => !DECLARED.includes(p))
      .map((p) => `${p}  <-  ${IMPORTED_BY.get(p)!.slice(0, 3).join(', ')}`);
    expect(
      undeclared,
      `حزمةٌ تُستورَد ولا تُعلَن — موجودةٌ لأنَّ غيرها يعتمد عليها فقط:\n${undeclared.join('\n')}`
    ).toEqual([]);
  });
});

/* ═══════════════════ 2 · COMPONENTS ═══════════════════ */

const COMPONENTS = SWEPT.filter((p) => !isTest(p) && rel(p).startsWith('src/components/') && p.endsWith('.tsx'));

/** Does any file other than itself write `<Name …>`? */
const renderedByProd = (name: string, self: string) => {
  const tag = new RegExp('<' + name + '[\\s/>]');
  return PROD_TEXT.some(([n, s]) => n !== self && tag.test(s));
};

/** Every exported symbol that looks like a component — `Foo`, never `FOO_BAR`. */
function exportedComponents(src: string): string[] {
  const names = new Set<string>();
  for (const re of [/export\s+(?:default\s+)?function\s+([A-Z][a-z]\w*)/g, /export\s+const\s+([A-Z][a-z]\w*)/g]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) names.add(m[1]);
  }
  return [...names];
}

/**
 * BUILT, TESTED, AND RENDERED BY NOTHING — reported, never deleted.
 *
 * Each of these is a finished piece of work that no screen reaches. That is
 * a product decision (wire it up, or drop it), and this file is not allowed
 * to make it. What it IS allowed to do is stop the number growing quietly.
 */
const RENDERED_BY_NOTHING: Record<string, string> = {
  /*
   * `Skeleton` CAME OFF THIS LIST BY STOPPING BEING AN EXPORT.
   *
   * Its entry read «the single bar: SkeletonRows uses it inside its own
   * file, and nobody calls it from outside» — which is a description of a
   * needless `export`, not of unused code. The keyword is gone and the
   * function is module-private, so there is nothing left to classify.
   */
  /*
   * AND `ProductSkeleton` STAYS, after being deleted and put back.
   *
   * Its entry read «an export its own file does not even use», and on
   * that reading I removed it — then two guards in `shop-budget.test.ts`
   * failed. One of them pins, in writing, that this file holds **two**
   * skeletons and that each carries `aria-busy`; the other requires the
   * `.sf-product` container so the product page's placeholder lays out
   * where the real page does.
   *
   * «Nothing imports it» is not «nothing depends on it». It is a built
   * loading state for the product page, already held to the layout rules,
   * waiting for the route that renders it — and the entry now says that
   * instead of implying it is spare.
   */
  'src/components/storefront/ShopSkeleton.tsx:ProductSkeleton':
    'هيكلُ تحميلِ صفحةِ المنتج — مبنيٌّ ومحروسٌ في shop-budget (وجودُه و aria-busy و sf-product)، ولا مسارَ يرسمه بعد',

  /*
   * `MissionCardView` IS RENDERED BY ITS OWN FILE — and that is the point.
   *
   * `MissionCard` chooses the mission (with `useMayOpen`, so it needs a
   * session) and `WorkToday` renders it; the view half is exported so a test
   * can draw a card with a mission already in hand, without faking a session.
   * It is not dead code waiting for a route; it is the seam the test uses.
   */
  'src/components/dashboard/MissionCard.tsx:MissionCardView':
    'النصف المرسوم من بطاقة «مهمّتك الجاية» — يُصدَّر ليصيّره اختبارُها بمهمّة جاهزة بلا جلسة؛ `MissionCard` نفسها هي ما تستخدمه الشاشة.',

  /*
   * Same shape as `MissionCardView`: rendered by its own file (the «إضافة استثناء» dialog of UserDetailScreen), and
   * exported so its test can draw the list with a role already in hand, without faking the whole user page.
   */
  'src/components/screens/UserDetailScreen.tsx:PermissionPicker':
    'قائمة الصلاحيات بنافذة «إضافة استثناء» — ترسمها شاشة المستخدم نفسها، وتُصدَّر ليرسمها اختبارُها بدور جاهز بلا صفحة كاملة.',
};

describe('كلُّ مكوّنٍ إمّا تعرضه شاشة أو يُقال إنه بُني ولم يُوصَل', () => {
  it('sweeps every component file, not a handful', () => {
    expect(COMPONENTS.length).toBeGreaterThanOrEqual(180);
  });

  it('and every component file is imported by something that is not a test', () => {
    /*
     * FILE level, which is the level at which a file is dead. A file nothing
     * imports cannot render; a file only its own test imports renders only
     * in that test, which is the shape `SavedViews.tsx` has.
     */
    const unimported = COMPONENTS.map(rel).filter((f) => {
      const base = f.replace(/\.tsx$/, '');
      const alias = '@/' + base.replace(/^src\//, '');
      const leaf = base.split('/').pop()!;
      return !PROD_TEXT.some(([n, s]) =>
        n !== f && (s.includes(`'${alias}'`) || s.includes(`"${alias}"`) || new RegExp(`['"][.][\\w./-]*/${leaf}['"]`).test(s))
      );
    });
    const unclassified = unimported.filter(
      (f) => !Object.keys(RENDERED_BY_NOTHING).some((k) => k.startsWith(f + ':'))
    );
    expect(
      unclassified,
      `ملفُّ مكوّنٍ لا يستورده شيءٌ خارج الاختبارات ولم يُصنَّف:\n${unclassified.join('\n')}`
    ).toEqual([]);
  });

  it('and every exported component is rendered somewhere, or named as unwired', () => {
    const dead: string[] = [];
    for (const f of COMPONENTS) {
      const src = TEXT.get(rel(f))!;
      for (const name of exportedComponents(src)) {
        const key = `${rel(f)}:${name}`;
        if (!renderedByProd(name, rel(f)) && !(key in RENDERED_BY_NOTHING)) dead.push(key);
      }
    }
    expect(dead, `مكوّنٌ مُصدَّرٌ لا يرسمه شيء ولم يُصنَّف:\n${dead.join('\n')}`).toEqual([]);
  });

  it('and the unwired list has not gone stale by naming something now rendered', () => {
    const stale = Object.keys(RENDERED_BY_NOTHING).filter((key) => {
      const [file, name] = key.split(':');
      return renderedByProd(name, file);
    });
    expect(stale, `اسمٌ قيل إنه غيرُ موصولٍ وقد صار يُرسَم:\n${stale.join('\n')}`).toEqual([]);
  });

  it('and every reason on the unwired side is a sentence', () => {
    for (const [key, why] of Object.entries(RENDERED_BY_NOTHING)) {
      expect([...why].length, `${key}: السبب أقصر من أن يُراجَع`).toBeGreaterThan(20);
    }
  });
});

/* ═══════════════════ 3 · PAGES AND ROUTES ═══════════════════ */

/**
 * A route's own folder spells its URL, with `[param]` where a value goes and
 * a `(group)` that spells nothing. The matcher therefore allows, in a
 * parameter's place, either a template hole `${…}` or one plain segment —
 * which is how `/api/orders/${order.id}/notes` is recognised as reaching
 * `/api/orders/[id]/notes`.
 */
const SLOT = '(?:\\$\\{[^}]*\\}|[\\w.%:-]+)';
const escapeLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
const pathPattern = (p: string) =>
  new RegExp('/' + p.split('/').filter(Boolean).map((s) => (s.startsWith('[') ? SLOT : escapeLiteral(s))).join('/') + '(?![\\w-])');

const urlFromFile = (p: string, leaf: string) => {
  const u = rel(p).replace(/^src\/app/, '').replace(new RegExp(`/${leaf}$`), '')
    .split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/');
  return u === '' ? '/' : u;
};

const namedByProd = (url: string, self: string) => {
  const re = pathPattern(url);
  return PROD_TEXT.some(([n, s]) => n !== self && re.test(s));
};

const PAGES = SWEPT.filter((p) => !isTest(p) && /[\\/]page\.tsx$/.test(p) && rel(p).startsWith('src/app/'));
const API_ROUTES = SWEPT.filter((p) => !isTest(p) && /[\\/]route\.ts$/.test(p) && rel(p).startsWith('src/app/api/'));

const NAV_SOURCE = readFileSync(join(ROOT, 'src/lib/route-registry.ts'), 'utf8');

/**
 * ROUTES NO FILE IN THIS REPOSITORY CALLS — and the two reasons are not the
 * same reason, so they are not in the same list.
 *
 * REACHED, BY A PATH THIS SWEEP CANNOT SEE. The caller builds the URL
 * instead of writing it, or the caller is not in this repository. These are
 * live and must not be touched; they are here because the only honest thing
 * a blind method can do is name what it is blind to.
 */
const REACHED_BUT_UNSEEN: Record<string, string> = {
  '/api/health': 'يستدعيه مراقبُ التشغيل وHEALTHCHECK في Dockerfile — لا ملفَّ مصدرٍ يسمّيه',
  '/api/health/live': 'HEALTHCHECK في Dockerfile يسأله: هل العمليةُ حيّة؟ بلا قاعدةٍ ولا عامل',
  '/api/health/worker': 'نفسُ الباب: نبضُ العاملِ يُقرأ من خارج المستودع لا من داخله',
  '/api/geo/stores/[id]/favicon': 'StoreBrandField يبني `/api/geo/stores/${storeId}/${kind}` والمقطعُ الأخير محسوب',
  '/api/geo/stores/[id]/logo': 'StoreBrandField يبني `/api/geo/stores/${storeId}/${kind}` والمقطعُ الأخير محسوب',
  '/api/whatsapp/connection/reconnect': 'WhatsAppSettingsScreen يبني `/api/whatsapp/connection/${kind}` بمقطعٍ محسوب',
  '/api/whatsapp/connection/test': 'WhatsAppSettingsScreen يبني `/api/whatsapp/connection/${kind}` بمقطعٍ محسوب',
  '/api/dev-fonts/[file]': 'blocks/styles.ts يكتبه داخل @font-face: `/api/dev-fonts/${stem}-${w}.woff2` — فتحتان في مقطع',
  '/api/store-fonts/[store]/[file]': 'load-store-fonts.ts يبنيه من مفتاحِ الخطِّ ووزنِه وصيغتِه في مقطعٍ واحد',
  '/api/public/store-logo/[storeId]/[file]': 'store-logo.ts يحفظ البادئة ثابتاً STORE_LOGO_PREFIX ويلحق الباقي',
  /*
   * `/api/public/landing-pages/[slug]/meta` was listed here, on the grounds
   * that only the generated `form.js` reaches it by string concatenation.
   * It came off the list because this sweep reads `scripts/` as well, and
   * `scripts/golden-path.ts` fetches it by its literal path as its
   * is-the-server-up probe. A caller is a caller.
   */
  '/api/public/landing-pages/[slug]/orders/[orderNumber]/add-product':
    'OrderForm يبنيه من ${orderEndpoint} وهو متغيّر، فلا تظهر البادئةُ في أيِّ نصّ',
  '/api/public/landing-pages/[slug]/media/[file]': 'صفحةُ الهبوطِ المرفوعةُ تحمل الرابطَ في HTMLها المخزَّن في القاعدة، لا في المصدر',
  '/api/settings/launch-flags': 'لا شاشةَ له بالقصد — توثيقُه يقول إنه نصفُ القرارِ الذي يجعل حالةَ الرايةِ مكتوبةً بصلاحيةٍ وسجلٍّ',
  /*
   * ── O7: THE FIVE DOORS WHOSE CALLER IS ANOTHER REPOSITORY ──
   *
   * `/api/v1/**` exists so that a program outside this building can reach
   * us. Its caller is `MKory18/AIresponse` → `src/modules/oms/client.ts`,
   * which this sweep cannot see and never will — that is the whole point of
   * the door. They are the clearest possible case of «reached by a path
   * this sweep is blind to», and the only honest thing a blind method can
   * do is say so.
   */
  '/api/v1/products': 'نظامُ الردود (MKory18/AIresponse) يقرأ الكتالوجَ منه بتوكن — المستدعي في مستودعٍ آخر',
  '/api/v1/customers/lookup': 'نظامُ الردود يسأل عن رقمٍ قبل أن يوعِدَ بتسليم — المستدعي خارجَ هذا المستودع',
  '/api/v1/orders': 'بابُ ترحيلِ الطلبِ من نظامِ الردود — لا ملفَّ هنا يستدعيه، وهذا هو الغرضُ منه',
  '/api/v1/orders/[id]': 'نظامُ الردود يتابع حالةَ الطلبِ الذي رحّله — المستدعي في مستودعٍ آخر',
  '/api/v1/orders/[id]/notes': 'نظامُ الردود يكتب ما عرفه من المحادثةِ على الطلب — المستدعي في مستودعٍ آخر',
  '/api/v1/orders/attribution': 'الميديا باير (zaki-mediabuyer → src/adapters/oms.ts) يقرأ مصدرَ الطلباتِ وحالتَها كلَّ ساعة بتوكن — المستدعي في مستودعٍ آخر',
};

/**
 * NO CALLER FOUND, AND NONE BUILT BY A STRING EITHER — a capability that
 * exists only as an endpoint. Reported. Deleting one is the owner's call and
 * three of them are permission-gated writes, which is exactly why nobody
 * should delete them on a sweep's word.
 */
const NO_CALLER_FOUND: Record<string, string> = {
  '/api/orders/[id]/finance': 'لقطةُ مالِ الطلبِ ودفترُه — لا نافذةَ تطلبها، وشاشةُ الطلب تقرأ /api/orders/[id] وحدها',
  '/api/orders/[id]/call-logs': 'المسارُ باقٍ وتعليقُ OrderDetailModal نفسه يقول إنه عاش هناك ولم يرسمه شيء',
  '/api/moderators': 'صاحبُها الوحيد كان نموذجَ «طلب جديد»، وصار يقرأ /api/orders/form-options (PR-6: الأسماء فقط، ولمن عنده «إسناد الطلبات»). باقٍ كما هو — فيه مبيعاتُ كلِّ موظف وعمولتُه خلف users.view — وتضييقُه بـteam.monitor بندٌ لاحق لا يُنفَّذ هنا',
  '/api/orders/follow-ups': 'مسكَّر (410) — طوابيرُ المتابعةِ صارت بشاشات التأكيد، والبابُ كان بلا صلاحية ويقرّر بأسماء الأدوار',
  /*
   * `/api/orders/confirmation/performance` — STILL UNCALLED, BUT NO LONGER
   * «الطريقُ الأقدمُ لنفسِ الأرقام».
   *
   * The old reason was right and was two things at once: nothing calls it,
   * AND it computed the team screen's figures a second way. The second
   * half is gone — it reads `teamPerformance()` now, the one calculator —
   * so what is left is a capability no screen offers: an agent looking at
   * their own week. Wiring that to a screen or dropping it is a product
   * decision, the same shape as `SavedViews` was, and not this file's.
   */
  '/api/orders/confirmation/performance':
    'يقرأ أرقامَه من الحاسبة المشتركة ولا يكرّرها — لكنه يَعرض أداءَ الموظف لنفسه ولا شاشةَ تسأله بعد',
  '/api/finance/summary': 'يُلخّص المالَ عبر محرّكِ التحليلاتِ الواحد، ولا شاشةَ تستدعيه — له اختبارُه فقط',
  '/api/public/stores/[store]/search': 'صفحةُ المتجر تبحث على الخادم بـsearchProducts مباشرةً؛ لا حقلَ اقتراحاتٍ يستدعي الطريق',

};

describe('كلُّ صفحةٍ يقود إليها رابط', () => {
  it('sweeps every page in the app', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(70);
  });

  it('and every one is either in the navigation contract or named by a living file', () => {
    const unlinked = PAGES.filter((p) => {
      const url = urlFromFile(p, 'page.tsx');
      return !pathPattern(url).test(NAV_SOURCE) && !namedByProd(url, rel(p));
    }).map((p) => `${urlFromFile(p, 'page.tsx')}  (${rel(p)})`);
    expect(
      unlinked,
      `صفحةٌ لا تذكرها لوحةُ المسارات ولا يسمّيها ملفٌّ حيّ — بابٌ بلا مقبض:\n${unlinked.join('\n')}`
    ).toEqual([]);
  });
});

describe('كلُّ مسارِ API إمّا يستدعيه شيءٌ أو يُقال لماذا لا يظهر له مستدعٍ', () => {
  it('sweeps every route handler in the app', () => {
    expect(API_ROUTES.length).toBeGreaterThanOrEqual(200);
  });

  it('and not one of them falls outside the partition', () => {
    const known = new Set([...Object.keys(REACHED_BUT_UNSEEN), ...Object.keys(NO_CALLER_FOUND)]);
    const strangers = API_ROUTES
      .map((p) => urlFromFile(p, 'route.ts'))
      .filter((u, i) => !namedByProd(u, rel(API_ROUTES[i])) && !known.has(u));
    expect(
      strangers,
      `مسارٌ لا يستدعيه ملفٌّ حيّ ولم يُصنَّف — إمّا أن يُوصَل أو أن يُكتَب لماذا لا يُرى مستدعيه:\n${strangers.join('\n')}`
    ).toEqual([]);
  });

  it('and neither list keeps a route that now has a visible caller', () => {
    const selfOf = new Map(API_ROUTES.map((p) => [urlFromFile(p, 'route.ts'), rel(p)]));
    const stale = [...Object.keys(REACHED_BUT_UNSEEN), ...Object.keys(NO_CALLER_FOUND)]
      .filter((u) => selfOf.has(u) && namedByProd(u, selfOf.get(u)!));
    expect(stale, `مسارٌ قيل إنه بلا مستدعٍ ظاهر، وقد صار يُستدعى:\n${stale.join('\n')}`).toEqual([]);
  });

  it('and neither list names a route that no longer exists', () => {
    const live = new Set(API_ROUTES.map((p) => urlFromFile(p, 'route.ts')));
    const ghosts = [...Object.keys(REACHED_BUT_UNSEEN), ...Object.keys(NO_CALLER_FOUND)].filter((u) => !live.has(u));
    expect(ghosts, `اسمُ مسارٍ في القائمة لا وجودَ له في src/app/api:\n${ghosts.join('\n')}`).toEqual([]);
  });

  it('and every reason on both sides is a sentence a reviewer can check', () => {
    for (const [url, why] of Object.entries({ ...REACHED_BUT_UNSEEN, ...NO_CALLER_FOUND })) {
      expect([...why].length, `${url}: السبب أقصر من أن يُراجَع`).toBeGreaterThan(20);
    }
  });

  /*
   * THE TWO SIDES ARE NOT INTERCHANGEABLE, so moving a route from one to the
   * other must be a deliberate edit and not a copy-paste. A URL on both
   * lists would mean somebody did not read either.
   */
  it('and no route is claimed by both sides at once', () => {
    const both = Object.keys(NO_CALLER_FOUND).filter((u) => u in REACHED_BUT_UNSEEN);
    expect(both, `مسارٌ قيل عنه الشيءُ ونقيضُه:\n${both.join('\n')}`).toEqual([]);
  });
});
