/**
 * THE QUEUE-PRIORITY HARNESS — asks the repo's REAL `readBacklogShare` and REAL `pickNextCandidate` (the v2 branch, `src/lib/confirmation-queue.ts` + `queue-priority-share.ts`), on the
 * REAL Prisma client against the scratch PostgreSQL. The unit tests' in-memory database never ran the share's three counts (`distinct`, and `some` beside `none` on the attempt lines)
 * nor the v2 pick's filters on real tables; this does.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, DATABASE_URL set before `db.ts` is imported).
 *   2. Imports the repo's own TypeScript under the tsx command (it relaunches itself under it): no copy of any rule lives here.
 *   3. Everything it writes (an isolated STORE of the «KIT ON» company with its own orders and attempt lines) is written in ONE transaction that is ROLLED BACK — the scratch
 *      database is left as it was, and the isolated store means the seeded desks cannot move a count or a pick.
 *   4. Part 1 — the SHARE: the three counts of the isolated store, from rows with known dates (already backlog before the window, a non-«لا يرد» line, a closed order, an order
 *      with no line, a repeat customer) — and the share they give.
 *   5. Part 2 — the PICK: the same pool dealt by `pickNextCandidate` with a plan in each of its states — fresh first, an aged retry, the backlog's turn, not its turn,
 *      the two time-of-day modes (new first, oldest first) — and the key off (no plan: the old order).
 *   5b. Part 3 (request Q5a, 21/11) — «هالطلبات أول»: two owner's PRIORITY rules (a product; a channel's kind, new orders only) turned into filters by the REAL
 *      `priorityBoostOf` and dealt on real tables: with no rule the order is main's, with the rules the boosted come first INSIDE each tier and no tier moves.
 *   5c. Part 4 (request Q5b, 21/11) — «هالطلبات بس لهالموظفات»: a ROUTING rule of a product turned into the puller's filter by the REAL `routingWhereFor` and dealt
 *      on real tables (a line of the product, the header product of an order with no lines, a header of it whose line is another): kept from her while somebody
 *      named can pull, hers too once nobody can and the order is past the rule's wait, all hers when she is named — and the board's «طلبات بلا موظفة» count.
 *   6. Exit code 0 when it ran to the end (and, with `--assert`, every case matched), 2 when a database/Prisma error stopped it, 3 when `--assert` found a mismatch.
 *
 *   node scripts/verify-on-postgres/queue-priority.mjs [--assert]
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

const queue = await import('../../src/lib/confirmation-queue.ts');
const { readBacklogShare, SHARE_CACHE_MS } = await import('../../src/lib/queue-priority-share.ts');
const { returnsMode } = await import('../../src/lib/no-answer-returns.ts');
const { workClock } = await import('../../src/lib/no-answer-rounds.ts');

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
        // An isolated desk: its own store, product and orders — the seeded ones are in other stores and cannot move a count or a pick.
        const store = await tx.store.create({ data: { companyId: company.id, countryId: country.id, name: `KIT-QP-${stamp}`, slug: `kit-qp-${stamp}` } });
        const product = await tx.product.create({
          data: { companyId: company.id, storeId: store.id, name: 'منتج الأولوية', sku: `KIT-QP-${stamp}`, basePrice: 20, status: 'ACTIVE' },
        });
        const scope = { companyId: company.id, storeId: store.id };

        let n = 0;
        async function customer() {
          n += 1;
          return tx.customer.create({
            data: { companyId: company.id, storeId: store.id, fullName: `زبون الأولوية ${n}`, phone: `95${stamp}${n}`, rawPhone: `095${stamp}${n}`, address: 'عنوان', city: region.name, country: 'SY', totalOrders: 1 },
          });
        }
        /** An order of the isolated store: `age` old, with `lines` (each `{ result, ago, due }`), in `status`. */
        async function order(key, age, { cust, lines = [], status = 'NEW' } = {}) {
          const c = cust ?? (await customer());
          const number = `KIT-QP-${stamp}-${key}`;
          const o = await tx.order.create({
            data: {
              companyId: company.id, countryId: country.id, storeId: store.id, orderNumber: number, merchantRef: number, regionId: region.id,
              customerId: c.id, productId: product.id, quantity: 1, sellingPrice: 20, shippingCost: 0, totalAmount: 20, currency: country.currencyCode,
              estimatedCostOfGoods: 7, status, confirmationStatus: status, shippingStatus: 'NOT_READY', source: 'Manual', createdAt: ago(age),
            },
          });
          await tx.orderItem.create({
            data: { companyId: company.id, orderId: o.id, productId: product.id, productName: product.name, quantity: 1, unitPrice: 20, lineTotal: 20, addedStage: 'INTAKE' },
          });
          let i = 0;
          for (const l of lines) {
            i += 1;
            await tx.orderContactAttempt.create({
              data: {
                companyId: company.id, orderId: o.id, employeeId: agent.id, employeeRole: 'CONFIRMATION_AGENT', attemptNumber: i, contactMethod: 'PHONE',
                result: l.result ?? 'NO_ANSWER', nextFollowUpAt: l.due === undefined ? null : new Date(now.getTime() + l.due), createdAt: ago(l.ago),
              },
            });
          }
          return { id: o.id, number };
        }

        // ── Part 1: the share, as the DELTA of the three counts the rows below add (the clock is moved past the cache each read) ──
        const read = async (k) => (await readBacklogShare(tx, scope, new Date(now.getTime() + k * (SHARE_CACHE_MS + MIN)), queue.OPEN_CONFIRMATION)).inputs;
        const before = await read(1);
        check('الحصة: متجر معزول فاضي = صفر بكل عدّاد', before.newUnique === 0 && before.backlogEntered === 0 && before.staleStock === 0, JSON.stringify(before));

        const sameCustomer = await customer();
        await order('S-C1A', 3 * HOUR, { cust: sameCustomer });
        await order('S-C1B', 2 * HOUR, { cust: sameCustomer }); // the same person twice: one customer
        await order('S-C2', 1 * HOUR);
        const entered = await order('S-ENTERED', 5 * DAY, { lines: [{ ago: 2 * DAY, due: -HOUR }] }); // first «لا يرد» line 2 days ago: entered the backlog in the window; open + old: stock
        await order('S-OLDBACKLOG', 12 * DAY, { lines: [{ ago: 10 * DAY, due: -HOUR }, { ago: 1 * DAY, due: -HOUR }] }); // backlog since before the window: not «entered»; older than the window: not a customer; but stock
        await order('S-ANSWERED', 36 * HOUR, { lines: [{ result: 'ANSWERED', ago: 1 * DAY }] }); // not a «لا يرد» line; younger than 48 h: not stock
        await order('S-CLOSED', 3 * DAY, { status: 'CONFIRMED', lines: [{ ago: 2 * DAY, due: -HOUR }] }); // counts as «entered» (a line in the window) but is not open: not stock
        await order('S-NOLINE', 3 * DAY); // old, open, never rung: not backlog, not stock
        const after = await read(2);
        const delta = { newUnique: after.newUnique - before.newUnique, backlogEntered: after.backlogEntered - before.backlogEntered, staleStock: after.staleStock - before.staleStock };
        check('الحصة: زبائن فريدين = 6 (الزبون المكرر مرة وحدة، والطلب أقدم من 7 أيام برّا)', delta.newUnique === 6, JSON.stringify(delta));
        check('الحصة: صار متأخر بالنافذة = 2 (أول «لا يرد» بالنافذة؛ اللي كان متأخر قبلها ما بينعدّ)', delta.backlogEntered === 2, JSON.stringify(delta));
        check('الحصة: مخزون أقدم من 48 ساعة = 2 (مفتوح وإله سطر؛ المسكّر والبلا سطر والأحدث برّا)', delta.staleStock === 2, JSON.stringify(delta));

        // ── Part 2: the pick, in the isolated desk ──
        const cal = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [], timezone: 'UTC' };
        const since = ago(30 * DAY);
        const returns = returnsMode(now, workClock(cal), queue.RETURNS_MODE.idleBusinessMinutes, since);
        const pickWith = (priority, withReturns = returns) => queue.pickNextCandidate(tx, scope, now, agent.id, { returns: withReturns, priority });
        const claim = (id) => tx.order.update({ where: { id }, data: { claimedById: agent.id, claimedAt: now, confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS' } });
        const numberOf = async (id) => (id ? (await tx.order.findUnique({ where: { id }, select: { orderNumber: true } })).orderNumber.replace(`KIT-QP-${stamp}-`, '') : null);

        // The shared desk: take the part-1 rows out of the way, then a clean pool of five.
        await tx.order.updateMany({ where: { storeId: store.id }, data: { claimedById: agent.id, claimedAt: now, confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS' } });
        const aged = await order('P-AGED', 40 * HOUR, { status: 'IN_PROGRESS', lines: [{ ago: 6 * HOUR, due: -3 * HOUR }] });
        const recentRetry = await order('P-RETRY', 30 * HOUR, { status: 'IN_PROGRESS', lines: [{ ago: 90 * MIN, due: -30 * MIN }] });
        const older = await order('P-OLDNEW', 3 * HOUR);
        const fresh = await order('P-FRESH', 5 * MIN);
        const plan = (over = {}) => ({ mode: 'NORMAL', backlogTurn: false, ...over });

        check('الترتيب: بلا خطة (المفتاح مطفي) = القديم: أقدم طلب جديد أول', (await numberOf(await pickWith(null))) === 'P-OLDNEW');
        check('الترتيب: الطلب الطازج (5 دقايق) أول', (await numberOf(await pickWith(plan()))) === 'P-FRESH');
        await claim(fresh.id);
        check('الترتيب: بعد الطازج، الإعادة المتأخرة أكتر من ساعتين تتقدّم على الجديد الأقدم', (await numberOf(await pickWith(plan()))) === 'P-AGED');
        await claim(aged.id);
        check('الترتيب: مش دور المتأخر = الجديد الأقدم (الإعادة اللي ما تأخرت ساعتين ما بتتقدّم)', (await numberOf(await pickWith(plan()))) === 'P-OLDNEW');
        check('الترتيب: دور المتأخر = الإعادة صاحبة الموعد الأقدم', (await numberOf(await pickWith(plan({ backlogTurn: true })))) === 'P-RETRY');
        check('الترتيب: وضع الصبح = القاعدة الأساس: الجديد أول (مش الإعادة) ولو دور المتأخر', (await numberOf(await pickWith(plan({ mode: 'NIGHT_FIRST', backlogTurn: true })))) === 'P-OLDNEW');
        await claim(older.id);
        check('الترتيب: ما ضل جديد ومش دور المتأخر = القاعدة ما إلها شي والقديم بيسحب الإعادة', (await numberOf(await pickWith(plan()))) === 'P-RETRY');
        await claim(recentRetry.id);
        check('الترتيب: الطابور فاضي = لا شي', (await pickWith(plan())) === null);

        // ── Part 3 (request Q5a, 21/11): «هالطلبات أول» — the owner's PRIORITY rules, through the REAL `priorityBoostOf`, on real tables (items, the channel's kind).
        // Two rules: a product (any phase) and a channel (new orders only). The same pool is dealt twice: with no rule (main's order) and with the two rules.
        const boostedProduct = await tx.product.create({
          data: { companyId: company.id, storeId: store.id, name: 'منتج الحملة', sku: `KIT-QP-B-${stamp}`, basePrice: 20, status: 'ACTIVE' },
        });
        const channel = await tx.orderChannel.create({ data: { companyId: company.id, name: `KIT-QP-CH-${stamp}`, kind: 'WHATSAPP' } });
        const { priorityBoostOf } = await import('../../src/lib/priority-rules.ts');
        const ruleRow = (id, over) => ({
          id, companyId: company.id, storeId: null, name: id, kind: 'PRIORITY', userIds: null, productId: null, channelKind: null, phase: null,
          hoursFrom: null, hoursTo: null, effectiveFrom: ago(DAY), effectiveTo: null, isActive: true, payload: { first: true }, createdAt: ago(DAY), ...over,
        });
        const boost = priorityBoostOf([ruleRow('kit-product', { productId: boostedProduct.id }), ruleRow('kit-channel', { channelKind: 'WHATSAPP', phase: 'NEW' })], {
          companyId: company.id, storeId: store.id, now, timezone: 'UTC',
        });
        check('الأولوية: القاعدتين بيعملوا فلتر (جديد · إعادة · مؤجّل)', !!(boost?.NEW && boost?.RETRY && boost?.ANY), JSON.stringify(boost));
        /** A Part-3 order: like `order`, its line on `prod`, and its channel when `ch`. */
        async function boostOrder(key, age, { prod = product, ch = null, lines = [], status = 'NEW' } = {}) {
          const o = await order(key, age, { lines, status });
          if (prod.id !== product.id) await tx.orderItem.updateMany({ where: { orderId: o.id }, data: { productId: prod.id, productName: prod.name } });
          if (ch) await tx.order.update({ where: { id: o.id }, data: { channelId: ch.id } });
          return o;
        }
        const pool = [
          await boostOrder('B-FRESH-PLAIN', 10 * MIN),
          await boostOrder('B-FRESH-BOOST', 5 * MIN, { prod: boostedProduct }),
          await boostOrder('B-NEW-PLAIN', 3 * HOUR),
          await boostOrder('B-NEW-BOOST', 2 * HOUR, { prod: boostedProduct }),
          await boostOrder('B-NEW-CHANNEL', 4 * HOUR, { ch: channel }),
          await boostOrder('B-AGED-PLAIN', 40 * HOUR, { status: 'IN_PROGRESS', lines: [{ ago: 8 * HOUR, due: -5 * HOUR }] }),
          await boostOrder('B-AGED-BOOST', 30 * HOUR, { prod: boostedProduct, status: 'IN_PROGRESS', lines: [{ ago: 6 * HOUR, due: -3 * HOUR }] }),
          await boostOrder('B-RETRY-BOOST', 20 * HOUR, { prod: boostedProduct, status: 'IN_PROGRESS', lines: [{ ago: 90 * MIN, due: -30 * MIN }] }),
        ];
        const unclaim = () => tx.order.updateMany({ where: { id: { in: pool.map((o) => o.id) } }, data: { claimedById: null, claimedAt: null, confirmationStatus: 'NEW', status: 'NEW' } });
        const restoreRetries = () =>
          tx.order.updateMany({ where: { id: { in: pool.map((o) => o.id) }, contactAttempts: { some: {} } }, data: { confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS' } });
        async function dealAll(p) {
          await unclaim();
          await restoreRetries();
          const out = [];
          for (let i = 0; i < 12; i++) {
            const id = await pickWith(p);
            if (!id) break;
            out.push(await numberOf(id));
            await claim(id);
          }
          return out.join(' → ');
        }
        const MAIN = 'B-FRESH-PLAIN → B-FRESH-BOOST → B-AGED-PLAIN → B-AGED-BOOST → B-NEW-CHANNEL → B-NEW-PLAIN → B-NEW-BOOST → B-RETRY-BOOST';
        const RULED = 'B-FRESH-BOOST → B-FRESH-PLAIN → B-AGED-BOOST → B-AGED-PLAIN → B-NEW-CHANNEL → B-NEW-BOOST → B-NEW-PLAIN → B-RETRY-BOOST';
        const plain = await dealAll(plan());
        check('الأولوية: بلا قاعدة = ترتيب main بالحرف', plain === MAIN, plain);
        const ruled = await dealAll(plan({ boost }));
        check('الأولوية: جوّا كل درجة المرفوع أول، والدرجات ما بتتبدّل (إعادة مرفوعة ما بتسبق جديد)', ruled === RULED, ruled);
        const turn = await dealAll(plan({ boost, backlogTurn: true }));
        check(
          'الأولوية: دور المتأخر = الإعادة المرفوعة أول بعد الطازج والمتأخرة',
          turn.startsWith('B-FRESH-BOOST → B-FRESH-PLAIN → B-AGED-BOOST → B-AGED-PLAIN → B-RETRY-BOOST'),
          turn
        );
        const night = await dealAll(plan({ boost, mode: 'NIGHT_FIRST' }));
        const nightMain = await dealAll(plan({ mode: 'NIGHT_FIRST' }));
        check('الأولوية: وضع الصبح ما بيتغيّر بالقاعدة', night === nightMain, `${night} | ${nightMain}`);

        // ── Part 4 (request Q5b, 21/11): «هالطلبات بس لهالموظفات» — a ROUTING rule of a product, through the REAL `routingWhereFor`, on real tables.
        // The roster is handed in (who can pull is `routing-staff.ts`'s, tested against the grants engine); here the SQL of the filter is what is proved.
        await tx.order.updateMany({ where: { storeId: store.id }, data: { claimedById: agent.id, claimedAt: now, confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS' } });
        const routedProduct = await tx.product.create({
          data: { companyId: company.id, storeId: store.id, name: 'منتج بموظفات', sku: `KIT-QP-R-${stamp}`, basePrice: 20, status: 'ACTIVE' },
        });
        const { routingRulesInForce, routingWhereFor, fallbackCut, unstaffedWhere } = await import('../../src/lib/routing-rules.ts');
        /** A Part-4 order: a new one, its header product and its line (or no line row at all). */
        async function routedOrder(key, age, { header, line }) {
          const o = await order(key, age);
          if (header) await tx.order.update({ where: { id: o.id }, data: { productId: header.id } });
          if (line === null) await tx.orderItem.deleteMany({ where: { orderId: o.id } });
          else if (line) await tx.orderItem.updateMany({ where: { orderId: o.id }, data: { productId: line.id, productName: line.name } });
          return o;
        }
        const routedPool = [
          await routedOrder('R-PLAIN', 3 * HOUR, {}),
          await routedOrder('R-LINE', 2 * HOUR, { line: routedProduct }),
          await routedOrder('R-HEADER', 1 * HOUR, { header: routedProduct, line: null }),
          await routedOrder('R-OTHERLINE', 50 * MIN, { header: routedProduct }),
          await routedOrder('R-YOUNG', 10 * MIN, { line: routedProduct }),
        ];
        const routingRow = (toUserIds) => ({
          id: 'kit-routing', companyId: company.id, storeId: null, name: 'kit-routing', kind: 'ROUTING', userIds: null, productId: routedProduct.id, channelKind: null, phase: null,
          hoursFrom: null, hoursTo: null, effectiveFrom: ago(DAY), effectiveTo: null, isActive: true, payload: { toUserIds, fallbackMinutes: 30 }, createdAt: ago(DAY),
        });
        const cut = fallbackCut(now, cal);
        const routedFor = (toUserIds, staff) =>
          routingWhereFor(routingRulesInForce([routingRow(toUserIds)], { companyId: company.id, storeId: store.id, now, timezone: 'UTC' }), { userId: agent.id, staff, cutOf: cut });
        async function dealRouted(routing) {
          await tx.order.updateMany({ where: { id: { in: routedPool.map((o) => o.id) } }, data: { claimedById: null, claimedAt: null, confirmationStatus: 'NEW', status: 'NEW' } });
          const out = [];
          for (let i = 0; i < 8; i++) {
            const id = await queue.pickNextCandidate(tx, scope, now, agent.id, { returns, priority: null, ...(routing ? { routing } : {}) });
            if (!id) break;
            out.push(await numberOf(id));
            await claim(id);
          }
          return out.join(' → ');
        }
        const ALL = 'R-PLAIN → R-LINE → R-HEADER → R-OTHERLINE → R-YOUNG';
        check('التوزيع: بلا قاعدة = كل الطلبات بترتيبها', (await dealRouted(null)) === ALL);
        const keptOut = await dealRouted(routedFor(['kit-colleague'], new Set(['kit-colleague'])));
        check('التوزيع: زميلة مسمّاة بتقدر تسحب = طلبات المنتج (سطر أو راس بلا سطور) مش إلها، والراس اللي سطره غيره إلها', keptOut === 'R-PLAIN → R-OTHERLINE', keptOut);
        const fellBack = await dealRouted(routedFor(['kit-colleague'], new Set()));
        check('التوزيع: ما حدا من المسمّيات بيقدر يسحب = بعد 30 دقيقة دوام للكل، والأحدث بيستنّى', fellBack === 'R-PLAIN → R-LINE → R-HEADER → R-OTHERLINE', fellBack);
        check('التوزيع: هي مسمّاة = ما في فلتر', routedFor([agent.id], new Set()) === null);
        await tx.order.updateMany({ where: { id: { in: routedPool.map((o) => o.id) } }, data: { claimedById: null, claimedAt: null, confirmationStatus: 'NEW', status: 'NEW' } });
        const unstaffed = unstaffedWhere(routingRulesInForce([routingRow(['kit-colleague'])], { companyId: company.id, storeId: store.id, now, timezone: 'UTC' }), new Set());
        const boardCount = await tx.order.count({ where: { AND: [{ OR: [queue.readyToPullWhere(scope, undefined, now), queue.duePostponedWhere(scope, now)] }, unstaffed] } });
        check('التوزيع: «طلبات بلا موظفة» = 3 (سطر المنتج، راسه بلا سطور، والأحدث)', boardCount === 3, String(boardCount));

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
