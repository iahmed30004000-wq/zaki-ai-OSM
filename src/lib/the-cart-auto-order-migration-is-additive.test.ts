import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `20261117120000_abandoned_cart_auto_order` IS ONE NULLABLE COLUMN AND NOTHING ELSE, AND THE SCHEMA AND THE ROLLBACK AGREE.
 *
 * It runs by itself at the owner's Redeploy (`prisma migrate deploy`), so what it may do is pinned by reading it: it adds
 * `abandoned_carts."autoOrderAt"` — the mark that a cart was taken to become an order by itself (the owner, 17/11) — with
 * no default and no backfill, guarded so a second run changes nothing. It writes no row and touches no other table.
 */

const NAME = '20261117120000_abandoned_cart_auto_order';
const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const sqlOf = (file: string) => readFileSync(join(MIGRATIONS, NAME, file), 'utf8');
const code = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
const statements = (sql: string) =>
  code(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

describe('the migration', () => {
  it('adds the one column, nullable, IF NOT EXISTS — and that is the whole file', () => {
    expect(statements(sqlOf('migration.sql'))).toEqual(['ALTER TABLE "abandoned_carts" ADD COLUMN IF NOT EXISTS "autoOrderAt" TIMESTAMP(3)']);
  });

  it('NEGATIVE: no default, no NOT NULL, no row written, nothing dropped', () => {
    const body = code(sqlOf('migration.sql'));
    for (const forbidden of [/\bDEFAULT\b/i, /\bNOT NULL\b/i, /\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /\bINDEX\b/i]) {
      expect(body, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('runs after the migration that creates the table', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort();
    expect(dirs.indexOf('20261115120000_abandoned_carts')).toBeGreaterThanOrEqual(0);
    expect(dirs.indexOf('20261115120000_abandoned_carts')).toBeLessThan(dirs.indexOf(NAME));
  });
});

describe('the rollback', () => {
  it('drops the one column, forgets the migration, and touches nothing else', () => {
    expect(statements(sqlOf('rollback.sql'))).toEqual([
      'ALTER TABLE "abandoned_carts" DROP COLUMN IF EXISTS "autoOrderAt"',
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}'`,
    ]);
    expect(sqlOf('rollback.sql')).toContain('Run ONLY after the previous release is redeployed');
  });
});

describe('the schema', () => {
  it('AbandonedCart carries the column, optional', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
    const start = schema.indexOf('model AbandonedCart {');
    const model = schema.slice(start, schema.indexOf('\n}\n', start));
    expect(model).toMatch(/\n\s+autoOrderAt\s+DateTime\?\s*\n/);
  });
});
