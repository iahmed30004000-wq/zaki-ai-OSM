/**
 * Writes the verification SCENARIO (`scenario.mjs`) into the scratch database, through the real Prisma schema.
 *
 * WHY NOT `prisma/seed.ts`: it was read and it fits badly — it deletes every business table, builds ONE company with ONE country and two
 * orders, and has no «لا يرد» history at all; and `the-seed-never-runs-on-production.test.ts` pins its production guard, which this kit
 * must not touch. So the kit writes its own scenario, guarded the opposite way: it refuses anything that is not a local `scratch_` database.
 *
 * DEFINITION OF DONE:
 *   1. Refuses (before connecting) unless the URL is localhost/127.0.0.1 and the database starts with `scratch_` (`assertScratchUrl`).
 *   2. Creates: two companies (the switch ON with `enabledAt` three days back / OFF), two countries for the ON company (Syria-like: Asia/Damascus,
 *      `weekendDays` [], 10:00-22:00; Jordan-like: Asia/Amman, [5,6], 09:00-17:00) and one Syria-like for the OFF one, a store per country,
 *      regions, a courier with fees, one product per store, an admin and confirmation agents, and the scenario orders with their «لا يرد» lines.
 *   3. Re-runnable: it first removes the kit's own companies (name starts with `KIT `) and their users, then writes again with fresh times.
 *   4. The password of the test accounts is `KIT_PASSWORD` if the caller chose one, else generated here, and PRINTED ONCE on the console.
 *      It is written to no file.
 *   Offers are not created (`an-offer-price-has-one-door.test.ts` names every script that writes one, and this is not meant to be one).
 *
 *   node scripts/verify-on-postgres/seed.mjs
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as prismaPackage from '@prisma/client';
import { assertScratchUrl, scratchUrl } from './lib.mjs';
import { COMPANY_OFF, COMPANY_ON, COUNTRIES, USERS, buildScenario, enabledAtOf } from './scenario.mjs';

const PrismaClient = prismaPackage.PrismaClient ?? prismaPackage.default.PrismaClient;

// The gate, before a client exists. The URL is built here from the container — never read from the environment or from a file.
const url = scratchUrl();
assertScratchUrl(url);
const prisma = new PrismaClient({ datasourceUrl: url, log: ['error'] });

const KIT_PREFIX = 'KIT ';
const now = new Date();

async function reset() {
  const companies = await prisma.company.findMany({ where: { name: { startsWith: KIT_PREFIX } }, select: { id: true } });
  if (companies.length === 0) return 0;
  const companyIds = companies.map((c) => c.id);
  // Children of the orders cascade; the RESTRICT edges (an order → its store/country/region/customer, an item → its product, a log → its user)
  // need the explicit order below.
  await prisma.order.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.customer.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.product.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.deliveryFee.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.deliveryProvider.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.store.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.region.deleteMany({ where: { country: { companyId: { in: companyIds } } } });
  await prisma.country.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.user.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
  return companies.length;
}

async function main() {
  const removed = await reset();
  if (removed) console.log(`[seed] انحذف ${removed} شركة KIT قديمة وكل ما تحتها.`);

  const generated = !process.env.KIT_PASSWORD;
  const password = process.env.KIT_PASSWORD || randomBytes(12).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);

  const enabledAt = enabledAtOf(now);
  const settings = {
    on: JSON.stringify({ currencySymbol: '$', callProofAndCadence: { enabled: true, enabledAt: enabledAt.toISOString() } }),
    off: JSON.stringify({ currencySymbol: '$', callProofAndCadence: { enabled: false, enabledAt: null } }),
  };

  const companies = {
    on: await prisma.company.create({ data: { name: COMPANY_ON, currency: 'USD', country: 'سوريا', settings: settings.on } }),
    off: await prisma.company.create({ data: { name: COMPANY_OFF, currency: 'USD', country: 'سوريا', settings: settings.off } }),
  };

  // Countries, regions, stores, a courier with a fee per region — the chain a confirmed order needs later (a shipment is blocked without a fee).
  const plan = [
    { company: 'on', code: 'SY' },
    { company: 'on', code: 'JO' },
    { company: 'off', code: 'SY' },
  ];
  const places = {}; // `${company}-${code}` → { country, store, regions, product }
  for (const { company, code } of plan) {
    const spec = COUNTRIES[code];
    const co = companies[company];
    const country = await prisma.country.create({
      data: {
        companyId: co.id, code: spec.code, name: spec.name, currencyCode: spec.currencyCode, minorUnit: spec.minorUnit,
        weekendDays: spec.weekendDays, timezone: spec.timezone, workHoursStart: spec.workHoursStart, workHoursEnd: spec.workHoursEnd,
        orderPrefix: spec.orderPrefix,
      },
    });
    const store = await prisma.store.create({ data: { companyId: co.id, countryId: country.id, name: `KIT ${spec.name} (${company.toUpperCase()})`, slug: `kit-${code.toLowerCase()}` } });
    await prisma.region.createMany({ data: spec.regions.map((name, i) => ({ countryId: country.id, name, sortOrder: i })) });
    const regions = await prisma.region.findMany({ where: { countryId: country.id }, orderBy: { sortOrder: 'asc' } });
    const courier = await prisma.deliveryProvider.create({ data: { companyId: co.id, storeId: store.id, name: `مندوب KIT ${spec.name}`, code: `KIT-${code}-${company.toUpperCase()}`, phone: '0000000000' } });
    await prisma.deliveryFee.createMany({
      data: regions.map((r) => ({ companyId: co.id, countryId: country.id, deliveryProviderId: courier.id, regionId: r.id, fee: 2.5, lateThresholdDays: 3, returnFee: 1 })),
    });
    const product = await prisma.product.create({
      data: { companyId: co.id, storeId: store.id, name: `منتج تجريبي ${spec.name}`, sku: `KIT-${company.toUpperCase()}-${code}-1`, basePrice: 20, status: 'ACTIVE' },
    });
    places[`${company}-${code}`] = { country, store, regions, product };
  }

  // Users — an admin per company and the confirmation agents; each enters only the countries listed.
  const users = {};
  for (const [key, u] of Object.entries(USERS)) {
    const user = await prisma.user.create({
      data: { companyId: companies[u.company].id, email: u.email, name: u.name, passwordHash, role: u.role, status: 'ACTIVE' },
    });
    users[key] = user;
    for (const code of u.countries) {
      await prisma.userCountryAccess.create({ data: { userId: user.id, countryId: places[`${u.company}-${code}`].country.id } });
    }
  }

  // The scenario orders.
  const scenario = buildScenario(now);
  let phoneSeq = 0;
  const written = [];
  for (const o of scenario) {
    const place = places[`${o.company}-${o.country}`];
    const co = companies[o.company];
    const spec = COUNTRIES[o.country];
    phoneSeq += 1;
    const phone = `${o.country === 'SY' ? '09' : '07'}000${String(phoneSeq).padStart(5, '0')}`;
    const customer = await prisma.customer.create({
      data: {
        companyId: co.id, storeId: place.store.id, fullName: `زبون تجريبي ${o.key}`, phone, rawPhone: phone,
        address: 'عنوان تجريبي', city: place.regions[phoneSeq % place.regions.length].name, country: o.country,
        totalOrders: 1,
      },
    });
    const holder = o.heldBy ? users[o.heldBy] : null;
    const order = await prisma.order.create({
      data: {
        companyId: co.id, countryId: place.country.id, storeId: place.store.id,
        orderNumber: o.key, merchantRef: o.key, regionId: place.regions[phoneSeq % place.regions.length].id,
        customerId: customer.id, productId: place.product.id,
        quantity: 1, sellingPrice: 20, shippingCost: 0, totalAmount: 20, currency: spec.currencyCode, estimatedCostOfGoods: 7,
        status: o.status, confirmationStatus: o.status, shippingStatus: 'NOT_READY',
        source: 'Manual',
        createdAt: o.createdAt,
        ...(o.postponedUntil ? { postponedUntil: o.postponedUntil, postponeCount: 1 } : {}),
        ...(o.nextFollowUpAt !== undefined ? { nextFollowUpAt: o.nextFollowUpAt } : {}),
        ...(o.followUpReason ? { followUpReason: o.followUpReason, followUpStatus: 'SCHEDULED' } : {}),
        ...(o.status === 'NO_ANSWER' ? { followUpReason: 'NO_ANSWER', followUpStatus: 'SCHEDULED' } : {}),
        ...(holder ? { claimedById: holder.id, currentOwnerId: holder.id, claimedAt: o.claimedAt } : {}),
        ...(o.closedToday ? { rejectionReason: o.closedToday, rejectionNote: `إغلاق تلقائي بعد ${o.closedToday.includes('5') ? 5 : 3} محاولات بلا رد` } : {}),
      },
    });
    await prisma.orderItem.create({
      data: { companyId: co.id, orderId: order.id, productId: place.product.id, productName: place.product.name, quantity: 1, unitPrice: 20, lineTotal: 20, addedStage: 'INTAKE' },
    });
    // The lines are written oldest first with a fixed attemptNumber, `createdAt` and stored due — exactly what the contact door writes.
    const caller = holder ?? (o.company === 'on' ? users[o.country === 'JO' ? 'agent2On' : 'agent1On'] : users.agentOff);
    for (const l of o.lines) {
      await prisma.orderContactAttempt.create({
        data: {
          companyId: co.id, orderId: order.id, employeeId: caller.id, employeeRole: caller.role, attemptNumber: l.n,
          contactMethod: 'PHONE', result: l.result, createdAt: l.createdAt, nextFollowUpAt: l.due, ...(l.result === 'NO_ANSWER' && o.company === 'on' ? { durationSeconds: 45 } : {}),
        },
      });
    }
    if (holder) {
      await prisma.orderClaimHistory.create({ data: { companyId: co.id, orderId: order.id, userId: holder.id, action: 'CLAIMED', reason: 'PULL_NEXT', metadata: JSON.stringify({ role: holder.role }), createdAt: o.claimedAt } });
      await prisma.orderStatusLog.create({ data: { companyId: co.id, orderId: order.id, statusType: 'CONFIRMATION', previousValue: null, newValue: 'IN_PROGRESS', changedById: holder.id, changedByRole: holder.role, note: 'سحب من الطابور', createdAt: o.claimedAt } });
    }
    if (o.closedToday) {
      await prisma.orderStatusLog.create({
        data: {
          companyId: co.id, orderId: order.id, statusType: 'CONFIRMATION', previousValue: 'IN_PROGRESS', newValue: 'CANCELLED', changedById: holder.id, changedByRole: holder.role,
          note: `AUTO_CLOSE_${o.closedToday}`, createdAt: new Date(now.getTime() - 5 * 60_000),
        },
      });
    }
    written.push({ key: o.key, where: `${o.company.toUpperCase()}/${o.country}`, state: o.pool ? 'pool' : o.heldBy ? `بيد ${o.heldBy}` : '-', status: o.status, expect: o.expect });
  }

  console.log(`\n[seed] جاهز — الوقت المرجعي ${now.toISOString()} (كل المواعيد نسبية إله؛ أعد التشغيل قبل أي فحص بعد ساعات)`);
  console.log(`[seed] المفتاح: ${COMPANY_ON.split(' —')[0]} شغّال منذ ${enabledAt.toISOString()} · ${COMPANY_OFF.split(' —')[0]} مطفي`);
  console.table(written);

  console.log('\n[seed] الحسابات (كلمة السر وحدة للكل):');
  for (const u of Object.values(USERS)) console.log(`   ${u.email.padEnd(26)} ${u.role.padEnd(20)} ${u.company.toUpperCase()} ${u.countries.join('+')}`);
  if (generated) {
    console.log(`\n[seed] كلمة السر (انتولدت هلّق، بتنطبع هالمرة بس ومحفوظة بلا أي ملف):\n\n    ${password}\n`);
    console.log('[seed] للأوامر اللي بتسجّل دخول: KIT_PASSWORD=<الكلمة فوق> (PowerShell: $env:KIT_PASSWORD = "...")');
  } else {
    console.log('[seed] كلمة السر هي KIT_PASSWORD اللي انت حطيتها.');
  }
}

main()
  .catch((e) => {
    console.error('[seed] فشل:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
