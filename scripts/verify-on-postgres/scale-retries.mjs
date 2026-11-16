/**
 * THE SCALE PROBE of the retry-ranking query: writes N ready retries into the ON company's Syria store, then asks the real `pickMostOverdueRetry`
 * (and `pickNextCandidate`) for the most overdue one, three times, with the SQL durations Prisma reports — so the cost of the nested select and
 * the effect of the page cap (`RETRY_SCAN_PAGE`, 2000) are SEEN on real PostgreSQL and not guessed.
 *
 * DEFINITION OF DONE:
 *   1. Scratch database only (`scratchUrl` + `assertScratchUrl`, before the repo's `db.ts` is imported).
 *   2. The bulk orders are built so that AGE and DUE are OPPOSITES (the older the order, the later its due): a pool larger than the page cap then
 *      shows whether the answer is the pool's most overdue or only the most overdue of the oldest-created page — printed, not asserted.
 *   3. Any `console.warn` the repo's code prints while the three calls run is printed under them (the planner's answer 10: a warning when the page is full).
 *   4. It WRITES (N customers, orders and lines with ids `bulk-…`): run `seed.mjs` afterwards, which empties the database, before any other check.
 *
 *   node scripts/verify-on-postgres/scale-retries.mjs [--count 5000]
 */
import * as prismaPackage from '@prisma/client';
import { argv, assertScratchUrl, relaunchUnderTsx, scratchUrl } from './lib.mjs';
import { COMPANY_ON, USERS } from './scenario.mjs';

// The repo's TypeScript is imported below, so this file must run under the tsx command; if it was started with plain `node`, it starts itself again that way.
relaunchUnderTsx(import.meta.url);

const PrismaClient = prismaPackage.PrismaClient ?? prismaPackage.default.PrismaClient;
const args = argv();
const N = Number(args.count || 5000);

const url = scratchUrl();
assertScratchUrl(url);
process.env.DATABASE_URL = url;

const queue = await import('../../src/lib/confirmation-queue.ts');
const { db } = await import('../../src/lib/db.ts');
const prisma = new PrismaClient({ datasourceUrl: url, log: [{ emit: 'event', level: 'query' }] });
const statements = [];
prisma.$on('query', (e) => statements.push(e));

const company = await prisma.company.findFirst({ where: { name: COMPANY_ON } });
if (!company) throw new Error('شغّل seed.mjs أول.');
const country = await prisma.country.findFirst({ where: { companyId: company.id, code: 'SY' } });
const store = await prisma.store.findFirst({ where: { companyId: company.id, countryId: country.id } });
const product = await prisma.product.findFirst({ where: { storeId: store.id } });
const agent = await prisma.user.findUnique({ where: { email: USERS.agent1On.email } });
const now = new Date();
const minute = 60_000;

const scenarioOrders = await prisma.order.count({ where: { storeId: store.id } });
await prisma.customer.createMany({
  data: Array.from({ length: N }, (_, i) => ({
    id: `bulk-c-${i}`, companyId: company.id, storeId: store.id, fullName: `bulk ${i}`, phone: `0911${String(i).padStart(7, '0')}`, rawPhone: `0911${String(i).padStart(7, '0')}`, address: 'x', city: 'x', country: 'SY',
  })),
});
// Order i: the OLDER the order (small i), the LATER its due — so oldest-first and most-overdue-first are opposite lists.
await prisma.order.createMany({
  data: Array.from({ length: N }, (_, i) => ({
    id: `bulk-o-${i}`, companyId: company.id, countryId: country.id, storeId: store.id, orderNumber: `BULK-${i}`, merchantRef: `BULK-${i}`, customerId: `bulk-c-${i}`, productId: product.id,
    quantity: 1, sellingPrice: 20, totalAmount: 20, currency: 'USD', status: 'NO_ANSWER', confirmationStatus: 'NO_ANSWER',
    createdAt: new Date(now.getTime() - (N - i) * minute - 7 * 24 * 60 * minute),
    nextFollowUpAt: new Date(now.getTime() - (i + 1) * minute),
  })),
});
await prisma.orderContactAttempt.createMany({
  data: Array.from({ length: N }, (_, i) => ({
    companyId: company.id, orderId: `bulk-o-${i}`, employeeId: agent.id, employeeRole: agent.role, attemptNumber: 1, contactMethod: 'PHONE', result: 'NO_ANSWER',
    createdAt: new Date(now.getTime() - (i + 31) * minute), nextFollowUpAt: new Date(now.getTime() - (i + 1) * minute),
  })),
});
console.log(`كتبت ${N} إعادة جاهزة (+${scenarioOrders} طلب من السيناريو بنفس المتجر). سقف الصفحة RETRY_SCAN_PAGE = ${queue.RETRY_SCAN_PAGE}`);
console.log(`الأكثر تأخّراً بالمجموعة كلها: BULK-${N - 1} · الأقدم إنشاءً: BULK-0 · الأكثر تأخّراً ضمن أقدم ${queue.RETRY_SCAN_PAGE}: BULK-${Math.min(N, queue.RETRY_SCAN_PAGE) - 1}`);

const cal = { workHoursStart: country.workHoursStart, workHoursEnd: country.workHoursEnd, weekendDays: country.weekendDays, timezone: country.timezone };
const returns = await queue.readReturnsMode(prisma, company.id, { now, calendar: () => cal });
const scope = { companyId: company.id, storeId: store.id };

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.map(String).join(' '));
try {
  for (let k = 1; k <= 3; k++) {
    statements.length = 0;
    const t0 = Date.now();
    const id = await queue.pickMostOverdueRetry(prisma, scope, new Date(), agent.id, returns);
    const ms = Date.now() - t0;
    const row = id ? await prisma.order.findUnique({ where: { id }, select: { orderNumber: true } }) : null;
    console.log(`pickMostOverdueRetry #${k}: ${row?.orderNumber ?? 'null'} في ${ms}ms · ${statements.length} statements (${statements.map((s) => `${s.duration}ms`).join(' / ')}) · طول params للثاني ${String(statements[1]?.params).length}`);
  }
  const t1 = Date.now();
  const picked = await queue.pickNextCandidate(prisma, scope, new Date(), agent.id, { returns });
  const name = picked ? (await prisma.order.findUnique({ where: { id: picked }, select: { orderNumber: true } }))?.orderNumber : null;
  console.log(`pickNextCandidate كاملة: ${name ?? 'null'} في ${Date.now() - t1}ms (الجديد بيجي قبل الإعادات، فالنتيجة هي أول طلب جديد)`);
} finally {
  console.warn = realWarn;
}
console.log(warnings.length ? `\nconsole.warn من الكود (${warnings.length}):\n${warnings.map((w) => `  ${w}`).join('\n')}` : '\nما طلع ولا console.warn من الكود.');
await Promise.allSettled([prisma.$disconnect(), db.$disconnect()]);
process.exit(0);
