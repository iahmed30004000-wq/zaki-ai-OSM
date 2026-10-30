import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OPERATIONS DOORS GET A BOX EACH — AND NOBODY LOSES A DOOR OR GAINS ONE (perm-plan PR-8).
 *
 * Five new keys: ops.batches · ops.deliver · ops.transfer · ops.write_off · ops.return_fee. Before this change each door asked
 * a wider key (ops.ship OR ops.track; ops.track; ops.track; finance.update OR orders.unlock — a catch-chain; ops.returns).
 * The owner's rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 * THE STAND-DOWN DOOR IS NOT IN THIS MIGRATION, on purpose (see src/lib/ops-action-keys.ts): moving it onto orders.cancel would
 * widen that key. The replay therefore also holds that, for EVERYBODY, "can they pass ops.ship" and "can they cancel
 * (orders.cancel)" are exactly what they were: the migration writes no row for either.
 *
 * ⚠️ WHAT THIS FILE IS, SAID PLAINLY. There is no database in CI, so the SQL cannot be run here. Two things are done
 * instead, and neither is the SQL running:
 *   1. the SQL is READ as text — its shape (what it writes, in which order, from which keys) is pinned;
 *   2. the SQL's logic is REPLAYED by `applyTheMigration` below, a statement-for-statement copy over in-memory rows, and
 *      the people it produces are judged by the REAL engine (computeEffectiveGrants + can): for every person and every
 *      door, "could they pass yesterday" must equal "can they pass today".
 * The copy can drift from the SQL; the reviewer's own rehearsal of the SQL inside a rolled-back transaction is the
 * stronger evidence, and the pull request says what was and was not done.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants, can } from './authorization';
import { userCan } from './can';
import { ALL_CATALOG_KEYS, catalogItem, orphanPairs } from './permission-catalog';
import { computeEffectiveGrants, legacyEffectiveKeys, type GrantSource } from './permissions-core';
import { OPS_ACTION_KEYS_FROM } from './ops-action-keys';
import { ROLE_PERMISSIONS } from '../types/auth';
import type { SessionUser } from '@/types/auth';

