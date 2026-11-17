/**
 * THE INTEGRATION-SETTINGS HARNESS — asks the repo's REAL `saveSetting` / `getSetting` / `clearSetting` / `settingsStatus` (`src/lib/integration-settings.ts`) and the REAL new table `integration_secrets`
 * (migration 20261118120000), on the REAL Prisma client against the scratch PostgreSQL (the media buyer's doors, PR-C). The unit tests double the table; that a value is sealed IN THE COLUMN, that the
 * unique key keeps one row per setting and that a webhook is verified with a secret read back from the table only mean something on a real one.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`, DATABASE_URL set before `db.ts` is imported); imports the repo's own TypeScript under tsx.
 *   2. The module writes through the repo's own \`db\`, so this cannot be a rolled-back transaction: it writes ONLY rows of \`integration_secrets\` under the settings' names and DELETES them at the end (also when a
 *      case failed). The table starts empty and the seeded companies are never touched. A throwaway encryption key is set for this process only.
 *   3. The cases: a saved value is sealed in the column (the raw column does not contain it; only the last four characters are in the clear) · what is read back is the value · a second save replaces the first
 *      (one row) and the unique key refuses a second raw insert for the same name · the site's value wins over the environment, and clearing it lets the environment answer again · \`settingsStatus\` lists all ten
 *      names, says where each comes from and carries no value · a webhook is verified with a secret saved on the site (Meta's signature, Telegram's token) with the environment empty · a wrong shape and an unknown name write nothing.
 *   4. Exit code 0 when it ran to the end (and, with \`--assert\`, every case matched), 2 when a database/Prisma error stopped it, 3 when \`--assert\` found a mismatch.
 *
 *   node scripts/verify-on-postgres/integration-settings.mjs [--assert]
 */
import { createHmac } from 'node:crypto';
import * as prismaPackage from '@prisma/client';
import { argv, assertScratchUrl, relaunchUnderTsx, scratchUrl } from './lib.mjs';

relaunchUnderTsx(import.meta.url);

const PrismaClient = prismaPackage.PrismaClient ?? prismaPackage.default.PrismaClient;
const args = argv({ assert: 'flag' });
const url = scratchUrl();
assertScratchUrl(url);
process.env.DATABASE_URL = url;
for (const k of ['DIRECT_URL', 'SHADOW_DATABASE_URL']) delete process.env[k];
if (process.env.NODE_ENV === 'production') delete process.env.NODE_ENV;
// A throwaway key for this scratch run only (never printed, never stored anywhere).
process.env.APP_ENCRYPTION_KEY = 'ef'.repeat(32);

const settings = await import('../../src/lib/integration-settings.ts');
const { verifyMetaSignature } = await import('../../src/lib/whatsapp/signature.ts');
const { verifyTelegramSecret } = await import('../../src/lib/telegram/signature.ts');
const { saveSetting, getSetting, clearSetting, settingsStatus, forgetIntegrationSettings, INTEGRATION_KEYS } = settings;
const probe = new PrismaClient({ datasourceUrl: url, log: [{ emit: 'stdout', level: 'error' }] });

const mismatches = [];
function check(what, ok, detail = '') {
  if (ok) console.log(`${args.assert ? 'ASSERT OK    ' : 'ok           '}${what}`);
  else {
    console.log(`${args.assert ? 'ASSERT FAIL  ' : 'DIFFERENT    '}${what}${detail ? ` — ${detail}` : ''}`);
    mismatches.push(what);
  }
}

const NAMES = INTEGRATION_KEYS.map((k) => k.key);
let exit = 0;

