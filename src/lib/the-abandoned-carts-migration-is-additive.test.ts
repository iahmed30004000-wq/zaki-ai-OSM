import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `20261115120000_abandoned_carts` IS TWO NEW TABLES AND NOTHING ELSE, AND THE SCHEMA AND THE ROLLBACK AGREE (15/11).
 *
 * It runs by itself at the owner's Redeploy (`prisma migrate deploy`), so what it may do is pinned by reading it: it
 * creates `abandoned_carts` and `abandoned_cart_activities`, their indexes, and their foreign keys — guarded, so a second
 * run changes nothing. It writes no row, drops nothing, and alters no existing table. There is no database here to run it
 * against, so every statement is read, and the Prisma models it has to match are read beside it.
 */

const NAME = '20261115120000_abandoned_carts';
const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const sqlOf = (file: string) => readFileSync(join(MIGRATIONS, NAME, file), 'utf8');
const code = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

describe('the migration', () => {
  const migration = sqlOf('migration.sql');
  const body = code(migration);

  it('creates exactly the two tables, both IF NOT EXISTS', () => {
    expect(body.match(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)).toEqual([
      'CREATE TABLE IF NOT EXISTS "abandoned_carts"',
      'CREATE TABLE IF NOT EXISTS "abandoned_cart_activities"',
    ]);
    expect(body.match(/CREATE TABLE/g)).toHaveLength(2);
  });

  it('NEGATIVE: it writes no row and destroys, rewrites or retypes nothing', () => {
    for (const forbidden of [
      /\bDROP\b/i, /(?<!ON )\bDELETE\b/i, /(?<!ON )\bUPDATE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /\bRENAME\b/i, /\bALTER COLUMN\b/i,
      /\bADD COLUMN\b/i, /\bCOPY\b/i, /\bSELECT\b(?![\s\S]{0,10}1 FROM pg_constraint)/i,
    ]) {
      expect(body, String(forbidden)).not.toMatch(forbidden);
    }
    // The only tables it alters are its own two (to add their foreign keys).
    const altered = new Set([...body.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]));
    expect([...altered].sort()).toEqual(['abandoned_cart_activities', 'abandoned_carts']);
  });

  it('every index says IF NOT EXISTS, and every constraint is added only if pg_constraint does not hold it', () => {
    for (const m of body.matchAll(/CREATE (UNIQUE )?INDEX[^;]+;/g)) expect(m[0]).toContain('IF NOT EXISTS');
    const adds = [...body.matchAll(/ADD CONSTRAINT "(\w+)"/g)].map((m) => m[1]);
    expect(adds).toHaveLength(8);
    for (const name of adds) expect(body, name).toContain(`conname = '${name}'`);
  });

  it('a cart is unique per company and externalId, and goes with its company; a product, region, order or person that goes leaves it', () => {
    expect(body).toMatch(/UNIQUE INDEX IF NOT EXISTS "abandoned_carts_companyId_externalId_key"\s+ON "abandoned_carts" \("companyId", "externalId"\)/);
    expect(body).toMatch(/"abandoned_carts_companyId_fkey"\s+FOREIGN KEY \("companyId"\) REFERENCES "companies"\("id"\) ON DELETE CASCADE/);
    for (const [col, table] of [['productId', 'products'], ['regionId', 'regions'], ['orderId', 'orders'], ['assignedToId', 'users']]) {
      expect(body).toMatch(new RegExp(`FOREIGN KEY \\("${col}"\\) REFERENCES "${table}"\\("id"\\) ON DELETE SET NULL`));
    }
    expect(body).toMatch(/"abandoned_cart_activities_cartId_fkey"\s+FOREIGN KEY \("cartId"\) REFERENCES "abandoned_carts"\("id"\) ON DELETE CASCADE/);
  });

  it('runs after every migration that creates a table it points at', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort();
    const sql = (d: string) => readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8');
    for (const table of ['companies', 'products', 'regions', 'orders', 'users']) {
      const creators = dirs.filter((d) => new RegExp(`CREATE TABLE (IF NOT EXISTS )?"${table}"`, 'i').test(sql(d)));
      expect(creators.length, `no migration creates ${table}`).toBeGreaterThan(0);
      for (const c of creators) expect(c < NAME, `${c} must come before ${NAME}`).toBe(true);
    }
  });
});

describe('the rollback', () => {
  it('drops the two tables, forgets the migration, and touches nothing else', () => {
    const statements = code(sqlOf('rollback.sql'))
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    expect(statements).toEqual([
      'DROP TABLE IF EXISTS "abandoned_cart_activities"',
      'DROP TABLE IF EXISTS "abandoned_carts"',
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}'`,
    ]);
    expect(sqlOf('rollback.sql')).toContain('redeploy the old release, THEN run this file');
  });
});

describe('the schema', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const model = (name: string) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf('\n}\n', schema.indexOf(`model ${name} {`)));

  it('AbandonedCart is mapped to the table, unique per company and externalId', () => {
    const cart = model('AbandonedCart');
    expect(cart).toMatch(/@@map\("abandoned_carts"\)/);
    expect(cart).toMatch(/@@unique\(\[companyId, externalId\]\)/);
    expect(cart).toMatch(/status\s+String\s+@default\("NEW"\)/);
    expect(cart).toMatch(/attempts\s+Int\s+@default\(0\)/);
    expect(cart).toMatch(/source\s+String\s+@default\("LANDING_PAGE"\)/);
  });

  it('AbandonedCartActivity is mapped to its table and goes with its cart', () => {
    const line = model('AbandonedCartActivity');
    expect(line).toMatch(/@@map\("abandoned_cart_activities"\)/);
    expect(line).toMatch(/cart\s+AbandonedCart\s+@relation\(fields: \[cartId\], references: \[id\], onDelete: Cascade\)/);
  });
});
