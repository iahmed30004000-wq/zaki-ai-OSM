/**
 * Applies the repo's hand-written migrations (`prisma/migrations`) to the scratch database with `prisma migrate deploy`.
 *
 * DEFINITION OF DONE:
 *   1. BEFORE anything real, a harmless proof that a process-env DATABASE_URL beats a `.env` file for this prisma: a temporary
 *      directory holds a `.env` pointing at a decoy host that can never resolve (`*.invalid`); `prisma migrate status` is run there
 *      once WITHOUT a process variable (the control: it must report the decoy — so the `.env` really is read) and once WITH the
 *      scratch URL (it must report 127.0.0.1:54329 and not the decoy). Either result wrong → stop, nothing is applied.
 *   2. `migrate deploy` only: never `migrate dev`, `migrate reset`, `db push`, never a generated migration. The child's DATABASE_URL
 *      is explicit and has passed `assertScratchUrl`.
 *   3. The applied migrations are listed afterwards from `_prisma_migrations`, and an unfinished or rolled-back row is a failure.
 *
 *   node scripts/verify-on-postgres/migrate.mjs            # proof, deploy, list
 *   node scripts/verify-on-postgres/migrate.mjs --status   # proof and status only (applies nothing)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DB_NAME, HOST, PORT, PRISMA_CLI, REPO, argv, childEnv, die, psql, runNode } from './lib.mjs';

const args = argv({ status: 'flag' });
const SCHEMA = resolve(REPO, 'prisma', 'schema.prisma');
const DECOY_HOST = 'decoy-host.invalid';

const quiet = { PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' };

function proveProcessEnvBeatsDotEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'zaki-env-proof-'));
  try {
    writeFileSync(join(dir, '.env'), `DATABASE_URL="postgresql://decoy_user@${DECOY_HOST}:5432/decoy_db"\n`);
    const run = (env) => runNode([PRISMA_CLI, 'migrate', 'status', '--schema', SCHEMA], { cwd: dir, env: { ...env, ...quiet }, capture: true }).out;

    // Control: no process variable at all → the .env must be read and the decoy reported.
    const control = { ...process.env };
    delete control.DATABASE_URL;
    const withoutVar = run(control);
    if (!withoutVar.includes(DECOY_HOST)) {
      die(`الفحص التجريبي فاضي: بدون متغيّر بالبيئة prisma ما قرا ملف .env.\n${withoutVar}`);
    }

    // The real question: the scratch URL in the process environment, the decoy in `.env` of the working directory.
    const withVar = run(childEnv());
    const reportsScratch = withVar.includes(`${HOST}:${PORT}`) && withVar.includes(`"${DB_NAME}"`);
    if (!reportsScratch || withVar.includes(DECOY_HOST)) {
      die(`prisma قرا ملف .env بدل متغيّر البيئة — الكيت بيوقف.\n${withVar}`);
    }
    console.log(`[migrate] الإثبات: بدون متغيّر → "${DECOY_HOST}" (الـ.env انقرا) · مع متغيّر → "${HOST}:${PORT}" (المتغيّر غلب).`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

proveProcessEnvBeatsDotEnv();

const env = { ...childEnv(), ...quiet };

if (!args.status) {
  console.log('\n[migrate] prisma migrate deploy → scratch_zaki');
  const code = runNode([PRISMA_CLI, 'migrate', 'deploy', '--schema', SCHEMA], { env });
  if (code !== 0) die(`migrate deploy فشل (${code}). اقرأ الخطأ فوق — هاد بحدّ ذاتو نتيجة فحص على قاعدة حقيقية.`, code);
}

console.log('\n[migrate] prisma migrate status');
const status = runNode([PRISMA_CLI, 'migrate', 'status', '--schema', SCHEMA], { env });
if (args.status) process.exit(0); // status-only: pending migrations are an answer here, not a failure
if (status !== 0) die(`migrate status ما رجّع "up to date" (${status}).`, status);

const rows = psql(
  `SELECT migration_name || '|' || COALESCE(to_char(finished_at, 'YYYY-MM-DD HH24:MI:SS'), 'UNFINISHED') || '|' || COALESCE(to_char(rolled_back_at, 'YYYY-MM-DD'), '') FROM _prisma_migrations ORDER BY started_at, migration_name`,
  DB_NAME
).out
  .split(/\r?\n/)
  .filter(Boolean);
const bad = rows.filter((r) => r.split('|')[1] === 'UNFINISHED' || r.split('|')[2]);
console.log(`\n[migrate] المطبّق: ${rows.length} migration. آخر خمسة:`);
for (const r of rows.slice(-5)) console.log(`  ${r.split('|').slice(0, 2).join('  ')}`);
if (bad.length) die(`فيه migration ما خلص أو انرجع:\n${bad.join('\n')}`);
console.log('[migrate] كلها خالصة، ولا وحدة انرجعت.');
