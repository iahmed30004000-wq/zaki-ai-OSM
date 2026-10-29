import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_CATALOG_KEYS } from './permission-catalog';
import { sightWhere, type TrackingSight } from './tracking-sight';

/**
 * «عرض المرتجعات في المتابعة» (ops.returns_view) — GRANTED ON THE DAY, NOT LEFT FOR SOMEBODY TO NOTICE.
 *
 * Until now every holder of «متابعة الشحن» saw the return rows. Seeing them is a key of its own now, and the owner's
 * default (28/10) is that it goes to the roles that hold «المرتجعات» plus the delivery manager — so nobody who chases
 * parcels loses them on the deploy, and he unticks the key per role afterwards.
 *
 * ⚠️ There is no database in CI, so the migration is read here as text, and the people it would leave without rows are
 * worked out from the system templates the migrations seed. The migration was ALSO run against the local database inside
 * a transaction that was rolled back, over fixture people — before and after compared; that measurement is in the pull
 * request and is the stronger evidence.
 */

const MIGRATIONS = path.join(process.cwd(), 'prisma', 'migrations');
const DIR = path.join(MIGRATIONS, '20261029000000_tracking_returns_view_key');
const sql = readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
/** The statements, comments dropped. */
const statements = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);

describe('the key', () => {
  it('is in the catalog, so the owner can tick it per role', () => {
    expect(ALL_CATALOG_KEYS.has('ops.returns_view')).toBe(true);
  });
});

describe('the migration: only adds, only where it should, only what it can take back', () => {
  it('only adds rows — nothing is changed, removed or altered — and each steps aside for a row already there', () => {
    expect(statements).toHaveLength(5);
    for (const s of statements) {
      expect(s.startsWith('INSERT INTO'), s.slice(0, 60)).toBe(true);
      expect(s).not.toMatch(/\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b/i);
      expect(s).toMatch(/ON CONFLICT \("(roleId|userId)", "permission"\) DO NOTHING$/);
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'trv-' || gen_random_uuid()::text`);
      expect(s).toContain(`'ops.returns_view'`);
    }
  });

  it('writes the key in all three places a grant lives — the role, its baseline, and the person', () => {
    const into = statements.map((s) => s.match(/^INSERT INTO "(\w+)"/)?.[1]);
    expect(into.filter((t) => t === 'role_permissions')).toHaveLength(2);
    expect(into.filter((t) => t === 'role_permission_defaults')).toHaveLength(2);
    expect(into.filter((t) => t === 'user_permissions')).toHaveLength(1);
  });

  it('is granted FROM «المرتجعات» and to the delivery manager — and from nothing else', () => {
    const sources = statements.flatMap((s) => [...s.matchAll(/"permission" = '([a-z_.]+)'/g)].map((m) => m[1]));
    expect(new Set(sources)).toEqual(new Set(['ops.returns']));
    expect(statements.filter((s) => s.includes(`"name" = 'DELIVERY_MANAGER'`))).toHaveLength(2);
  });

  it('carries a person’s «سماح», keeps its scope, and writes nothing for SUPER_ADMIN, who passes everything anyway', () => {
    const person = statements.find((s) => s.startsWith('INSERT INTO "user_permissions"'))!;
    expect(person).toContain(`'ALLOW'`);
    expect(person).toContain('a."scope", a."scopeIds"');
    expect(person).toContain(`a."effect" = 'ALLOW'`);
    expect(person).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('NEGATIVE: carries no «منع» — a refusal to RECEIVE stock never hid a row from the follow-up screen', () => {
    for (const s of statements) expect(s).not.toContain(`'DENY'`);
  });

  it('NEGATIVE: never writes a baseline for a role that has none — a lone row would make «إرجاع للافتراضي» wipe the role', () => {
    const delivery = statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"') && s.includes('DELIVERY_MANAGER'))!;
    expect(delivery).toMatch(/EXISTS \(SELECT 1 FROM "role_permission_defaults" b WHERE b\."roleId" = r\."id"\)/);
  });

  it('its rollback removes only what it wrote', () => {
    const rollback = readFileSync(path.join(DIR, 'rollback.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    const deletes = rollback.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'trv-%'`);
    expect(deletes[3]).toContain(`'20261029000000_tracking_returns_view_key'`);
  });
});

