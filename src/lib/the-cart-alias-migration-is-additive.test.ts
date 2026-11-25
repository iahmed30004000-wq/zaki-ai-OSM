import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `20261121120000_abandoned_cart_aliases` IS ONE NEW TABLE AND NOTHING ELSE, AND THE SCHEMA AND THE ROLLBACK AGREE (21/11).
 *
 * It runs by itself at the owner's Redeploy (`prisma migrate deploy`), so what it may do is pinned by reading it: it creates
 * `abandoned_cart_aliases` — a second visit's externalId folded into the customer's open cart for the same product — its
 * indexes and its two foreign keys, guarded so a second run changes nothing. It writes no row, drops nothing, and alters
 * no existing table.
 */

const NAME = '20261121120000_abandoned_cart_aliases';
const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const sqlOf = (file: string) => readFileSync(join(MIGRATIONS, NAME, file), 'utf8');
const code = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

describe('the migration', () => {
  const body = code(sqlOf('migration.sql'));

  it('creates exactly the one table, IF NOT EXISTS', () => {
    expect(body.match(/CREATE TABLE[^"]*"(\w+)"/g)).toEqual(['CREATE TABLE IF NOT EXISTS "abandoned_cart_aliases"']);
  });

  it('NEGATIVE: it writes no row and destroys, rewrites or retypes nothing; it alters only its own table', () => {
    for (const forbidden of [
      /\bDROP\b/i, /(?<!ON )\bDELETE\b/i, /(?<!ON )\bUPDATE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /\bRENAME\b/i, /\bALTER COLUMN\b/i,
      /\bADD COLUMN\b/i, /\bCOPY\b/i, /\bSELECT\b(?![\s\S]{0,10}1 FROM pg_constraint)/i,
    ]) {
      expect(body, String(forbidden)).not.toMatch(forbidden);
    }
    const altered = new Set([...body.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]));
    expect([...altered]).toEqual(['abandoned_cart_aliases']);
  });

  it('every index says IF NOT EXISTS; every constraint is added only if pg_constraint does not hold it', () => {
    for (const m of body.matchAll(/CREATE (UNIQUE )?INDEX[^;]+;/g)) expect(m[0]).toContain('IF NOT EXISTS');
    const adds = [...body.matchAll(/ADD CONSTRAINT "(\w+)"/g)].map((m) => m[1]);
    expect(adds).toEqual(['abandoned_cart_aliases_companyId_fkey', 'abandoned_cart_aliases_cartId_fkey']);
    for (const name of adds) expect(body, name).toContain(`conname = '${name}'`);
  });

  it('an alias is unique per company and externalId, and goes with its cart and its company', () => {
    expect(body).toMatch(/UNIQUE INDEX IF NOT EXISTS "abandoned_cart_aliases_companyId_externalId_key"\s+ON "abandoned_cart_aliases" \("companyId", "externalId"\)/);
    expect(body).toMatch(/FOREIGN KEY \("companyId"\) REFERENCES "companies"\("id"\) ON DELETE CASCADE/);
    expect(body).toMatch(/FOREIGN KEY \("cartId"\) REFERENCES "abandoned_carts"\("id"\) ON DELETE CASCADE/);
  });

  it('runs after the migration that creates the carts table', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort();
    expect(dirs.indexOf('20261115120000_abandoned_carts')).toBeGreaterThanOrEqual(0);
    expect(dirs.indexOf('20261115120000_abandoned_carts')).toBeLessThan(dirs.indexOf(NAME));
  });
});

describe('the rollback', () => {
  it('drops the one table, forgets the migration, and touches nothing else', () => {
    const statements = code(sqlOf('rollback.sql'))
      .split(';')
      .map((x) => x.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    expect(statements).toEqual([
      'DROP TABLE IF EXISTS "abandoned_cart_aliases"',
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}'`,
    ]);
    expect(sqlOf('rollback.sql')).toContain('redeploy the old release, THEN run this file');
  });
});

describe('the schema', () => {
  it('AbandonedCartAlias is mapped to the table, unique per company and externalId, and goes with its cart', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
    const start = schema.indexOf('model AbandonedCartAlias {');
    expect(start).toBeGreaterThan(0);
    const model = schema.slice(start, schema.indexOf('\n}\n', start));
    expect(model).toMatch(/@@map\("abandoned_cart_aliases"\)/);
    expect(model).toMatch(/@@unique\(\[companyId, externalId\]\)/);
    expect(model).toMatch(/cart\s+AbandonedCart\s+@relation\(fields: \[cartId\], references: \[id\], onDelete: Cascade\)/);
  });
});
