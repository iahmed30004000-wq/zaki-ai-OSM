/**
 * THE INTAKE-FILTER HARNESS — asks the repo's REAL `sweepIntake` (`src/lib/intake-filter.ts`), on the REAL Prisma client against the scratch PostgreSQL, which
 * of a handful of new orders get a flag. The double of the unit tests never ran the nested relation select (`activities: { where, select }`), the
 * `customerId: { in }` / `phone: { in }` queries or the `createdAt` window against a real database; this does.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, the process's DATABASE_URL is set before `db.ts` is imported).
 *   2. Imports the repo's own TypeScript under the tsx command (it relaunches itself under it): no copy of the rule lives here.
 *   3. Everything it writes (a switch turned on, customers, orders, lines) is written in ONE transaction that is ROLLED BACK — the scratch database is
 *      left as it was, so the other kit scripts run after it unchanged.
 *   4. The cases (all in the Syrian store of the «KIT ON» company, products and customers of its own):
 *        a. a repeat under the SAME number, a day or less later               → INTAKE_DUPLICATE naming the FIRST order
 *        b. a repeat under the dial code written bare (963…, a second customer row) → INTAKE_DUPLICATE
 *        c. the earlier order was REJECTED                                    → no flag
 *        d. the earlier order is more than 24 h older                         → no flag
 *        e. the same customer, ANOTHER product                                → no flag
 *        f. a number of the wrong shape                                       → INTAKE_SUSPECT_NUMBER
 *        g. a second sweep over the same orders                               → writes nothing
 *        h. the switch off                                                    → writes nothing, asks nothing of the orders
 *   5. Exit code 0 when it ran to the end (and, with `--assert`, every case matched), 2 when a database/Prisma error stopped it, 3 when `--assert` found a mismatch.
 *
 *   node scripts/verify-on-postgres/intake-filter.mjs [--assert]
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

const { sweepIntake } = await import('../../src/lib/intake-filter.ts');
const { forgetIntakeFilterSwitch } = await import('../../src/lib/intake-filter-switch.ts');

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
  const store = await probe.store.findFirst({ where: { companyId: company.id, countryId: country.id } });
  const region = await probe.region.findFirst({ where: { countryId: country.id } });
  const baseProduct = await probe.product.findFirst({ where: { companyId: company.id, storeId: store.id } });
  const scope = { companyId: company.id, storeId: store.id, countryCode: country.code };

  await probe
    .$transaction(
      async (tx) => {
        const productB = await tx.product.create({
          data: { companyId: company.id, storeId: store.id, name: 'منتج تاني للكيت', sku: `KIT-INTAKE-${Date.now()}`, basePrice: 20, status: 'ACTIVE' },
        });
        const stamp = String(Date.now()).slice(-6);

        let n = 0;
        async function customer(phone, rawPhone = phone) {
          n += 1;
          return tx.customer.create({
            data: { companyId: company.id, storeId: store.id, fullName: `زبون الاستقبال ${n}`, phone, rawPhone, address: 'عنوان', city: region.name, country: 'SY', totalOrders: 1 },
          });
        }
        async function order(key, cust, product, createdAt, status = 'NEW') {
          const number = `KIT-INTAKE-${stamp}-${key}`;
          const o = await tx.order.create({
            data: {
              companyId: company.id, countryId: country.id, storeId: store.id, orderNumber: number, merchantRef: number, regionId: region.id,
              customerId: cust.id, productId: product.id, quantity: 1, sellingPrice: 20, shippingCost: 0, totalAmount: 20, currency: country.currencyCode,
              estimatedCostOfGoods: 7, status, confirmationStatus: status, shippingStatus: 'NOT_READY', source: 'Manual', createdAt,
            },
          });
          await tx.orderItem.create({
            data: { companyId: company.id, orderId: o.id, productId: product.id, productName: product.name, quantity: 1, unitPrice: 20, lineTotal: 20, addedStage: 'INTAKE' },
          });
          return { ...o, number };
        }

        // a + b: a first order, a repeat under the same number, a repeat under the bare dial code (another customer row, stored whole).
        const c1 = await customer(`933${stamp}`, `0933${stamp}`);
        const c1bare = await customer(`963933${stamp}`, `963933${stamp}`);
        const first = await order('A-FIRST', c1, baseProduct, ago(5));
        const repeatSame = await order('A-SAME', c1, baseProduct, ago(1));
        const repeatBare = await order('B-BARE', c1bare, baseProduct, ago(0.5));
        // c: the earlier order was refused.
        const c2 = await customer(`934${stamp}`, `0934${stamp}`);
        await order('C-REFUSED', c2, baseProduct, ago(3), 'REJECTED');
        const afterRefused = await order('C-AFTER', c2, baseProduct, ago(1));
        // d: the earlier one is more than a day older.
        const c3 = await customer(`935${stamp}`, `0935${stamp}`);
        await order('D-OLD', c3, baseProduct, ago(30));
        const afterOld = await order('D-NEW', c3, baseProduct, ago(1));
        // e: another product.
        const c4 = await customer(`936${stamp}`, `0936${stamp}`);
        await order('E-P1', c4, baseProduct, ago(3));
        const otherProduct = await order('E-P2', c4, productB, ago(1));
        // f: the wrong shape.
        const c5 = await customer(`${stamp}1`, 'abc 12');
        const odd = await order('F-ODD', c5, baseProduct, ago(1));

        const ids = [first, repeatSame, repeatBare, afterRefused, afterOld, otherProduct, odd].map((o) => o.id);
        const flagsOf = async () => {
          const rows = await tx.orderActivity.findMany({
            where: { orderId: { in: ids }, action: { in: ['INTAKE_DUPLICATE', 'INTAKE_SUSPECT_NUMBER'] } },
            select: { orderId: true, action: true, metadata: true, userId: true },
          });
          const by = new Map();
          for (const r of rows) by.set(r.orderId, [...(by.get(r.orderId) ?? []), r]);
          return by;
        };

        // h: off — the company's own switch is not on, so nothing is written (and the orders are not even read).
        forgetIntakeFilterSwitch();
        check('h · المفتاح مطفي: ما انكتب شي', (await sweepIntake(scope, now, tx)) === 0 && (await flagsOf()).size === 0);

        // The switch on, since ten hours ago (the first order of a is five hours old: after it).
        const settings = { ...(company.settings ? JSON.parse(company.settings) : {}), intakeFilter: { enabled: true, enabledAt: ago(10).toISOString() } };
        await tx.company.update({ where: { id: company.id }, data: { settings: JSON.stringify(settings) } });
        forgetIntakeFilterSwitch();

        const written = await sweepIntake(scope, now, tx);
        const by = await flagsOf();
        const kinds = (o) => (by.get(o.id) ?? []).map((r) => r.action).sort();

        check('a · نفس الرقم: INTAKE_DUPLICATE', kinds(repeatSame).join() === 'INTAKE_DUPLICATE', kinds(repeatSame).join());
        const named = JSON.parse((by.get(repeatSame.id) ?? [])[0]?.metadata ?? '{}');
        check('a · بيسمّي الطلب الأول', named.firstOrderNumber === first.number && named.firstOrderId === first.id, JSON.stringify(named));
        check('a · الأول ما انوسم', kinds(first).length === 0, kinds(first).join());
        check('a · الوسم بلا كاتب (userId فاضي)', (by.get(repeatSame.id) ?? []).every((r) => r.userId === null));
        check('b · رمز الدولة بدون + (زبون تاني): INTAKE_DUPLICATE', kinds(repeatBare).join() === 'INTAKE_DUPLICATE', kinds(repeatBare).join());
        check('c · الأقدم مرفوض: بلا وسم', kinds(afterRefused).length === 0, kinds(afterRefused).join());
        check('d · الأقدم أكتر من 24 ساعة: بلا وسم', kinds(afterOld).length === 0, kinds(afterOld).join());
        check('e · منتج تاني: بلا وسم', kinds(otherProduct).length === 0, kinds(otherProduct).join());
        check('f · شكل الرقم غلط: INTAKE_SUSPECT_NUMBER', kinds(odd).join() === 'INTAKE_SUSPECT_NUMBER', kinds(odd).join());
        check('عدد الوسوم المكتوبة = 3 بالضبط', written === 3, `written=${written}`);

        const again = await sweepIntake(scope, now, tx);
        check('g · تشغيل تاني: ما بيكتب شي', again === 0, `written=${again}`);
        const orders = await tx.order.findMany({ where: { id: { in: ids } }, select: { confirmationStatus: true, claimedById: true, assignedToId: true } });
        check('الطلبات نفسها ما تغيّرت (حالة وحامل)', orders.every((o) => ['NEW', 'REJECTED'].includes(o.confirmationStatus) && o.claimedById === null && o.assignedToId === null));

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