/**
 * THE SYSTEM TEMPLATES, AS THE MIGRATIONS SEED THEM — the roles every new company is cut from.
 * (A company's own copies, and the people with exceptions, are the owner's data: see the read-only query in the pull request.)
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

/** What each template holds after the migration: the key from «المرتجعات», and the delivery manager. */
function afterTheMigration(before: Map<string, Set<string>>): Map<string, Set<string>> {
  const after = new Map([...before].map(([r, keys]) => [r, new Set(keys)]));
  for (const [role, keys] of after) if (keys.has('ops.returns') || role === 'DELIVERY_MANAGER') keys.add('ops.returns_view');
  if (!after.has('DELIVERY_MANAGER')) after.set('DELIVERY_MANAGER', new Set(['ops.returns_view']));
  return after;
}

const sightOf = (keys: Set<string>): TrackingSight => ({
  money: keys.has('settlement.view') || keys.has('finance.cashbox'),
  returns: keys.has('ops.returns_view'),
  collect: keys.has('finance.cashbox'),
});
/** What the follow-up screen showed everybody who held «متابعة الشحن», before this change. */
const EVERYTHING: TrackingSight = { money: true, returns: true, collect: true };

describe('WHO LOSES ROWS OR FIGURES AFTER THE DEPLOY — the system templates', () => {
  const before = templates();
  const after = afterTheMigration(before);
  const trackers = [...before].filter(([, keys]) => keys.has('ops.track')).map(([role]) => role).sort();

  it('reads the templates it claims to: the follow-up roles are the ones the migrations seed', () => {
    expect(trackers).toEqual(['COMPANY_ADMIN', 'DELIVERY_MANAGER', 'MANAGER']);
    expect(before.get('DELIVERY_MANAGER')!.has('ops.returns')).toBe(false);
    expect(before.get('WAREHOUSE')!.has('ops.returns')).toBe(true);
  });

  it('NOBODY loses the return rows: every template that follows parcels holds the new key', () => {
    const lose = trackers.filter((role) => !sightOf(after.get(role)!).returns);
    expect(lose).toEqual([]);
  });

  it('the warehouse, which receives returns but never followed parcels, gets the key too — it changes nothing it could see', () => {
    expect(after.get('WAREHOUSE')!.has('ops.returns_view')).toBe(true);
  });

  it('and WITHOUT the migration the same templates would have lost them — the test can tell', () => {
    const lose = trackers.filter((role) => !sightOf(before.get(role)!).returns);
    expect(lose).toEqual(['COMPANY_ADMIN', 'DELIVERY_MANAGER', 'MANAGER']);
  });

  it('the courier’s money: the roles that follow parcels and hold neither «عرض التسويات» nor «إدارة الصناديق النقدية» lose the collection rows and the figures — named here, on purpose', () => {
    const lose = trackers.filter((role) => !sightOf(after.get(role)!).money);
    expect(lose).toEqual(['DELIVERY_MANAGER', 'MANAGER']);
    // …and the owner’s company admin does not.
    expect(sightOf(after.get('COMPANY_ADMIN')!)).toEqual(EVERYTHING);
  });

  it('acting on the money is «إدارة الصناديق النقدية» alone — settlement.view does not open the bar', () => {
    expect(sightOf(new Set(['settlement.view']))).toEqual({ money: true, returns: false, collect: false });
    expect(sightOf(new Set(['finance.cashbox']))).toEqual({ money: true, returns: false, collect: true });
  });

  it('what a template with neither level is asked: the delivered and the returned parcels are left out of the question', () => {
    expect(sightWhere(sightOf(new Set(['ops.track'])))).toEqual({
      shippingStatus: { notIn: ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] },
    });
  });
});
