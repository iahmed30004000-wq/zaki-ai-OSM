import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `20261113040000_settlement_match_exchange_kind` IS ONE NULLABLE COLUMN ON `settlement_matches`, AND THE SCHEMA AND THE ROLLBACK AGREE ON IT.
 *
 * «طلب تبديل» (the owner, 13/11) keeps the stored answer `ACCEPTED_COURIER` and writes WHY in a column beside it. The migration runs by
 * itself at the next Redeploy (`prisma migrate deploy`), on a table that sits under a statement's money, so what it may do is pinned by
 * reading it: it adds one column and does nothing else — no value written, no row changed or removed, no constraint, no index, no
 * default, not one existing column touched. There is no database here to run it against, so every statement of the file is read, and
 * the schema model it has to match is read beside it.
 *
 * The rollback is read the same way, and one thing more: it REFUSES to drop the mark while a statement whose matching is still open
 * carries an exchange line — the old release would read that line as a plain accepted one and charge the employee at the door.
 */

const NAME = '20261113040000_settlement_match_exchange_kind';
const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const sqlOf = (file: string) => readFileSync(join(MIGRATIONS, NAME, file), 'utf8').replace(/\r\n/g, '\n');
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
  it('is exactly one statement: add one nullable text column to settlement_matches, if it is not there', () => {
    expect(statements(sqlOf('migration.sql'))).toEqual([
      'ALTER TABLE "settlement_matches" ADD COLUMN IF NOT EXISTS "resolutionKind" TEXT',
    ]);
  });

  it('NEGATIVE: nothing in it destroys, rewrites, constrains or indexes', () => {
    const code = statements(sqlOf('migration.sql')).join(' ; ');
    for (const forbidden of [/\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /\bNOT NULL\b/i,
      /\bDEFAULT\b/i, /\bUNIQUE\b/i, /\bINDEX\b/i, /\bCONSTRAINT\b/i, /\bRENAME\b/i, /\bTYPE\b/i, /\bREFERENCES\b/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    expect(code.match(/ADD COLUMN/gi)).toHaveLength(1);
    expect(code.match(/ALTER TABLE/gi)).toHaveLength(1);
  });

  it('runs after the migration that creates the table it alters, and after the newest one that was there before it', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
    expect(dirs).toContain(NAME);
    const creators = dirs.filter((d) => /CREATE TABLE (?:IF NOT EXISTS )?"settlement_matches"/i.test(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8')));
    expect(creators.length, 'no migration creates the settlement_matches table').toBeGreaterThan(0);
    for (const creator of creators) expect(creator < NAME, `${creator} must come before ${NAME}`).toBe(true);
    // The name is a timestamp: it must sort AFTER the wallet-pictures migration, the newest that was merged when this was written.
    expect(NAME > '20261111120000_wallet_pictures').toBe(true);
  });

  it('is not touched, dropped or recreated by any migration that runs after it', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
    for (const d of dirs.slice(dirs.indexOf(NAME) + 1)) {
      for (const statement of statements(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n'))) {
        if (!/"settlement_matches"/.test(statement)) continue;
        expect(statement, `${d} touches the exchange mark`).not.toMatch(/"resolutionKind"/);
      }
    }
  });
});

describe('the rollback', () => {
  const rollback = sqlOf('rollback.sql');
  const code = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('refuses while an OPEN matching carries an exchange line — before it drops anything', () => {
    const guard = code.indexOf('RAISE EXCEPTION');
    const drop = code.indexOf('DROP COLUMN');
    expect(guard).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(guard);
    const block = code.slice(code.indexOf('DO $$'), code.indexOf('END $$'));
    expect(block).toContain(`m."resolutionKind" IS NOT NULL`);
    expect(block).toContain(`s."matchingClosedAt" IS NULL`);
    expect(block).toContain('JOIN "courier_statements" s ON s."id" = m."statementId"');
  });

  it('then removes the same column and forgets the migration, and nothing else', () => {
    const after = code.slice(code.indexOf('END $$') + 'END $$;'.length);
    expect(statements(after)).toEqual([
      'ALTER TABLE "settlement_matches" DROP COLUMN IF EXISTS "resolutionKind"',
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}'`,
    ]);
  });
});

describe('the schema', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const model = schema.slice(schema.indexOf('model SettlementMatch {'), schema.indexOf('@@map("settlement_matches")'));

  it('SettlementMatch carries the column under the same name, nullable text, beside the answer', () => {
    expect(model).toMatch(/\bresolutionKind\s+String\?/);
    // Its column is the field's own name: no @map, so the migration's "resolutionKind" is the one Prisma reads and writes.
    const line = model.split('\n').find((l) => /^\s+resolutionKind\s/.test(l)) ?? '';
    expect(line).not.toMatch(/@map|@default|@unique|@id|@db\./);
    expect(model).not.toMatch(/@@(?:index|unique)\([^)]*resolutionKind/);
    // It sits with the rest of the answer, not apart from it.
    expect(model.indexOf('resolutionKind')).toBeGreaterThan(model.indexOf('resolutionNote'));
    expect(model.indexOf('resolutionKind')).toBeLessThan(model.indexOf('appliedAt'));
  });

  it('and the stored answer is still only the old words: no new resolution value is written anywhere in the schema', () => {
    expect(model).toMatch(/How the difference was settled: ACCEPTED_COURIER \| OURS_STANDS\./);
    expect(model).not.toMatch(/EXCHANGE\s*\|/);
  });
});
