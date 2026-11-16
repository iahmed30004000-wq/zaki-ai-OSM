/**
 * THE END-OF-DAY REPORT HARNESS — asks the repo's REAL `systemNumbers` and `sampleRejected` (`src/lib/eod-report.ts`) and the REAL new table `confirmation_eod_reports` (migration 20261116130000), on the
 * REAL Prisma client against the scratch PostgreSQL, over rows with known dates in an isolated store.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, DATABASE_URL set before `db.ts` is imported); imports the repo's own TypeScript under tsx.
 *   2. Everything it writes (an isolated STORE, its orders, claim/status/attempt/audit lines, two report rows) is in ONE transaction that is ROLLED BACK.
 *   3. The cases: the system's numbers of one agent (unique claims · the last decision stands · rejected by reason · «لا يرد» lines · winback offered and converted · held over 48 h) with another
 *      store's activity left out · the sample of rejected orders is ten at most, the same on a second read, and carries no phone · the table takes ONE report per (store, day, person) and refuses the
 *      second with the unique violation.
 *   4. Exit code 0 when it ran to the end (and, with `--assert`, every case matched), 2 when a database/Prisma error stopped it, 3 when `--assert` found a mismatch.
 *
 *   node scripts/verify-on-postgres/eod-report.mjs [--assert]
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

const { systemNumbers, sampleRejected } = await import('../../src/lib/eod-report.ts');
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

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const now = new Date();
const dayStart = new Date(now.getTime() - 2 * DAY);
dayStart.setUTCHours(0, 0, 0, 0);
const dayEnd = new Date(dayStart.getTime() + DAY);
const at = (minutes) => new Date(dayStart.getTime() + minutes * MIN);

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
        const store = await tx.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-EOD-${stamp}`, slug: `kit-eod-${stamp}` } });
        const other = await tx.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-EOD2-${stamp}`, slug: `kit-eod2-${stamp}` } });
        const product = await tx.product.create({ data: { companyId: company.id, storeId: store.id, name: 'منتج التقرير', sku: `KIT-EOD-${stamp}`, basePrice: 20, status: 'ACTIVE' } });
        const product2 = await tx.product.create({ data: { companyId: company.id, storeId: other.id, name: 'منتج تاني', sku: `KIT-EOD2-${stamp}`, basePrice: 20, status: 'ACTIVE' } });

        let n = 0;
        async function order(key, st, prod, extra = {}, phone = null) {
          n += 1;
          const cust = await tx.customer.create({ data: { companyId: company.id, storeId: st.id, fullName: `زبون التقرير ${n}`, phone: `97${stamp}${n}`, rawPhone: phone ?? `097${stamp}${n}`, address: 'عنوان', city: region.name, country: 'SY', totalOrders: 1 } });
          const number = `KIT-EOD-${stamp}-${key}`;
          return tx.order.create({
            data: {
              companyId: company.id, countryId: country.id, storeId: st.id, orderNumber: number, merchantRef: number, regionId: region.id, customerId: cust.id, productId: prod.id, quantity: 1, sellingPrice: 20,
              shippingCost: 0, totalAmount: 20, currency: country.currencyCode, estimatedCostOfGoods: 7, source: 'Manual', status: 'NEW', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', ...extra,
            },
          });
        }
        const claim = (o, m) => tx.orderClaimHistory.create({ data: { companyId: company.id, orderId: o.id, userId: agent.id, action: 'CLAIMED', reason: 'PULL_NEXT', createdAt: at(m) } });
        const decide = (o, value, m) => tx.orderStatusLog.create({ data: { companyId: company.id, orderId: o.id, statusType: 'CONFIRMATION', newValue: value, changedById: agent.id, changedByRole: 'CONFIRMATION_AGENT', createdAt: at(m) } });

        const A = await order('A', store, product);
        const B = await order('B', store, product, { rejectionReason: 'PRICE_TOO_HIGH', confirmationStatus: 'REJECTED' });
        const C = await order('C', store, product, { rejectionReason: 'FAKE_ORDER', confirmationStatus: 'REJECTED' }, 'abc 12');
        const D = await order('D', store, product, { confirmationStatus: 'IN_PROGRESS', claimedById: agent.id, claimedAt: new Date(now.getTime() - 3 * DAY) });
        const X = await order('X', other, product2);
        for (const [o, m] of [[A, 1], [A, 2], [B, 3], [C, 4], [D, 5]]) await claim(o, m);
        await claim(X, 6);
        await decide(A, 'CONFIRMED', 10);
        await decide(B, 'CONFIRMED', 11);
        await decide(B, 'REJECTED', 12);
        await decide(C, 'REJECTED', 13);
        await decide(X, 'CONFIRMED', 14);
        for (const m of [20, 21]) await tx.orderContactAttempt.create({ data: { companyId: company.id, orderId: A.id, employeeId: agent.id, employeeRole: 'CONFIRMATION_AGENT', attemptNumber: m - 19, contactMethod: 'PHONE', result: 'NO_ANSWER', createdAt: at(m) } });
        const fresh = await order('W', store, product, { confirmationStatus: 'CONFIRMED' });
        await tx.auditLog.create({ data: { companyId: company.id, userId: agent.id, action: 'WINBACK_OFFERED', entity: 'Order', entityId: A.id, newData: JSON.stringify({ newOrderId: fresh.id }), createdAt: at(30) } });
        await tx.auditLog.create({ data: { companyId: company.id, userId: agent.id, action: 'WINBACK_OFFERED', entity: 'Order', entityId: B.id, newData: JSON.stringify({ newOrderId: 'nonexistent' }), createdAt: at(31) } });

        const rows = await systemNumbers(tx, { companyId: company.id, storeId: store.id, start: dayStart, end: dayEnd }, now);
        const me = rows.find((r) => r.userId === agent.id);
        check('النظام: السحب = 4 طلبات مختلفة (A انسحب مرتين، وطلب المتجر التاني برّا)', me?.claims === 4, `claims=${me?.claims}`);
        check('النظام: أكّدت 1 (A) ورفضت 2 (B انعكس وC)', me?.confirmed === 1 && me?.rejected === 2, `c=${me?.confirmed} r=${me?.rejected}`);
        check('النظام: الرفض حسب السبب (سعر 1، وهمي 1)', me?.rejectedByReason?.PRICE_TOO_HIGH === 1 && me?.rejectedByReason?.FAKE_ORDER === 1, JSON.stringify(me?.rejectedByReason));
        check('النظام: محاولات لا يرد = 2', me?.noAnswer === 2, `noAnswer=${me?.noAnswer}`);
        check('النظام: استرجاع 2 عرض وواحد صار طلب مؤكَّد', me?.winback === 2 && me?.winbackConverted === 1, `w=${me?.winback} conv=${me?.winbackConverted}`);
        check('النظام: عالق أكتر من 48 ساعة = 1 (D)', me?.stuck === 1, `stuck=${me?.stuck}`);
        check('النظام: ما في صف لحدا من المتجر التاني', rows.every((r) => r.userId === agent.id));

        const sample = await sampleRejected(tx, { companyId: company.id, storeId: store.id, start: dayStart, end: dayEnd, countryCode: 'SY', day: dayStart.toISOString().slice(0, 10) });
        const again = await sampleRejected(tx, { companyId: company.id, storeId: store.id, start: dayStart, end: dayEnd, countryCode: 'SY', day: dayStart.toISOString().slice(0, 10) });
        check('العيّنة: طلبين مرفوضين (B وC) بنفس الترتيب بالقراءة التانية', sample.length === 2 && JSON.stringify(sample) === JSON.stringify(again), `n=${sample.length}`);
        const c = sample.find((s) => s.orderNumber.endsWith('-C'));
        const b = sample.find((s) => s.orderNumber.endsWith('-B'));
        check('العيّنة: الرقم الغلط مشكوك والسليم صالح، والسبب بالعربي', c?.phoneValid === false && b?.phoneValid === true && !!c?.reasonAr, JSON.stringify([c?.phoneValid, b?.phoneValid]));
        check('العيّنة: ما فيها أي رقم هاتف', !JSON.stringify(sample).includes('abc 12') && !JSON.stringify(sample).includes(`097${stamp}`));

        const key = { companyId: company.id, storeId: store.id, day: '2026-11-10', userId: agent.id };
        await tx.confirmationEodReport.create({ data: { ...key, payload: { agents: [] }, system: [] } });
        // the second one must fail on the unique key — inside a savepoint, so the transaction goes on
        await tx.$executeRawUnsafe('SAVEPOINT eod_second');
        let refused = false;
        try {
          await tx.confirmationEodReport.create({ data: { ...key, payload: { agents: [] }, system: [] } });
        } catch (e) {
          refused = e?.code === 'P2002';
        }
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT eod_second');
        check('الجدول: تقرير واحد لكل (متجر، يوم، شخص) والتاني بيرفضو المفتاح الفريد', refused);
        const other2 = await tx.confirmationEodReport.create({ data: { ...key, day: '2026-11-11', payload: {}, system: [] } });
        check('الجدول: يوم تاني بيتقبل', !!other2.id);

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
