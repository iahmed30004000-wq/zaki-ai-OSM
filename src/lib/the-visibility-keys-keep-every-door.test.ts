import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT A THING COST US, THE SMART CARDS AND THE TEAM'S TABLES GET A KEY EACH — AND NOBODY LOSES A DOOR OR GAINS ONE
 * (perm-plan PR-10).
 *
 * `costs.view` ← the five keys `maySeeCost` was an OR of. `insights.view` ← the nine keys of the screens a smart card is drawn
 * on. `team.monitor` (an existing key) ← `users.view` and the role NAMES COMPANY_ADMIN / MANAGER, which the two team tables on
 * the confirmation desk read. The migration 20261030170000_costs_insights_keys gives each box to exactly the roles and people
 * who passed that door, and carries every «منع».
 *
 * The owner’s rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 * ⚠️ WHAT THIS FILE IS, SAID PLAINLY. There is no database in CI, so the SQL cannot be run here. Two things are done
 * instead, and neither is the SQL running:
 *   1. the SQL is READ as text — its shape (what it writes, in which order, from which keys) is pinned;
 *   2. the SQL's logic is REPLAYED by `applyTheMigration` below, a statement-for-statement copy over in-memory rows, and
 *      the people it produces are judged by the REAL engine (computeEffectiveGrants + can): for every person and every
 *      door, "could they pass yesterday" must equal "can they pass today".
 * The copy can drift from the SQL; the reviewer’s own rehearsal of the SQL inside a rolled-back transaction is the
 * stronger evidence, and the pull request says what was and was not done.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants, can } from './authorization';
import { userCan } from './can';
import { ALL_CATALOG_KEYS, catalogItem } from './permission-catalog';
import { computeEffectiveGrants, legacyEffectiveKeys, type GrantSource } from './permissions-core';
import { COST_SOURCE_KEYS, INSIGHT_SOURCE_KEYS, TEAM_TABLE_ROLE_NAMES, VISIBILITY_KEYS_FROM } from './visibility-keys';
import { repoFile, stripComments } from './guard-source';
import { ROLE_PERMISSIONS } from '../types/auth';
import type { SessionUser } from '@/types/auth';

const NAME = '20261030170000_costs_insights_keys';
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

/** The gate table, one row per (box, key the door asked) and one per (box, role name the door read). */
type GateRow = { newKey: string; src: string | null; roleName: string | null };
const GATE: GateRow[] = VISIBILITY_KEYS_FROM.flatMap((r) => [
  ...r.from.map((src) => ({ newKey: r.key, src, roleName: null })),
  ...(r.byRole ?? []).map((roleName) => ({ newKey: r.key, src: null, roleName })),
]);
const NEW_KEYS = VISIBILITY_KEYS_FROM.map((r) => r.key);
const SRC_KEYS = [...new Set(GATE.flatMap((g) => (g.src ? [g.src] : [])))];
/** `team.monitor` existed before this change; the other two did not. */
const EXISTING_KEYS = ['team.monitor'];

