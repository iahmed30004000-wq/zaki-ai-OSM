/**
 * THE QUEUE-HEALTH HARNESS — asks the repo's REAL `readQueueHealth` (`src/lib/queue-health.ts`, step D2) on the REAL Prisma client against the scratch PostgreSQL. The unit tests double the
 * database; the backlog count, `some` beside `none` on the attempt lines, the claim-history relation filter and the store day only mean something on real tables.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, DATABASE_URL set before `db.ts` is imported); imports the repo's own TypeScript under tsx.
 *   2. Everything it writes (an isolated STORE, its orders, attempt lines and one claim-history line) is in ONE transaction that is ROLLED BACK.
 *   3. The cases: an empty store is all zeros · the backlog counts open orders with a «لا يرد» line (a held one counts, a confirmed one does not) · «due now» is only the unheld ones whose
 *      due arrived, and the oldest wait is the oldest of them · «entered today» is a first line today, «closed today» an order that had a line before today and is final · new orders waiting and the
 *      oldest wait · the last pull is read through the claim history of THIS store only.
 *   4. Exit code 0 when it ran to the end (and, with `--assert`, every case matched), 2 when a database/Prisma error stopped it, 3 when `--assert` found a mismatch.
 *
 *   node scripts/verify-on-postgres/queue-health.mjs [--assert]
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

const { readQueueHealth } = await import('../../src/lib/queue-health.ts');
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date();
const ago = (ms) => new Date(now.getTime() - ms);
const near = (a, b, tol) => a !== null && Math.abs(a - b) <= tol;

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
        const store = await tx.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-QH-${stamp}`, slug: `kit-qh-${stamp}` } });
        const product = await tx.product.create({ data: { companyId: company.id, storeId: store.id, name: 'منتج الصحة', sku: `KIT-QH-${stamp}`, basePrice: 20, status: 'ACTIVE' } });
        const scope = { companyId: company.id, storeId: store.id };
        // a calendar that is always inside shift hours, in UTC: the harness computes the «minutes since the shift opened» cap itself
        const cal = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [], timezone: 'UTC' };
        const sinceMidnight = now.getUTCHours() * 60 + now.getUTCMinutes();

        let n = 0;
        async function order(key, age, { lines = [], status = 'NEW', held = false } = {}) {
          n += 1;
          const cust = await tx.customer.create({
            data: { companyId: company.id, storeId: store.id, fullName: `زبون الصحة ${n}`, phone: `96${stamp}${n}`, rawPhone: `096${stamp}${n}`, address: 'عنوان', city: region.name, country: 'SY', totalOrders: 1 },
          });
          const number = `KIT-QH-${stamp}-${key}`;
          const o = await tx.order.create({
            data: {
              companyId: company.id, countryId: country.id, storeId: store.id, orderNumber: number, merchantRef: number, regionId: region.id, customerId: cust.id, productId: product.id,
              quantity: 1, sellingPrice: 20, shippingCost: 0, totalAmount: 20, currency: country.currencyCode, estimatedCostOfGoods: 7, status, confirmationStatus: status,
              shippingStatus: 'NOT_READY', source: 'Manual', createdAt: ago(age), ...(held ? { claimedById: agent.id, claimedAt: now } : {}),
            },
          });
          await tx.orderItem.create({ data: { companyId: company.id, orderId: o.id, productId: product.id, productName: product.name, quantity: 1, unitPrice: 20, lineTotal: 20, addedStage: 'INTAKE' } });
          let i = 0;
          for (const l of lines) {
            i += 1;
            await tx.orderContactAttempt.create({
              data: {
                companyId: company.id, orderId: o.id, employeeId: agent.id, employeeRole: 'CONFIRMATION_AGENT', attemptNumber: i, contactMethod: 'PHONE', result: l.result ?? 'NO_ANSWER',
                nextFollowUpAt: l.due === undefined ? null : new Date(now.getTime() + l.due), createdAt: ago(l.ago),
              },
            });
          }
          return o;
        }

        const empty = await readQueueHealth(tx, scope, cal, now);
        check('متجر معزول فاضي: كل الأرقام صفر', empty.backlog === 0 && empty.dueNow === 0 && empty.oldestDueHours === null && empty.enteredToday === 0 && empty.closedToday === 0 && empty.newWaiting === 0 && empty.oldestNewMinutes === null, JSON.stringify(empty));

        // the backlog: three unheld retries (due 26 h ago, 2 h ago, in 3 h), one held, one confirmed
        await order('B1', 5 * DAY, { status: 'NO_ANSWER', lines: [{ ago: 3 * DAY, due: -26 * HOUR }] });
        await order('B2', 5 * DAY, { status: 'NO_ANSWER', lines: [{ ago: 2 * DAY, due: -2 * HOUR }] });
        await order('B3', 5 * DAY, { status: 'NO_ANSWER', lines: [{ ago: 1 * DAY, due: 3 * HOUR }] });
        await order('B4', 5 * DAY, { status: 'NO_ANSWER', held: true, lines: [{ ago: 2 * DAY, due: -5 * HOUR }] });
        const closed = await order('C1', 4 * DAY, { status: 'CONFIRMED', lines: [{ ago: 3 * DAY, due: -HOUR }] });
        const h1 = await readQueueHealth(tx, scope, cal, now);
        check('«بالانتظار» = 4: المفتوح وعليه «لا يرد» (المحجوز بينعدّ، المؤكَّد لا)', h1.backlog === 4, `backlog=${h1.backlog}`);
        check('«حان موعده» = 2: غير المحجوز وموعدو وصل (الجاي بعد 3 ساعات لا، والمحجوز لا)', h1.dueNow === 2, `dueNow=${h1.dueNow}`);
        check('أقدم موعد فات ≈ 26 ساعة', near(h1.oldestDueHours, 26, 0.05), `oldestDueHours=${h1.oldestDueHours}`);
        check('«انسكّر اليوم» = 1: الطلب المؤكَّد كان عليه «لا يرد» قبل اليوم ووصل لحالة نهائية اليوم', h1.closedToday === 1, `closedToday=${h1.closedToday}`);
        void closed;

        await order('E1', 1 * HOUR, { status: 'NO_ANSWER', lines: [{ ago: 10_000, due: 3 * HOUR }] });
        const h2 = await readQueueHealth(tx, scope, cal, now);
        check('«دخل اليوم» = 1: أول «لا يرد» إلو قبل ثواني (واللي كان عليه سطر قبل اليوم ما بينعدّ)', h2.enteredToday === 1 || sinceMidnight < 1, `enteredToday=${h2.enteredToday}`);

        // new orders waiting
        await order('N1', 40 * MIN);
        await order('N2', 10 * MIN);
        const h3 = await readQueueHealth(tx, scope, cal, now);
        check('جدد بالانتظار = 2', h3.newWaiting === 2, `newWaiting=${h3.newWaiting}`);
        check('أقدم جديد: دقايق الانتظار ≈ 40 (أو منذ بداية الدوام لو أحدث)', near(h3.oldestNewMinutes, Math.min(40, sinceMidnight), 0.2), `oldestNewMinutes=${h3.oldestNewMinutes}`);

        // the last pull: read through the claim history of THIS store
        const none = await readQueueHealth(tx, scope, cal, now);
        check('بدون سحب بالمتجر: الفجوة = منذ بداية الدوام', near(none.noPullMinutes, sinceMidnight, 0.2), `noPullMinutes=${none.noPullMinutes}`);
        const held = await tx.order.findFirst({ where: { storeId: store.id, claimedById: agent.id }, select: { id: true } });
        await tx.orderClaimHistory.create({ data: { companyId: company.id, orderId: held.id, userId: agent.id, action: 'CLAIMED', reason: 'PULL_NEXT', createdAt: ago(5 * MIN) } });
        const h4 = await readQueueHealth(tx, scope, cal, now);
        check('آخر سحب قبل 5 دقايق: الفجوة ≈ 5 (أو منذ بداية الدوام لو أحدث)', near(h4.noPullMinutes, Math.min(5, sinceMidnight), 0.2), `noPullMinutes=${h4.noPullMinutes}`);
        check('الدوام: ضمن ساعات الدوام', h4.inShift === true);

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
