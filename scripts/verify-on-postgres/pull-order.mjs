/**
 * THE PULL-ORDER HARNESS — asks the repo's REAL pull code, on the REAL Prisma client against the scratch PostgreSQL, in which order the
 * seeded orders are handed out. It asserts NOTHING: it prints, and the person who runs it on the merged code compares with the planner's
 * answers (13: the promise whose time arrived, then retries by their due, then the rest by oldest created).
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, the process's DATABASE_URL is set from it before the repo's
 *      `src/lib/db.ts` is imported — `db.ts` reads it at load time).
 *   2. Imports the repo's own TypeScript (`src/lib/confirmation-queue.ts`) through tsx's `tsImport`: no copy of any rule lives here.
 *   3. Part 1 — the HAND-OUT ORDER of each desk: `pickNextCandidate` in a loop inside ONE transaction on a client that logs every SQL statement;
 *      each pick is claimed in that transaction (so the next pick moves on), and the transaction is ROLLED BACK at the end — nothing stays written.
 *   4. Part 2 — the QUERY OF `pickMostOverdueRetry` (the nested select, only ever checked by an in-memory double before): run alone, its SQL
 *      printed in full with its duration, and the id it returns.
 *   5. Part 3 — the REAL `pullNextOrder` (own transaction, the hand limit, the work-first gate, the pace): called until it refuses; what it
 *      handed out and the refusal are printed; then the orders it touched are put back and its history rows deleted.
 *   6. Exit code 0 when it ran to the end, 2 when a database/Prisma error stopped it (the error and the SQL are printed — that is a finding).
 *
 *   node scripts/verify-on-postgres/pull-order.mjs [--sql] [--no-real-pulls]
 *     --sql             print every statement of Part 1 as well
 *     --no-real-pulls   skip Part 3
 */
import * as prismaPackage from '@prisma/client';
import { tsImport } from 'tsx/esm/api';
import { argv, assertScratchUrl, scratchUrl } from './lib.mjs';
import { COMPANY_OFF, COMPANY_ON, USERS, buildScenario } from './scenario.mjs';

const PrismaClient = prismaPackage.PrismaClient ?? prismaPackage.default.PrismaClient;
const args = argv({ sql: 'flag', 'no-real-pulls': 'flag' });

// The gate, then the environment the repo's db.ts will read when it loads.
const url = scratchUrl();
assertScratchUrl(url);
process.env.DATABASE_URL = url;
for (const k of ['DIRECT_URL', 'SHADOW_DATABASE_URL']) delete process.env[k];
if (process.env.NODE_ENV === 'production') delete process.env.NODE_ENV;

const queue = await tsImport('../../src/lib/confirmation-queue.ts', import.meta.url);
const { db } = await tsImport('../../src/lib/db.ts', import.meta.url);

// A client of the kit's own, only to SEE the SQL Prisma sends (the repo's `db` logs errors only).
const sqlLog = [];
const probe = new PrismaClient({ datasourceUrl: url, log: [{ emit: 'event', level: 'query' }, { emit: 'stdout', level: 'error' }] });
probe.$on('query', (e) => sqlLog.push({ sql: e.query, params: e.params, ms: e.duration }));

class Rollback extends Error {}
/** The note of the one row Part 3 writes by hand (an attempt that «touches» an order); it is found by this and deleted afterwards. */
const KIT_TOUCH = 'kit: touched';

const line = (s = '') => console.log(s);
const rule = (s) => line(`\n${'═'.repeat(8)} ${s} ${'═'.repeat(Math.max(4, 70 - s.length))}`);

async function deskOf(companyName, email, countryCode) {
  const company = await probe.company.findFirst({ where: { name: companyName } });
  if (!company) throw new Error(`ما لقيت الشركة "${companyName}" — شغّل seed.mjs أول.`);
  const user = await probe.user.findUnique({ where: { email } });
  const country = await probe.country.findFirst({ where: { companyId: company.id, code: countryCode } });
  const store = await probe.store.findFirst({ where: { companyId: company.id, countryId: country.id } });
  const cal = { workHoursStart: country.workHoursStart, workHoursEnd: country.workHoursEnd, weekendDays: country.weekendDays, timezone: country.timezone };
  return { company, user: { id: user.id, role: user.role }, cal, scope: { companyId: company.id, storeId: store.id }, label: `${companyName.split(' —')[0]} / ${countryCode} / ${email}` };
}

