/**
 * THE LANDING AD-TAGS HARNESS — asks the repo's REAL `takeLandingOrder` (`src/lib/v1/landing-door.ts`, the door `POST /api/v1/landing/orders` calls) and the REAL `orders` table with the
 * twelve ad-tag columns of migration 20261117140000, on the REAL Prisma client against the scratch PostgreSQL. The unit tests double the database; that the tags land on the real row, that
 * an order without them is untouched and that a damaged tag costs the shop nothing only mean something on real tables.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, DATABASE_URL set before `db.ts` is imported); imports the repo's own TypeScript under tsx.
 *   2. `takeLandingOrder` opens its own transactions on the repo's `db`, so this one cannot be a rolled-back transaction like the others: everything it writes lives in an ISOLATED store,
 *      product and customers made here, and is DELETED at the end (orders first, then customers, the product, the store) — also when a case failed. The scratch database is disposable
 *      either way; the seeded companies are never touched.
 *   3. The cases, each through the real door: an order WITH the ads' links (utm_source / utm_campaign / utm_term / utm_content as the ads send them, ad_name, the page's link with a query and Meta's
 *      click ids) · an order with NO tags · an order with a DAMAGED tag (macros the platform did not fill, a non-http link, an id that is not digits) — and the order is created, with its number, in all three.
 *      With tags: campaign / ad set / ad ids are the macros' digits, the utm trio is kept as text, the name and the link (without its query) are stored, the three Meta ids are sealed (not readable in the
 *      column). With none: every tag column is NULL. Damaged: the utm text is kept, the ids are NULL. A second stamp on the tagged order changes nothing.
 *   4. Exit code 0 when it ran to the end (and, with `--assert`, every case matched), 2 when a database/Prisma error stopped it, 3 when `--assert` found a mismatch.
 *
 *   node scripts/verify-on-postgres/landing-ad-tags.mjs [--assert]
 */
import * as prismaPackage from '@prisma/client';
import { argv, assertScratchUrl, relaunchUnderTsx, scratchUrl } from './lib.mjs';
import { COMPANY_ON } from './scenario.mjs';

relaunchUnderTsx(import.meta.url);

const PrismaClient = prismaPackage.PrismaClient ?? prismaPackage.default.PrismaClient;
const args = argv({ assert: 'flag' });
const url = scratchUrl();
assertScratchUrl(url);
process.env.DATABASE_URL = url;
for (const k of ['DIRECT_URL', 'SHADOW_DATABASE_URL']) delete process.env[k];
if (process.env.NODE_ENV === 'production') delete process.env.NODE_ENV;
// The Meta click ids are sealed with the app's key; a throwaway one for this scratch run only (never printed, never stored anywhere).
process.env.APP_ENCRYPTION_KEY = 'ab'.repeat(32);

const { takeLandingOrder } = await import('../../src/lib/v1/landing-door.ts');
const { stampAdTags } = await import('../../src/lib/v1/ad-tags.ts');
const { decryptSecret } = await import('../../src/lib/secrets.ts');
const probe = new PrismaClient({ datasourceUrl: url, log: [{ emit: 'stdout', level: 'error' }] });

const mismatches = [];
function check(what, ok, detail = '') {
  if (ok) console.log(`${args.assert ? 'ASSERT OK    ' : 'ok           '}${what}`);
  else {
    console.log(`${args.assert ? 'ASSERT FAIL  ' : 'DIFFERENT    '}${what}${detail ? ` — ${detail}` : ''}`);
    mismatches.push(what);
  }
}

const TAG_COLUMNS = ['adId', 'adSourceType', 'adsetId', 'adCampaignId', 'adName', 'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent', 'landingUrl', 'fbclidEnc', 'fbcEnc', 'fbpEnc'];
const pick = (row) => Object.fromEntries(TAG_COLUMNS.map((c) => [c, row?.[c] ?? null]));

