/**
 * THE DAILY-WINBACK HARNESS — asks the repo's REAL `readDailyList` (`src/lib/winback-daily.ts`) and the scorecard's winback credit (`readScorecard`, `src/lib/agent-scorecard.ts`), on the REAL Prisma client
 * against the scratch PostgreSQL, over rows with known dates in an isolated store. The unit tests double the database; the nested filters here (`order: { replacedBy: null, … }` on the status log, the
 * `OR` of the postponed date, the audit lines) only mean something on real tables.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, DATABASE_URL set before `db.ts` is imported); imports the repo's own TypeScript under tsx.
 *   2. Everything it writes (an isolated STORE, its orders, status lines, audit lines) is in ONE transaction that is ROLLED BACK.
 *   3. The cases: a lost order 24–72 h old for a spec reason is listed · 10 h old (too early), 80 h old (too late), another reason, shipped, already offered on (a replacement exists), another store's —
 *      none is · a postponed order whose date passed 50 h ago is listed as «missed» and one whose date passed 10 h ago is not · the latest assignment and the latest call are folded in ·
 *      the scorecard credits the offer's author: two offers, one whose new order is confirmed.
 *   4. Exit code 0 when it ran to the end (and, with `--assert`, every case matched), 2 when a database/Prisma error stopped it, 3 when `--assert` found a mismatch.
 *
 *   node scripts/verify-on-postgres/winback-daily.mjs [--assert]
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

const { readDailyList } = await import('../../src/lib/winback-daily.ts');
const { readScorecard } = await import('../../src/lib/agent-scorecard.ts');
const probe = new PrismaClient({ datasourceUrl: url, log: [{ emit: 'stdout', level: 'error' }] });
class Rollback extends Error {}

const mismatches = [];
function check(what, ok, detail = '') {
  if (ok) console.log(`${args.assert ? 'ASSERT OK    ' : 'ok           '}${what}`);
  else {
    console.log(`${args.assert ? 'ASSERT FAIL  ' : 'DIFFERENT    '}${what}${detail ? ` — ${detail}` : ''}`);
    mismatches.push(what);
  }
}

const HOUR = 3_600_000;
const now = new Date();
const ago = (h) => new Date(now.getTime() - h * HOUR);

try {
  const company = await probe.company.findFirst({ where: { name: COMPANY_ON } });
  if (!company) throw new Error(`ما لقيت الشركة "${COMPANY_ON}" — شغّل seed.mjs أول.`);
  const country = await probe.country.findFirst({ where: { companyId: company.id, code: 'SY' } });
  const region = await probe.region.findFirst({ where: { countryId: country.id } });
  const agent = await probe.user.findFirst({ where: { companyId: company.id } });
  if (!agent) throw new Error('ما لقيت مستخدم بالشركة التجريبية.');

  await probe
    .$transaction(
      async (tx) => {
        const stamp = String(Date.now()).slice(-6);
        const store = await tx.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-WB-${stamp}`, slug: `kit-wb-${stamp}` } });
        const other = await tx.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-WB2-${stamp}`, slug: `kit-wb2-${stamp}` } });
        const product = await tx.product.create({ data: { companyId: company.id, storeId: store.id, name: 'منتج الاسترجاع', sku: `KIT-WB-${stamp}`, basePrice: 20, status: 'ACTIVE' } });
        const product2 = await tx.product.create({ data: { companyId: company.id, storeId: other.id, name: 'منتج تاني', sku: `KIT-WB2-${stamp}`, basePrice: 20, status: 'ACTIVE' } });

        let n = 0;
        async function order(key, st, prod, extra = {}) {
          n += 1;
          const cust = await tx.customer.create({ data: { companyId: company.id, storeId: st.id, fullName: `زبون الاسترجاع ${n}`, phone: `98${stamp}${n}`, rawPhone: `098${stamp}${n}`, address: 'عنوان', city: region.name, country: 'SY', totalOrders: 1 } });
          const number = `KIT-WB-${stamp}-${key}`;
          return tx.order.create({
            data: {
              companyId: company.id, countryId: country.id, storeId: st.id, orderNumber: number, merchantRef: number, regionId: region.id, customerId: cust.id, productId: prod.id, quantity: 1, sellingPrice: 20,
              shippingCost: 0, totalAmount: 20, currency: country.currencyCode, estimatedCostOfGoods: 7, source: 'Manual', status: 'NEW', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', ...extra,
            },
          });
        }
        const lostLog = (o, h, value = 'REJECTED') => tx.orderStatusLog.create({ data: { companyId: company.id, orderId: o.id, statusType: 'CONFIRMATION', newValue: value, changedById: agent.id, changedByRole: 'CONFIRMATION_AGENT', createdAt: ago(h) } });
        const lost = (key, reason, h, extra = {}, st = store, prod = product) => order(key, st, prod, { confirmationStatus: 'REJECTED', status: 'REJECTED', rejectionReason: reason, ...extra });

        const L1 = await lost('L1', 'PRICE_TOO_HIGH', 30);
        const L2 = await lost('L2', 'CUSTOMER_CHANGED_MIND', 10);
        const L3 = await lost('L3', 'NO_ANSWER_5_ATTEMPTS', 80);
        const L4 = await lost('L4', 'OTHER', 30);
        const L5 = await lost('L5', 'PRICE_TOO_HIGH', 30, { shippedAt: ago(40) });
        const L6 = await lost('L6', 'PRICE_TOO_HIGH', 30);
        const X = await lost('X', 'PRICE_TOO_HIGH', 30, {}, other, product2);
        const L7 = await lost('L7', 'CUSTOMER_CHANGED_MIND', 60); // lost twice: the LAST decision (30 h) is the one that counts
        for (const [o, h] of [[L1, 30], [L2, 10], [L3, 80], [L4, 30], [L5, 30], [L6, 30], [X, 30], [L7, 70], [L7, 30]]) await lostLog(o, h);
        await order('L6-NEW', store, product, { replacesOrderId: L6.id }); // an offer was already made on L6
        const P1 = await order('P1', store, product, { confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: ago(50) });
        const P2 = await order('P2', store, product, { confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: ago(10) });
        await order('P3', store, product, { confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: null, nextFollowUpAt: ago(40) });

        const audit = (action, o, data, h, userId = agent.id) => tx.auditLog.create({ data: { companyId: company.id, userId, action, entity: 'Order', entityId: o.id, newData: JSON.stringify(data), createdAt: ago(h) } });
        await audit('WINBACK_ASSIGNED', L1, { assigneeId: agent.id }, 5);
        await audit('WINBACK_CALLED', L1, { result: 'NO_ANSWER' }, 4);
        await audit('WINBACK_CALLED', L1, { result: 'AGREED', note: 'وافق' }, 2);

        const list = await readDailyList(tx, { companyId: company.id, storeId: store.id }, now);
        const nums = list.map((i) => i.orderNumber.replace(`KIT-WB-${stamp}-`, '')).sort();
        check('القايمة: بس اللي بالنافذة وبالسبب وبلا عرض وبلا شحن — L1 وL7 وP1 وP3', JSON.stringify(nums) === JSON.stringify(['L1', 'L7', 'P1', 'P3']), nums.join(','));
        check('القايمة: 10 ساعات (بدري) و80 ساعة (متأخر) و«سبب آخر» والمشحون والمعروض عليه ومتجر تاني — كلهم برّا', !nums.some((x) => ['L2', 'L3', 'L4', 'L5', 'L6', 'X'].includes(x)));
        check('القايمة: المؤجّل اللي فات موعدو بـ50 ساعة جوّا (نوع «مؤجّل فات موعدو») وبـ10 ساعات لا', list.find((i) => i.orderNumber.endsWith('-P1'))?.kind === 'MISSED_POSTPONED' && !nums.includes('P2'));
        check('القايمة: المؤجّل بموعد المتابعة (بدون موعد الزبون) جوّا', nums.includes('P3'));
        check('القايمة: آخر قرار رفض هو اللي بيعدّ (L7 مرفوض مرتين = مرة وحدة)', nums.filter((x) => x === 'L7').length === 1);
        const l1 = list.find((i) => i.orderNumber.endsWith('-L1'));
        check('القايمة: آخر تعيين وآخر اتصال منطويين بالطلب', l1?.assignee?.id === agent.id && l1?.lastCall?.result === 'AGREED' && l1?.lastCall?.note === 'وافق', JSON.stringify([l1?.assignee, l1?.lastCall]));

        // the scorecard credits the author of the offer
        const confirmedNew = await order('N-OK', store, product, { confirmationStatus: 'CONFIRMED' });
        const openNew = await order('N-OPEN', store, product);
        await audit('WINBACK_OFFERED', L2, { newOrderId: confirmedNew.id }, 3);
        await audit('WINBACK_OFFERED', L3, { newOrderId: openNew.id }, 2);
        const card = await readScorecard(tx, { companyId: company.id, storeId: store.id, start: ago(24), end: new Date(now.getTime() + HOUR), calendar: { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [], timezone: 'UTC' }, grain: 'week' }, now);
        const mine = card.rows.filter((r) => r.userId === agent.id);
        const offers = mine.reduce((s, r) => s + r.winback.base, 0);
        const reactivated = mine.reduce((s, r) => s + r.winback.of, 0);
        check('البطاقة: عرضين قدّمتهم، واحد منهم صار طلب مؤكَّد (منسوب للي قدّم العرض)', offers === 2 && reactivated === 1, `offers=${offers} reactivated=${reactivated}`);

        throw new Rollback();
      },
      { maxWait: 10_000, timeout: 120_000 }
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  console.log('\nانعمل rollback: القاعدة التجريبية متل ما كانت.');
} catch (e) {
  console.error(`\nوقف الفحص بخطأ قاعدة/Prisma: ${e instanceof Error ? e.message : e}`);
  await probe.$disconnect();
  process.exit(2);
}

await probe.$disconnect();
if (args.assert && mismatches.length) {
  console.error(`\nفرق (${mismatches.length}): ${mismatches.join(' | ')}`);
  process.exit(3);
}
process.exit(0);
