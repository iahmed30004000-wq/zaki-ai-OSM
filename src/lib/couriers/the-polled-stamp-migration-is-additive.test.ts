import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `20261030200000_courier_polled_at` IS ONE NULLABLE COLUMN, AND THE SCHEMA, THE CODE AND THE ROLLBACK AGREE ON IT (RV146).
 *
 * The migration runs by itself at the next Redeploy (`prisma migrate deploy`), so what it may do is pinned by reading it:
 * it adds a column and does nothing else — no value written, no row changed or removed, no constraint, no index, no
 * default. There is no database here to run it against, so the file's every statement is read and the schema model it
 * has to match is read beside it.
 */

const NAME = '20261030200000_courier_polled_at';
const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const sqlOf = (file: string) => readFileSync(join(MIGRATIONS, NAME, file), 'utf8');
/** The statements of a file, comments and blank lines gone. */
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

describe('the migration', () => {
  it('is exactly one statement: add a nullable timestamp column to orders, if it is not there', () => {
    expect(statements(sqlOf('migration.sql'))).toEqual([
      'ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "courier_polled_at" TIMESTAMP(3)',
    ]);
  });

  it('NEGATIVE: nothing in it destroys, rewrites, constrains or indexes', () => {
    const code = statements(sqlOf('migration.sql')).join(' ; ');
    for (const forbidden of [/\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /\bNOT NULL\b/i,
      /\bDEFAULT\b/i, /\bUNIQUE\b/i, /\bINDEX\b/i, /\bCONSTRAINT\b/i, /\bRENAME\b/i, /\bTYPE\b/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    // One column, one table.
    expect(code.match(/ADD COLUMN/gi)).toHaveLength(1);
    expect(code.match(/ALTER TABLE/gi)).toHaveLength(1);
  });

  /*
   * قديم ← جديد (PR-A, 20261031000000_enrol_code): «is the newest migration» ← the two things it really meant.
   * The old test pinned the NAME as the last in the folder, so ANY later migration turned it red though none of them has
   * anything to do with this column. What «newest» was protecting is (1) the orders table exists before this file adds a column
   * to it, and (2) nothing that runs after it touches, drops or recreates that column. Both are checked directly, so a later
   * migration that names `courier_polled_at` still fails here, and an unrelated one (a column on users) does not.
   */
  it('runs after the migration that creates the orders table it alters', () => {
    // `0_init` is the baseline and has no 14-digit stamp, so every folder with a number in front is read here.
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort();
    const creators = dirs.filter((d) => /CREATE TABLE "orders"/i.test(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8')));
    expect(creators.length, 'no migration creates the orders table').toBeGreaterThan(0);
    for (const creator of creators) expect(creator < NAME, `${creator} must come before ${NAME}`).toBe(true);
  });

  it('is not touched, dropped or recreated by any migration that runs after it', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
    const after = dirs.slice(dirs.indexOf(NAME) + 1);
    expect(dirs).toContain(NAME);
    for (const d of after) {
      expect(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8'), d).not.toMatch(/courier_polled_at/);
    }
  });

  it('has a rollback that removes the same column and forgets the migration, and nothing else', () => {
    expect(statements(sqlOf('rollback.sql'))).toEqual([
      'ALTER TABLE "orders" DROP COLUMN IF EXISTS "courier_polled_at"',
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}'`,
    ]);
  });
});

describe('the schema and the code it is for', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const order = schema.slice(schema.indexOf('model Order {'), schema.indexOf('@@map("orders")'));

  it('Order carries the column under the same name, nullable, as a DateTime', () => {
    expect(order).toMatch(/courierPolledAt\s+DateTime\?\s+@map\("courier_polled_at"\)/);
  });

  it('the stamp writes that column by raw SQL, with the company in its WHERE, and touches no other column', () => {
    const whole = readFileSync(join(process.cwd(), 'src', 'lib', 'couriers', 'poll-stamp.ts'), 'utf8');
    // The code, not the comments that explain it.
    const source = whole.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).toContain('SET "courier_polled_at" = now()');
    expect(source).toContain('WHERE "companyId" = ${companyId}');
    // The only SET in the statement is that column: no updatedAt, no version, no status.
    expect(source.match(/\bSET\b/g)).toHaveLength(1);
    expect(source).not.toMatch(/updatedAt|"version"|shippingStatus/);
  });

  it('NEGATIVE: the poll never writes the column through the ORM, which would move updatedAt', () => {
    const job = readFileSync(join(process.cwd(), 'src', 'lib', 'jobs', 'definitions', 'sync-courier-status.ts'), 'utf8');
    expect(job).not.toMatch(/courierPolledAt\s*:\s*(new Date|now)/);
    expect(job).not.toMatch(/order\.update/);
    expect(job).toContain('stampCourierPolled(');
  });
});