let store = null;
let exit = 0;
try {
  const company = await probe.company.findFirst({ where: { name: COMPANY_ON } });
  if (!company) throw new Error(`ما لقيت الشركة "${COMPANY_ON}" — شغّل seed.mjs أول.`);
  const country = await probe.country.findFirst({ where: { companyId: company.id, code: 'SY' } });

  const stamp = String(Date.now()).slice(-6);
  store = await probe.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-AT-${stamp}`, slug: `kit-at-${stamp}` } });
  const product = await probe.product.create({ data: { companyId: company.id, storeId: store.id, name: 'منتج الوسوم', sku: `KIT-AT-${stamp}`, basePrice: 20, status: 'ACTIVE' } });

  let n = 0;
  const order = (extra = {}) => {
    n += 1;
    // a Syrian mobile: nine digits starting 9 — `93` + one digit + the six of the stamp
    return takeLandingOrder(company.id, {
      productId: product.id,
      offerId: '',
      landingPageId: `kit-lp-${stamp}-${n}`,
      full_name: `زبون الوسوم ${n}`,
      phone: `093${n}${stamp}`,
      address: 'شارع الجلاء، دمشق',
      city: '',
      ...extra,
    });
  };
  const rowOf = (result) => probe.order.findFirst({ where: { companyId: company.id, orderNumber: String(result.body.orderNumber) } });

  // 1) WITH the ads' links
  const tagged = await order({
    attribution: {
      method: 'url_tags',
      utm_source: 'fb',
      utm_campaign: '120210000000000009',
      utm_term: '120210000000000005',
      utm_content: '120211000000000001',
      ad_name: 'CR00147_TRF01_hook2',
      landing_url: 'https://pages.zakiai.io/p/kamaa-eye-water?fbclid=IwAR0example&utm_source=fb',
      fbclid: 'IwAR0example',
      fbc: 'fb.1.1762200000000.IwAR0example',
      fbp: 'fb.1.1762200000000.1234567890',
    },
  });
  check('طلب بوسوم: الباب أنشأ الطلب ورجّع رقمو', tagged.ok === true && !!tagged.body.orderNumber, JSON.stringify(tagged).slice(0, 200));
  const a = pick(await rowOf(tagged));
  check(
    'الوسوم انكتبت على صف الطلب الحقيقي: حملة/مجموعة/إعلان من أرقام الماكرو، والـutm نص، والاسم، والمصدر',
    a.adCampaignId === '120210000000000009' && a.adsetId === '120210000000000005' && a.adId === '120211000000000001' && a.utmCampaign === '120210000000000009' && a.utmTerm === '120210000000000005' && a.utmContent === '120211000000000001' && a.utmSource === 'fb' && a.adName === 'CR00147_TRF01_hook2' && a.adSourceType === 'url_tags',
    JSON.stringify(a)
  );
  check('رابط الصفحة انخزّن بدون query (فيها الـclick id)', a.landingUrl === 'https://pages.zakiai.io/p/kamaa-eye-water', String(a.landingUrl));
  check(
    'fbclid وfbc وfbp مشفّرة بالعمود: مش مقروءة، وبتتفك لنفس القيمة',
    !!a.fbclidEnc && !!a.fbcEnc && !!a.fbpEnc && !/IwAR0example|1234567890/.test(`${a.fbclidEnc}${a.fbcEnc}${a.fbpEnc}`) && decryptSecret(a.fbclidEnc) === 'IwAR0example' && decryptSecret(a.fbpEnc) === 'fb.1.1762200000000.1234567890'
  );
  const again = await stampAdTags(company.id, String(tagged.body.orderNumber), { ad_id: '999999999', utm_campaign: '888888888' });
  const a2 = pick(await rowOf(tagged));
  check('وسم تاني على نفس الطلب ما بيغيّر شي (التحديث مشروط: لسا ما انوسم)', again === false && JSON.stringify(a2) === JSON.stringify(a));

  // 2) with NO tags
  const bare = await order();
  check('طلب بلا وسوم: الباب أنشأ الطلب ورجّع رقمو', bare.ok === true && !!bare.body.orderNumber, JSON.stringify(bare).slice(0, 200));
  const b = pick(await rowOf(bare));
  check('طلب بلا وسوم: كل أعمدة الوسوم NULL — متل ما كان قبل الميزة', TAG_COLUMNS.every((c) => b[c] === null), JSON.stringify(b));

  // 3) with a DAMAGED tag
  const damaged = await order({
    attribution: {
      method: 'url_tags',
      ad_id: 'not-digits',
      utm_source: 'fb',
      utm_campaign: '{{campaign.id}}',
      utm_term: 'broad-audience',
      utm_content: '{{ad.id}}',
      ad_name: '{{ad.name}}',
      landing_url: 'javascript:alert(1)',
      fbc: 7,
    },
  });
  check('طلب بوسم خربان: الباب أنشأ الطلب ورجّع رقمو', damaged.ok === true && !!damaged.body.orderNumber, JSON.stringify(damaged).slice(0, 200));
  const c = pick(await rowOf(damaged));
  check(
    'وسم خربان: الـutm انحفظ كنص متل ما اجا، والأرقام (الحملة/المجموعة/الإعلان) فاضية',
    c.utmCampaign === '{{campaign.id}}' && c.utmTerm === 'broad-audience' && c.utmContent === '{{ad.id}}' && c.utmSource === 'fb' && c.adCampaignId === null && c.adsetId === null && c.adId === null,
    JSON.stringify(c)
  );
  check('وسم خربان: الرابط غير http انرمى، والمشفّرات فاضية', c.landingUrl === null && c.fbclidEnc === null && c.fbcEnc === null && c.fbpEnc === null);

  // 4) three orders, three numbers, nothing else disturbed
  const numbers = [tagged, bare, damaged].map((r) => String(r.body.orderNumber));
  const rows = await probe.order.count({ where: { storeId: store.id } });
  check('التلات طلبات موجودين بأرقام مختلفة بالقاعدة', new Set(numbers).size === 3 && rows === 3, `${rows} rows`);
} catch (e) {
  console.error(`\nوقف الفحص بخطأ قاعدة/Prisma: ${e instanceof Error ? e.stack || e.message : e}`);
  exit = 2;
} finally {
  if (store) {
    try {
      // orders first (they hold the store with Restrict), then what they hung on
      await probe.order.deleteMany({ where: { storeId: store.id } });
      await probe.customer.deleteMany({ where: { storeId: store.id } });
      await probe.product.deleteMany({ where: { storeId: store.id } });
      await probe.store.delete({ where: { id: store.id } });
      console.log('\nانمسح كل اللي كتبو الفحص (المتجر المعزول، منتجو، زباينو، طلباتو).');
    } catch (e) {
      console.error(`\nما قدرت أمسح بقايا الفحص (القاعدة تجريبية): ${e instanceof Error ? e.message : e}`);
    }
  }
  await probe.$disconnect();
}

if (exit) process.exit(exit);
if (args.assert && mismatches.length) {
  console.error(`\nفرق (${mismatches.length}): ${mismatches.join(' | ')}`);
  process.exit(3);
}
process.exit(0);