const NAME = '20261030160000_ops_action_keys';
const DIR = path.join(process.cwd(), 'prisma', 'migrations', NAME);
const sql = readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
const rollback = readFileSync(path.join(DIR, 'rollback.sql'), 'utf8');
const statements = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);
const flat = (s: string) => s.replace(/\s+/g, ' ').replace(/\( /g, '(');

/** The gate table, one row per (box, key the door asked). */
const GATE = OPS_ACTION_KEYS_FROM.flatMap((r) => r.from.map((src) => ({ newKey: r.key, src })));
const NEW_KEYS = OPS_ACTION_KEYS_FROM.map((r) => r.key);
const BRAND_NEW = NEW_KEYS;
const SRC_KEYS = [...new Set(GATE.map((g) => g.src))];

describe('the five new boxes are in the catalog, each with the screen key it sits behind', () => {
  const REQUIRES: Record<string, string> = {
    'ops.batches': '',
    'ops.deliver': 'ops.track',
    'ops.transfer': 'ops.track',
    'ops.write_off': 'ops.track',
    'ops.return_fee': 'ops.returns',
  };

  it('are exactly these five, in the list the migration and the engine fallback read', () => {
    expect([...BRAND_NEW].sort()).toEqual(Object.keys(REQUIRES).sort());
    expect(BRAND_NEW).toHaveLength(5);
    expect(NEW_KEYS).not.toContain('orders.cancel');
  });

  it('can all be ticked on «الصلاحيات», with an Arabic and an English label and the key they sit behind', () => {
    for (const k of BRAND_NEW) {
      const item = catalogItem(k);
      expect(item, k).toBeDefined();
      expect(ALL_CATALOG_KEYS.has(k), k).toBe(true);
      expect(item!.requires ?? '', `${k}: مفتاح الشاشة`).toBe(REQUIRES[k]);
      expect(item!.ar.trim().length, k).toBeGreaterThan(8);
      expect(item!.en.trim().length, k).toBeGreaterThan(8);
      expect(item!.scopes, `${k} بلا مدى`).toBeUndefined();
    }
  });

  it('the batches page opens on ITS box now, and neither the packing key nor the tracking key claims to open it', () => {
    expect(catalogItem('ops.batches')!.opens).toEqual(['دفعات الشحن']);
    expect(catalogItem('ops.ship')!.opens).toEqual(['إنشاء شحنة']);
    expect(catalogItem('ops.track')!.opens).toEqual(['متابعة الشحن']);
  });

  it('NEGATIVE: unticking the tracking screen takes its three actions with it, and the returns screen takes the fee', () => {
    const held = ['ops.deliver', 'ops.transfer', 'ops.write_off'];
    expect(orphanPairs(held).map((p) => p.action).sort()).toEqual([...held].sort());
    expect(orphanPairs([...held, 'ops.track'])).toEqual([]);
    expect(orphanPairs(['ops.return_fee']).map((p) => p.action)).toEqual(['ops.return_fee']);
    expect(orphanPairs(['ops.return_fee', 'ops.returns'])).toEqual([]);
  });

  it('NEGATIVE: ops.deliver is NOT sourced from orders.change_status, and the cancel box is nobody’s source or target', () => {
    expect(OPS_ACTION_KEYS_FROM.find((r) => r.key === 'ops.deliver')!.from).toEqual(['ops.track']);
    expect(OPS_ACTION_KEYS_FROM.some((r) => r.key === 'orders.cancel' || r.from.includes('orders.cancel'))).toBe(false);
    expect(OPS_ACTION_KEYS_FROM.find((r) => r.key === 'ops.write_off')!.from).toEqual(['finance.update', 'orders.unlock']);
    expect(OPS_ACTION_KEYS_FROM.find((r) => r.key === 'ops.batches')!.from).toEqual(['ops.ship', 'ops.track']);
    expect(OPS_ACTION_KEYS_FROM.find((r) => r.key === 'ops.transfer')!.from).toEqual(['ops.track']);
    expect(OPS_ACTION_KEYS_FROM.find((r) => r.key === 'ops.return_fee')!.from).toEqual(['ops.returns']);
    // ops.decide_changes is PR-7's and is not touched here
    expect(NEW_KEYS).not.toContain('ops.decide_changes');
  });
});

describe('the SQL, read as text', () => {
  const grantTables = ['user_permissions', 'role_permissions', 'role_permission_defaults'];

  it('only ADDS rows to the three grant tables — and only drops its own temporary tables', () => {
    const inserts = statements.filter((s) => s.startsWith('INSERT INTO'));
    expect(inserts).toHaveLength(4);
    for (const s of inserts) {
      expect(grantTables).toContain(s.match(/^INSERT INTO "(\w+)"/)![1]);
      expect(s).toMatch(/ON CONFLICT \("(roleId|userId)", "(permission)"\) DO NOTHING$/);
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'op8-' || gen_random_uuid()::text`);
    }
    for (const s of statements.filter((x) => !x.startsWith('INSERT INTO'))) {
      expect(s.startsWith('DROP TABLE IF EXISTS pg_temp.sp8_') || s.startsWith('CREATE TEMP TABLE sp8_'), s.slice(0, 70)).toBe(true);
      if (s.startsWith('DROP')) expect(s).not.toMatch(/\bpublic\b|"(users|roles|role_permissions|user_permissions)"/);
    }
    // the quoted key names are values (finance.update is a key, not a statement): strip them before looking at the words
    for (const s of statements) expect(s.replace(/'[^']*'/g, "''")).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|ALTER)\b/i);
  });

  it('has no BEGIN or COMMIT, so a rehearsal inside a transaction can really be rolled back', () => {
    expect(statements.filter((s) => /^(BEGIN|COMMIT|START TRANSACTION|ROLLBACK)\b/i.test(s))).toEqual([]);
  });

  it('writes the box in all three places a grant lives — the role, its baseline, and the person (both effects)', () => {
    const writes = statements.filter((s) => s.startsWith('INSERT INTO'));
    expect(writes.map((s) => s.match(/^INSERT INTO "(\w+)"/)![1])).toEqual(['user_permissions', 'user_permissions', 'role_permissions', 'role_permission_defaults']);
    expect(writes.filter((s) => s.includes(`'DENY'`))).toHaveLength(1);
    expect(writes.filter((s) => s.includes(`'ALLOW'`))).toHaveLength(1);
  });

  it('takes its snapshot BEFORE the first row is written, and carries the «منع» before anything else', () => {
    const firstInsert = statements.findIndex((s) => s.startsWith('INSERT INTO'));
    const lastSnapshot = Math.max(...statements.map((s, i) => (s.startsWith('CREATE TEMP TABLE') ? i : -1)));
    expect(lastSnapshot).toBeLessThan(firstInsert);
    const deny = statements.findIndex((s) => s.startsWith('INSERT INTO "user_permissions"') && s.includes(`'DENY'`));
    const allow = statements.findIndex((s) => s.startsWith('INSERT INTO "user_permissions"') && s.includes(`'ALLOW'`));
    const roles = statements.findIndex((s) => s.startsWith('INSERT INTO "role_permissions"'));
    const defaults = statements.findIndex((s) => s.startsWith('INSERT INTO "role_permission_defaults"'));
    expect(deny).toBe(firstInsert);
    expect(deny).toBeLessThan(allow);
    expect(allow).toBeLessThan(roles);
    expect(roles).toBeLessThan(defaults);
  });

  it('NEGATIVE: the step-4 error of the old plan cannot happen — no decision reads a row this file wrote', () => {
    for (const s of statements.filter((x) => x.startsWith('INSERT INTO "user_permissions"'))) {
      const reads = s.slice(s.indexOf('SELECT'));
      expect(reads).not.toContain('"role_permissions"');
      expect(reads).not.toContain('"user_permissions"');
      expect(reads).toMatch(/sp8_pass/);
      expect(reads).toMatch(/sp8_has/);
    }
    // a new key may appear only as the LEFT column of the gate table, never in a snapshot of what people hold
    for (const s of statements.filter((x) => x.startsWith('CREATE TEMP TABLE') && !x.startsWith('CREATE TEMP TABLE sp8_gate'))) {
      for (const k of NEW_KEYS) expect(s, `${k} in ${s.slice(0, 40)}`).not.toContain(`'${k}'`);
    }
  });

  it('the gate table is EXACTLY the one the engine fallback reads (OPS_ACTION_KEYS_FROM)', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp8_gate'))!;
    const rows = [...gate.matchAll(/\('([a-z_.]+)',\s*'([a-z_.]+)'\)/g)].map((m) => ({ newKey: m[1], src: m[2] }));
    const key = (r: { newKey: string; src: string }) => `${r.newKey}<${r.src}`;
    expect(rows.map(key).sort()).toEqual(GATE.map(key).sort());
    expect(rows).toHaveLength(7);
  });

  it('NEGATIVE: it takes nothing from orders.change_status and writes nothing for ops.decide_changes or any key of PR-7', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp8_gate'))!;
    expect(gate).not.toContain(`'orders.change_status'`);
    expect(gate).not.toContain(`'ops.decide_changes'`);
    expect(gate).not.toContain(`'orders.cancel'`);
    expect(gate).not.toContain(`'control.change_requests`);
  });

  it('the snapshot of what people hold reads exactly the source keys of the gate table', () => {
    const holds = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp8_holds'))!);
    expect(holds).toContain('h.k IN (SELECT src FROM sp8_gate)');
    expect(holds).toContain(`up."effect" = 'ALLOW'`);
    expect(holds).toContain(`d."effect" = 'DENY'`);
    expect(holds).toContain(`u."role" <> 'SUPER_ADMIN'`);
    // a person's own «سماح» REPLACES the role's row for the same key — the engine's rule — so the role's is read only without one
    expect(holds).toContain(`a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW'`);
  });

  it('the snapshot of who ALREADY holds a box leaves a person row of either kind to decide, else the role', () => {
    const has = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp8_has'))!);
    expect(has).toContain(`up."effect" = 'ALLOW' AND up."permission" IN (SELECT new_key FROM sp8_gate)`);
    expect(has).toContain('rp."permission" IN (SELECT new_key FROM sp8_gate)');
    expect(has).toContain('NOT EXISTS (SELECT 1 FROM "user_permissions" o WHERE o."userId" = ur.uid AND o."permission" = rp."permission")');
  });

  it('the statements that decide a person say exactly what the replay does — a flipped condition is caught HERE, since the replay is a copy', () => {
    const deny = flat(statements.find((s) => s.includes(`'DENY'`) && s.startsWith('INSERT INTO'))!);
    // the role receives the box AND the person did not pass THAT door AND does not already hold the box
    expect(deny).toContain('FROM sp8_user_role ur JOIN sp8_role_gets rg ON rg.rid = ur.rid');
    expect(deny).toContain('WHERE NOT EXISTS (SELECT 1 FROM sp8_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)');
    expect(deny).toContain('AND NOT EXISTS (SELECT 1 FROM sp8_has x WHERE x.uid = ur.uid AND x.k = rg.new_key)');
    const allow = flat(statements.find((s) => s.includes(`'ALLOW'`) && s.startsWith('INSERT INTO'))!);
    // the person passed AND no role of theirs receives the box AND they do not already hold it
    expect(allow).toContain('FROM sp8_pass p WHERE NOT EXISTS (SELECT 1 FROM sp8_user_role ur JOIN sp8_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key WHERE ur.uid = p.uid)');
    expect(allow).toContain('AND NOT EXISTS (SELECT 1 FROM sp8_has x WHERE x.uid = p.uid AND x.k = p.new_key)');
    expect(allow).toContain(`'ALLOW', 'ALL_COMPANY', NULL`);
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!)).toContain('FROM sp8_role_gets rg');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!)).toContain('FROM sp8_default_gets dg');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp8_role_gets'))!)).toContain('FROM "role_permissions" rp JOIN sp8_gate g ON g.src = rp."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp8_default_gets'))!)).toContain('FROM "role_permission_defaults" d JOIN sp8_gate g ON g.src = d."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp8_pass'))!)).toContain('FROM sp8_holds h JOIN sp8_gate g ON g.src = h.k');
  });

  it('reads the role the way the engine reads it, and leaves SUPER_ADMIN alone', () => {
    const ur = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp8_user_role'))!;
    expect(ur).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
    expect(ur).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
    expect(ur).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('its rollback removes only what it wrote, in all three places, and its own row in the migrations table', () => {
    const body = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const deletes = body.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'op8-%'`);
    expect(deletes[3]).toContain(`'${NAME}'`);
    expect(new Set(deletes.slice(0, 3).map((d) => d.match(/FROM "(\w+)"/)![1]))).toEqual(new Set(grantTables));
  });

  it('the tag is its own: no other migration writes ids that start with it', () => {
    const others = [
      '20261027000000_sensitive_settings_own_key', '20261029000000_tracking_returns_view_key', '20261029130000_analytics_view_becomes_reports_view',
      '20261029120000_shortfall_penalty', '20261029150000_settings_split_keys', '20261030120000_ai_assist_key', '20261030130000_order_action_keys',
      '20261030140000_confirmation_split_keys', '20261030150000_finance_split_keys',
    ];
    for (const m of others) {
      const text = readFileSync(path.join(process.cwd(), 'prisma', 'migrations', m, 'migration.sql'), 'utf8');
      expect(text, m).not.toContain(`'op8-'`);
    }
  });

  it('runs after the migrations of the previous permission boxes (#92 #93 #94), so every key it reads is already there', () => {
    expect(NAME > '20261030130000_order_action_keys').toBe(true);
    expect(NAME > '20261030140000_confirmation_split_keys').toBe(true);
    expect(NAME > '20261030150000_finance_split_keys').toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE REPLAY — the SQL's statements, one by one, over in-memory rows.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Scope = 'ALL_COMPANY' | 'OWN' | 'ASSIGNED';
interface Grant { id: string; roleId: string; permission: string; scope: string; scopeIds: unknown[] | null }
interface Rows {
  users: Array<{ id: string; role: string; roleId: string | null }>;
  roles: Array<{ id: string; companyId: string | null; name: string }>;
  rolePerms: Grant[];
  defaults: Grant[];
  userPerms: Array<{ id: string; userId: string; permission: string; effect: 'ALLOW' | 'DENY'; scope: string | null; scopeIds: unknown[] | null }>;
}

const clone = (r: Rows): Rows => JSON.parse(JSON.stringify(r)) as Rows;

/** `sp8_user_role`: (uid, rid) — the engine's own reading of "which role are this person's grants from". */
function userRole(db: Rows) {
  const out: Array<{ uid: string; rid: string }> = [];
  for (const u of db.users) {
    if (u.role === 'SUPER_ADMIN') continue;
    for (const r of db.roles) {
      if ((u.roleId !== null && r.id === u.roleId) || (u.roleId === null && r.companyId === null && r.name === u.role)) {
        out.push({ uid: u.id, rid: r.id });
      }
    }
  }
  return out;
}

type Skip = 'deny' | 'allow' | 'roles' | 'defaults' | 'denied-sources' | 'own-allow-replaces-role' | 'has';

/** Statement-for-statement the SQL of migration.sql. */
function applyTheMigration(before: Rows, skip?: Skip): Rows {
  const db = clone(before);

  // ── the snapshot: everything below is read from `before`, never from rows written here ──
  const ur = userRole(before);
  const superIds = new Set(before.users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.id));
  const denied = (uid: string, k: string) => skip !== 'denied-sources' && before.userPerms.some((d) => d.userId === uid && d.permission === k && d.effect === 'DENY');

  // sp8_holds — a person's own «سماح» REPLACES the role's row for the same key
  const holds: Array<{ uid: string; k: string }> = [];
  for (const up of before.userPerms) {
    if (up.effect === 'ALLOW' && !superIds.has(up.userId) && SRC_KEYS.includes(up.permission) && !denied(up.userId, up.permission)) {
      holds.push({ uid: up.userId, k: up.permission });
    }
  }
  for (const x of ur) {
    for (const rp of before.rolePerms) {
      if (rp.roleId !== x.rid || !SRC_KEYS.includes(rp.permission)) continue;
      if (skip !== 'own-allow-replaces-role' && before.userPerms.some((a) => a.userId === x.uid && a.permission === rp.permission && a.effect === 'ALLOW')) continue;
      if (denied(x.uid, rp.permission)) continue;
      holds.push({ uid: x.uid, k: rp.permission });
    }
  }

  // sp8_has — who ALREADY holds a box: a personal «سماح», or the role's row when the person has no row of their own for it
  const has = new Set<string>();
  if (skip !== 'has') {
    for (const up of before.userPerms) if (up.effect === 'ALLOW' && NEW_KEYS.includes(up.permission)) has.add(`${up.userId}|${up.permission}`);
    for (const x of ur) {
      for (const rp of before.rolePerms) {
        if (rp.roleId !== x.rid || !NEW_KEYS.includes(rp.permission)) continue;
        if (before.userPerms.some((o) => o.userId === x.uid && o.permission === rp.permission)) continue;
        has.add(`${x.uid}|${rp.permission}`);
      }
    }
  }

  // sp8_pass
  const pass = holds.flatMap((h) => GATE.filter((g) => g.src === h.k).map((g) => ({ uid: h.uid, newKey: g.newKey })));

  // sp8_role_gets / sp8_default_gets
  const gets = (table: Grant[]) => table.flatMap((rp) => GATE.filter((g) => g.src === rp.permission).map((g) => ({ rid: rp.roleId, newKey: g.newKey })));
  const roleGets = gets(before.rolePerms);
  const defaultGets = gets(before.defaults);

  let n = 0;
  const id = () => `op8-${++n}`;
  const hasUserRow = (uid: string, k: string) => db.userPerms.some((p) => p.userId === uid && p.permission === k);

  // 1. «منع» — the role receives the box, the person did not pass THAT door, and does not already hold the box.
  for (const x of skip === 'deny' ? [] : ur) {
    for (const rg of roleGets) {
      if (rg.rid !== x.rid) continue;
      if (!pass.some((p) => p.uid === x.uid && p.newKey === rg.newKey) && !has.has(`${x.uid}|${rg.newKey}`) && !hasUserRow(x.uid, rg.newKey)) {
        db.userPerms.push({ id: id(), userId: x.uid, permission: rg.newKey, effect: 'DENY', scope: null, scopeIds: null });
      }
    }
  }
  // 2. «سماح» — the person passed; no role of theirs receives the box; they do not already hold it.
  for (const p of skip === 'allow' ? [] : pass) {
    const roleReceives = ur.some((x) => x.uid === p.uid && roleGets.some((rg) => rg.rid === x.rid && rg.newKey === p.newKey));
    if (!roleReceives && !has.has(`${p.uid}|${p.newKey}`) && !hasUserRow(p.uid, p.newKey)) {
      db.userPerms.push({ id: id(), userId: p.uid, permission: p.newKey, effect: 'ALLOW', scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  // 3. roles
  for (const rg of skip === 'roles' ? [] : roleGets) {
    if (!db.rolePerms.some((p) => p.roleId === rg.rid && p.permission === rg.newKey)) {
      db.rolePerms.push({ id: id(), roleId: rg.rid, permission: rg.newKey, scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  // 4. baselines
  for (const dg of skip === 'defaults' ? [] : defaultGets) {
    if (!db.defaults.some((p) => p.roleId === dg.rid && p.permission === dg.newKey)) {
      db.defaults.push({ id: id(), roleId: dg.rid, permission: dg.newKey, scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  return db;
}

// ── the REAL engine over in-memory rows ──

const sourceOf = (db: Rows): GrantSource => ({
  roleRows: async (u) =>
    db.rolePerms
      .filter((p) =>
        u.roleId
          ? p.roleId === u.roleId
          : db.roles.some((r) => r.id === p.roleId && r.companyId === null && r.name === u.role))
      .map((p) => ({ permission: p.permission, scope: p.scope, scopeIds: p.scopeIds })),
  overrideRows: async (userId) =>
    db.userPerms.filter((p) => p.userId === userId).map((p) => ({ permission: p.permission, effect: p.effect, scope: p.scope, scopeIds: p.scopeIds })),
});

async function holder(db: Rows, uid: string): Promise<SessionUser> {
  const row = db.users.find((u) => u.id === uid)!;
  const g = await computeEffectiveGrants({ id: row.id, role: row.role, roleId: row.roleId }, sourceOf(db));
  const user = { id: row.id, name: uid, email: `${uid}@x`, role: row.role, status: 'ACTIVE', companyId: 'c1', permissions: Object.keys(g.grants) } as unknown as SessionUser;
  return attachGrants(user, g);
}

/** The door's OLD rule, asked of the old rows through the real engine: ANY of the keys it asked. */
async function passedYesterday(db0: Rows, uid: string, newKey: string): Promise<boolean> {
  const u = await holder(db0, uid);
  return OPS_ACTION_KEYS_FROM.find((r) => r.key === newKey)!.from.some((src) => can(u, src));
}

let nextId = 0;
const role = (name: string, companyId: string | null = null) => ({ id: `r${++nextId}`, companyId, name });

function fixture(): Rows {
  nextId = 0;
  const tAdmin = role('COMPANY_ADMIN'); // system templates
  const tDelivery = role('DELIVERY_MANAGER'); // packs and tracks, never held orders.unlock
  const tWarehouse = role('WAREHOUSE'); // prepares, prints, receives returns
  const tAccountant = role('ACCOUNTANT'); // finance.update only
  const cPacker = role('مجهّز', 'c1'); // ops.ship only
  const cTracker = role('متابع', 'c1'); // ops.track only
  const cBoth = role('شحن', 'c1'); // ops.ship AND ops.track
  const cFinance = role('مالي', 'c1'); // finance.update only (no ops.track: the write-off box is inert for it)
  const cUnlocker = role('مدير أقفال', 'c1'); // orders.unlock + orders.cancel (the 30/10 migration gave it) — untouched here
  const cReturns = role('مرتجعات', 'c1'); // ops.returns only
  const cCanceller = role('يلغي', 'c1'); // orders.cancel only: untouched here, and the stand-down door stays on ops.ship
  const cBaselineless = role('بلا افتراضي', 'c1'); // has ops.track, never issued a baseline
  const cNothing = role('فاضي', 'c1');
  const cViewer = role('قارئ', 'c1'); // orders.view only: not a door of this change
  const perms: Array<[typeof tAdmin, string[]]> = [
    [tAdmin, ['orders.view', 'orders.edit', 'orders.change_status', 'orders.confirm', 'orders.unlock', 'orders.cancel', 'ops.prepare', 'ops.ship', 'ops.labels', 'ops.track', 'ops.returns', 'finance.view', 'finance.update', 'confirmation.issues']],
    [tDelivery, ['orders.view', 'orders.edit', 'orders.change_status', 'ops.ship', 'ops.labels', 'ops.track', 'ops.returns']],
    [tWarehouse, ['ops.prepare', 'ops.labels', 'ops.returns']],
    [tAccountant, ['finance.view', 'finance.update']],
    [cPacker, ['ops.ship']],
    [cTracker, ['ops.track']],
    [cBoth, ['ops.ship', 'ops.track']],
    [cFinance, ['finance.update']],
    [cUnlocker, ['orders.unlock', 'orders.cancel']],
    [cReturns, ['ops.returns']],
    [cCanceller, ['orders.cancel']],
    [cBaselineless, ['ops.track']],
    [cViewer, ['orders.view']],
  ];
  const rows: Rows = {
    users: [],
    roles: [tAdmin, tDelivery, tWarehouse, tAccountant, cPacker, cTracker, cBoth, cFinance, cUnlocker, cReturns, cCanceller, cBaselineless, cNothing, cViewer],
    rolePerms: [], defaults: [], userPerms: [],
  };
  let i = 0;
  for (const [r, keys] of perms) {
    for (const permission of keys) {
      rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission, scope: 'ALL_COMPANY', scopeIds: null });
      if (r.id !== cBaselineless.id) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission, scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  const user = (id: string, roleName: string, roleId: string | null) => rows.users.push({ id, role: roleName, roleId });
  const ex = (userId: string, permission: string, effect: 'ALLOW' | 'DENY') =>
    rows.userPerms.push({ id: `up${++i}`, userId, permission, effect, scope: effect === 'ALLOW' ? 'ALL_COMPANY' : null, scopeIds: null });

  user('admin', 'COMPANY_ADMIN', tAdmin.id);
  user('admin-no-role-id', 'COMPANY_ADMIN', null); // reads the template named like the role
  user('delivery', 'DELIVERY_MANAGER', null);
  user('warehouse', 'WAREHOUSE', null);
  user('accountant', 'ACCOUNTANT', null);
  user('packer', 'MODERATOR', cPacker.id);
  user('tracker', 'MODERATOR', cTracker.id);
  user('both', 'MODERATOR', cBoth.id);
  user('finance', 'MODERATOR', cFinance.id);
  user('unlocker', 'MODERATOR', cUnlocker.id);
  user('returns', 'MODERATOR', cReturns.id);
  user('canceller', 'MODERATOR', cCanceller.id);
  user('baselineless', 'MODERATOR', cBaselineless.id);
  user('nothing', 'MODERATOR', cNothing.id);
  user('viewer', 'MODERATOR', cViewer.id);
  user('root', 'SUPER_ADMIN', null);
  user('stranger', 'ROLE_NOBODY_KNOWS', null); // no role id, no template: the fallback, which is empty
  user('fallback-warehouse', 'WAREHOUSE_X', null); // no template of that name
  // ── the same roles, with a personal «منع» / «سماح» on a source key ──
  user('admin-denied-ship', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-ship', 'ops.ship', 'DENY'); // still tracks, still holds orders.cancel
  user('admin-denied-track', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-track', 'ops.track', 'DENY'); // still packs
  user('admin-denied-both', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-both', 'ops.ship', 'DENY'); ex('admin-denied-both', 'ops.track', 'DENY'); // batches go; orders.cancel stays (the role’s row)
  user('admin-denied-finance', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-finance', 'finance.update', 'DENY'); // still unlocks → still writes off
  user('admin-denied-unlock', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-unlock', 'orders.unlock', 'DENY'); // still finance.update
  user('admin-denied-write-off-sources', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-write-off-sources', 'finance.update', 'DENY'); ex('admin-denied-write-off-sources', 'orders.unlock', 'DENY');
  user('admin-denied-returns', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-returns', 'ops.returns', 'DENY');
  user('packer-denied-ship', 'MODERATOR', cPacker.id); ex('packer-denied-ship', 'ops.ship', 'DENY'); // the role’s ONLY source, refused
  user('tracker-denied-track', 'MODERATOR', cTracker.id); ex('tracker-denied-track', 'ops.track', 'DENY');
  user('both-denied-ship', 'MODERATOR', cBoth.id); ex('both-denied-ship', 'ops.ship', 'DENY');
  user('both-denied-track', 'MODERATOR', cBoth.id); ex('both-denied-track', 'ops.track', 'DENY');
  user('unlocker-denied-unlock', 'MODERATOR', cUnlocker.id); ex('unlocker-denied-unlock', 'orders.unlock', 'DENY'); // the 30/10 migration also denied orders.cancel
  ex('unlocker-denied-unlock', 'orders.cancel', 'DENY');
  user('finance-denied-update', 'MODERATOR', cFinance.id); ex('finance-denied-update', 'finance.update', 'DENY');
  user('returns-denied-returns', 'MODERATOR', cReturns.id); ex('returns-denied-returns', 'ops.returns', 'DENY');
  // a personal «منع» / «سماح» on the cancel box, which this migration must never read or write
  user('packer-denied-cancel', 'MODERATOR', cPacker.id); ex('packer-denied-cancel', 'orders.cancel', 'DENY');
  user('admin-denied-cancel', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-cancel', 'orders.cancel', 'DENY');
  user('canceller-denied-cancel', 'MODERATOR', cCanceller.id); ex('canceller-denied-cancel', 'orders.cancel', 'DENY');
  // «سماح» of their own
  user('nothing-allowed-ship', 'MODERATOR', cNothing.id); ex('nothing-allowed-ship', 'ops.ship', 'ALLOW');
  user('nothing-allowed-track', 'MODERATOR', cNothing.id); ex('nothing-allowed-track', 'ops.track', 'ALLOW');
  user('nothing-allowed-finance', 'MODERATOR', cNothing.id); ex('nothing-allowed-finance', 'finance.update', 'ALLOW');
  user('nothing-allowed-unlock', 'MODERATOR', cNothing.id); ex('nothing-allowed-unlock', 'orders.unlock', 'ALLOW');
  user('nothing-allowed-returns', 'MODERATOR', cNothing.id); ex('nothing-allowed-returns', 'ops.returns', 'ALLOW');
  user('nothing-allowed-all', 'MODERATOR', cNothing.id);
  for (const k of SRC_KEYS) ex('nothing-allowed-all', k, 'ALLOW');
  user('packer-allowed-track', 'MODERATOR', cPacker.id); ex('packer-allowed-track', 'ops.track', 'ALLOW');
  user('packer-allowed-cancel', 'MODERATOR', cPacker.id); ex('packer-allowed-cancel', 'orders.cancel', 'ALLOW'); // already holds the box by a row of their own
  user('stranger-allowed-ship', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-ship', 'ops.ship', 'ALLOW');
  user('stranger-allowed-track', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-track', 'ops.track', 'ALLOW');
  user('stranger-allowed-finance', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-finance', 'finance.update', 'ALLOW');
  user('stranger-allowed-returns', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-returns', 'ops.returns', 'ALLOW');
  user('warehouse-denied-returns', 'WAREHOUSE', null); ex('warehouse-denied-returns', 'ops.returns', 'DENY');
  // an unrelated exception must not move anything
  user('admin-denied-other', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-other', 'settings.view', 'DENY');
  // someone denied the NEW key already (the owner pre-empted it): the deny stays, nothing re-grants it
  user('tracker-pre-denied-deliver', 'MODERATOR', cTracker.id); ex('tracker-pre-denied-deliver', 'ops.deliver', 'DENY');
  user('both-pre-denied-batches', 'MODERATOR', cBoth.id); ex('both-pre-denied-batches', 'ops.batches', 'DENY');
  return rows;
}

/**
 * Every person against every door: yesterday through the OLD keys, today through the NEW ones.
 *   · the five boxes are exact;
 *   · ops.ship (the stand-down door) and orders.cancel are exactly what they were, for everybody;
 *   · every other key a person holds is exactly what it was (the fuzz below).
 */
async function everyDoorOfEveryone(db0: Rows) {
  const db1 = applyTheMigration(db0);
  const lost: string[] = [];
  const gained: string[] = [];
  const moved: string[] = [];
  for (const u of db0.users) {
    const before = await holder(db0, u.id);
    const after = await holder(db1, u.id);
    for (const k of BRAND_NEW) {
      const was = await passedYesterday(db0, u.id, k);
      const is = can(after, k);
      // A key the owner had ALREADY denied by hand is the one deliberate exception: the migration never re-grants it.
      const preDenied = db0.userPerms.some((p) => p.userId === u.id && p.permission === k && p.effect === 'DENY');
      if (was && !is && !preDenied) lost.push(`${u.id} lost ${k}`);
      if (!was && is) gained.push(`${u.id} gained ${k}`);
      // The screen's own question agrees with the server's.
      expect(userCan(after, k), `${u.id}/${k}: الشاشة والخادم`).toBe(is);
    }
    for (const k of ['ops.ship', 'orders.cancel']) if (can(before, k) !== can(after, k)) moved.push(`${u.id}/${k}`);
  }
  return { db1, lost, gained, moved };
}

describe('the replay: every person, every door — yesterday against today, through the real engine', () => {
  it('nobody loses a door, nobody gains one (fixture people, 5 boxes each)', async () => {
    const db0 = fixture();
    const r = await everyDoorOfEveryone(db0);
    expect(r.lost, 'خسروا باباً').toEqual([]);
    expect(r.gained, 'كسبوا باباً').toEqual([]);
    expect(r.moved, 'تحرّك باب الإيقاف أو مفتاح الإلغاء').toEqual([]);
    expect(db0.users.length).toBeGreaterThanOrEqual(40);
  });

  it('the migration writes NO row for ops.ship or orders.cancel — the stand-down door and the cancel box are untouched', () => {
    const db1 = applyTheMigration(fixture());
    const written = [...db1.userPerms, ...db1.rolePerms, ...db1.defaults].filter((x) => x.id.startsWith('op8-'));
    expect(written.length).toBeGreaterThan(40);
    for (const w of written) expect(['ops.ship', 'orders.cancel'], w.id).not.toContain(w.permission);
  });

  it('the fixture really exercises the cases (a replay that finds nothing would pass for the wrong reason)', async () => {
    const db0 = fixture();
    let passers = 0;
    for (const u of db0.users) for (const k of BRAND_NEW) if (await passedYesterday(db0, u.id, k)) passers++;
    expect(passers, 'من يمر من الأبواب').toBeGreaterThan(40);
    expect(await passedYesterday(db0, 'nothing', 'ops.deliver')).toBe(false);
    const db1 = applyTheMigration(db0);
    const written = (rows: Array<{ id: string }>, before: Array<{ id: string }>) => rows.length - before.length;
    expect(written(db1.userPerms, db0.userPerms)).toBeGreaterThan(10);
    expect(written(db1.rolePerms, db0.rolePerms)).toBeGreaterThan(14);
    expect(written(db1.defaults, db0.defaults)).toBeGreaterThan(10);
    expect(db1.userPerms.filter((p) => p.id.startsWith('op8-') && p.effect === 'DENY').length).toBeGreaterThan(4);
    expect(db1.userPerms.filter((p) => p.id.startsWith('op8-') && p.effect === 'ALLOW').length).toBeGreaterThan(6);
  });

  it('each case by name: a box follows the key its door asked, and not another one', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const box = async (uid: string, k: string) => can(await holder(db1, uid), k);
    const only = async (uid: string, ...yes: string[]) => {
      for (const k of BRAND_NEW) expect(await box(uid, k), `${uid}/${k}`).toBe(yes.includes(k));
    };
    // the packing key: the batches and (the cancel box), none of the tracking desk’s acts
    await only('packer', 'ops.batches');
    // the tracking key: the batches, the outcome, the transfer — NOT the write-off, NOT the cancel box
    await only('tracker', 'ops.batches', 'ops.deliver', 'ops.transfer');
    await only('both', 'ops.batches', 'ops.deliver', 'ops.transfer');
    // finance.update alone gives the write-off, and nothing else
    await only('finance', 'ops.write_off');
    await only('accountant', 'ops.write_off');
    // orders.unlock gives the write-off
    await only('unlocker', 'ops.write_off');
    // receiving returns gives the fee box, nothing else
    await only('returns', 'ops.return_fee');
    await only('warehouse', 'ops.return_fee');
    // the admin template has every source
    for (const k of BRAND_NEW) expect(await box('admin', k), `admin/${k}`).toBe(true);
    for (const k of BRAND_NEW) expect(await box('admin-no-role-id', k), `admin-no-role-id/${k}`).toBe(true);
    // the delivery manager packs and tracks and never unlocked: batches, deliver, transfer, fee — not the write-off
    await only('delivery', 'ops.batches', 'ops.deliver', 'ops.transfer', 'ops.return_fee');
    // not a door of this change
    await only('viewer');
    await only('nothing');
    await only('canceller');
    // a «منع» on ONE source of two takes only that source’s boxes
    expect(await box('admin-denied-ship', 'ops.batches')).toBe(true); // still tracks
    expect(await box('admin-denied-track', 'ops.batches')).toBe(true); // still packs
    expect(await box('admin-denied-track', 'ops.deliver')).toBe(false);
    expect(await box('admin-denied-track', 'ops.transfer')).toBe(false);
    expect(await box('admin-denied-both', 'ops.batches')).toBe(false);
    expect(await box('admin-denied-finance', 'ops.write_off')).toBe(true); // still unlocks
    expect(await box('admin-denied-unlock', 'ops.write_off')).toBe(true); // still has finance.update
    expect(await box('admin-denied-write-off-sources', 'ops.write_off')).toBe(false);
    expect(await box('admin-denied-returns', 'ops.return_fee')).toBe(false);
    // a «منع» on the role’s ONLY source
    expect(await box('packer-denied-ship', 'ops.batches')).toBe(false);
    expect(await box('tracker-denied-track', 'ops.deliver')).toBe(false);
    expect(await box('both-denied-ship', 'ops.batches')).toBe(true);
    expect(await box('both-denied-track', 'ops.deliver')).toBe(false);
    expect(await box('finance-denied-update', 'ops.write_off')).toBe(false);
    expect(await box('returns-denied-returns', 'ops.return_fee')).toBe(false);
    expect(await box('warehouse-denied-returns', 'ops.return_fee')).toBe(false);
    // the owner’s «منع» on the cancel box is KEPT: the packer who carries it does not get it back
    expect(await box('packer-denied-cancel', 'ops.batches')).toBe(true);
    // a «سماح» reaches the box in a role that has none
    expect(await box('nothing-allowed-ship', 'ops.batches')).toBe(true);
    expect(await box('nothing-allowed-ship', 'ops.deliver')).toBe(false);
    expect(await box('nothing-allowed-track', 'ops.deliver')).toBe(true);
    expect(await box('nothing-allowed-finance', 'ops.write_off')).toBe(true);
    expect(await box('nothing-allowed-unlock', 'ops.write_off')).toBe(true);
    expect(await box('nothing-allowed-returns', 'ops.return_fee')).toBe(true);
    for (const k of BRAND_NEW) expect(await box('nothing-allowed-all', k), `nothing-allowed-all/${k}`).toBe(true);
    expect(await box('packer-allowed-track', 'ops.deliver')).toBe(true);
    expect(await box('stranger-allowed-ship', 'ops.batches')).toBe(true);
    expect(await box('stranger-allowed-track', 'ops.transfer')).toBe(true);
    expect(await box('stranger-allowed-finance', 'ops.write_off')).toBe(true);
    expect(await box('stranger-allowed-returns', 'ops.return_fee')).toBe(true);
    // an unrelated exception moved nothing
    expect(await box('admin-denied-other', 'ops.write_off')).toBe(true);
    // the owner’s earlier «منع» on a NEW key is kept, and the other boxes of the same person still arrive
    expect(await box('tracker-pre-denied-deliver', 'ops.deliver')).toBe(false);
    expect(await box('tracker-pre-denied-deliver', 'ops.transfer')).toBe(true);
    expect(await box('both-pre-denied-batches', 'ops.batches')).toBe(false);
    expect(await box('both-pre-denied-batches', 'ops.deliver')).toBe(true);
  });

  it('the work keeps working when a box is taken: the owner unticks the write-off and the tracking STAYS', async () => {
    const db1 = applyTheMigration(fixture());
    db1.userPerms.push({ id: 'owner-1', userId: 'admin', permission: 'ops.write_off', effect: 'DENY', scope: null, scopeIds: null });
    const admin = await holder(db1, 'admin');
    expect(can(admin, 'ops.track')).toBe(true);
    expect(can(admin, 'ops.deliver')).toBe(true);
    expect(can(admin, 'ops.transfer')).toBe(true);
    expect(can(admin, 'ops.write_off')).toBe(false);
    expect(can(admin, 'ops.batches')).toBe(true);
  });

  it('what the owner unticked before is not given back: a role that holds no source today receives nothing', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const nothingRole = db0.roles.find((r) => r.name === 'فاضي')!;
    expect(db1.rolePerms.filter((p) => p.roleId === nothingRole.id)).toEqual([]);
    expect(db1.defaults.filter((p) => p.roleId === nothingRole.id)).toEqual([]);
    const viewerRole = db0.roles.find((r) => r.name === 'قارئ')!;
    expect(db1.rolePerms.filter((p) => p.roleId === viewerRole.id).map((p) => p.permission)).toEqual(['orders.view']);
  });

  it('SUPER_ADMIN is untouched: no row is written for him, and he still passes everything', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    expect(db1.userPerms.filter((p) => p.userId === 'root')).toEqual([]);
    const root = await holder(db1, 'root');
    for (const k of NEW_KEYS) expect(can(root, k)).toBe(true);
  });

  it('every row it writes is tagged, and a second run changes nothing (it steps aside for what is there)', () => {
    const db0 = fixture();
    const once = applyTheMigration(db0);
    const twice = applyTheMigration(once);
    const wrote = (r: Rows) => ({ u: r.userPerms.length, r: r.rolePerms.length, d: r.defaults.length });
    expect(wrote(twice)).toEqual(wrote(once));
    const old = new Set([...db0.userPerms, ...db0.rolePerms, ...db0.defaults].map((x) => x.id));
    const added = [...once.userPerms, ...once.rolePerms, ...once.defaults].map((x) => x.id).filter((i) => !old.has(i));
    expect(added.length).toBeGreaterThan(40);
    for (const i of added) expect(i).toMatch(/^op8-/);
    // Nothing that existed before was changed or removed.
    for (const p of db0.userPerms) expect(once.userPerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.rolePerms) expect(once.rolePerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.defaults) expect(once.defaults.find((q) => q.id === p.id)).toEqual(p);
  });

  it('the «إرجاع للافتراضي» baseline carries the boxes, so the first reset after the deploy does not take them away', () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    for (const rule of OPS_ACTION_KEYS_FROM) {
      const withSource = new Set(db0.defaults.filter((d) => rule.from.includes(d.permission)).map((d) => d.roleId));
      const boxed = new Set(db1.defaults.filter((d) => d.permission === rule.key).map((d) => d.roleId));
      for (const r of withSource) expect(boxed.has(r), `${rule.key} ← ${r}`).toBe(true);
      // and no role is given a baseline box without holding a source of it in its baseline
      for (const r of boxed) {
        if (db0.defaults.some((d) => d.roleId === r && d.permission === rule.key)) continue;
        expect(withSource.has(r), `${rule.key} → ${r}`).toBe(true);
      }
    }
  });

  it('NEGATIVE (the test of the test): a migration with one step removed is CAUGHT — no «منع», no «سماح», no role rows, a source read through a «منع», no “already holds”', async () => {
    const db0 = fixture();
    const count = async (skip: Skip) => {
      const broken = applyTheMigration(db0, skip);
      const found = { lost: 0, gained: 0 };
      for (const u of db0.users) {
        const after = await holder(broken, u.id);
        for (const k of BRAND_NEW) {
          const was = await passedYesterday(db0, u.id, k);
          const is = can(after, k);
          if (was && !is) found.lost++;
          if (!was && is) found.gained++;
        }
      }
      return found;
    };
    expect((await count('deny')).gained, 'بلا «منع» يُمنح المفتاح بلا باب').toBeGreaterThan(0);
    expect((await count('allow')).lost, 'بلا «سماح» يخسر صاحب الاستثناء').toBeGreaterThan(0);
    expect((await count('roles')).lost, 'بلا صفوف الأدوار يخسر الجميع').toBeGreaterThan(0);
    expect((await count('denied-sources')).gained, 'إن نسي أنّ «المنع» يُسقط المصدر').toBeGreaterThan(0);
    // the baseline is read by the reset button, not by the engine: its absence is seen in the rows
    const noDefaults = applyTheMigration(db0, 'defaults');
    expect(noDefaults.defaults.length, 'بلا الافتراضيّات زرّ «إرجاع» يشيل المفاتيح').toBe(db0.defaults.length);
    expect(applyTheMigration(db0).defaults.length).toBeGreaterThan(db0.defaults.length);
  });
});

// ── a seeded fuzz: random roles, random exceptions, random people ──

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomWorld(seed: number): Rows {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const KEYS = [...SRC_KEYS, 'orders.cancel', 'orders.view', 'orders.edit', 'finance.view', 'orders.create'];
  const SCOPES: Scope[] = ['ALL_COMPANY', 'OWN', 'ASSIGNED'];
  const rows: Rows = { users: [], roles: [], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  const templateNames = ['COMPANY_ADMIN', 'MANAGER', 'WAREHOUSE'];
  for (const name of templateNames) rows.roles.push({ id: `t-${name}`, companyId: null, name });
  for (let r = 0; r < 12; r++) rows.roles.push({ id: `c${r}`, companyId: 'c1', name: `role${r}` });
  for (const r of rows.roles) {
    for (const k of KEYS) {
      if (rand() < 0.35) rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission: k, scope: pick(SCOPES), scopeIds: null });
      if (rand() < 0.3) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission: k, scope: pick(SCOPES), scopeIds: null });
    }
  }
  for (let u = 0; u < 200; u++) {
    const kind = rand();
    const row =
      kind < 0.6 ? { role: 'MODERATOR', roleId: pick(rows.roles.filter((x) => x.companyId !== null)).id }
      : kind < 0.8 ? { role: pick(templateNames), roleId: null }
      : kind < 0.9 ? { role: pick(['WAREHOUSE_X', 'COMPANY_ADMIN_X', 'SETTLEMENT_OFFICER']), roleId: null }
      : kind < 0.95 ? { role: 'SUPER_ADMIN', roleId: null }
      : { role: 'MODERATOR', roleId: pick(rows.roles).id };
    rows.users.push({ id: `u${u}`, ...row });
    for (const k of KEYS) {
      const x = rand();
      if (x < 0.12) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'DENY', scope: null, scopeIds: null });
      else if (x < 0.22) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'ALLOW', scope: pick(SCOPES), scopeIds: null });
    }
    // The owner pre-empted a box here and there: a «منع» on a NEW key that exists before the migration. It is kept.
    if (rand() < 0.05) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: pick(BRAND_NEW), effect: 'DENY', scope: null, scopeIds: null });
  }
  return rows;
}

describe('a seeded fuzz: 40 random companies, 200 people each — nobody loses a door, nobody gains one', () => {
  it('holds for every seed, and the stand-down door and the cancel box never move', async () => {
    let people = 0;
    let withRows = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const db0 = randomWorld(seed);
      const r = await everyDoorOfEveryone(db0);
      expect(r.lost, `seed ${seed}`).toEqual([]);
      expect(r.gained, `seed ${seed}`).toEqual([]);
      expect(r.moved, `seed ${seed}`).toEqual([]);
      people += db0.users.length;
      if (r.db1.userPerms.length > db0.userPerms.length) withRows++;
    }
    expect(people).toBe(8000);
    expect(withRows, 'the fuzz must make the migration write exceptions').toBeGreaterThan(30);
  }, 240_000);

  it('and nothing else about anybody moves: every other key a person holds is exactly what it was', async () => {
    for (const seed of [3, 11, 29]) {
      const db0 = randomWorld(seed);
      const db1 = applyTheMigration(db0);
      for (const u of db0.users.slice(0, 120)) {
        const a = await holder(db0, u.id);
        const b = await holder(db1, u.id);
        const strip = (x: SessionUser) => (x.permissions ?? []).filter((k) => !NEW_KEYS.includes(k)).sort();
        expect(strip(b), `${u.id}`).toEqual(strip(a));
      }
    }
  }, 60_000);
});

describe('the engine fallback: a person with no stored role keeps what the old keys opened', () => {
  const fallback = async (roleName: string, ex: Array<{ permission: string; effect: string }> = []) =>
    computeEffectiveGrants({ id: 'f1', role: roleName, roleId: null }, {
      roleRows: async () => [],
      overrideRows: async () => ex.map((e) => ({ ...e, scope: null, scopeIds: null })),
    });

  it('a legacy role gets a box exactly when it held a key the door asked — no more, no less, for every role in the code', async () => {
    const roles = Object.keys(ROLE_PERMISSIONS);
    expect(roles.length).toBeGreaterThan(8);
    let boxes = 0;
    for (const r of roles) {
      const g = (await fallback(r)).grants;
      for (const rule of OPS_ACTION_KEYS_FROM) {
        const was = rule.from.some((src) => g[src] !== undefined);
        expect(g[rule.key] !== undefined, `${r}/${rule.key}`).toBe(was);
        if (was) boxes++;
      }
    }
    expect(boxes, 'a fallback that reaches no role would pass for the wrong reason').toBeGreaterThan(2);
  });

  it('a personal «سماح» on the old key reaches the boxes in the fallback too — and only the boxes of THAT key', async () => {
    const track = (await fallback('WAREHOUSE_X', [{ permission: 'ops.track', effect: 'ALLOW' }])).grants;
    for (const k of ['ops.batches', 'ops.deliver', 'ops.transfer']) expect(track[k], k).toBeDefined();
    for (const k of ['ops.write_off', 'ops.return_fee', 'orders.cancel']) expect(track[k], k).toBeUndefined();
    const ship = (await fallback('WAREHOUSE_X', [{ permission: 'ops.ship', effect: 'ALLOW' }])).grants;
    expect(ship['ops.batches']).toBeDefined();
    expect(ship['orders.cancel']).toBeUndefined(); // the cancel box is not derived from the packing key
    expect(ship['ops.deliver']).toBeUndefined();
    const fin = (await fallback('WAREHOUSE_X', [{ permission: 'finance.update', effect: 'ALLOW' }])).grants;
    expect(fin['ops.write_off']).toBeDefined();
    const unlock = (await fallback('WAREHOUSE_X', [{ permission: 'orders.unlock', effect: 'ALLOW' }])).grants;
    expect(unlock['ops.write_off']).toBeDefined();
    const returns = (await fallback('WAREHOUSE_X', [{ permission: 'ops.returns', effect: 'ALLOW' }])).grants;
    expect(returns['ops.return_fee']).toBeDefined();
    expect(returns['ops.batches']).toBeUndefined();
  });

  it('NEGATIVE: a «منع» on the box, or on the key it comes from, wins over the fallback — and the other boxes of the same person stay', async () => {
    const both = [{ permission: 'ops.track', effect: 'ALLOW' }];
    const g1 = (await fallback('WAREHOUSE_X', [...both, { permission: 'ops.transfer', effect: 'DENY' }])).grants;
    expect(g1['ops.transfer']).toBeUndefined();
    expect(g1['ops.deliver']).toBeDefined();
    const g2 = (await fallback('WAREHOUSE_X', [{ permission: 'ops.ship', effect: 'ALLOW' }, { permission: 'ops.track', effect: 'ALLOW' }, { permission: 'ops.ship', effect: 'DENY' }])).grants;
    expect(g2['ops.batches']).toBeDefined(); // still tracks
    expect(g2['orders.cancel']).toBeUndefined();
  });

  it('the parity list (the reset-to-default baseline of a legacy role) carries the boxes for the same roles', () => {
    const admin = legacyEffectiveKeys('COMPANY_ADMIN');
    // the legacy admin holds finance.update and orders.unlock
    expect(admin).toContain('ops.write_off');
    expect(legacyEffectiveKeys('PENDING_USER')).not.toContain('ops.write_off');
    expect(legacyEffectiveKeys('PENDING_USER')).not.toContain('ops.batches');
  });
});