try {
  await probe.integrationSecret.deleteMany({ where: { key: { in: NAMES } } });
  for (const n of NAMES) delete process.env[n];
  forgetIntegrationSettings();

  const TOKEN = 'test-token-fixture-987654321';
  const saved = await saveSetting('WHATSAPP_ACCESS_TOKEN', TOKEN, null);
  check('الحفظ نجح وبيرجّع آخر 4 بس', saved.ok === true && saved.hint === '4321', JSON.stringify(saved));
  const raw = await probe.$queryRawUnsafe(`SELECT "valueEncrypted", "hint" FROM integration_secrets WHERE "key" = 'WHATSAPP_ACCESS_TOKEN'`);
  check('القيمة مشفّرة بالعمود نفسو: العمود ما فيه القيمة، وآخر 4 بس بالواضح', raw.length === 1 && !String(raw[0].valueEncrypted).includes(TOKEN) && !String(raw[0].valueEncrypted).includes('token-fixture') && raw[0].hint === '4321');
  check('وبتنقرا مرة تانية متل ما انحفظت', (await getSetting('WHATSAPP_ACCESS_TOKEN')) === TOKEN);

  // a second save replaces the first; the unique key refuses a second raw row
  await saveSetting('WHATSAPP_ACCESS_TOKEN', 'test-second-token-00001111', null);
  const rows = await probe.integrationSecret.count({ where: { key: 'WHATSAPP_ACCESS_TOKEN' } });
  check('حفظة تانية بتبدّل الأولى: صف واحد', rows === 1, `${rows} rows`);
  let refused = false;
  try {
    await probe.integrationSecret.create({ data: { key: 'WHATSAPP_ACCESS_TOKEN', valueEncrypted: 'x', hint: 'xxxx' } });
  } catch (e) {
    refused = e?.code === 'P2002';
  }
  check('القيد الفريد بالجدول: بيرفض صف تاني لنفس الاسم', refused);

  // the site wins over the environment, and clearing lets the environment answer
  process.env.TELEGRAM_BOT_TOKEN = 'test-env-bot-token-123456';
  check('بدون حفظ بالموقع: البيئة بتجاوب (متل ما كانت)', (await getSetting('TELEGRAM_BOT_TOKEN')) === 'test-env-bot-token-123456');
  await saveSetting('TELEGRAM_BOT_TOKEN', 'test-site-bot-token-654321', null);
  check('المحفوظ بالموقع بيغلب البيئة', (await getSetting('TELEGRAM_BOT_TOKEN')) === 'test-site-bot-token-654321');
  check('المسح بيرجّع البيئة تجاوب', (await clearSetting('TELEGRAM_BOT_TOKEN')) === true && (await getSetting('TELEGRAM_BOT_TOKEN')) === 'test-env-bot-token-123456');
  delete process.env.TELEGRAM_BOT_TOKEN;

  // the screen's view carries no value
  const status = await settingsStatus();
  const text = JSON.stringify(status);
  check('الحالة بتذكر العشرة وما فيها ولا قيمة', status.length === 10 && !text.includes('test-second-token') && !text.includes('valueEncrypted'), String(status.length));
  check('وبتقول المصدر وآخر 4', status.find((s) => s.key === 'WHATSAPP_ACCESS_TOKEN')?.source === 'site' && status.find((s) => s.key === 'WHATSAPP_ACCESS_TOKEN')?.hint === '1111' && status.find((s) => s.key === 'WHATSAPP_VERIFY_TOKEN')?.source === 'none');

  // webhooks verified with what the site holds, environment empty
  await saveSetting('WHATSAPP_APP_SECRET', 'test-app-secret-0001', null);
  await saveSetting('TELEGRAM_WEBHOOK_SECRET', 'test-hook-secret-0001', null);
  const body = '{"object":"whatsapp_business_account"}';
  const sig = 'sha256=' + createHmac('sha256', 'test-app-secret-0001').update(body, 'utf8').digest('hex');
  check('توقيع ميتا بيتحقق بالسرّ المحفوظ بالجدول، والتالف لأ', (await verifyMetaSignature(body, sig)) === true && (await verifyMetaSignature(body + ' ', sig)) === false);
  check('سرّ تيليجرام بيتحقق بالمحفوظ بالجدول، والغلط لأ', (await verifyTelegramSecret('test-hook-secret-0001')) === true && (await verifyTelegramSecret('test-hook-secret-0002')) === false);

  // refusals write nothing
  const before = await probe.integrationSecret.count({ where: { key: { in: NAMES } } });
  const badShape = await saveSetting('WHATSAPP_PHONE_NUMBER_ID', 'not-digits', null);
  const unknown = await saveSetting('DATABASE_URL', 'postgres://x-1234', null);
  const after = await probe.integrationSecret.count({ where: { key: { in: NAMES } } });
  check('شكل غلط واسم مش معروف: مرفوضين وما انكتب ولا صف', badShape.ok === false && unknown.ok === false && before === after && !(await probe.integrationSecret.findFirst({ where: { key: 'DATABASE_URL' } })));
} catch (e) {
  console.error(`\nوقف الفحص بخطأ قاعدة/Prisma: ${e instanceof Error ? e.stack || e.message : e}`);
  exit = 2;
} finally {
  try {
    await probe.integrationSecret.deleteMany({ where: { key: { in: NAMES } } });
    console.log('\nانمسح كل اللي كتبو الفحص (صفوف integration_secrets).');
  } catch (e) {
    console.error(`\nما قدرت أمسح بقايا الفحص (القاعدة تجريبية): ${e instanceof Error ? e.message : e}`);
  }
  await probe.$disconnect();
}

if (exit) process.exit(exit);
if (args.assert && mismatches.length) {
  console.error(`\nفرق (${mismatches.length}): ${mismatches.join(' | ')}`);
  process.exit(3);
}
process.exit(0);
