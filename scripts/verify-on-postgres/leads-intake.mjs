/**
 * THE LEADS-INTAKE HARNESS — asks the repo's REAL `takeLead` (`src/lib/leads/lead-intake.ts`) and the REAL new table `leads` (migration 20261117100000), on the REAL Prisma client against the scratch
 * PostgreSQL. The unit tests double the database; the unique key, the customer lookup under every spelling of a number and the 24-hour window only mean something on real tables.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, DATABASE_URL set before `db.ts` is imported); imports the repo's own TypeScript under tsx.
 *   2. Everything it writes (an isolated STORE, a product, customers, orders, the leads) is in ONE transaction that is ROLLED BACK.
 *   3. The cases: a lead is kept once (the company and store come from the product) · the same lead sent again is `created: false` and one row · a number that ordered the same product 5 h ago FLAGS it (the
 *      lead is kept) — also when the order sits under the other spelling of the number (the dial code written bare) · an order 30 h old, another product, or a refused one does not flag ·
 *      an unknown product is refused and keeps nothing · the unique key of the table refuses a second row for the same external id · no order and no customer is created by taking a lead.
 *      Step E2, the lane (same store, same rows): the lane holds the NEW leads of the store with the product's live offer attached and the 24-hour flag · a dismissed lead leaves it and a second
 *      dismissal is refused · a lead of another store is neither read nor dismissed through this store.
 *   4. Exit code 0 when it ran to the end (and, with `--assert`, every case matched), 2 when a database/Prisma error stopped it, 3 when `--assert` found a mismatch.
 *
 *   node scripts/verify-on-postgres/leads-intake.mjs [--assert]
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

const { takeLead } = await import('../../src/lib/leads/lead-intake.ts');
const { readLeadLane, dismissLead } = await import('../../src/lib/leads/lead-lane.ts');
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

  await probe
    .$transaction(
      async (tx) => {
        const stamp = String(Date.now()).slice(-6);
        const store = await tx.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-LD-${stamp}`, slug: `kit-ld-${stamp}` } });
        const product = await tx.product.create({ data: { companyId: company.id, storeId: store.id, name: 'منتج الليدز', sku: `KIT-LD-${stamp}`, basePrice: 20, status: 'ACTIVE' } });
        const product2 = await tx.product.create({ data: { companyId: company.id, storeId: store.id, name: 'منتج تاني', sku: `KIT-LD2-${stamp}`, basePrice: 20, status: 'ACTIVE' } });

        let n = 0;
        // a Syrian mobile has nine digits: `93` + one digit + the six of the stamp — so every spelling of it (with the trunk zero, with the dial code bare) is a real one
        const nat = (k) => `93${k}${stamp}`;
        async function orderFor(phoneStored, prod, hours, confirmationStatus = 'NEW') {
          n += 1;
          const cust = await tx.customer.create({ data: { companyId: company.id, storeId: store.id, fullName: `زبون الليدز ${n}`, phone: phoneStored, rawPhone: phoneStored, address: 'عنوان', city: region.name, country: 'SY', totalOrders: 1 } });
          const number = `KIT-LD-${stamp}-${n}`;
          return tx.order.create({
            data: {
              companyId: company.id, countryId: country.id, storeId: store.id, orderNumber: number, merchantRef: number, regionId: region.id, customerId: cust.id, productId: prod.id, quantity: 1, sellingPrice: 20,
              shippingCost: 0, totalAmount: 20, currency: country.currencyCode, estimatedCostOfGoods: 7, source: 'Manual', status: confirmationStatus, confirmationStatus, shippingStatus: 'NOT_READY', createdAt: ago(hours),
            },
          });
        }
        const lead = (id, phone, productId = product.id) => ({ id, full_name: 'ليد تجريبي', phone, city: 'دمشق', product_id: productId, page: 'https://pages.zakiai.io/p', utm_campaign: 'camp', utm_content: 'ad1' });
        const rowOf = (id) => tx.lead.findUnique({ where: { companyId_externalId: { companyId: company.id, externalId: id } } });
        const ordersBefore = await tx.order.count({ where: { storeId: store.id } });
        const customersBefore = await tx.customer.count({ where: { storeId: store.id } });

        // a plain lead
        const a = await takeLead(tx, lead('A', `0${nat(1)}`), now);
        const rowA = await rowOf('A');
        check('الليد انحفظ مرة وحدة، والشركة والمتجر من المنتج، والرقم بمفتاحو، والـutm متل ما اجا', a.created === true && rowA?.companyId === company.id && rowA?.storeId === store.id && rowA?.phoneKey === nat(1) && rowA?.utmCampaign === 'camp' && rowA?.utmContent === 'ad1', JSON.stringify(rowA));
        const again = await takeLead(tx, lead('A', `0${nat(1)}`), now);
        check('نفس الليد مرة تانية: ما انكتب شي (created=false) وصف واحد', again.created === false && (await tx.lead.count({ where: { companyId: company.id, externalId: 'A' } })) === 1);

        // the 24-hour flag
        await orderFor(nat(2), product, 5);
        const b = await takeLead(tx, lead('B', `0${nat(2)}`), now);
        check('رقمو طلب نفس المنتج من 5 ساعات: الليد اتعلّم واتحفظ', b.created === true && b.recentOrder === true && !!(await rowOf('B'))?.recentOrderId);

        await orderFor(`963${nat(3)}`, product, 6); // stored under the dial code written bare: the other spelling
        const c = await takeLead(tx, lead('C', `0${nat(3)}`), now);
        check('الطلب مخزّن برمز الدولة بدون +: الليد اتعلّم كمان', c.recentOrder === true);

        await orderFor(nat(4), product, 30);
        const d = await takeLead(tx, lead('D', `0${nat(4)}`), now);
        await orderFor(nat(5), product2, 5);
        const e = await takeLead(tx, lead('E', `0${nat(5)}`), now);
        await orderFor(nat(6), product, 5, 'REJECTED');
        const f = await takeLead(tx, lead('F', `0${nat(6)}`), now);
        check('طلب عمرو 30 ساعة، أو منتج تاني، أو مرفوض: ما بيعلّم', d.recentOrder === false && e.recentOrder === false && f.recentOrder === false, JSON.stringify([d, e, f]));
        check('وكلهم انحفظوا (التعليم مش رفض)', !!(await rowOf('D')) && !!(await rowOf('E')) && !!(await rowOf('F')));

        // refusals and the key
        const g = await takeLead(tx, lead('G', `0${nat(7)}`, 'no-such-product'), now);
        check('منتج مش بالكتالوج: مرفوض ولا ينحفظ شي', g.ok === false && g.code === 'UNKNOWN_PRODUCT' && !(await rowOf('G')));
        await tx.$executeRawUnsafe('SAVEPOINT lead_second');
        let refused = false;
        try {
          await tx.lead.create({ data: { companyId: company.id, storeId: store.id, externalId: 'A', fullName: 'x', phone: '1', phoneKey: '1', productId: product.id } });
        } catch (err) {
          refused = err?.code === 'P2002';
        }
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT lead_second');
        check('الجدول: المفتاح الفريد (شركة، معرّف الصفحات) بيرفض الصف التاني', refused);

        // step E2 — the lane, on real tables
        const offer = await tx.offer.create({ data: { companyId: company.id, productId: product.id, name: 'عرض الليدز', quantity: 1, sellingPrice: 20 } });
        const scope = { companyId: company.id, storeId: store.id };
        const lane = await readLeadLane(tx, scope, country.minorUnit, now);
        const ids = lane.map((l) => l.id);
        const rowIds = (await tx.lead.findMany({ where: { storeId: store.id, status: 'NEW' }, select: { id: true } })).map((r) => r.id);
        check('الطابور: بيحمل ليدز المتجر الجديدة كلها (A..F) ولا شي غيرها', lane.length === 6 && rowIds.every((id) => ids.includes(id)), `${lane.length}`);
        check('الطابور: عرض المنتج الفعّال مرفق بكل ليد (وهو العرض الوحيد)', lane.every((l) => l.offers.length === 1 && l.offers[0].id === offer.id), JSON.stringify(lane.map((l) => l.offers.length)));
        check('الطابور: تعليم الـ24 ساعة على الليدين المعلَّمين (B وC) بس', lane.filter((l) => l.recentOrder).length === 2, String(lane.filter((l) => l.recentOrder).length));
        const target = lane[0];
        check('إزالة ليد: بتنجح مرة وتطلعو من الطابور', (await dismissLead(tx, scope, target.id)) === true && !(await readLeadLane(tx, scope, country.minorUnit, now)).some((l) => l.id === target.id));
        check('إزالة ثانية لنفس الليد مرفوضة، ومن متجر تاني مرفوضة', (await dismissLead(tx, scope, target.id)) === false && (await dismissLead(tx, { companyId: company.id, storeId: 'other-store' }, lane[1].id)) === false);

        // taking a lead creates no order and no customer
        check('أخذ الليدز ما أنشأ ولا طلب (غير اللي حطّيناها للفحص) ولا زبون', (await tx.order.count({ where: { storeId: store.id } })) === ordersBefore + 5 && (await tx.customer.count({ where: { storeId: store.id } })) === customersBefore + 5);

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