describe('the three boxes are in the list the migration and the engine fallback read', () => {
  it('are exactly costs.view, insights.view and team.monitor — payroll.view is deliberately NOT here', () => {
    expect([...NEW_KEYS].sort()).toEqual(['costs.view', 'insights.view', 'team.monitor']);
    expect(NEW_KEYS).not.toContain('payroll.view');
  });

  it('the cost key is read from exactly the five keys maySeeCost was an OR of, and the cards from nine screen keys', () => {
    expect([...COST_SOURCE_KEYS].sort()).toEqual(['finance.view', 'inventory.adjust', 'inventory.view', 'production.manage', 'production.view']);
    expect(INSIGHT_SOURCE_KEYS).toHaveLength(9);
    expect(INSIGHT_SOURCE_KEYS).not.toContain('analytics.view');
    expect(TEAM_TABLE_ROLE_NAMES).toEqual(['COMPANY_ADMIN', 'MANAGER']);
  });

  it('the two new keys are in the catalog as visibility keys: standalone, with a note, an Arabic and an English label, no scope', () => {
    for (const k of ['costs.view', 'insights.view']) {
      const item = catalogItem(k);
      expect(item, k).toBeDefined();
      expect(ALL_CATALOG_KEYS.has(k), k).toBe(true);
      expect(item!.requires, `${k}: بلا شاشة`).toBeNull();
      expect((item!.note ?? '').trim().length, k).toBeGreaterThan(10);
      expect(item!.ar.trim().length, k).toBeGreaterThan(8);
      expect(item!.en.trim().length, k).toBeGreaterThan(8);
      expect(item!.scopes, `${k} بلا مدى`).toBeUndefined();
    }
    expect(catalogItem('team.monitor')).toBeDefined();
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
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'ci10-' || gen_random_uuid()::text`);
    }
    for (const s of statements.filter((x) => !x.startsWith('INSERT INTO'))) {
      expect(s.startsWith('DROP TABLE IF EXISTS pg_temp.sp10_') || s.startsWith('CREATE TEMP TABLE sp10_'), s.slice(0, 70)).toBe(true);
      if (s.startsWith('DROP')) expect(s).not.toMatch(/\bpublic\b|"(users|roles|role_permissions|user_permissions)"/);
    }
    for (const s of statements) expect(s).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|ALTER)\b/i);
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
      expect(reads).toMatch(/sp10_pass/);
    }
    for (const s of statements.filter((x) => x.startsWith('CREATE TEMP TABLE'))) {
      // a new key may appear only as the LEFT column of the gate table, never in a snapshot of what people hold…
      if (s.startsWith('CREATE TEMP TABLE sp10_gate')) continue;
      for (const k of ['costs.view', 'insights.view']) expect(s, `${k} in ${s.slice(0, 40)}`).not.toContain(`'${k}'`);
    }
  });

  it('the gate table is EXACTLY the one the engine fallback reads (VISIBILITY_KEYS_FROM) — keys and role names', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp10_gate'))!;
    const rows = [...gate.matchAll(/\('([a-z_.]+)',\s*(?:'([a-z_.]+)'|NULL::text),\s*(?:'([A-Z_]+)'|NULL::text)\)/g)].map((m) => ({
      newKey: m[1],
      src: m[2] ?? null,
      roleName: m[3] ?? null,
    }));
    const key = (r: GateRow) => `${r.newKey}<${r.src ?? ''}|${r.roleName ?? ''}`;
    expect(rows.map(key).sort()).toEqual(GATE.map(key).sort());
    expect(rows).toHaveLength(5 + 9 + 1 + 2);
  });

  it('NEGATIVE: it writes nothing for payroll.view, and nothing for the retired analytics.view', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp10_gate'))!;
    expect(gate).not.toContain(`'payroll.view'`);
    expect(gate).not.toContain(`'payroll.pay'`);
    expect(gate).not.toContain(`'analytics.view'`);
    for (const s of statements.filter((x) => x.startsWith('INSERT INTO'))) expect(s).not.toContain('payroll');
  });

  it('the snapshot of what people hold reads exactly the source keys of the gate table', () => {
    const holds = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp10_holds'))!);
    expect(holds).toContain('h.k IN (SELECT src FROM sp10_gate WHERE src IS NOT NULL)');
    expect(holds).toContain(`up."effect" = 'ALLOW'`);
    expect(holds).toContain(`d."effect" = 'DENY'`);
    expect(holds).toContain(`u."role" <> 'SUPER_ADMIN'`);
    // a person's own «سماح» REPLACES the role's row for the same key — the engine's rule — so the role's is read only without one
    expect(holds).toContain(`a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW'`);
  });

  it('the two statements that decide a person say exactly what the replay does — a flipped condition is caught HERE, since the replay is a copy', () => {
    const deny = flat(statements.find((s) => s.includes(`'DENY'`) && s.startsWith('INSERT INTO'))!);
    // the role receives the box AND the person did not pass THAT door AND does not already hold the box
    expect(deny).toContain('FROM sp10_user_role ur JOIN sp10_role_gets rg ON rg.rid = ur.rid');
    expect(deny).toContain('WHERE NOT EXISTS (SELECT 1 FROM sp10_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)');
    expect(deny).toContain('AND NOT EXISTS (SELECT 1 FROM sp10_has x WHERE x.uid = ur.uid AND x.k = rg.new_key)');
    const allow = flat(statements.find((s) => s.includes(`'ALLOW'`) && s.startsWith('INSERT INTO'))!);
    // the person passed AND no role of theirs receives the box AND they do not already hold it
    expect(allow).toContain('FROM sp10_pass p WHERE NOT EXISTS (SELECT 1 FROM sp10_user_role ur JOIN sp10_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key WHERE ur.uid = p.uid)');
    expect(allow).toContain('AND NOT EXISTS (SELECT 1 FROM sp10_has x WHERE x.uid = p.uid AND x.k = p.new_key)');
    expect(allow).toContain(`'ALLOW', 'ALL_COMPANY', NULL`);
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!)).toContain('FROM sp10_role_gets rg');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!)).toContain('FROM sp10_default_gets dg');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp10_role_gets'))!)).toContain('FROM "role_permissions" rp JOIN sp10_gate g ON g.src = rp."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp10_default_gets'))!)).toContain('FROM "role_permission_defaults" d JOIN sp10_gate g ON g.src = d."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp10_pass'))!)).toContain('FROM sp10_holds h JOIN sp10_gate g ON g.src = h.k');
    // the role-NAME half of the door
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp10_pass'))!)).toContain(`JOIN sp10_gate g ON g.role_name = u."role" WHERE u."role" <> 'SUPER_ADMIN'`);
  });

  it('reads the role the way the engine reads it, and leaves SUPER_ADMIN alone', () => {
    const ur = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp10_user_role'))!;
    expect(ur).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
    expect(ur).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
    expect(ur).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('its rollback removes only what it wrote, in all three places, and its own row in the migrations table', () => {
    const body = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const deletes = body.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'ci10-%'`);
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
      expect(text, m).not.toContain(`'ci10-'`);
    }
  });

  it('runs after the migration of the previous permission box (#93/#94), so every key it reads is already there', () => {
    expect(NAME > '20261030150000_finance_split_keys').toBe(true);
    expect(NAME > '20261030140000_confirmation_split_keys').toBe(true);
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

/** `sp10_user_role`: (uid, rid) — the engine's own reading of "which role are this person's grants from". */
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

type Skip = 'deny' | 'allow' | 'roles' | 'defaults' | 'denied-sources' | 'own-allow-replaces-role' | 'has' | 'names';

/** Statement-for-statement the SQL of migration.sql. */
function applyTheMigration(before: Rows, skip?: Skip): Rows {
  const db = clone(before);

  // ── the snapshot: everything below is read from `before`, never from rows written here ──
  const ur = userRole(before);
  const superIds = new Set(before.users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.id));
  const denied = (uid: string, k: string) => skip !== 'denied-sources' && before.userPerms.some((d) => d.userId === uid && d.permission === k && d.effect === 'DENY');
  const KEYED = GATE.filter((g) => g.src !== null);
  const NAMED = skip === 'names' ? [] : GATE.filter((g) => g.roleName !== null);

  // sp10_holds — a person's own «سماح» REPLACES the role's row for the same key
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

  // sp10_has — who already holds a box this file would give: a personal «سماح», else the role's row (no personal row at all)
  const has = (uid: string, k: string) =>
    skip !== 'has' &&
    (before.userPerms.some((p) => p.userId === uid && p.permission === k && p.effect === 'ALLOW') ||
      (ur.some((x) => x.uid === uid && before.rolePerms.some((rp) => rp.roleId === x.rid && rp.permission === k)) &&
        !before.userPerms.some((p) => p.userId === uid && p.permission === k)));

  // sp10_pass — holds ANY key the door asked, or whose role NAME the door read (UNION: one row per person and box)
  const passSet = new Set<string>();
  for (const h of holds) for (const g of KEYED) if (g.src === h.k) passSet.add(`${h.uid}|${g.newKey}`);
  for (const u of before.users) {
    if (u.role === 'SUPER_ADMIN') continue;
    for (const g of NAMED) if (g.roleName === u.role) passSet.add(`${u.id}|${g.newKey}`);
  }
  const pass = [...passSet].map((s) => ({ uid: s.split('|')[0], newKey: s.split('|')[1] }));
  const passes = (uid: string, k: string) => passSet.has(`${uid}|${k}`);

  // sp10_role_gets / sp10_default_gets — the roles holding a source, and the roles named like a role the door read
  const getsSet = (table: Grant[]) => {
    const s = new Set<string>();
    for (const rp of table) for (const g of KEYED) if (g.src === rp.permission) s.add(`${rp.roleId}|${g.newKey}`);
    for (const r of before.roles) for (const g of NAMED) if (g.roleName === r.name) s.add(`${r.id}|${g.newKey}`);
    return [...s].map((x) => ({ rid: x.split('|')[0], newKey: x.split('|')[1] }));
  };
  const roleGets = getsSet(before.rolePerms);
  const defaultGets = getsSet(before.defaults);

  let n = 0;
  const id = () => `ci10-${++n}`;
  const hasUserRow = (uid: string, k: string) => db.userPerms.some((p) => p.userId === uid && p.permission === k);

  // 1. «منع» — the role receives the box, the person did not pass THAT door, and does not already hold the box.
  for (const x of skip === 'deny' ? [] : ur) {
    for (const rg of roleGets) {
      if (rg.rid !== x.rid) continue;
      if (!passes(x.uid, rg.newKey) && !has(x.uid, rg.newKey) && !hasUserRow(x.uid, rg.newKey)) {
        db.userPerms.push({ id: id(), userId: x.uid, permission: rg.newKey, effect: 'DENY', scope: null, scopeIds: null });
      }
    }
  }
  // 2. «سماح» — the person passed; no role of theirs receives the box; they do not already hold it.
  for (const p of skip === 'allow' ? [] : pass) {
    const roleReceives = ur.some((x) => x.uid === p.uid && roleGets.some((rg) => rg.rid === x.rid && rg.newKey === p.newKey));
    if (!roleReceives && !has(p.uid, p.newKey) && !hasUserRow(p.uid, p.newKey)) {
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

/**
 * The door's OLD rule, asked of the old rows through the real engine.
 *   · costs.view   — ANY of the five keys
 *   · insights.view — ANY of the nine screen keys
 *   · team.monitor — the TABLE's old door: users.view OR the role name. (A person who already held team.monitor is judged apart.)
 */
async function passedYesterday(db0: Rows, uid: string, newKey: string): Promise<boolean> {
  const u = await holder(db0, uid);
  const role = db0.users.find((x) => x.id === uid)!.role;
  if (newKey === 'team.monitor') return can(u, 'users.view') || (TEAM_TABLE_ROLE_NAMES as readonly string[]).includes(role);
  return VISIBILITY_KEYS_FROM.find((r) => r.key === newKey)!.from.some((src) => can(u, src));
}

let nextId = 0;
const role = (name: string, companyId: string | null = null) => ({ id: `r${++nextId}`, companyId, name });

function fixture(): Rows {
  nextId = 0;
  const tAdmin = role('COMPANY_ADMIN'); // system templates
  const tManager = role('MANAGER'); // no users.view of its own: passes the team table by NAME
  const tWarehouse = role('WAREHOUSE');
  const tAccountant = role('ACCOUNTANT');
  const tModerator = role('MODERATOR');
  const cShelf = role('أمين مخزن', 'c1'); // company roles
  const cMaker = role('مصنّع', 'c1'); // production.manage only
  const cMoney = role('مالي', 'c1'); // finance.view only
  const cViewer = role('مشاهد', 'c1'); // dashboard.view only
  const cNothing = role('فاضي', 'c1');
  const cPeople = role('قارئ الفريق', 'c1'); // users.view only
  const cWatcher = role('مراقب', 'c1'); // already holds team.monitor, without users.view
  const cNoBaseline = role('بلا افتراضي', 'c1'); // has sources, never issued a baseline
  const cNamedManager = role('MANAGER', 'c1'); // a COMPANY role that happens to be named like the template
  const cAdjust = role('معدّل', 'c1'); // inventory.adjust only
  const cBoth = role('فريق ومراقبة', 'c1'); // users.view AND team.monitor: the role RECEIVES the box it already holds
  const perms: Array<[typeof tAdmin, string[]]> = [
    [tAdmin, ['users.view', 'finance.view', 'inventory.view', 'inventory.adjust', 'production.view', 'production.manage', 'products.view', 'reports.view', 'dashboard.view', 'orders.view', 'customers.view', 'landing_pages.view']],
    [tManager, ['dashboard.view', 'orders.view', 'reports.view']],
    [tWarehouse, ['inventory.view', 'inventory.adjust', 'products.view', 'dashboard.view']],
    [tAccountant, ['finance.view', 'reports.view', 'dashboard.view', 'products.view']],
    [tModerator, ['orders.view', 'products.view', 'dashboard.view', 'reports.view']],
    [cShelf, ['inventory.view']],
    [cMaker, ['production.manage']],
    [cMoney, ['finance.view']],
    [cViewer, ['dashboard.view']],
    [cPeople, ['users.view']],
    [cWatcher, ['team.monitor']],
    [cNoBaseline, ['inventory.view', 'confirmation.work']],
    [cNamedManager, ['orders.confirm']],
    [cAdjust, ['inventory.adjust']],
    [cBoth, ['users.view', 'team.monitor']],
  ];
  const rows: Rows = {
    users: [],
    roles: [tAdmin, tManager, tWarehouse, tAccountant, tModerator, cShelf, cMaker, cMoney, cViewer, cNothing, cPeople, cWatcher, cNoBaseline, cNamedManager, cAdjust, cBoth],
    rolePerms: [],
    defaults: [],
    userPerms: [],
  };
  let i = 0;
  for (const [r, keys] of perms) {
    for (const permission of keys) {
      rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission, scope: 'ALL_COMPANY', scopeIds: null });
      if (r.id !== cNoBaseline.id) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission, scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  const user = (id: string, roleName: string, roleId: string | null) => rows.users.push({ id, role: roleName, roleId });
  const ex = (userId: string, permission: string, effect: 'ALLOW' | 'DENY') =>
    rows.userPerms.push({ id: `up${++i}`, userId, permission, effect, scope: effect === 'ALLOW' ? 'ALL_COMPANY' : null, scopeIds: null });

  user('admin', 'COMPANY_ADMIN', tAdmin.id);
  user('admin-no-role-id', 'COMPANY_ADMIN', null); // reads the template named like the role
  user('manager', 'MANAGER', tManager.id); // the NAME opens the team table
  user('manager-no-role-id', 'MANAGER', null);
  user('manager-custom-role', 'MANAGER', cViewer.id); // enum MANAGER, a custom role that holds nothing of the team
  user('moderator', 'MODERATOR', tModerator.id);
  user('warehouse', 'WAREHOUSE', tWarehouse.id);
  user('accountant', 'ACCOUNTANT', tAccountant.id);
  user('shelf', 'MODERATOR', cShelf.id);
  user('maker', 'MODERATOR', cMaker.id);
  user('money', 'MODERATOR', cMoney.id);
  user('viewer', 'MODERATOR', cViewer.id);
  user('nothing', 'MODERATOR', cNothing.id);
  user('people', 'MODERATOR', cPeople.id);
  user('watcher', 'MODERATOR', cWatcher.id);
  user('no-baseline', 'MODERATOR', cNoBaseline.id);
  user('named-manager-role', 'MODERATOR', cNamedManager.id); // a role NAMED «MANAGER» whose member is NOT enum MANAGER: no name pass
  user('adjust', 'MODERATOR', cAdjust.id);
  user('root', 'SUPER_ADMIN', null);
  user('stranger', 'ROLE_NOBODY_KNOWS', null); // no role id, no template: the fallback, which is empty
  user('fallback-warehouse', 'WAREHOUSE', null);
  user('fallback-manager', 'MANAGER', null);
  // ── the same roles, with a personal «منع» / «سماح» on a source key ──
  user('admin-denied-users', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-users', 'users.view', 'DENY'); // still passes the table BY NAME
  user('people-denied-users', 'MODERATOR', cPeople.id); ex('people-denied-users', 'users.view', 'DENY'); // the role's ONLY source, refused
  user('manager-denied-users', 'MANAGER', tManager.id); ex('manager-denied-users', 'users.view', 'DENY');
  user('admin-denied-cost-keys', 'COMPANY_ADMIN', tAdmin.id);
  for (const k of COST_SOURCE_KEYS) ex('admin-denied-cost-keys', k, 'DENY'); // keeps the cards through the others
  user('shelf-denied-inventory', 'MODERATOR', cShelf.id); ex('shelf-denied-inventory', 'inventory.view', 'DENY');
  user('viewer-denied-dashboard', 'MODERATOR', cViewer.id); ex('viewer-denied-dashboard', 'dashboard.view', 'DENY');
  user('moderator-denied-all-cards', 'MODERATOR', tModerator.id);
  for (const k of ['orders.view', 'products.view', 'dashboard.view', 'reports.view']) ex('moderator-denied-all-cards', k, 'DENY');
  user('nothing-allowed-finance', 'MODERATOR', cNothing.id); ex('nothing-allowed-finance', 'finance.view', 'ALLOW');
  user('nothing-allowed-users', 'MODERATOR', cNothing.id); ex('nothing-allowed-users', 'users.view', 'ALLOW');
  user('nothing-allowed-orders', 'MODERATOR', cNothing.id); ex('nothing-allowed-orders', 'orders.view', 'ALLOW');
  user('nothing-allowed-all', 'MODERATOR', cNothing.id);
  for (const k of SRC_KEYS) ex('nothing-allowed-all', k, 'ALLOW');
  user('shelf-allowed-finance', 'MODERATOR', cShelf.id); ex('shelf-allowed-finance', 'finance.view', 'ALLOW');
  user('stranger-allowed-inventory', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-inventory', 'inventory.view', 'ALLOW');
  user('stranger-allowed-users', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-users', 'users.view', 'ALLOW');
  user('manager-no-role-denied-users', 'MANAGER', null); ex('manager-no-role-denied-users', 'users.view', 'DENY');
  // ── the box the owner already holds or already refused ──
  user('watcher-allowed', 'MODERATOR', cNothing.id); ex('watcher-allowed', 'team.monitor', 'ALLOW'); // team.monitor by a personal row, no users.view
  user('admin-pre-denied-monitor', 'COMPANY_ADMIN', tAdmin.id); ex('admin-pre-denied-monitor', 'team.monitor', 'DENY'); // the owner took the scoreboard away
  user('shelf-pre-denied-costs', 'MODERATOR', cShelf.id); ex('shelf-pre-denied-costs', 'costs.view', 'DENY');
  user('watcher-and-people', 'MODERATOR', cPeople.id); ex('watcher-and-people', 'team.monitor', 'ALLOW');
  // the role holds BOTH keys; she is refused users.view by hand and so passed the table through nothing — but she holds the box
  user('both-denied-users', 'MODERATOR', cBoth.id); ex('both-denied-users', 'users.view', 'DENY');
  // an unrelated exception must not move anything
  user('admin-denied-other', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-other', 'settings.view', 'DENY');
  return rows;
}

/** A person who held `team.monitor` before this change reads the confirmation team table through it afterwards — the one gain. */
async function heldMonitorBefore(db0: Rows, uid: string) {
  return can(await holder(db0, uid), 'team.monitor');
}

async function everyDoorOfEveryone(db0: Rows) {
  const db1 = applyTheMigration(db0);
  const lost: string[] = [];
  const gained: string[] = [];
  const widened: string[] = [];
  for (const u of db0.users) {
    const after = await holder(db1, u.id);
    for (const k of NEW_KEYS) {
      const was = await passedYesterday(db0, u.id, k);
      const is = can(after, k);
      // A key the owner had ALREADY denied by hand is the one deliberate exception: the migration never re-grants it.
      const preDenied = u.role !== 'SUPER_ADMIN' && db0.userPerms.some((p) => p.userId === u.id && p.permission === k && p.effect === 'DENY');
      // A person who ALREADY held the key through the key itself passed its other door before; the table door is now theirs too.
      const heldItself = EXISTING_KEYS.includes(k) && (await heldMonitorBefore(db0, u.id));
      // Whoever held the key itself keeps it: taking it from them would take the scoreboard away.
      if ((was || heldItself) && !is && !preDenied) lost.push(`${u.id} lost ${k}`);
      if (!was && is && !heldItself) gained.push(`${u.id} gained ${k}`);
      if (!was && is && heldItself) widened.push(`${u.id}:${k}`);
      // The screen's own question agrees with the server's.
      expect(userCan(after, k), `${u.id}/${k}: الشاشة والخادم`).toBe(is);
    }
  }
  return { db1, lost, gained, widened };
}

describe('the replay: every person, every door — yesterday against today, through the real engine', () => {
  it('nobody loses a door, nobody gains one (fixture people, 3 boxes each)', async () => {
    const db0 = fixture();
    const { lost, gained } = await everyDoorOfEveryone(db0);
    expect(lost, 'خسروا باباً').toEqual([]);
    expect(gained, 'كسبوا باباً').toEqual([]);
    expect(db0.users.length).toBeGreaterThanOrEqual(40);
  });

  it('the one widening is exactly the people who held team.monitor already: they read the confirmation team table too', async () => {
    const db0 = fixture();
    const { widened } = await everyDoorOfEveryone(db0);
    // those who hold the key by a role or a personal row and passed neither users.view nor a role name
    expect(widened.sort()).toEqual(['both-denied-users:team.monitor', 'watcher:team.monitor', 'watcher-allowed:team.monitor'].sort());
  });

  it('the fixture really exercises the cases (a replay that finds nothing would pass for the wrong reason)', async () => {
    const db0 = fixture();
    let passers = 0;
    for (const u of db0.users) for (const k of NEW_KEYS) if (await passedYesterday(db0, u.id, k)) passers++;
    expect(passers, 'من يمر من الأبواب').toBeGreaterThan(60);
    expect(await passedYesterday(db0, 'nothing', 'costs.view')).toBe(false);
    expect(await passedYesterday(db0, 'viewer', 'costs.view')).toBe(false);
    const db1 = applyTheMigration(db0);
    const written = (rows: Array<{ id: string }>, before: Array<{ id: string }>) => rows.length - before.length;
    expect(written(db1.userPerms, db0.userPerms)).toBeGreaterThan(10);
    expect(written(db1.rolePerms, db0.rolePerms)).toBeGreaterThan(10);
    expect(written(db1.defaults, db0.defaults)).toBeGreaterThan(8);
    expect(db1.userPerms.filter((p) => p.id.startsWith('ci10-') && p.effect === 'DENY').length).toBeGreaterThan(4);
    expect(db1.userPerms.filter((p) => p.id.startsWith('ci10-') && p.effect === 'ALLOW').length).toBeGreaterThan(6);
  });

  it('each case by name: a box follows the key its door asked, and not another one', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const box = async (uid: string, k: string) => can(await holder(db1, uid), k);
    // the cost: the stock, the production and the finance keys — each alone
    for (const uid of ['shelf', 'maker', 'money', 'adjust', 'warehouse', 'accountant', 'admin']) expect(await box(uid, 'costs.view'), `${uid}/costs`).toBe(true);
    for (const uid of ['viewer', 'nothing', 'people', 'moderator', 'manager']) expect(await box(uid, 'costs.view'), `${uid}/costs`).toBe(false);
    // the cards: the screen keys
    for (const uid of ['shelf', 'moderator', 'viewer', 'accountant', 'warehouse', 'named-manager-role', 'no-baseline']) expect(await box(uid, 'insights.view'), `${uid}/cards`).toBe(true);
    for (const uid of ['nothing', 'people', 'maker', 'money']) expect(await box(uid, 'insights.view'), `${uid}/cards`).toBe(false);
    // the team table: users.view, or the NAME of the enum role (not the name of a company role)
    for (const uid of ['admin', 'admin-no-role-id', 'people', 'manager', 'manager-no-role-id', 'manager-custom-role', 'fallback-manager']) {
      expect(await box(uid, 'team.monitor'), `${uid}/team`).toBe(true);
    }
    for (const uid of ['shelf', 'nothing', 'moderator', 'named-manager-role', 'viewer']) expect(await box(uid, 'team.monitor'), `${uid}/team`).toBe(false);
    // a «منع» on ONE source of several takes only that source
    expect(await box('admin-denied-users', 'team.monitor')).toBe(true); // the NAME still passes her
    expect(await box('people-denied-users', 'team.monitor')).toBe(false);
    expect(await box('manager-denied-users', 'team.monitor')).toBe(true);
    expect(await box('manager-no-role-denied-users', 'team.monitor')).toBe(true);
    expect(await box('admin-denied-cost-keys', 'costs.view')).toBe(false);
    expect(await box('admin-denied-cost-keys', 'insights.view')).toBe(true);
    expect(await box('shelf-denied-inventory', 'costs.view')).toBe(false);
    expect(await box('shelf-denied-inventory', 'insights.view')).toBe(false);
    expect(await box('viewer-denied-dashboard', 'insights.view')).toBe(false);
    expect(await box('moderator-denied-all-cards', 'insights.view')).toBe(false);
    // a «سماح» reaches the box in a role that has none
    expect(await box('nothing-allowed-finance', 'costs.view')).toBe(true);
    expect(await box('nothing-allowed-finance', 'insights.view')).toBe(false);
    expect(await box('nothing-allowed-users', 'team.monitor')).toBe(true);
    expect(await box('nothing-allowed-orders', 'insights.view')).toBe(true);
    expect(await box('nothing-allowed-orders', 'costs.view')).toBe(false);
    expect(await box('shelf-allowed-finance', 'costs.view')).toBe(true);
    expect(await box('stranger-allowed-inventory', 'costs.view')).toBe(true);
    expect(await box('stranger-allowed-users', 'team.monitor')).toBe(true);
    // an unrelated exception moved nothing
    expect(await box('admin-denied-other', 'costs.view')).toBe(true);
  });

  it('what the owner already decided is not undone: his «منع» on a box stays, his «سماح» stays, his role keeps its box', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    expect(can(await holder(db1, 'admin-pre-denied-monitor'), 'team.monitor')).toBe(false);
    expect(can(await holder(db1, 'admin-pre-denied-monitor'), 'costs.view')).toBe(true);
    expect(can(await holder(db1, 'shelf-pre-denied-costs'), 'costs.view')).toBe(false);
    expect(can(await holder(db1, 'shelf-pre-denied-costs'), 'insights.view')).toBe(true);
    // a role that already holds team.monitor keeps it, and its members are NOT given a «منع» for it
    expect(can(await holder(db1, 'watcher'), 'team.monitor')).toBe(true);
    expect(db1.userPerms.filter((p) => p.userId === 'watcher' && p.permission === 'team.monitor')).toEqual([]);
    expect(can(await holder(db1, 'watcher-allowed'), 'team.monitor')).toBe(true);
    // and the people-list holder in the watcher’s company role also keeps the key through her own row
    expect(can(await holder(db1, 'watcher-and-people'), 'team.monitor')).toBe(true);
    // a role that holds no source today receives nothing
    const nothingRole = db0.roles.find((r) => r.name === 'فاضي')!;
    expect(db1.rolePerms.filter((p) => p.roleId === nothingRole.id)).toEqual([]);
    expect(db1.defaults.filter((p) => p.roleId === nothingRole.id)).toEqual([]);
  });

  it('the work keeps working when a box is taken: the owner unticks the cost and the shelf STAYS; he unticks the cards and the screen STAYS', async () => {
    const db1 = applyTheMigration(fixture());
    db1.userPerms.push({ id: 'owner-1', userId: 'warehouse', permission: 'costs.view', effect: 'DENY', scope: null, scopeIds: null });
    db1.userPerms.push({ id: 'owner-2', userId: 'moderator', permission: 'insights.view', effect: 'DENY', scope: null, scopeIds: null });
    const warehouse = await holder(db1, 'warehouse');
    expect(can(warehouse, 'costs.view')).toBe(false);
    expect(can(warehouse, 'inventory.view')).toBe(true);
    expect(can(warehouse, 'inventory.adjust')).toBe(true);
    const moderator = await holder(db1, 'moderator');
    expect(can(moderator, 'insights.view')).toBe(false);
    expect(can(moderator, 'orders.view')).toBe(true);
    expect(can(moderator, 'products.view')).toBe(true);
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
    for (const i of added) expect(i).toMatch(/^ci10-/);
    // Nothing that existed before was changed or removed.
    for (const p of db0.userPerms) expect(once.userPerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.rolePerms) expect(once.rolePerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.defaults) expect(once.defaults.find((q) => q.id === p.id)).toEqual(p);
  });

  it('the «إرجاع للافتراضي» baseline carries the boxes, so the first reset after the deploy does not take them away', () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    for (const rule of VISIBILITY_KEYS_FROM) {
      const withSource = new Set(db0.defaults.filter((d) => rule.from.includes(d.permission)).map((d) => d.roleId));
      for (const r of db0.roles) if ((rule.byRole ?? []).includes(r.name)) withSource.add(r.id);
      const boxed = new Set(db1.defaults.filter((d) => d.permission === rule.key).map((d) => d.roleId));
      // a role whose baseline ALREADY held the box before keeps it too (team.monitor's watcher role)
      for (const d of db0.defaults.filter((x) => x.permission === rule.key)) withSource.add(d.roleId);
      expect(boxed, rule.key).toEqual(withSource);
    }
  });

  it('NEGATIVE (the test of the test): a migration with one step removed is CAUGHT — no «منع», no «سماح», no role rows, no names, a source read through a «منع», a box taken from its holders', async () => {
    const db0 = fixture();
    const count = async (skip: Skip) => {
      const broken = applyTheMigration(db0, skip);
      const found = { lost: 0, gained: 0 };
      for (const u of db0.users) {
        const after = await holder(broken, u.id);
        for (const k of NEW_KEYS) {
          const was = await passedYesterday(db0, u.id, k);
          const is = can(after, k);
          const heldItself = EXISTING_KEYS.includes(k) && (await heldMonitorBefore(db0, u.id));
          const preDenied = db0.userPerms.some((p) => p.userId === u.id && p.permission === k && p.effect === 'DENY');
          if ((was || heldItself) && !is && !preDenied) found.lost++;
          if (!was && is && !heldItself) found.gained++;
        }
      }
      return found;
    };
    expect((await count('deny')).gained, 'بلا «منع» يُمنح المفتاح بلا باب').toBeGreaterThan(0);
    expect((await count('allow')).lost, 'بلا «سماح» يخسر صاحب الاستثناء').toBeGreaterThan(0);
    expect((await count('roles')).lost, 'بلا صفوف الأدوار يخسر الجميع').toBeGreaterThan(0);
    expect((await count('denied-sources')).gained, 'إن نسي أنّ «المنع» يُسقط المصدر').toBeGreaterThan(0);
    expect((await count('names')).lost, 'بلا الأسماء يخسر المدير ومدير الشركة جدول الفريق').toBeGreaterThan(0);
    // a «منع» written on top of a key somebody ALREADY holds takes a working door away
    expect((await count('has')).lost, 'بلا «يملكه أصلاً» يُسحب المفتاح ممّن يملكه').toBeGreaterThan(0);
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
  const KEYS = [...SRC_KEYS, 'team.monitor', 'finance.cashbox', 'orders.create'];
  const SCOPES: Scope[] = ['ALL_COMPANY', 'OWN', 'ASSIGNED'];
  const rows: Rows = { users: [], roles: [], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  const templateNames = ['COMPANY_ADMIN', 'MANAGER', 'ACCOUNTANT'];
  for (const name of templateNames) rows.roles.push({ id: `t-${name}`, companyId: null, name });
  for (let r = 0; r < 12; r++) rows.roles.push({ id: `c${r}`, companyId: 'c1', name: r === 3 ? 'MANAGER' : `role${r}` });
  for (const r of rows.roles) {
    for (const k of KEYS) {
      if (rand() < 0.3) rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission: k, scope: pick(SCOPES), scopeIds: null });
      if (rand() < 0.3) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission: k, scope: pick(SCOPES), scopeIds: null });
    }
  }
  for (let u = 0; u < 200; u++) {
    const kind = rand();
    const row =
      kind < 0.5 ? { role: pick(['MODERATOR', 'MANAGER', 'COMPANY_ADMIN']), roleId: pick(rows.roles.filter((x) => x.companyId !== null)).id }
      : kind < 0.75 ? { role: pick(templateNames), roleId: null }
      : kind < 0.9 ? { role: pick(['WAREHOUSE', 'COMPANY_ADMIN_X', 'MANAGER']), roleId: null }
      : kind < 0.95 ? { role: 'SUPER_ADMIN', roleId: null }
      : { role: 'MODERATOR', roleId: pick(rows.roles).id };
    rows.users.push({ id: `u${u}`, ...row });
    for (const k of KEYS) {
      const x = rand();
      if (x < 0.12) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'DENY', scope: null, scopeIds: null });
      else if (x < 0.22) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'ALLOW', scope: pick(SCOPES), scopeIds: null });
    }
    // The owner pre-empted a box here and there: a «منع» on a NEW key that exists before the migration. It is kept.
    if (rand() < 0.05) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: pick(['costs.view', 'insights.view']), effect: 'DENY', scope: null, scopeIds: null });
  }
  return rows;
}

describe('a seeded fuzz: 40 random companies, 200 people each — nobody loses a door, nobody gains one', () => {
  it('holds for every seed', async () => {
    let people = 0;
    let withRows = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const db0 = randomWorld(seed);
      const { db1, lost, gained } = await everyDoorOfEveryone(db0);
      expect(lost, `seed ${seed}`).toEqual([]);
      expect(gained, `seed ${seed}`).toEqual([]);
      people += db0.users.length;
      if (db1.userPerms.length > db0.userPerms.length) withRows++;
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

  it('a legacy role gets a box exactly when it held a key the door asked, or is NAMED by it — no more, no less, for every role in the code', async () => {
    const roles = Object.keys(ROLE_PERMISSIONS).filter((r) => r !== 'SUPER_ADMIN');
    expect(roles.length).toBeGreaterThan(8);
    let boxes = 0;
    for (const r of roles) {
      const g = (await fallback(r)).grants;
      for (const rule of VISIBILITY_KEYS_FROM) {
        const was = rule.from.some((src) => g[src] !== undefined) || (rule.byRole ?? []).includes(r);
        expect(g[rule.key] !== undefined, `${r}/${rule.key}`).toBe(was);
        if (was) boxes++;
      }
    }
    expect(boxes, 'a fallback that reaches no role would pass for the wrong reason').toBeGreaterThan(10);
  });

  it('by name: the company admin and the manager get the team key; the pending user gets none of the three', async () => {
    for (const r of ['COMPANY_ADMIN', 'MANAGER']) expect(Object.keys((await fallback(r)).grants), r).toContain('team.monitor');
    const pending = Object.keys((await fallback('PENDING_USER')).grants);
    for (const k of NEW_KEYS) expect(pending, k).not.toContain(k);
  });

  it('NEGATIVE: a «منع» on the box, or on every key it comes from, wins over the fallback — and the other boxes of the same person stay', async () => {
    expect(Object.keys((await fallback('COMPANY_ADMIN', [{ permission: 'costs.view', effect: 'DENY' }])).grants)).not.toContain('costs.view');
    const noCostKeys = Object.keys((await fallback('COMPANY_ADMIN', COST_SOURCE_KEYS.map((permission) => ({ permission, effect: 'DENY' })))).grants);
    expect(noCostKeys).not.toContain('costs.view');
    expect(noCostKeys).toContain('insights.view');
    // the NAME still opens the team table for a company admin whose people list was refused
    expect(Object.keys((await fallback('COMPANY_ADMIN', [{ permission: 'users.view', effect: 'DENY' }])).grants)).toContain('team.monitor');
    // …unless the box itself was refused
    expect(Object.keys((await fallback('COMPANY_ADMIN', [{ permission: 'team.monitor', effect: 'DENY' }])).grants)).not.toContain('team.monitor');
  });

  it('a personal «سماح» on the old key reaches the boxes in the fallback too', async () => {
    const g = (await fallback('ROLE_NOBODY_KNOWS', [{ permission: 'finance.view', effect: 'ALLOW' }])).grants;
    expect(g['costs.view']).toBeDefined();
    expect(g['insights.view']).toBeUndefined();
    const h = (await fallback('ROLE_NOBODY_KNOWS', [{ permission: 'orders.view', effect: 'ALLOW' }])).grants;
    expect(h['insights.view']).toBeDefined();
    expect(h['costs.view']).toBeUndefined();
    const t = (await fallback('ROLE_NOBODY_KNOWS', [{ permission: 'users.view', effect: 'ALLOW' }])).grants;
    expect(t['team.monitor']).toBeDefined();
  });

  it('the parity list (the reset-to-default baseline of a legacy role) carries the boxes for the same roles', () => {
    for (const r of ['COMPANY_ADMIN', 'MANAGER'] as const) {
      expect(legacyEffectiveKeys(r), r).toContain('team.monitor');
      expect(legacyEffectiveKeys(r), r).toContain('insights.view');
    }
    expect(legacyEffectiveKeys('PENDING_USER')).not.toContain('costs.view');
    expect(legacyEffectiveKeys('PENDING_USER')).not.toContain('team.monitor');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// EVERY DOOR ASKS ITS KEY — read from the source, so a door that quietly goes back to the old rule is caught here.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('every card door asks insights.view, and every cost door asks costs.view', () => {
  const src = (f: string) => stripComments(repoFile(f));

  it('the doors that serve ONLY a card answer 403 without the key, before they read anything', () => {
    for (const f of [
      'src/app/api/products/grades/route.ts',
      'src/app/api/settings/channels/performance/route.ts',
      'src/app/api/analytics/loss/route.ts',
      'src/app/api/orders/[id]/shape-risk/route.ts',
    ]) {
      const s = src(f);
      expect(s, `${f}: بلا مفتاح البطاقات`).toMatch(/if \(!mayReadInsights\(user\)\) return insightsRefused\(\)/);
      // the refusal comes first: before the first read of the database
      expect(s.indexOf('insightsRefused()'), f).toBeLessThan(s.search(/\bdb\.\w+\.(find|group|count|aggregate)/));
    }
  });

  it('the doors that serve records AND a card leave the card out — absent, not zero', () => {
    expect(src('src/app/api/products/stats/route.ts')).toMatch(/mayReadInsights\(user\) \? answer : \{ unitsSold: answer\.unitsSold \}/);
    expect(src('src/app/api/growth/campaigns/route.ts')).toMatch(/\.\.\.\(mayReadInsights\(user\) \? \{ insights \} : \{\}\)/);
    expect(src('src/app/api/growth/landing-analytics/route.ts')).toMatch(/const withVerdicts = mayReadInsights\(user\)/);
    expect(src('src/app/api/confirmation/mine/route.ts')).toMatch(/mayReadInsights\(user\) \? await Promise\.all/);
    expect(src('src/app/api/customers/[id]/history/route.ts')).toMatch(/mayReadInsights\(user\) \? await customerRisk/);
    expect(src('src/app/api/palette/route.ts').match(/facts: mayReadInsights\(user\)/g)).toHaveLength(2);
    expect(src('src/lib/analytics-projection.ts')).toMatch(/can\(user, 'insights\.view'\)/);
    expect(src('src/lib/analytics-answer.ts')).toMatch(/can\(user, 'insights\.view'\) \? \{ returnsByProduct: productReturns \}/);
  });

  it('the doors found by the independent review ask the key too: the day summary, the confirmation assistant, the API-token minter', () => {
    expect(src('src/app/api/palette/today/route.ts')).toContain("!can(user, 'ai.assist') || !mayReadInsights(user)");
    expect(src('src/app/api/palette/route.ts')).toContain("can(user, 'ai.assist') && mayReadInsights(user)");
    const ai = src('src/app/api/ai/confirmation/route.ts');
    expect(ai).toContain('const showRisk = mayReadInsights(user)');
    expect(ai).toContain('...(showRisk');
    expect(src('src/lib/v1/token-granter.ts')).toContain("'products.costs.read': ['products.view', 'finance.view', 'costs.view']");
  });

  it('the cost doors all ask maySeeCost, which asks costs.view and nothing else', () => {
    const cost = src('src/lib/cost-visibility.ts');
    expect(cost).toMatch(/return can\(user, 'costs\.view'\);/);
    for (const k of COST_SOURCE_KEYS) expect(cost, `${k} رجع إلى maySeeCost`).not.toContain(`'${k}'`);
    const order = src('src/lib/order-projection.ts');
    expect(order).toMatch(/return can\(user, 'finance\.view'\) && can\(user, 'costs\.view'\);/);
  });

  it('the two team tables ask team.monitor and name no role', () => {
    for (const f of ['src/app/api/orders/confirmation/team/route.ts', 'src/app/api/orders/confirmation/performance/route.ts']) {
      const s = src(f);
      expect(s, f).toMatch(/can\(user, 'team\.monitor'\)/);
      expect(s, `${f}: اسم دور`).not.toMatch(/'COMPANY_ADMIN'|'MANAGER'|'SUPER_ADMIN'/);
      expect(s, `${f}: users.view`).not.toContain(`'users.view'`);
    }
  });

  it('the screens draw a card only for the key the server answers to', () => {
    const must: Array<[string, RegExp]> = [
      ['src/components/screens/ProductsScreen.tsx', /userCan\(currentUser, 'insights\.view'\)/],
      ['src/components/screens/ProductDetailScreen.tsx', /userCan\(currentUser, 'insights\.view'\) && <ProductPerformance/],
      ['src/components/screens/DashboardScreen.tsx', /canInsights && <LossPanel/],
      ['src/components/screens/PerformanceScreen.tsx', /canInsights && <ChannelScoresSection/],
      ['src/components/screens/PerformanceScreen.tsx', /if \(!canScores\) return;/],
      ['src/components/screens/PerformanceScreen.tsx', /\{canScores && \(\s*<Card>/],
      ['src/components/screens/DashboardScreen.tsx', /\{canInsights && \(\s*<Card>/],
      ['src/components/orders/OrderDetailModal.tsx', /userCan\(currentUser, 'insights\.view'\) && <ShapeRiskPanel/],
      ['src/components/orders/OrderDetailModal.tsx', /userCan\(currentUser, 'finance\.view'\) && userCan\(currentUser, 'costs\.view'\)/],
    ];
    for (const [f, re] of must) expect(src(f), `${f}: ${re}`).toMatch(re);
  });
});
