import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `20261113120000_partners_and_draws` IS ONE NEW TABLE AND TWO NULLABLE COLUMNS, AND THE SCHEMA, THE CODE AND THE ROLLBACK AGREE (13/11).
 *
 * The migration runs by itself at the owner's Redeploy (`prisma migrate deploy`), so what it may do is pinned by reading it: it
 * creates the partners table, adds two nullable columns without a default to `wallet_movements`, and adds the foreign keys and the one
 * CHECK of a share — guarded, so a second run changes nothing. It writes no row (the four partners are typed on the settings card and
 * saved by the owner's press), drops nothing, changes no existing column, and gives no existing row a value. There is no database here to
 * run it against, so every statement is read and the schema models it has to match are read beside it.
 */

const NAME = '20261113120000_partners_and_draws';
const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const sqlOf = (file: string) => readFileSync(join(MIGRATIONS, NAME, file), 'utf8');
const code = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
/** The statements of a file, comments gone, a DO block kept whole (its inner semicolons are not statement ends). */
const statements = (sql: string) => {
  const blocks: string[] = [];
  const flat = code(sql).replace(/DO \$\$[\s\S]*?END \$\$;/g, (m) => {
    blocks.push(m.replace(/\s+/g, ' ').trim().replace(/;$/, ''));
    return `__BLOCK${blocks.length - 1}__;`;
  });
  return flat
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('__BLOCK') ? blocks[Number(/__BLOCK(\d+)__/.exec(s)![1])] : s));
};

