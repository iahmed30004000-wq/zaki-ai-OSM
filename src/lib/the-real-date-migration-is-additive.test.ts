import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `20261122130000_wallet_real_dates` IS TWO NULLABLE COLUMNS, AND THE SCHEMA AND THE ROLLBACK AGREE ON THEM (22/11).
 *
 * It runs by itself at the next Redeploy, on the two tables that hold the money's history: so what it may do is pinned by reading
 * it — add `occurredAt` to `wallet_movements` and to `wallet_transfers`, nullable, no default, no backfill, nothing else.
 * (Proven on a scratch database too: applied twice, rolled back twice, dropped — see the PR.)
 */

const NAME = '20261122130000_wallet_real_dates';
const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const sqlOf = (file: string) => readFileSync(join(MIGRATIONS, NAME, file), 'utf8');
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

describe('the migration', () => {
  it('is exactly two statements: a nullable timestamp on each table, if it is not there', () => {
    expect(statements(sqlOf('migration.sql'))).toEqual([
      'ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3)',
      'ALTER TABLE "wallet_transfers" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3)',
    ]);
  });

  it('NEGATIVE: nothing in it destroys, rewrites, backfills, constrains or indexes', () => {
    const code = statements(sqlOf('migration.sql')).join(' ; ');
    for (const forbidden of [/\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /\bNOT NULL\b/i,
      /\bDEFAULT\b/i, /\bUNIQUE\b/i, /\bINDEX\b/i, /\bCONSTRAINT\b/i, /\bRENAME\b/i, /\bTYPE\b/i, /\bREFERENCES\b/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('the rollback drops exactly those two columns, and nothing else', () => {
    expect(statements(sqlOf('rollback.sql'))).toEqual([
      'ALTER TABLE "wallet_movements" DROP COLUMN IF EXISTS "occurredAt"',
      'ALTER TABLE "wallet_transfers" DROP COLUMN IF EXISTS "occurredAt"',
    ]);
  });

  it('the schema carries the same two nullable fields, on the two models', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    for (const model of ['WalletMovement', 'WalletTransfer']) {
      const start = schema.indexOf(`model ${model} {`);
      const body = schema.slice(start, schema.indexOf('\n}', start));
      expect(body, model).toMatch(/\n\s+occurredAt\s+DateTime\?\s*\r?\n/);
    }
  });

  it('runs after the migration that creates the two tables', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
    const creator = dirs.find((d) => /CREATE TABLE "wallet_movements"/.test(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8')));
    expect(creator && creator < NAME).toBe(true);
  });
});
