/**
 * THE STOCK-FIGURES HARNESS — asks the repo's REAL `productFigures` (`src/lib/v1/product-figures.ts`, what `GET /api/v1/products?fields=stock_units,daily_sales_7d,stock_days` answers from) on the
 * REAL tables (`production_batches`, `orders`, `order_items`) of the scratch PostgreSQL. The unit tests double the database; the join from a shipped order to its lines, the store scope and the
 * seven-day window only mean something on real rows.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, DATABASE_URL set before `db.ts` is imported); imports the repo's own TypeScript under tsx.
 *   2. `productFigures` reads through the repo's own `db` connection, which cannot see another connection's open transaction, so this harness cannot be a rolled-back transaction like the others: everything it
 *      writes lives in two ISOLATED stores (two products, a batch, customers, orders and their lines) and is DELETED at the end, orders first — also when a case failed. The scratch database is disposable either
 *      way; the seeded companies are never touched.
 *   3. The cases: a batch of 240 and 210 units shipped in the last 7 days → 30.00 a day → 8 days · units shipped 8 days ago do not count · gift units count · another store's shipments do not count ·
 *      an order never shipped does not count · a product with no batch has no stock count.
 *   4. Exit code 0 when it ran to the end (and, with `--assert`, every case matched), 2 when a database/Prisma error stopped it, 3 when `--assert` found a mismatch.
 *
 *   node scripts/verify-on-postgres/stock-figures.mjs [--assert]
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

const { productFigures, shippedPerProduct, SALES_WINDOW_DAYS } = await import('../../src/lib/v1/product-figures.ts');
const { db } = await import('../../src/lib/db.ts');
const probe = new PrismaClient({ datasourceUrl: url, log: [{ emit: 'stdout', level: 'error' }] });

const mismatches = [];
function check(what, ok, detail = '') {
  if (ok) console.log(`${args.assert ? 'ASSERT OK    ' : 'ok           '}${what}`);
  else {
    console.log(`${args.assert ? 'ASSERT FAIL  ' : 'DIFFERENT    '}${what}${detail ? ` — ${detail}` : ''}`);
    mismatches.push(what);
  }
}

const DAY = 86_400_000;
const now = new Date();
const daysAgo = (d) => new Date(now.getTime() - d * DAY);

let store = null;
let other = null;
let product = null;
let product2 = null;
let exit = 0;

try {
  const company = await probe.company.findFirst({ where: { name: COMPANY_ON } });
  if (!company) throw new Error(`ما لقيت الشركة "${COMPANY_ON}" — شغّل seed.mjs أول.`);
  const country = await probe.country.findFirst({ where: { companyId: company.id, code: 'SY' } });
  const region = await probe.region.findFirst({ where: { countryId: country.id } });

  // `productFigures` reads through the repo's `db`, so this harness writes through the same connection and CLEANS UP at the end (orders first), like `landing-ad-tags.mjs`.
  const stamp = String(Date.now()).slice(-6);
  store = await probe.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-ST-${stamp}`, slug: `kit-st-${stamp}` } });
  other = await probe.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-ST2-${stamp}`, slug: `kit-st2-${stamp}` } });
  product = await probe.product.create({ data: { companyId: company.id, storeId: store.id, name: 'منتج المخزون', sku: `KIT-ST-${stamp}`, basePrice: 20, status: 'ACTIVE' } });
  product2 = await probe.product.create({ data: { companyId: company.id, storeId: store.id, name: 'منتج بلا مخزون', sku: `KIT-ST2-${stamp}`, basePrice: 20, status: 'ACTIVE' } });
  await probe.productionBatch.create({
    data: { companyId: company.id, storeId: store.id, productId: product.id, batchNumber: `KIT-B-${stamp}`, quantityProduced: 240, quantityRemaining: 240, costPerUnit: 3.25, productionDate: daysAgo(40) },
  });

  let n = 0;
  async function ship({ storeId = store.id, productId = product.id, quantity, free = 0, shippedAt, shipped = true }) {
    n += 1;
    const cust = await probe.customer.create({ data: { companyId: company.id, storeId, fullName: `زبون المخزون ${n}`, phone: `93${n}${stamp}`, rawPhone: `93${n}${stamp}`, address: 'عنوان', city: region.name, country: 'SY', totalOrders: 1 } });
    const number = `KIT-ST-${stamp}-${n}`;
    const order = await probe.order.create({
      data: {
        companyId: company.id, countryId: country.id, storeId, orderNumber: number, merchantRef: number, regionId: region.id, customerId: cust.id, productId, quantity, sellingPrice: 20,
        shippingCost: 0, totalAmount: 20, currency: country.currencyCode, estimatedCostOfGoods: 7, source: 'Manual', status: 'CONFIRMED', confirmationStatus: 'CONFIRMED',
        shippingStatus: shipped ? 'SHIPPED' : 'NOT_READY', shippedAt: shipped ? shippedAt : null,
      },
    });
    await probe.orderItem.create({ data: { companyId: company.id, orderId: order.id, productId, productName: 'منتج المخزون', quantity, freeQuantity: free, unitPrice: 20, lineTotal: 20 * quantity } });
    return order;
  }

  // 210 units shipped inside the window: 100 + 100 + gift 5 + gift 5
  await ship({ quantity: 100, free: 5, shippedAt: daysAgo(1) });
  await ship({ quantity: 100, free: 5, shippedAt: daysAgo(6.5) });
  // not counted: shipped 8 days ago · never shipped · another store's order of the same product id? (a product belongs to one store, so another store's shipment of ANOTHER product)
  await ship({ quantity: 999, shippedAt: daysAgo(8) });
  await ship({ quantity: 888, shipped: false });
  const otherProduct = await probe.product.create({ data: { companyId: company.id, storeId: other.id, name: 'منتج متجر تاني', sku: `KIT-ST3-${stamp}`, basePrice: 20, status: 'ACTIVE' } });
  await ship({ storeId: other.id, productId: otherProduct.id, quantity: 777, shippedAt: daysAgo(1) });

  const figures = async (wanted, products) =>
    productFigures(company.id, products, new Set(wanted), now);
  const mine = { id: product.id, storeId: store.id, currency: 'USD', minorUnit: 2 };
  const none = { id: product2.id, storeId: store.id, currency: 'USD', minorUnit: 2 };

  const shipped = await shippedPerProduct(company.id, store.id, daysAgo(SALES_WINDOW_DAYS));
  check('الوحدات المشحونة آخر 7 أيام: 210 (الأساسي + الهدايا)، وما انحسب شحن عمرو 8 أيام ولا طلب ما انشحن ولا متجر تاني', shipped.get(product.id) === 210 && !shipped.has(otherProduct.id), JSON.stringify([...shipped]));

  const got = await figures(['stock_units', 'daily_sales_7d', 'stock_days'], [mine, none]);
  const a = got.get(product.id);
  check('240 على الرف و210 مشحونة: 30.00 باليوم و8 أيام تكفي', a?.stock_units === 240 && a?.daily_sales_7d === '30.00' && a?.stock_days === 8, JSON.stringify(a));
  const b = got.get(product2.id);
  check('منتج بلا ولا دفعة: ما في عدّ مخزون (null مش 0)، وما في مبيعات: 0.00، والتغطية null', b?.stock_units === null && b?.daily_sales_7d === '0.00' && b?.stock_days === null, JSON.stringify(b));

  const only = await figures(['stock_units'], [mine]);
  check('بدون الحقول التانية ما بيرجع غير اللي انطلب', Object.keys(only.get(product.id) ?? {}).join() === 'stock_units');
} catch (e) {
  console.error(`\nوقف الفحص بخطأ قاعدة/Prisma: ${e instanceof Error ? e.stack || e.message : e}`);
  exit = 2;
} finally {
  const ids = [store?.id, other?.id].filter(Boolean);
  if (ids.length) {
    try {
      await probe.order.deleteMany({ where: { storeId: { in: ids } } });
      await probe.customer.deleteMany({ where: { storeId: { in: ids } } });
      await probe.productionBatch.deleteMany({ where: { storeId: { in: ids } } });
      await probe.product.deleteMany({ where: { storeId: { in: ids } } });
      await probe.store.deleteMany({ where: { id: { in: ids } } });
      console.log('\nانمسح كل اللي كتبو الفحص (المتجران المعزولان، المنتجات، الدفعة، الزباين، الطلبات).');
    } catch (e) {
      console.error(`\nما قدرت أمسح بقايا الفحص (القاعدة تجريبية): ${e instanceof Error ? e.message : e}`);
    }
  }
  await probe.$disconnect();
  await db.$disconnect?.();
}

if (exit) process.exit(exit);
if (args.assert && mismatches.length) {
  console.error(`\nفرق (${mismatches.length}): ${mismatches.join(' | ')}`);
  process.exit(3);
}
process.exit(0);
