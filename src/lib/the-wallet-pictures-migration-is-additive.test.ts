import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `20261111120000_wallet_pictures` IS THREE NULLABLE COLUMNS ON `wallets`, AND THE SCHEMA AND THE ROLLBACK AGREE ON THEM.
 *
 * The migration runs by itself at the next Redeploy (`prisma migrate deploy`), on a table with live money behind it, so
 * what it may do is pinned by reading it: it adds three columns and does nothing else — no value written, no row changed
 * or removed, no constraint, no index, no default, not one existing column touched. There is no database here to run it
 * against, so every statement of the file is read, and the schema model it has to match is read beside it.
 */

const NAME = '20261111120000_wallet_pictures';
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
  it('is exactly one statement: add three nullable text columns to wallets, if they are not there', () => {
    expect(statements(sqlOf('migration.sql'))).toEqual([
      'ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "image_key" TEXT, ADD COLUMN IF NOT EXISTS "icon_key" TEXT, ADD COLUMN IF NOT EXISTS "color_key" TEXT',
    ]);
  });

  it('NEGATIVE: nothing in it destroys, rewrites, constrains or indexes', () => {
    const code = statements(sqlOf('migration.sql')).join(' ; ');
    for (const forbidden of [/\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /\bNOT NULL\b/i,
      /\bDEFAULT\b/i, /\bUNIQUE\b/i, /\bINDEX\b/i, /\bCONSTRAINT\b/i, /\bRENAME\b/i, /\bTYPE\b/i, /\bREFERENCES\b/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    // Three columns, one table.
    expect(code.match(/ADD COLUMN/gi)).toHaveLength(3);
    expect(code.match(/ALTER TABLE/gi)).toHaveLength(1);
  });

  it('runs after the migration that creates the wallets table it alters', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort();
    const creators = dirs.filter((d) => /CREATE TABLE (?:IF NOT EXISTS )?"wallets"/i.test(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8')));
    expect(creators.length, 'no migration creates the wallets table').toBeGreaterThan(0);
    for (const creator of creators) expect(creator < NAME, `${creator} must come before ${NAME}`).toBe(true);
  });

  it('is not touched, dropped or recreated by any migration that runs after it', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
    const after = dirs.slice(dirs.indexOf(NAME) + 1);
    expect(dirs).toContain(NAME);
    for (const d of after) {
      for (const statement of statements(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8'))) {
        if (!/"wallets"/.test(statement)) continue;
        expect(statement, `${d} touches the wallet look`).not.toMatch(/"(?:image_key|icon_key|color_key)"/);
      }
    }
  });

  it('has a rollback that removes the same three columns and forgets the migration, and nothing else', () => {
    expect(statements(sqlOf('rollback.sql'))).toEqual([
      'ALTER TABLE "wallets" DROP COLUMN IF EXISTS "image_key", DROP COLUMN IF EXISTS "icon_key", DROP COLUMN IF EXISTS "color_key"',
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}'`,
    ]);
  });
});

describe('the schema', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const wallet = schema.slice(schema.indexOf('model Wallet {'), schema.indexOf('@@map("wallets")'));

  it('Wallet carries the three columns under the same names, each nullable text', () => {
    expect(wallet).toMatch(/\bimageKey\s+String\?\s+@map\("image_key"\)/);
    expect(wallet).toMatch(/\biconKey\s+String\?\s+@map\("icon_key"\)/);
    expect(wallet).toMatch(/\bcolorKey\s+String\?\s+@map\("color_key"\)/);
  });

  it('and not one of them has a default, a constraint or an index of its own', () => {
    for (const field of ['imageKey', 'iconKey', 'colorKey']) {
      const line = wallet.split('\n').find((l) => new RegExp(`^\\s+${field}\\s`).test(l)) ?? '';
      expect(line, field).not.toMatch(/@default|@unique|@id|@db\./);
    }
    expect(wallet).not.toMatch(/@@(?:index|unique)\([^)]*(?:imageKey|iconKey|colorKey)/);
  });
});
