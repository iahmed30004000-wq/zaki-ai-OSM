/**
 * The SMOKE CHECK of the running kit app: the login API answers for the seeded users, and `GET /api/confirmation/mine` answers with the orders
 * the seed put in each agent's hand. It is the proof that «seed → run-app» fits together, not a test of the product.
 *
 * DEFINITION OF DONE: for each of the three seeded desks (ON/SY, ON/JO, OFF/SY) — sign in through the real door, choose the country, read the desk;
 * print the rows of «اتصلي هلّق» / «بانتظار» / «أُغلقت اليوم» with the words the SERVER wrote and the limit it reports (5 with the plan on, 3 off);
 * exit 1 when a seeded held order is missing from the desk or the switch shows on the wrong side.
 *
 *   KIT_PASSWORD=… node scripts/verify-on-postgres/check-app.mjs [--base-url http://127.0.0.1:3100]
 */
import { argv, die } from './lib.mjs';
import { baseUrlFrom, call, chooseContext, login, passwordFrom } from './app-session.mjs';
import { USERS, buildScenario } from './scenario.mjs';

const args = argv();
const base = baseUrlFrom(args['base-url']);
const password = passwordFrom(args.password);
const scenario = buildScenario(new Date());

const desks = [
  { who: 'agent1On', country: 'SY', cadence: true },
  { who: 'agent2On', country: 'JO', cadence: true },
  { who: 'agentOff', country: 'SY', cadence: false },
];

let failed = false;
for (const d of desks) {
  const u = USERS[d.who];
  const { jar: session, user } = await login(base, u.email, password);
  const { jar, storeId } = await chooseContext(base, session, d.country);
  const r = await call(base, '/api/confirmation/mine', jar);
  console.log(`\n── ${u.email} (${user?.role ?? u.role}) · ${d.country} · store ${storeId.slice(0, 8)}… · GET /api/confirmation/mine → ${r.status}`);
  if (r.status !== 200) {
    failed = true;
    console.log(`   ${r.text.slice(0, 300)}`);
    continue;
  }
  const m = r.json;
  const rows = (list) => (list ?? []).map((o) => ({ order: o.orderNumber, status: o.confirmationStatus, attempts: o.noAnswerCount, dueNow: o.dueNow, words: o.dueWords ?? o.closedWords ?? '' }));
  console.log(`   noAnswerLimit=${m.noAnswerLimit}  cadenceOn=${m.cadenceOn ?? '(absent)'}  callProofOn=${m.callProofOn ?? '(absent)'}`);
  for (const [title, list] of [['اتصلي هلّق (work)', m.work], ['بانتظار (noAnswer)', m.noAnswer], ['أُغلقت اليوم (closedToday)', m.closedToday]]) {
    console.log(`   ${title}: ${list?.length ?? 0}`);
    if (list?.length) console.table(rows(list));
  }
  // The seed's own promise: every order it put in this agent's hand is on the desk, closed ones in the closed list.
  const mine = scenario.filter((o) => o.heldBy === d.who);
  const shown = new Set([...(m.work ?? []), ...(m.noAnswer ?? [])].map((o) => o.orderNumber));
  const closed = new Set((m.closedToday ?? []).map((o) => o.orderNumber));
  const missing = mine.filter((o) => (o.closedToday ? !closed.has(o.key) : !shown.has(o.key))).map((o) => o.key);
  const switchOk = Boolean(m.cadenceOn) === d.cadence && m.noAnswerLimit === (d.cadence ? 5 : 3);
  const ok = missing.length === 0 && switchOk;
  if (!ok) failed = true;
  console.log(`   ${ok ? 'PASS' : 'FAIL'} — ممسوكة بالـseed: ${mine.map((o) => o.key).join(', ')}${missing.length ? ` · ناقصة: ${missing.join(', ')}` : ''}${switchOk ? '' : ` · المفتاح مش متل المتوقع (cadenceOn=${m.cadenceOn}, limit=${m.noAnswerLimit})`}`);
}
if (failed) die('check-app: في فرق — اقرأ فوق.');
console.log('\ncheck-app: كل المكاتب الثلاثة رجّعت طلبات السيناريو، والمفتاح على الجهة الصح.');
