/**
 * THE TEAM-LEADER MIGRATION HARNESS — runs the REAL `prisma/migrations/20261116120000_team_leader_role/migration.sql` (and its rollback.sql) against the scratch PostgreSQL, inside ONE transaction
 * that is ROLLED BACK, and reads the rows it wrote. The unit test reads the SQL as text; only a database can say that the INSERT … SELECT really copies the live supervisor template.
 *
 * DEFINITION OF DONE:
 *   1. Runs only against the scratch database (`scratchUrl` + `assertScratchUrl`).
 *   2. The migration is applied as it stands in the repo (the file is read, not copied) and everything is rolled back at the end: the scratch database is left as it was.
 *   3. The cases: the role row exists once, a system template (companyId NULL) · its grants are EXACTLY the supervisor's minus `orders.change_price` and `campaigns.manage`, plus `team.monitor`
 *      · the baseline (role_permission_defaults) has the same rows · no other role's grants changed (counts) · a second run writes nothing (idempotent) · the rollback removes the rows and the role.
 *   4. Exit code 0 when it ran to the end (and, with `--assert`, every case matched), 2 on a database error, 3 when `--assert` found a mismatch.
 *
 *   node scripts/verify-on-postgres/team-leader-role.mjs [--assert]
 */
import { readFileSync } from 'node:fs';
import * as prismaPackage from '@prisma/client';
import { argv, assertScratchUrl, scratchUrl } from './lib.mjs';

const PrismaClient = prismaPackage.PrismaClient ?? prismaPackage.default.PrismaClient;
const args = argv({ assert: 'flag' });
const url = scratchUrl();
assertScratchUrl(url);

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

/** The statements of a SQL file: comment lines dropped, split on `;` at the end of a line. */
const statementsOf = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

const DIR = 'prisma/migrations/20261116120000_team_leader_role';

try {
  await probe
    .$transaction(
      async (tx) => {
        const grantsOf = async (table, name) =>
          (await tx.$queryRawUnsafe(`SELECT p."permission" FROM "${table}" p JOIN "roles" r ON r.id = p."roleId" WHERE r."companyId" IS NULL AND r.name = $1 ORDER BY p."permission"`, name)).map((r) => r.permission);
        const countOthers = async () => Number((await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "role_permissions" p JOIN "roles" r ON r.id = p."roleId" WHERE r.name <> 'TEAM_LEADER'`))[0].n);

        const supervisor = await grantsOf('role_permissions', 'CONFIRMATION_SUPERVISOR');
        if (supervisor.length === 0) throw new Error('ما لقيت قالب مشرف التأكيد بالقاعدة التجريبية — شغّل migrate.mjs أول.');
        // The kit's migrate.mjs has applied every migration, this one included: start from the state BEFORE it by running its own rollback (inside the transaction, undone at the end).
        for (const st of statementsOf(`${DIR}/rollback.sql`)) await tx.$executeRawUnsafe(st);
        const before = await countOthers();
        const roleCount = async () => Number((await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "roles" WHERE "companyId" IS NULL AND name = 'TEAM_LEADER'`))[0].n);
        check('قبل الترحيل: ما في دور TEAM_LEADER', (await roleCount()) === 0);

        for (const s of statementsOf(`${DIR}/migration.sql`)) await tx.$executeRawUnsafe(s);

        const expected = [...new Set([...supervisor.filter((p) => p !== 'orders.change_price' && p !== 'campaigns.manage'), 'team.monitor'])].sort();
        const got = await grantsOf('role_permissions', 'TEAM_LEADER');
        check('الدور انكتب مرة وحدة وهو قالب نظام (companyId فاضي)', (await roleCount()) === 1);
        check('صلاحياته = المشرف بدون orders.change_price وcampaigns.manage ومعها team.monitor بالضبط', JSON.stringify(got) === JSON.stringify(expected), `got=${got.join(',')}`);
        check('ما عندو orders.change_price ولا campaigns.manage', !got.includes('orders.change_price') && !got.includes('campaigns.manage'));
        check('المشرف نفسو ما انلمس (بيحتفظ بالمفتاحين لو كان عندو)', JSON.stringify(await grantsOf('role_permissions', 'CONFIRMATION_SUPERVISOR')) === JSON.stringify(supervisor));
        check('نقطة «إرجاع للافتراضي» فيها نفس الصفوف', JSON.stringify(await grantsOf('role_permission_defaults', 'TEAM_LEADER')) === JSON.stringify(expected));
        check('ما تغيّر ولا صف لأي دور تاني', (await countOthers()) === before);

        for (const s of statementsOf(`${DIR}/migration.sql`)) await tx.$executeRawUnsafe(s);
        check('تشغيل تاني: ما بيضيف شي (يتحمّل الإعادة)', (await roleCount()) === 1 && JSON.stringify(await grantsOf('role_permissions', 'TEAM_LEADER')) === JSON.stringify(expected));

        for (const s of statementsOf(`${DIR}/rollback.sql`)) await tx.$executeRawUnsafe(s);
        check('الرجوع: الدور وصفوفو راحوا', (await roleCount()) === 0 && (await grantsOf('role_permissions', 'TEAM_LEADER')).length === 0);
        check('الرجوع: ما انلمس أي دور تاني', (await countOthers()) === before);

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
