/**
 * THE SCORECARD HARNESS — asks the repo's REAL `readScorecard` and `readMeasure` (`src/lib/agent-scorecard.ts`, `src/lib/no-answer-measure.ts`), on the REAL Prisma client against the
 * scratch PostgreSQL, for the figures of one agent over rows with known dates. The unit tests tally in memory; this runs the reads — the relation filter `order: { storeId }` on the claim
 * history and the status log, the attempts read with its `OR`, the upsell lines, the delivery rows — against real tables.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, DATABASE_URL set before `db.ts` is imported).
 *   2. Imports the repo's own TypeScript under the tsx command (it relaunches itself under it): no copy of any rule lives here.
 *   3. Everything it writes (an isolated STORE of the «KIT ON» company, its orders, claim lines, status lines, attempts) is written in ONE transaction that is ROLLED BACK; the
 *      isolated store means no seeded desk can move a figure, and another store's activity must not appear in it (checked).
 *   4. The cases (one agent, one local day in the store's timezone): claims (a repeat of one order = one) · confirmed and rejected on unique orders · the confirmation rate ·
 *      attempts (the press and a message left out) · the first attempt after the claim · a quick release · the upsell · the delivery of mature confirmations only · and the
 *      measurement report's pairing of a «لا يرد» with the press before it.
 *   5. Exit code 0 when it ran to the end (and, with `--assert`, every case matched), 2 when a database/Prisma error stopped it, 3 when `--assert` found a mismatch.
 *
 *   node scripts/verify-on-postgres/scorecard.mjs [--assert]
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

const { readScorecard } = await import('../../src/lib/agent-scorecard.ts');
const { readMeasure } = await import('../../src/lib/no-answer-measure.ts');

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
// noon UTC of "yesterday" and of "ten days ago": inside one local day of any timezone the kit uses, and far from midnight
const noon = (daysAgo) => {
  const d = new Date(now.getTime() - daysAgo * DAY);
  d.setUTCHours(12, 0, 0, 0);
  return d;
};
const at = (base, minutes) => new Date(base.getTime() + minutes * MIN);

try {
  const company = await probe.company.findFirst({ where: { name: COMPANY_ON } });
  if (!company) throw new Error(`ما لقيت الشركة "${COMPANY_ON}" — شغّل seed.mjs أول.`);
  const country = await probe.country.findFirst({ where: { companyId: company.id, code: 'SY' } });
  const region = await probe.region.findFirst({ where: { countryId: country.id } });
  const agent = await probe.user.findFirst({ where: { companyId: company.id } });
  if (!agent) throw new Error('ما لقيت مستخدم بالشركة التجريبية.');
  const calendar = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [], timezone: 'UTC' };

  await probe
    .$transaction(
      async (tx) => {
        const stamp = String(Date.now()).slice(-6);
        const store = await tx.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-SC-${stamp}`, slug: `kit-sc-${stamp}` } });
        const other = await tx.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-SC2-${stamp}`, slug: `kit-sc2-${stamp}` } });
        const product = await tx.product.create({ data: { companyId: company.id, storeId: store.id, name: 'منتج البطاقة', sku: `KIT-SC-${stamp}`, basePrice: 20, status: 'ACTIVE' } });
        const otherProduct = await tx.product.create({ data: { companyId: company.id, storeId: other.id, name: 'منتج تاني', sku: `KIT-SC2-${stamp}`, basePrice: 20, status: 'ACTIVE' } });

        let n = 0;
        async function order(key, st, prod, extra = {}) {
          n += 1;
          const cust = await tx.customer.create({
            data: { companyId: company.id, storeId: st.id, fullName: `زبون البطاقة ${n}`, phone: `96${stamp}${n}`, rawPhone: `096${stamp}${n}`, address: 'عنوان', city: region.name, country: 'SY', totalOrders: 1 },
          });
          const number = `KIT-SC-${stamp}-${key}`;
          const o = await tx.order.create({
            data: {
              companyId: company.id, countryId: country.id, storeId: st.id, orderNumber: number, merchantRef: number, regionId: region.id, customerId: cust.id, productId: prod.id,
              quantity: 1, sellingPrice: 20, shippingCost: 0, totalAmount: 20, currency: country.currencyCode, estimatedCostOfGoods: 7, source: 'Manual',
              status: 'NEW', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', ...extra,
            },
          });
          await tx.orderItem.create({ data: { companyId: company.id, orderId: o.id, productId: prod.id, productName: prod.name, quantity: 1, unitPrice: 20, lineTotal: 20, addedStage: 'INTAKE' } });
          return o;
        }
        const claim = (o, when, action = 'CLAIMED') => tx.orderClaimHistory.create({ data: { companyId: company.id, orderId: o.id, userId: agent.id, action, reason: action === 'CLAIMED' ? 'PULL_NEXT' : 'NO_ANSWER_RETURNED', createdAt: when } });
        const decide = (o, value, when) =>
          tx.orderStatusLog.create({ data: { companyId: company.id, orderId: o.id, statusType: 'CONFIRMATION', newValue: value, changedById: agent.id, changedByRole: 'CONFIRMATION_AGENT', createdAt: when } });
        let seq = {};
        const attempt = (o, result, when) => {
          seq[o.id] = (seq[o.id] ?? 0) + 1;
          return tx.orderContactAttempt.create({
            data: { companyId: company.id, orderId: o.id, employeeId: agent.id, employeeRole: 'CONFIRMATION_AGENT', attemptNumber: seq[o.id], contactMethod: 'PHONE', result, createdAt: when },
          });
        };

        const day = noon(1);
        const oldDay = noon(10);

        // yesterday: A confirmed (with an upsell line by her), B confirmed then rejected, C rejected, D no-answer released in 30 s; A is claimed twice
        const A = await order('A', store, product, { confirmedById: agent.id, confirmedAt: at(day, 20) });
        const B = await order('B', store, product);
        const C = await order('C', store, product);
        const D = await order('D', store, product);
        for (const o of [A, B, C, D]) await claim(o, at(day, 0));
        await claim(A, at(day, 5)); // a second claim of A the same day: still one
        await tx.orderItem.create({ data: { companyId: company.id, orderId: A.id, productId: product.id, productName: product.name, quantity: 1, unitPrice: 20, lineTotal: 20, addedById: agent.id, addedStage: 'CONFIRMATION' } });
        await attempt(A, 'OPENED', at(day, 2));
        await attempt(A, 'ANSWERED', at(day, 3));
        await attempt(D, 'OPENED', at(day, 1));
        await attempt(D, 'NO_ANSWER', at(day, 1.25)); // 15 s after the press
        await attempt(D, 'MESSAGE_SENT', at(day, 1.5));
        await claim(D, at(day, 0.5), 'RELEASED'); // released 30 s after the claim
        await decide(A, 'CONFIRMED', at(day, 20));
        await decide(B, 'CONFIRMED', at(day, 25));
        await decide(B, 'REJECTED', at(day, 30));
        await decide(C, 'REJECTED', at(day, 35));
        // another store's activity must not appear
        const X = await order('X', other, otherProduct);
        await claim(X, at(day, 0));
        await decide(X, 'CONFIRMED', at(day, 10));

        // ten days ago: four confirmations — three delivered, one returned — and a fresh one (yesterday's A is too young for the delivery rate)
        for (const [key, ship] of [['M1', 'DELIVERED'], ['M2', 'DELIVERED'], ['M3', 'DELIVERED'], ['M4', 'RETURNED'], ['M5', 'OUT_FOR_DELIVERY']]) {
          await order(key, store, product, { confirmedById: agent.id, confirmedAt: at(oldDay, 10), confirmationStatus: 'CONFIRMED', shippingStatus: ship });
        }

        const card = await readScorecard(tx, { companyId: company.id, storeId: store.id, start: new Date(now.getTime() - 12 * DAY), end: now, calendar, grain: 'day' }, now);
        const dayKey = day.toISOString().slice(0, 10);
        const oldKey = oldDay.toISOString().slice(0, 10);
        const y = card.rows.find((r) => r.bucket === dayKey && r.userId === agent.id);
        const o = card.rows.find((r) => r.bucket === oldKey && r.userId === agent.id);

        check('البطاقة: سطر الأمس للموظفة موجود، وما في سطر للمتجر التاني', !!y && card.rows.every((r) => r.userId === agent.id), JSON.stringify(card.rows.map((r) => r.bucket)));
        check('البطاقة: السحب = 4 طلبات مختلفة (A انسحب مرتين = مرة)', y?.claims === 4, `claims=${y?.claims}`);
        check('البطاقة: أكّدت 1 ورفضت 2 (B أُكّد ثم رُفض = مرفوض)', y?.confirmed === 1 && y?.rejected === 2, `c=${y?.confirmed} r=${y?.rejected}`);
        check('البطاقة: نسبة التأكيد 1 ÷ 3 = 33%', y?.confirmationRate.rate === 33 && y?.confirmationRate.base === 3, JSON.stringify(y?.confirmationRate));
        check('البطاقة: المحاولات المسجّلة = 2 (الضغطة والرسالة برّا)', y?.attempts === 2, `attempts=${y?.attempts}`);
        check('البطاقة: رجّعت بأقل من دقيقة = 1 من 4', y?.quickNoAnswer.of === 1 && y?.quickNoAnswer.base === 4, JSON.stringify(y?.quickNoAnswer));
        check('البطاقة: زيادة منتج = 1 من 1 مؤكَّد', y?.upsell.of === 1 && y?.upsell.base === 1, JSON.stringify(y?.upsell));
        check('البطاقة: وسيط أول اتصال مقيس (طلبين عليهم سطر)', y?.firstAttempts === 2 && y?.medianFirstAttemptMinutes !== null, `n=${y?.firstAttempts} m=${y?.medianFirstAttemptMinutes}`);
        check('البطاقة: التسليم من التأكيدات الناضجة = 3 مسلَّم و1 مرتجع (75%)، والطلب بالطريق برّا', o?.delivery.delivered === 3 && o?.delivery.returned === 1 && o?.delivery.rate === 75, JSON.stringify(o?.delivery));
        check('البطاقة: تأكيد الأمس (أصغر من 7 أيام) ما دخل التسليم', (y?.delivery.base ?? 0) === 0, JSON.stringify(y?.delivery));

        const measure = await readMeasure(tx, { companyId: company.id, storeId: store.id, start: new Date(now.getTime() - 12 * DAY), end: now, timezone: 'UTC' });
        const m = measure.rows.find((r) => r.day === dayKey && r.userId === agent.id);
        check('القياس: ضغطتين اتصل ولا يرد وحدة مربوطة بضغطتها', m?.opened === 2 && m?.noAnswer === 1 && m?.withPress === 1 && m?.withoutPress === 0, JSON.stringify(m));
        check('القياس: رنّت 15 ثانية = أقل من 30 ثانية (100%)', m?.under.find((u) => u.seconds === 30)?.count === 1 && m?.under.find((u) => u.seconds === 30)?.rate === 100, JSON.stringify(m?.under));

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