describe('the migration', () => {
  const migration = sqlOf('migration.sql');
  const all = statements(migration);

  it('creates the table, adds the two columns, indexes, and holds three guarded constraints — and that is all', () => {
    expect(all).toHaveLength(6);
    const starts = [
      'CREATE TABLE IF NOT EXISTS "partners" (',
      'CREATE UNIQUE INDEX IF NOT EXISTS "partners_companyId_name_key" ON "partners" (',
      'CREATE INDEX IF NOT EXISTS "partners_companyId_isActive_sortOrder_idx" ON "partners" (',
      'ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "partnerId" TEXT, ADD COLUMN IF NOT EXISTS "valueInStoreCurrency" DECIMAL(14,3)',
      'CREATE INDEX IF NOT EXISTS "wallet_movements_partnerId_idx" ON "wallet_movements" (',
      'DO $$ BEGIN IF NOT EXISTS',
    ];
    starts.forEach((start, i) => expect(all[i].startsWith(start), all[i]).toBe(true));
  });

  it('the two new columns are nullable, have no default, and exist only if they are not there', () => {
    const alter = all.find((s) => s.startsWith('ALTER TABLE "wallet_movements"'))!;
    expect(alter.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(2);
    expect(alter.match(/ADD COLUMN/g)).toHaveLength(2);
    expect(alter).toContain('"partnerId" TEXT');
    expect(alter).toContain('"valueInStoreCurrency" DECIMAL(14,3)');
    expect(alter).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it('NEGATIVE: it writes no row and destroys, rewrites or retypes nothing', () => {
    const body = code(migration);
    // «ON DELETE» and «ON UPDATE» are the foreign keys' rules, not statements.
    for (const forbidden of [
      /\bDROP\b/i, /(?<!ON )\bDELETE\b/i, /(?<!ON )\bUPDATE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /\bRENAME\b/i, /\bALTER COLUMN\b/i,
      /\bSET NOT NULL\b/i, /\bSET DEFAULT\b/i, /\bCOPY\b/i, /\bSELECT\b(?![\s\S]{0,10}1 FROM pg_constraint)/i,
    ]) {
      expect(body, String(forbidden)).not.toMatch(forbidden);
    }
    // the only table it alters is the movements one, the only one it creates is partners
    expect(body.match(/ALTER TABLE "(\w+)"/g)?.sort()).toEqual([
      'ALTER TABLE "partners"', 'ALTER TABLE "partners"', 'ALTER TABLE "wallet_movements"', 'ALTER TABLE "wallet_movements"',
    ]);
    expect(body.match(/CREATE TABLE/g)).toHaveLength(1);
  });

  it('every CREATE says IF NOT EXISTS, and every constraint is added only if pg_constraint does not hold it already', () => {
    for (const s of all.filter((x) => /^CREATE (UNIQUE )?(INDEX|TABLE)/.test(x))) expect(s, s).toContain('IF NOT EXISTS');
    const block = all.find((s) => s.startsWith('DO $$'))!;
    const adds = block.match(/ADD CONSTRAINT "[\w]+"/g) ?? [];
    expect(adds).toHaveLength(3);
    for (const a of adds) {
      const name = /"([\w]+)"/.exec(a)![1];
      expect(block, name).toContain(`conname = '${name}'`);
    }
  });

  it('the foreign keys: a company takes its partners with it; a partner a movement names cannot be deleted', () => {
    expect(migration).toMatch(/"partners_companyId_fkey"\s+FOREIGN KEY \("companyId"\) REFERENCES "companies"\("id"\) ON DELETE CASCADE/);
    expect(migration).toMatch(/"wallet_movements_partnerId_fkey"\s+FOREIGN KEY \("partnerId"\) REFERENCES "partners"\("id"\) ON DELETE RESTRICT/);
  });

  it('the share is held to (0, 100] by a CHECK, which Prisma cannot express and the schema therefore leaves to this file', () => {
    expect(migration).toMatch(/CHECK \("sharePercent" > 0 AND "sharePercent" <= 100\)/);
  });

  it('the partners table is exactly the Prisma model: names, types, defaults, the unique name and the index', () => {
    const create = all[0];
    for (const column of [
      '"id" TEXT NOT NULL', '"companyId" TEXT NOT NULL', '"name" TEXT NOT NULL', '"sharePercent" DECIMAL(5,2) NOT NULL',
      '"isActive" BOOLEAN NOT NULL DEFAULT true', '"sortOrder" INTEGER NOT NULL DEFAULT 0', '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      '"updatedAt" TIMESTAMP(3) NOT NULL', 'CONSTRAINT "partners_pkey" PRIMARY KEY ("id")',
    ]) {
      expect(create, column).toContain(column);
    }
    expect(all.find((s) => s.includes('partners_companyId_name_key'))).toContain('("companyId", "name")');
    expect(all.find((s) => s.includes('partners_companyId_isActive_sortOrder_idx'))).toContain('("companyId", "isActive", "sortOrder")');
  });

  it('runs after the migrations that create the tables it touches, and no migration after it touches its names', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort();
    const sql = (d: string) => readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8');
    for (const table of ['wallet_movements', 'companies']) {
      const creators = dirs.filter((d) => new RegExp(`CREATE TABLE (IF NOT EXISTS )?"${table}"`, 'i').test(sql(d)));
      expect(creators.length, `no migration creates ${table}`).toBeGreaterThan(0);
      for (const c of creators) expect(c < NAME, `${c} must come before ${NAME}`).toBe(true);
    }
    const after = dirs.filter((d) => /^\d{14}_/.test(d)).slice(dirs.filter((d) => /^\d{14}_/.test(d)).indexOf(NAME) + 1);
    for (const d of after) expect(sql(d), d).not.toMatch(/"partners"|valueInStoreCurrency|wallet_movements_partnerId/);
  });
});

describe('the rollback', () => {
  it('removes what the migration added, forgets it, and does nothing else', () => {
    expect(statements(sqlOf('rollback.sql'))).toEqual([
      'ALTER TABLE "wallet_movements" DROP CONSTRAINT IF EXISTS "wallet_movements_partnerId_fkey"',
      'DROP INDEX IF EXISTS "wallet_movements_partnerId_idx"',
      'ALTER TABLE "wallet_movements" DROP COLUMN IF EXISTS "partnerId", DROP COLUMN IF EXISTS "valueInStoreCurrency"',
      'DROP TABLE IF EXISTS "partners"',
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}'`,
    ]);
  });

  it('says what is lost and what is not: the draws stay in their wallets', () => {
    const text = sqlOf('rollback.sql');
    expect(text).toContain('The draws THEMSELVES are not lost');
    expect(text).toContain('redeploy the old release, THEN run this file');
  });
});

describe('the schema and the code it is for', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const model = (name: string) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf('\n}\n', schema.indexOf(`model ${name} {`)));

  it('Partner carries the table’s columns, under the same names, and is mapped to «partners»', () => {
    const partner = model('Partner');
    expect(partner).toMatch(/companyId\s+String/);
    expect(partner).toMatch(/name\s+String/);
    expect(partner).toMatch(/sharePercent\s+Decimal\s+@db\.Decimal\(5, 2\)/);
    expect(partner).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
    expect(partner).toMatch(/sortOrder\s+Int\s+@default\(0\)/);
    expect(partner).toMatch(/updatedAt\s+DateTime\s+@updatedAt/);
    expect(partner).toMatch(/@@unique\(\[companyId, name\]\)/);
    expect(partner).toMatch(/@@index\(\[companyId, isActive, sortOrder\]\)/);
    expect(partner).toMatch(/@@map\("partners"\)/);
    expect(partner).toMatch(/company\s+Company\s+@relation\(fields: \[companyId\], references: \[id\], onDelete: Cascade\)/);
  });

  it('WalletMovement carries the two columns nullable, the relation RESTRICTed and the index', () => {
    const movement = model('WalletMovement');
    expect(movement).toMatch(/partnerId\s+String\?/);
    expect(movement).toMatch(/valueInStoreCurrency\s+Decimal\?\s+@db\.Decimal\(14, 3\)/);
    expect(movement).toMatch(/partner\s+Partner\?\s+@relation\(fields: \[partnerId\], references: \[id\], onDelete: Restrict\)/);
    expect(movement).toMatch(/@@index\(\[partnerId\]\)/);
  });

  it('Company knows its partners', () => {
    expect(model('Company')).toMatch(/partners\s+Partner\[\]/);
  });

  it('no code deletes a partner: there is no partner.delete in src', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name.name) && !/\.test\./.test(name.name) && /\bpartner\.(delete|deleteMany)\(/.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});