async function namesOf(ids) {
  const rows = await probe.order.findMany({ where: { id: { in: ids } }, select: { id: true, orderNumber: true } });
  return new Map(rows.map((r) => [r.id, r.orderNumber]));
}

/** Part 1: the order a desk is handed, by `pickNextCandidate` — claimed one by one inside a transaction that is rolled back. */
async function handOutOrder(desk, now) {
  rule(`1 · ترتيب التسليم — ${desk.label}`);
  const returns = await queue.readReturnsMode(probe, desk.company.id, { now, calendar: () => desk.cal });
  line(returns ? `وضع الإرجاع: شغّال — الجدول ${returns.cadence ? `شغّال منذ ${returns.cadence.since.toISOString()}` : 'مطفي (الوضع القديم)'}` : 'وضع الإرجاع: مطفي (القاعدة القديمة بالحرف)');
  const picks = [];
  sqlLog.length = 0;
  try {
    await probe.$transaction(
      async (tx) => {
        for (let i = 0; i < 60; i++) {
          const id = await queue.pickNextCandidate(tx, desk.scope, now, desk.user.id, { returns });
          if (!id) break;
          picks.push(id);
          // What a pull does to the order, so the next pick moves on (the transaction is thrown away below).
          await tx.order.update({ where: { id }, data: { claimedById: desk.user.id, claimedAt: now, currentOwnerId: desk.user.id, confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS' } });
        }
        throw new Rollback();
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const names = await namesOf(picks);
  const expect = new Map(buildScenario(now).map((o) => [o.key, o.expect]));
  const rows = picks.map((id, i) => ({ '#': i + 1, order: names.get(id), expect: expect.get(names.get(id)) ?? '' }));
  if (rows.length) console.table(rows);
  else line('(ما انسحب ولا طلب)');
  const left = await probe.order.count({ where: { ...desk.scope, claimedById: null, confirmationStatus: { in: ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'] } } });
  line(`بعد الـrollback: ${left} طلب مفتوح بلا حامل بالمجموعة (الأصلي) — ما انكتب شي.`);
  if (args.sql) for (const q of sqlLog) line(`  [${q.ms}ms] ${q.sql}\n     ${q.params}`);
  // The counters read the same two predicates as the picks — print what they say so a disagreement is visible.
  const waiting = await queue.waitingCount(probe, desk.scope, now, desk.user.id, returns);
  line(`عدّاد «بانتظار التأكيد» (waitingCount) للموظفة: ${waiting}`);
  return { returns };
}

/** Part 2: the nested-select query alone, with its SQL. */
async function retryQuery(desk, now) {
  rule(`2 · استعلام pickMostOverdueRetry — ${desk.label}`);
  const returns = await queue.readReturnsMode(probe, desk.company.id, { now, calendar: () => desk.cal });
  if (!returns?.cadence) {
    line('الجدول مطفي هون — الدالة ما بتنسأل (بترجع null من أول سطر). تخطّي.');
    return;
  }
  sqlLog.length = 0;
  const t0 = Date.now();
  const id = await queue.pickMostOverdueRetry(probe, desk.scope, now, desk.user.id, returns);
  const ms = Date.now() - t0;
  const names = await namesOf(id ? [id] : []);
  line(`رجّعت: ${id ? `${names.get(id)} (${id})` : 'null'} — ${ms}ms — ${sqlLog.length} statement(s)`);
  const statements = [...sqlLog];
  statements.forEach((q, i) => {
    line(`\n  -- statement ${i + 1}  (${q.ms}ms)`);
    line(`  ${q.sql}`);
    line(`  -- params: ${q.params}`);
  });
}

/**
 * Part 3: the real `pullNextOrder`, until it refuses; then everything it touched is put back.
 *   3a  the desk AS SEEDED — her hand holds an order with no attempt, so the real gate («سجّل محاولة اتصال … قبل سحب طلب جديد») answers.
 *   3b  after she TOUCHED what she holds without an attempt, and finishing every order she pulls (a decision ends it) — so the hand never fills
 *       and the sequence is the whole pool's, handed out by the real door: the list to compare with Part 1.
 */
async function realPulls(desk) {
  rule(`3 · pullNextOrder الحقيقية — ${desk.label}`);
  const columns = { id: true, claimedById: true, claimedAt: true, currentOwnerId: true, confirmationStatus: true, status: true, version: true, assignedAt: true, signatureStatus: true, confirmedAt: true };
  const touched = await probe.order.findMany({ where: { companyId: desk.company.id, storeId: desk.scope.storeId }, select: columns });
  const startedAt = new Date(Date.now() - 1000);
  const pulls = async (label, finishEach) => {
    const results = [];
    for (let i = 0; i < 14; i++) {
      const r = await queue.pullNextOrder(desk.scope, desk.user, desk.cal, new Date());
      const name = r.orderId ? (await namesOf([r.orderId])).get(r.orderId) : null;
      results.push({ '#': i + 1, ok: r.ok, order: name ?? '', refusal: r.refusal ? `${r.refusal.code}: ${r.refusal.message}` : '', released: r.released ?? 0 });
      if (!r.ok) break;
      if (finishEach) {
        await probe.order.update({ where: { id: r.orderId }, data: { claimedById: null, currentOwnerId: null, confirmationStatus: 'CONFIRMED', status: 'CONFIRMED', confirmedAt: new Date() } });
      }
    }
    line(`\n${label}`);
    console.table(results);
  };
  try {
    await pulls('3a · كما هي بالـseed', false);
    const untouched = await probe.order.findMany({
      where: { ...desk.scope, claimedById: desk.user.id, confirmationStatus: { in: ['NEW', 'IN_PROGRESS', 'NO_ANSWER'] }, contactAttempts: { none: {} } },
      select: { id: true },
    });
    for (const o of untouched) {
      await probe.orderContactAttempt.create({
        data: { companyId: desk.company.id, orderId: o.id, employeeId: desk.user.id, employeeRole: desk.user.role, attemptNumber: 1, contactMethod: 'PHONE', result: 'OTHER', note: KIT_TOUCH },
      });
    }
    await pulls(`3b · بعد ما لمست ${untouched.length} طلب بإيدها، وكل طلب بتسحبو بتخلّصو`, true);
  } finally {
    // Put everything back: the orders as they were, and the rows the pulls (and any release inside them) wrote.
    for (const o of touched) {
      await probe.order.update({
        where: { id: o.id },
        data: { claimedById: o.claimedById, claimedAt: o.claimedAt, currentOwnerId: o.currentOwnerId, confirmationStatus: o.confirmationStatus, status: o.status, version: o.version, assignedAt: o.assignedAt, signatureStatus: o.signatureStatus, confirmedAt: o.confirmedAt },
      });
    }
    const a = await probe.orderContactAttempt.deleteMany({ where: { companyId: desk.company.id, createdAt: { gt: startedAt }, note: KIT_TOUCH } });
    const h = await probe.orderClaimHistory.deleteMany({ where: { companyId: desk.company.id, createdAt: { gt: startedAt } } });
    const s = await probe.orderStatusLog.deleteMany({ where: { companyId: desk.company.id, createdAt: { gt: startedAt }, note: 'سحب من الطابور' } });
    line(`انرجّع: ${touched.length} طلب لحالتو، وانحذف ${a.count} سطر لمس و${h.count} سطر claim-history و${s.count} سطر status-log كتبهم الفحص.`);
  }
}

let failed = false;
try {
  const now = new Date();
  line(`pull-order على ${new URL(url).host}/${new URL(url).pathname.slice(1)} — الوقت ${now.toISOString()}`);
  const desks = [
    await deskOf(COMPANY_ON, USERS.agent1On.email, 'SY'),
    await deskOf(COMPANY_ON, USERS.agent2On.email, 'JO'),
    await deskOf(COMPANY_OFF, USERS.agentOff.email, 'SY'),
  ];
  for (const desk of desks) await handOutOrder(desk, now);
  for (const desk of desks) await retryQuery(desk, now);
  if (!args['no-real-pulls']) for (const desk of desks) await realPulls(desk);
  line('\nخلص. pull-order ما بيفحص شي بحدّ ذاتو: قارن الجداول فوق بجواب المخطط 13.');
} catch (e) {
  failed = true;
  console.error('\n[pull-order] وقف بخطأ — هاد بحدّ ذاتو نتيجة فحص على PostgreSQL حقيقي:\n');
  console.error(e);
  if (sqlLog.length) {
    console.error('\nآخر statements نفّذها Prisma قبل الخطأ:');
    for (const q of sqlLog.slice(-4)) console.error(`  [${q.ms}ms] ${q.sql}\n     ${q.params}`);
  }
}
await Promise.allSettled([probe.$disconnect(), db.$disconnect()]);
process.exit(failed ? 2 : 0);
