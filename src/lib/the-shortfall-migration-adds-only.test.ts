import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_CATALOG_KEYS } from './permission-catalog';

/**
 * «فرق التحصيل على الموظف» — THE MIGRATION ADDS, LOOSENS ONE INDEX, AND GRANTS TWO KEYS TO ONE ROLE.
 *
 * ⚠️ There is no database in CI, so the migration is read here as text. It was ALSO run against the local database
 * inside a transaction that was rolled back, over fixture people — before and after compared; that measurement is in
 * the pull request and is the stronger evidence. It reaches production with the first Redeploy (docker-entrypoint.sh
 * runs `prisma migrate deploy` at every start), which is safe because it only adds and can run twice; applying it by
 * hand first (`prisma db execute`, then `prisma migrate resolve --applied`) is optional.
 */

const MIGRATIONS = path.join(process.cwd(), 'prisma', 'migrations');
const NAME = '20261029120000_shortfall_penalty';
const DIR = path.join(MIGRATIONS, NAME);
const sql = readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
/** The text with comments dropped — what the database would run. */
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');
const statements = code.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
const schema = readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');

describe('the schema half', () => {
  it('adds the four columns, all nullable, with no default and no NOT NULL — no existing row changes', () => {
    const adds = statements.filter((s) => /^ALTER TABLE .* ADD COLUMN/.test(s));
    expect(adds).toHaveLength(4);
    expect(adds.join('\n')).toContain('"settlement_match_id" TEXT');
    expect(adds.join('\n')).toContain('"settled_amount" DECIMAL(14,3)');
    expect(adds.join('\n')).toContain('"settled_currency" TEXT');
    expect(adds.join('\n')).toContain('"settled_rate" DECIMAL(14,6)');
    for (const a of adds) {
      expect(a).toContain('IF NOT EXISTS');
      expect(a).not.toMatch(/NOT NULL|DEFAULT/i);
    }
  });

  it('the money columns keep the fils: three places for an amount, six for a rate', () => {
    expect(code).not.toMatch(/DECIMAL\(\d+,\s*[012]\)/);
    expect(code).not.toMatch(/numeric\(\d+,\s*[012]\)/i);
  });

  it('ties a charge to a statement line with a RESTRICT key — a line with a charge cannot be deleted from under it', () => {
    const fk = statements.find((s) => s.includes('penalties_settlement_match_id_fkey') && s.includes('ADD CONSTRAINT'))!;
    expect(fk).toContain('FOREIGN KEY ("settlement_match_id") REFERENCES "settlement_matches"("id") ON DELETE RESTRICT');
    // Idempotent: it checks before adding.
    expect(fk).toContain('IF NOT EXISTS (SELECT 1 FROM pg_constraint');
  });

  it('keeps ONE live charge per statement line — partial, on live rows with a line', () => {
    const idx = statements.find((s) => s.includes('"penalties_one_live_per_match"'))!;
    expect(idx).toMatch(/^CREATE UNIQUE INDEX IF NOT EXISTS/);
    expect(idx).toContain('("settlement_match_id")');
    expect(idx).toContain(`"status" IN ('PROPOSED', 'APPLIED')`);
    expect(idx).toContain('"settlement_match_id" IS NOT NULL');
  });

  it('narrows the day rule with «AND settlement_match_id IS NULL» and changes nothing else about it', () => {
    const idx = statements.find((s) => s.startsWith('CREATE UNIQUE INDEX "penalties_one_live_per_day"'))!;
    expect(idx).toContain('("company_id", "user_id", "kind", "occurred_on")');
    expect(idx).toContain(`WHERE "status" IN ('PROPOSED', 'APPLIED') AND "settlement_match_id" IS NULL`);
  });

  it('drops that index and nothing else — and creates it again right after, so no moment is without it', () => {
    const drops = statements.filter((s) => /^DROP /.test(s));
    expect(drops).toEqual(['DROP INDEX IF EXISTS "penalties_one_live_per_day"']);
    const order = statements.map((s) => (s.includes('penalties_one_live_per_day') ? (s.startsWith('DROP') ? 'drop' : 'create') : ''));
    expect(order.filter(Boolean)).toEqual(['drop', 'create']);
    // Nothing between the two.
    const at = statements.findIndex((s) => s.startsWith('DROP INDEX'));
    expect(statements[at + 1]).toContain('CREATE UNIQUE INDEX "penalties_one_live_per_day"');
  });

  it('the narrowed index is a RELAXATION of the old one — every set of rows the old allowed, the new allows', () => {
    // Old: UNIQUE(…) WHERE status IN (…). New: the same WHERE with a further condition. A partial unique index over a
    // smaller set of rows can only accept more tables of rows, never fewer.
    const old = readFileSync(path.join(MIGRATIONS, '20260925230000_penalties', 'migration.sql'), 'utf8');
    expect(old).toContain(`WHERE "status" IN ('PROPOSED', 'APPLIED')`);
    const idx = statements.find((s) => s.startsWith('CREATE UNIQUE INDEX "penalties_one_live_per_day"'))!;
    expect(idx).toContain(`"status" IN ('PROPOSED', 'APPLIED')`);
  });

  it('NEGATIVE: removes no data — no DELETE, TRUNCATE, UPDATE, DROP COLUMN or DROP TABLE', () => {
    // («ON DELETE RESTRICT» and «ON UPDATE CASCADE» belong to the key and are not statements.)
    expect(code).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|UPDATE\s+"|DROP\s+COLUMN|DROP\s+TABLE|DROP\s+CONSTRAINT)\b/i);
  });

  it('and is not wrapped in anything that could be mistaken for a reset', () => {
    expect(code).not.toMatch(/\b(DROP\s+(SCHEMA|DATABASE)|RESET|migrate\s+reset)\b/i);
  });

  it('schema.prisma carries the same columns and names the index it cannot express', () => {
    expect(schema).toMatch(/settlementMatchId\s+String\?\s+@map\("settlement_match_id"\)/);
    expect(schema).toMatch(/settlementMatch\s+SettlementMatch\?\s+@relation\(fields: \[settlementMatchId\], references: \[id\], onDelete: Restrict\)/);
    expect(schema).toMatch(/settledAmount\s+Decimal\?\s+@map\("settled_amount"\)\s+@db\.Decimal\(14, 3\)/);
    expect(schema).toMatch(/settledCurrency\s+String\?\s+@map\("settled_currency"\)/);
    expect(schema).toMatch(/settledRate\s+Decimal\?\s+@map\("settled_rate"\)\s+@db\.Decimal\(14, 6\)/);
    expect(schema).toContain('penalties_one_live_per_match');
    expect(schema).toContain('AND settlement_match_id IS NULL');
  });
});

describe('the grant half', () => {
  const inserts = statements.filter((s) => s.startsWith('INSERT INTO'));

  it('only adds rows, each stepping aside for a row already there, each tagged for the rollback', () => {
    expect(inserts).toHaveLength(2);
    for (const s of inserts) {
      expect(s).toMatch(/ON CONFLICT \("roleId", "permission"\) DO NOTHING$/);
      expect(s).toContain(`'sfl-' || gen_random_uuid()::text`);
    }
  });

  it('grants the two keys that exist in the catalog — and no new key is invented', () => {
    expect(ALL_CATALOG_KEYS.has('penalties.view')).toBe(true);
    expect(ALL_CATALOG_KEYS.has('penalties.decide')).toBe(true);
    for (const s of inserts) {
      expect(s).toContain(`('penalties.view'), ('penalties.decide')`);
      expect([...s.matchAll(/'([a-z]+\.[a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(['penalties.decide', 'penalties.view']);
    }
  });

  it('goes to the ACCOUNTANT and to no other role', () => {
    for (const s of inserts) {
      expect(s).toContain(`r."name" = 'ACCOUNTANT'`);
      expect([...s.matchAll(/r\."name" = '([A-Z_]+)'/g)].map((m) => m[1])).toEqual(['ACCOUNTANT']);
    }
  });

  it('NEGATIVE: carries no «منع», touches no person’s own exceptions and grants no payroll key', () => {
    for (const s of inserts) {
      expect(s).not.toContain('DENY');
      expect(s).not.toContain('payroll.');
    }
    expect(code).not.toContain('"user_permissions"');
  });

  it('NEGATIVE: never writes a baseline for a role that has none — a lone row would make «إرجاع للافتراضي» wipe the role', () => {
    const baseline = inserts.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!;
    expect(baseline).toMatch(/EXISTS \(SELECT 1 FROM "role_permission_defaults" b WHERE b\."roleId" = r\."id"\)/);
    // The role table it reads is the one «roles» — and the step that ASSUMED a baseline everywhere is not here.
    expect(baseline).not.toMatch(/SELECT[^;]*FROM "role_permission_defaults" d\s+WHERE d\./);
  });

  it('its rollback removes only what it wrote, and refuses to drop a column that holds a charge', () => {
    const rollback = readFileSync(path.join(DIR, 'rollback.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    const deletes = rollback.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(3);
    for (const d of deletes.slice(0, 2)) expect(d).toContain(`"id" LIKE 'sfl-%'`);
    expect(deletes[2]).toContain(`'${NAME}'`);
    // The schema half is guarded: a charge tied to a line, or a converted payslip, stops it.
    expect(rollback).toMatch(/IF EXISTS \(SELECT 1 FROM "penalties" WHERE "settlement_match_id" IS NOT NULL\)\s+THEN\s+RAISE EXCEPTION/);
    expect(rollback).toMatch(/IF EXISTS \(SELECT 1 FROM "payslips" WHERE "settled_amount" IS NOT NULL[\s\S]*\)\s+THEN\s+RAISE EXCEPTION/);
    // …and the guard comes BEFORE the first column is dropped.
    expect(rollback.indexOf('RAISE EXCEPTION')).toBeLessThan(rollback.indexOf('DROP COLUMN'));
  });
});

/**
 * THE SYSTEM TEMPLATES, AS THE MIGRATIONS SEED THEM — the roles every new company is cut from.
 */
function templates(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const give = (role: string, key: string) => out.set(role, (out.get(role) ?? new Set<string>()).add(key));

  const engine = readFileSync(path.join(MIGRATIONS, '20260909093141_permission_engine', 'migration.sql'), 'utf8');
  const nameOf = new Map<string, string>();
  for (const m of engine.matchAll(/INSERT INTO roles \(id, "companyId", name, "isSystem"[^)]*\) VALUES \('([^']+)', NULL, '([^']+)'/g)) nameOf.set(m[1], m[2]);
  for (const m of engine.matchAll(/INSERT INTO role_permissions \(id, "roleId", permission, scope\) VALUES \('[^']+', '([^']+)', '([^']+)'/g)) {
    const role = nameOf.get(m[1]);
    if (role) give(role, m[2]);
  }
  const stage2 = readFileSync(path.join(MIGRATIONS, '20260919205403_stage2_store_scope_roles', 'migration.sql'), 'utf8');
  for (const m of stage2.matchAll(/\(\s*'([A-Z_]+)',\s*'([a-z_]+\.[a-z_]+)',\s*'ALL_COMPANY'\s*\)/g)) give(m[1], m[2]);
  return out;
}

describe('WHO HOLDS THE KEYS AFTER THE DEPLOY — the system templates', () => {
  const before = templates();

  it('reads the templates it claims to: the accountant is one of them', () => {
    expect(before.has('ACCOUNTANT')).toBe(true);
    expect(before.get('ACCOUNTANT')!.size).toBeGreaterThan(3);
  });

  it('before it NO template holds penalties.decide — the accountant could not have waived anything', () => {
    for (const [role, keys] of before) expect(keys.has('penalties.decide'), role).toBe(false);
  });

  it('after it ONLY the accountant does, and she also sees the list she decides from', () => {
    // The roles the migration names, read from its own text, are given the two keys.
    const named = new Set([...code.matchAll(/r\."name" = '([A-Z_]+)'/g)].map((m) => m[1]));
    const after = new Map([...before].map(([role, keys]) => [role, new Set(keys)]));
    for (const role of named) {
      const keys = after.get(role) ?? new Set<string>();
      keys.add('penalties.view');
      keys.add('penalties.decide');
      after.set(role, keys);
    }
    expect([...after].filter(([, keys]) => keys.has('penalties.decide')).map(([role]) => role)).toEqual(['ACCOUNTANT']);
    expect([...after].filter(([, keys]) => keys.has('penalties.view')).map(([role]) => role)).toEqual(['ACCOUNTANT']);
  });

  it('NOBODY loses a key: the migration removes nothing, so every template keeps what it had', () => {
    expect(code).not.toMatch(/DELETE\s+FROM|REVOKE/i);
  });
});
