import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE USERS, ROLES AND APP-KEY DOORS GET A BOX EACH — AND NOBODY LOSES A DOOR OR GAINS ONE (perm-plan PR-13).
 *
 * Five keys: users.delete · users.shift · users.security · roles.edit_system · apps.tokens.
 *
 * The migration 20261030190000_users_roles_apps_keys gives each box to exactly the roles and people who passed the old door —
 * by KEY (users.edit, apps.manage) and, where the old door read a role NAME (the password and second-factor doors, the
 * system-template door), by that name — and carries every «منع». The owner's rule for this change, in his words:
 * «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 * THERE IS NO DELIBERATE GAIN in this change and no deliberate loss in the migration. (The two narrowings that ARE deliberate —
 * the personal exceptions on roles.edit, the inbox obeying its stored scope — are not grants this file writes; they are
 * door changes with their own tests, and the pre-deploy report counts the people they touch.)
 *
 * ⚠️ WHAT THIS FILE IS, SAID PLAINLY. There is no database in CI, so the SQL cannot be run here. Two things are done
 * instead, and neither is the SQL running:
 *   1. the SQL is READ as text — its shape (what it writes, in which order, from which keys) is pinned;
 *   2. the SQL's logic is REPLAYED by `applyTheMigration` below, a statement-for-statement copy over in-memory rows, and
 *      the people it produces are judged by the REAL engine (computeEffectiveGrants + can): for every person and every
 *      door, "could they pass yesterday" must equal "can they pass today".
 * The copy can drift from the SQL; the reviewer's own rehearsal of the SQL inside a rolled-back transaction is the
 * stronger evidence, and the pull request says what was and was not done.
 *
 * AND THE SUPER_ADMIN IS THE WAY BACK IN: it passes all five doors centrally, whatever rows say. Tested below with an
 * engine whose every row is a «منع».
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants, can } from './authorization';
import { userCan } from './can';
import { ALL_CATALOG_KEYS, catalogItem } from './permission-catalog';
import { computeEffectiveGrants, legacyEffectiveKeys, type GrantSource } from './permissions-core';
import { SYSTEM_TEMPLATE_EDITOR_ROLE_NAMES, USERS_ROLES_APPS_KEYS_FROM, USERS_SECURITY_ROLE_NAMES } from './users-roles-apps-keys';
import type { SessionUser } from '@/types/auth';

const NAME = '20261030190000_users_roles_apps_keys';
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

interface GateRow { newKey: string; src: string | null; role: string | null }
/** The gate table, one row per (box, key the door asked) and one per (box, role name the door read). */
const GATE: GateRow[] = USERS_ROLES_APPS_KEYS_FROM.flatMap((r) => [
  ...r.from.map((src) => ({ newKey: r.key, src, role: null })),
  ...(r.byRole ?? []).map((role) => ({ newKey: r.key, src: null, role })),
]);
const NEW_KEYS = USERS_ROLES_APPS_KEYS_FROM.map((r) => r.key);
const SRC_KEYS = [...new Set(GATE.flatMap((g) => (g.src ? [g.src] : [])))];

describe('the five new boxes are in the catalog, each with the screen key it sits behind', () => {
  const REQUIRES: Record<string, string> = {
    'users.delete': 'users.edit',
    'users.shift': 'users.edit',
    'users.security': 'users.view',
    'roles.edit_system': 'roles.edit',
    'apps.tokens': 'apps.view',
  };

  it('are exactly these five, in the list the migration and the engine fallback read', () => {
    expect([...NEW_KEYS].sort()).toEqual(Object.keys(REQUIRES).sort());
    expect(NEW_KEYS).toHaveLength(5);
  });

  it('can all be ticked on «الصلاحيات», with an Arabic and an English label', () => {
    for (const k of NEW_KEYS) {
      const item = catalogItem(k);
      expect(item, k).toBeDefined();
      expect(ALL_CATALOG_KEYS.has(k), k).toBe(true);
      expect(item!.requires, `${k}: مفتاح الشاشة`).toBe(REQUIRES[k]);
      expect(item!.ar.trim().length, k).toBeGreaterThan(8);
      expect(item!.en.trim().length, k).toBeGreaterThan(8);
    }
  });

  it('the names the old doors read are exactly COMPANY_ADMIN — SUPER_ADMIN is central and gets no row', () => {
    expect([...USERS_SECURITY_ROLE_NAMES]).toEqual(['COMPANY_ADMIN']);
    expect([...SYSTEM_TEMPLATE_EDITOR_ROLE_NAMES]).toEqual(['COMPANY_ADMIN']);
    // NEGATIVE: not a single gate row names the owner — a row on its template would be one the engine never reads
    expect(GATE.filter((g) => g.role === 'SUPER_ADMIN')).toEqual([]);
  });

  it('only the two key-fed boxes list a key; only the two name-fed boxes list a name', () => {
    expect(GATE.filter((g) => g.src).map((g) => `${g.newKey}<${g.src}`).sort()).toEqual(['apps.tokens<apps.manage', 'users.delete<users.edit', 'users.shift<users.edit']);
    expect(GATE.filter((g) => g.role).map((g) => `${g.newKey}<${g.role}`).sort()).toEqual(['roles.edit_system<COMPANY_ADMIN', 'users.security<COMPANY_ADMIN']);
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
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'ur13-' || gen_random_uuid()::text`);
    }
    for (const s of statements.filter((x) => !x.startsWith('INSERT INTO'))) {
      expect(s.startsWith('DROP TABLE IF EXISTS pg_temp.sp13_') || s.startsWith('CREATE TEMP TABLE sp13_'), s.slice(0, 70)).toBe(true);
      if (s.startsWith('DROP')) expect(s).not.toMatch(/\bpublic\b|"(users|roles|role_permissions|user_permissions)"/);
    }
    // The quoted key names are values (users.delete is a key, not a statement): strip them before looking at the words.
    for (const s of statements) expect(s.replace(/'[^']*'/g, "''")).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|ALTER)\b/i);
  });

  it('has no BEGIN or COMMIT, so a rehearsal inside a transaction can really be rolled back', () => {
    expect(statements.filter((s) => /^(BEGIN|COMMIT|START TRANSACTION|ROLLBACK)\b/i.test(s))).toEqual([]);
  });

  it('writes the box in all three places a grant lives — the person (both effects), the role, and its baseline', () => {
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
      expect(reads).not.toContain('"user_permissions"');
      expect(reads).not.toContain('"role_permissions"');
      expect(reads).toMatch(/sp13_pass/);
      expect(reads).toMatch(/sp13_has/);
    }
    // a new key may appear only as the LEFT column of the gate table, never in a snapshot of what people hold
    for (const s of statements.filter((x) => x.startsWith('CREATE TEMP TABLE') && !x.startsWith('CREATE TEMP TABLE sp13_gate'))) {
      for (const k of NEW_KEYS) expect(s, `${k} in ${s.slice(0, 40)}`).not.toContain(`'${k}'`);
    }
  });

  it('the gate table is EXACTLY the one the engine fallback and the screens read (USERS_ROLES_APPS_KEYS_FROM)', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp13_gate'))!;
    const lit = `(NULL::text|'[A-Za-z_.]+')`;
    const re = new RegExp(`\\('([a-z_.]+)',\\s*${lit},\\s*${lit}\\)`, 'g');
    const strip = (x: string) => (x === 'NULL::text' ? null : x.replace(/'/g, ''));
    const rows = [...gate.matchAll(re)].map((m) => ({ newKey: m[1], src: strip(m[2]), role: strip(m[3]) }));
    const key = (r: GateRow) => `${r.newKey}<${r.src}<${r.role}`;
    expect(rows.map(key).sort()).toEqual(GATE.map(key).sort());
    expect(rows).toHaveLength(GATE.length);
    // a row names a key OR a role, never both and never neither
    for (const r of rows) expect((r.src === null) !== (r.role === null), key(r)).toBe(true);
  });

  it('the snapshot of what people hold reads exactly the source keys of the gate table', () => {
    const holds = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp13_holds'))!);
    expect(holds).toContain('h.k IN (SELECT src FROM sp13_gate WHERE src IS NOT NULL)');
    expect(holds).toContain(`up."effect" = 'ALLOW'`);
    expect(holds).toContain(`d."effect" = 'DENY'`);
    expect(holds).toContain(`u."role" <> 'SUPER_ADMIN'`);
    // a person's own «سماح» REPLACES the role's row for the same key — the engine's rule — so the role's is read only without one
    expect(holds).toContain(`a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW'`);
    expect(SRC_KEYS.sort()).toEqual(['apps.manage', 'users.edit']);
  });

  it('the statements that decide a person say exactly what the replay does — a flipped condition is caught HERE, since the replay is a copy', () => {
    const deny = flat(statements.find((s) => s.includes(`'DENY'`) && s.startsWith('INSERT INTO'))!);
    // the role receives the box AND the person did not pass THAT door AND does not already hold the box
    expect(deny).toContain('FROM sp13_user_role ur JOIN sp13_role_gets rg ON rg.rid = ur.rid');
    expect(deny).toContain('WHERE NOT EXISTS (SELECT 1 FROM sp13_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)');
    expect(deny).toContain('AND NOT EXISTS (SELECT 1 FROM sp13_has x WHERE x.uid = ur.uid AND x.k = rg.new_key)');
    const allow = flat(statements.find((s) => s.includes(`'ALLOW'`) && s.startsWith('INSERT INTO'))!);
    // the person passed AND no role of theirs receives the box AND they do not already hold it
    expect(allow).toContain('FROM sp13_pass p WHERE NOT EXISTS (SELECT 1 FROM sp13_user_role ur JOIN sp13_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key WHERE ur.uid = p.uid)');
    expect(allow).toContain('AND NOT EXISTS (SELECT 1 FROM sp13_has x WHERE x.uid = p.uid AND x.k = p.new_key)');
    // no box carries a scope: none of these doors ever evaluated one (a «منع» stores none at all)
    for (const s of statements.filter((x) => x.startsWith('INSERT INTO') && !x.includes(`'DENY'`))) expect(s).toContain(`'ALL_COMPANY'`);
    expect(deny).toContain(`'DENY', NULL, NULL, now()`);
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!)).toContain('FROM sp13_role_gets rg');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!)).toContain('FROM sp13_default_gets dg');
  });

  it('a role is judged by the key it holds OR the name it carries — in both the role table and the baseline', () => {
    for (const [t, from, col] of [['sp13_role_gets', '"role_permissions" rp', 'rp."permission"'], ['sp13_default_gets', '"role_permission_defaults" d', 'd."permission"']] as const) {
      const s = flat(statements.find((x) => x.startsWith(`CREATE TEMP TABLE ${t}`))!);
      expect(s, t).toContain(`FROM ${from} JOIN sp13_gate g ON g.src = ${col}`);
      expect(s, t).toContain('FROM "roles" r JOIN sp13_gate g ON g.role_name = r."name"');
    }
  });

  it('a system template with NO rows is given none: its people are answered by the in-code matrix, which two rows would switch off', () => {
    const s = flat(statements.find((x) => x.startsWith('CREATE TEMP TABLE sp13_role_gets'))!);
    expect(s).toContain('WHERE r."companyId" IS NOT NULL OR EXISTS (SELECT 1 FROM "role_permissions" x WHERE x."roleId" = r."id")');
  });

  it('the baseline of a role named like the owner is written ONLY for a role that already has baseline rows', () => {
    const s = flat(statements.find((x) => x.startsWith('CREATE TEMP TABLE sp13_default_gets'))!);
    expect(s).toContain('FROM "roles" r JOIN sp13_gate g ON g.role_name = r."name" WHERE EXISTS (SELECT 1 FROM "role_permission_defaults" x WHERE x."roleId" = r."id")');
    // ...and the LIVE role rows carry no such condition: the role keeps its doors
    expect(flat(statements.find((x) => x.startsWith('CREATE TEMP TABLE sp13_role_gets'))!)).not.toContain('role_permission_defaults');
  });

  it('a person is judged by the key they hold OR the name of their role, and the owner is never read', () => {
    const pass = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp13_pass'))!);
    expect(pass).toContain('FROM sp13_holds h JOIN sp13_gate g ON g.src = h.k');
    expect(pass).toContain('FROM "users" u JOIN sp13_gate g ON g.role_name = u."role"');
    expect(pass).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('reads the role the way the engine reads it, and leaves SUPER_ADMIN alone', () => {
    const ur = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp13_user_role'))!;
    expect(ur).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
    expect(ur).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
    expect(ur).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('its rollback removes only what it wrote, in all three places, and its own row in the migrations table', () => {
    const body = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const deletes = body.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'ur13-%'`);
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
      expect(text, m).not.toContain(`'ur13-'`);
    }
  });

  it('runs after the migrations of the previous permission boxes, and has the timestamp reserved for it', () => {
    expect(NAME > '20261030150000_finance_split_keys').toBe(true);
    expect(NAME).toBe('20261030190000_users_roles_apps_keys');
  });

  it('does NOT write the backfills the old plan had (whatsapp.view / telegram.view from manage) — they would open an inbox', () => {
    expect(sql.replace(/^--.*$/gm, '')).not.toMatch(/whatsapp|telegram/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE REPLAY — the SQL's statements, one by one, over in-memory rows.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Grant { id: string; roleId: string; permission: string; scope: string; scopeIds: unknown[] | null }
interface Rows {
  users: Array<{ id: string; role: string; roleId: string | null }>;
  roles: Array<{ id: string; companyId: string | null; name: string }>;
  rolePerms: Grant[];
  defaults: Grant[];
  userPerms: Array<{ id: string; userId: string; permission: string; effect: 'ALLOW' | 'DENY'; scope: string | null; scopeIds: unknown[] | null }>;
}

const clone = (r: Rows): Rows => JSON.parse(JSON.stringify(r)) as Rows;

/** `sp13_user_role`: (uid, rid) — the engine's own reading of "which role are this person's grants from". */
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

type Skip = 'deny' | 'allow' | 'roles' | 'defaults' | 'denied-sources' | 'has' | 'names' | 'own-allow-replaces-role' | 'baseline-for-all' | 'rowless-template';

/** Statement-for-statement the SQL of migration.sql. */
function applyTheMigration(before: Rows, skip?: Skip): Rows {
  const db = clone(before);
  const gate = GATE.filter((g) => !(skip === 'names' && g.role !== null));

  // ── the snapshot: everything below is read from `before`, never from rows written here ──
  const ur = userRole(before);
  const superIds = new Set(before.users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.id));
  const denied = (uid: string, k: string) => skip !== 'denied-sources' && before.userPerms.some((d) => d.userId === uid && d.permission === k && d.effect === 'DENY');
  const holdKeys = new Set(gate.flatMap((g) => (g.src ? [g.src] : [])));

  // sp13_holds — a person's own «سماح» REPLACES the role's row for the same key
  const holds: Array<{ uid: string; k: string }> = [];
  for (const up of before.userPerms) {
    if (up.effect === 'ALLOW' && !superIds.has(up.userId) && holdKeys.has(up.permission) && !denied(up.userId, up.permission)) holds.push({ uid: up.userId, k: up.permission });
  }
  for (const x of ur) {
    for (const rp of before.rolePerms) {
      if (rp.roleId !== x.rid || !holdKeys.has(rp.permission)) continue;
      if (skip !== 'own-allow-replaces-role' && before.userPerms.some((a) => a.userId === x.uid && a.permission === rp.permission && a.effect === 'ALLOW')) continue;
      if (denied(x.uid, rp.permission)) continue;
      holds.push({ uid: x.uid, k: rp.permission });
    }
  }

  // sp13_has — who already holds a box this file would give
  const newKeys = new Set(gate.map((g) => g.newKey));
  const has = new Set<string>();
  if (skip !== 'has') {
    for (const up of before.userPerms) if (up.effect === 'ALLOW' && newKeys.has(up.permission)) has.add(`${up.userId}|${up.permission}`);
    for (const x of ur) {
      for (const rp of before.rolePerms) {
        if (rp.roleId !== x.rid || !newKeys.has(rp.permission)) continue;
        if (before.userPerms.some((o) => o.userId === x.uid && o.permission === rp.permission)) continue;
        has.add(`${x.uid}|${rp.permission}`);
      }
    }
  }

  // sp13_pass
  const pass: Array<{ uid: string; newKey: string }> = [];
  for (const h of holds) for (const g of gate) if (g.src === h.k) pass.push({ uid: h.uid, newKey: g.newKey });
  for (const u of before.users) {
    if (u.role === 'SUPER_ADMIN') continue;
    for (const g of gate) if (g.role === u.role) pass.push({ uid: u.id, newKey: g.newKey });
  }

  // sp13_role_gets / sp13_default_gets
  const gets = (table: Grant[], onlyWithABaseline: boolean) => {
    const out: Array<{ rid: string; newKey: string }> = [];
    for (const rp of table) for (const g of gate) if (g.src === rp.permission) out.push({ rid: rp.roleId, newKey: g.newKey });
    for (const r of before.roles) {
      // a role never issued a baseline is not given one by the name path (skip 'baseline-for-all' undoes this on purpose)
      if (onlyWithABaseline && skip !== 'baseline-for-all' && !before.defaults.some((x) => x.roleId === r.id)) continue;
      // a SYSTEM template with no rows is answered by the in-code matrix: it gets no live rows either (skip 'rowless-template' undoes this)
      if (!onlyWithABaseline && skip !== 'rowless-template' && r.companyId === null && !before.rolePerms.some((x) => x.roleId === r.id)) continue;
      for (const g of gate) if (g.role === r.name) out.push({ rid: r.id, newKey: g.newKey });
    }
    return out;
  };
  const roleGets = gets(before.rolePerms, false);
  const defaultGets = gets(before.defaults, true);

  let n = 0;
  const id = () => `ur13-${++n}`;
  const hasUserRow = (uid: string, k: string) => db.userPerms.some((p) => p.userId === uid && p.permission === k);

  // 1. «منع» — the role receives the box, the person did not pass THAT door, and does not already hold it.
  for (const x of skip === 'deny' ? [] : ur) {
    for (const rg of roleGets) {
      if (rg.rid !== x.rid) continue;
      if (pass.some((p) => p.uid === x.uid && p.newKey === rg.newKey)) continue;
      if (has.has(`${x.uid}|${rg.newKey}`)) continue;
      if (!hasUserRow(x.uid, rg.newKey)) {
        db.userPerms.push({ id: id(), userId: x.uid, permission: rg.newKey, effect: 'DENY', scope: null, scopeIds: null });
      }
    }
  }
  // 2. «سماح» — the person passed and no role of theirs receives the box.
  for (const p of skip === 'allow' ? [] : pass) {
    const roleReceives = ur.some((x) => x.uid === p.uid && roleGets.some((rg) => rg.rid === x.rid && rg.newKey === p.newKey));
    if (roleReceives) continue;
    if (has.has(`${p.uid}|${p.newKey}`)) continue;
    if (!hasUserRow(p.uid, p.newKey)) {
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

const roleOf = (db: Rows, uid: string) => db.users.find((u) => u.id === uid)!.role;

/** The OLD doors, asked of the OLD rows through the real engine — what each box must equal the day after. */
async function passedYesterday(db0: Rows, uid: string, key: string): Promise<boolean> {
  const u = await holder(db0, uid);
  const role = roleOf(db0, uid);
  switch (key) {
    case 'users.delete':
    case 'users.shift':
      return can(u, 'users.edit');
    case 'apps.tokens':
      return can(u, 'apps.manage');
    // The two name-fed doors read `users.role` and nothing else: no «منع» ever stopped them, no «سماح» ever opened them.
    case 'users.security':
    case 'roles.edit_system':
      return role === 'SUPER_ADMIN' || role === 'COMPANY_ADMIN';
    default:
      throw new Error(key);
  }
}

let nextId = 0;
const role = (name: string, companyId: string | null = null) => ({ id: `r${++nextId}`, companyId, name });

/** The world AFTER the previous migrations: the templates and the company's own roles, and the people on them. */
function fixture(): Rows {
  nextId = 0;
  const tAdmin = role('COMPANY_ADMIN'); // system templates
  const tMgr = role('MANAGER');
  const tMod = role('MODERATOR');
  const tAcc = role('ACCOUNTANT');
  const cEditor = role('محرر موظفين', 'c1'); // users.edit only
  const cApps = role('مسؤول تطبيقات', 'c1'); // apps.manage only
  const cBoth = role('محرر وتطبيقات', 'c1'); // users.edit + apps.manage
  const cNothing = role('فاضي', 'c1');
  const cNamedAdmin = role('COMPANY_ADMIN', 'c1'); // a COMPANY role carrying the owner's name, holding nothing of the kind
  const cNoBaseline = role('بلا خط أساس', 'c1'); // users.edit, never issued a baseline
  const cAdminNoBaseline = role('COMPANY_ADMIN', 'c2'); // carries the owner's name, was never issued a baseline
  const perms: Array<[typeof tAdmin, string[]]> = [
    [tAdmin, ['users.view', 'users.edit', 'roles.view', 'roles.edit', 'apps.view', 'apps.manage']],
    [tMgr, ['users.view', 'users.edit', 'apps.view']],
    [tMod, ['orders.view']],
    [tAcc, ['finance.view', 'apps.view', 'apps.manage']],
    [cEditor, ['users.view', 'users.edit']],
    [cApps, ['apps.view', 'apps.manage']],
    [cBoth, ['users.view', 'users.edit', 'apps.view', 'apps.manage']],
    [cNothing, ['settings.view']],
    [cNamedAdmin, ['settings.view']],
    [cNoBaseline, ['users.view', 'users.edit']],
    [cAdminNoBaseline, ['users.view', 'users.edit', 'apps.manage']],
  ];
  const rows: Rows = {
    users: [],
    roles: [tAdmin, tMgr, tMod, tAcc, cEditor, cApps, cBoth, cNothing, cNamedAdmin, cNoBaseline, cAdminNoBaseline],
    rolePerms: [], defaults: [], userPerms: [],
  };
  let i = 0;
  for (const [r, keys] of perms) {
    for (const permission of keys) {
      rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission, scope: 'ALL_COMPANY', scopeIds: null });
      if (r.id !== cNoBaseline.id && r.id !== cAdminNoBaseline.id) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission, scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  const user = (id: string, roleName: string, roleId: string | null) => rows.users.push({ id, role: roleName, roleId });
  const ex = (userId: string, permission: string, effect: 'ALLOW' | 'DENY') =>
    rows.userPerms.push({ id: `up${++i}`, userId, permission, effect, scope: effect === 'ALLOW' ? 'ALL_COMPANY' : null, scopeIds: null });

  user('admin', 'COMPANY_ADMIN', tAdmin.id);
  user('admin-no-role-id', 'COMPANY_ADMIN', null); // reads the template named like the role
  user('manager', 'MANAGER', tMgr.id);
  user('mod', 'MODERATOR', tMod.id);
  user('acc', 'ACCOUNTANT', tAcc.id);
  user('editor', 'MODERATOR', cEditor.id);
  user('apps', 'MODERATOR', cApps.id);
  user('both', 'MODERATOR', cBoth.id);
  user('nothing', 'MODERATOR', cNothing.id);
  user('no-baseline', 'MODERATOR', cNoBaseline.id);
  user('root', 'SUPER_ADMIN', null);
  user('stranger', 'ROLE_NOBODY_KNOWS', null); // no role id, no template: the fallback, which is empty
  user('legacy-accountant', 'ACCOUNTANT', null); // no roleId, but a template of that name exists (tAcc): reads it
  user('legacy-follow-up', 'FOLLOW_UP_AGENT', null); // no template of that name: the in-code fallback
  // ── the same roles, with a personal «منع» / «سماح» on a source key ──
  user('admin-denied-edit', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-edit', 'users.edit', 'DENY'); // keeps the NAME doors, loses the key doors
  user('admin-denied-apps', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-apps', 'apps.manage', 'DENY');
  user('manager-denied-edit', 'MANAGER', tMgr.id); ex('manager-denied-edit', 'users.edit', 'DENY');
  user('editor-denied-edit', 'MODERATOR', cEditor.id); ex('editor-denied-edit', 'users.edit', 'DENY'); // the role's only source, refused
  user('both-denied-edit', 'MODERATOR', cBoth.id); ex('both-denied-edit', 'users.edit', 'DENY'); // keeps apps, loses delete+shift
  user('both-denied-apps', 'MODERATOR', cBoth.id); ex('both-denied-apps', 'apps.manage', 'DENY');
  user('apps-denied-apps', 'MODERATOR', cApps.id); ex('apps-denied-apps', 'apps.manage', 'DENY');
  user('nothing-allowed-edit', 'MODERATOR', cNothing.id); ex('nothing-allowed-edit', 'users.edit', 'ALLOW'); // a personal «سماح» in a role without it
  user('nothing-allowed-apps', 'MODERATOR', cNothing.id); ex('nothing-allowed-apps', 'apps.manage', 'ALLOW');
  user('nothing-allowed-both', 'MODERATOR', cNothing.id); ex('nothing-allowed-both', 'users.edit', 'ALLOW'); ex('nothing-allowed-both', 'apps.manage', 'ALLOW');
  user('mod-allowed-edit', 'MODERATOR', tMod.id); ex('mod-allowed-edit', 'users.edit', 'ALLOW');
  user('editor-allowed-apps', 'MODERATOR', cEditor.id); ex('editor-allowed-apps', 'apps.manage', 'ALLOW');
  user('stranger-allowed-edit', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-edit', 'users.edit', 'ALLOW');
  user('stranger-allowed-apps', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-apps', 'apps.manage', 'ALLOW');
  user('legacy-follow-up-allowed-edit', 'FOLLOW_UP_AGENT', null); ex('legacy-follow-up-allowed-edit', 'users.edit', 'ALLOW');
  user('admin-allowed-other', 'COMPANY_ADMIN', tAdmin.id); ex('admin-allowed-other', 'settings.view', 'ALLOW'); // an unrelated exception moves nothing
  user('admin-denied-other', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-other', 'settings.view', 'DENY');
  // ── the NAME without the role: a person whose role string is the owner's name but whose roleId is a custom role ──
  user('admin-in-custom-role', 'COMPANY_ADMIN', cNothing.id);
  user('admin-in-editor-role', 'COMPANY_ADMIN', cEditor.id);
  user('admin-in-apps-role', 'COMPANY_ADMIN', cApps.id);
  // ── a role CARRYING the owner's name, with a person whose own role string is something else ──
  user('named-role-other-string', 'ACCOUNTANT', cNamedAdmin.id); // must NOT gain users.security / roles.edit_system
  user('named-role-moderator', 'MODERATOR', cNamedAdmin.id);
  user('named-role-and-apps-allow', 'MODERATOR', cNamedAdmin.id); ex('named-role-and-apps-allow', 'apps.manage', 'ALLOW');
  user('named-role-admin-string', 'COMPANY_ADMIN', cNamedAdmin.id); // string AND role carry the name: passes
  user('admin-of-the-other-company', 'COMPANY_ADMIN', cAdminNoBaseline.id);
  return rows;
}

async function everyDoorOfEveryone(db0: Rows, migrate: (r: Rows) => Rows = applyTheMigration) {
  const db1 = migrate(db0);
  const lost: string[] = [];
  const gained: string[] = [];
  for (const u of db0.users) {
    const after = await holder(db1, u.id);
    for (const k of NEW_KEYS) {
      const was = await passedYesterday(db0, u.id, k);
      const is = can(after, k);
      if (was && !is) lost.push(`${u.id} lost ${k}`);
      if (!was && is) gained.push(`${u.id} gained ${k}`);
      // The screen's own question agrees with the server's.
      expect(userCan(after, k), `${u.id}/${k}: الشاشة والخادم`).toBe(is);
    }
    // THE OLD KEYS WERE NOT TOUCHED: this file writes only the five new ones.
    for (const k of [...SRC_KEYS, 'roles.edit', 'users.view', 'roles.view', 'apps.view']) {
      expect(can(after, k), `${u.id}: ${k} تغيّر`).toBe(can(await holder(db0, u.id), k));
    }
  }
  return { db1, lost, gained };
}

describe('the replay: every person, every door — yesterday against today, through the real engine', () => {
  it('nobody loses a door and nobody gains one', async () => {
    const db0 = fixture();
    const { lost, gained } = await everyDoorOfEveryone(db0);
    expect(lost, 'خسروا باباً').toEqual([]);
    expect(gained, 'كسبوا باباً').toEqual([]);
    expect(db0.users.length).toBeGreaterThanOrEqual(35);
  });

  it('the fixture really exercises the cases (a replay that finds nothing would pass for the wrong reason)', async () => {
    const db0 = fixture();
    let passers = 0;
    let refused = 0;
    for (const u of db0.users) for (const k of NEW_KEYS) ((await passedYesterday(db0, u.id, k)) ? passers++ : refused++);
    expect(passers, 'من يمر من الأبواب').toBeGreaterThan(50);
    expect(refused, 'من لا يمر').toBeGreaterThan(50);
    const db1 = applyTheMigration(db0);
    expect(db1.userPerms.length - db0.userPerms.length).toBeGreaterThan(15);
    expect(db1.rolePerms.length - db0.rolePerms.length).toBeGreaterThan(10);
    expect(db1.defaults.length - db0.defaults.length).toBeGreaterThan(8);
    expect(db1.userPerms.filter((p) => p.id.startsWith('ur13-') && p.effect === 'DENY').length).toBeGreaterThan(4);
    expect(db1.userPerms.filter((p) => p.id.startsWith('ur13-') && p.effect === 'ALLOW').length).toBeGreaterThan(8);
  });

  it('each case by name: the box follows the door it came from, and not another one', async () => {
    const db1 = applyTheMigration(fixture());
    const box = async (uid: string, k: string) => can(await holder(db1, uid), k);
    // a key alone is enough, in a role or as a personal «سماح»
    expect(await box('editor', 'users.delete')).toBe(true);
    expect(await box('editor', 'users.shift')).toBe(true);
    expect(await box('nothing-allowed-edit', 'users.delete')).toBe(true);
    expect(await box('mod-allowed-edit', 'users.shift')).toBe(true);
    expect(await box('apps', 'apps.tokens')).toBe(true);
    expect(await box('nothing-allowed-apps', 'apps.tokens')).toBe(true);
    expect(await box('editor-allowed-apps', 'apps.tokens')).toBe(true);
    // …and the lists do not leak into one another
    expect(await box('editor', 'apps.tokens')).toBe(false); // users.edit is not apps.manage
    expect(await box('apps', 'users.delete')).toBe(false);
    expect(await box('apps', 'users.shift')).toBe(false);
    expect(await box('both', 'users.delete')).toBe(true);
    expect(await box('both', 'apps.tokens')).toBe(true);
    // the old key itself does NOT carry the name-fed boxes: users.edit is not users.security, apps.manage is not roles.edit_system
    for (const uid of ['editor', 'apps', 'both', 'manager', 'acc', 'nothing-allowed-both']) {
      expect(await box(uid, 'users.security'), `${uid} security`).toBe(false);
      expect(await box(uid, 'roles.edit_system'), `${uid} edit_system`).toBe(false);
    }
    // by NAME: the company admin keeps the password/2FA door and the system templates — even with every source unticked
    for (const uid of ['admin', 'admin-no-role-id', 'admin-denied-edit', 'admin-denied-apps', 'admin-in-custom-role', 'admin-in-editor-role', 'admin-in-apps-role', 'named-role-admin-string']) {
      expect(await box(uid, 'users.security'), `${uid} security`).toBe(true);
      expect(await box(uid, 'roles.edit_system'), `${uid} edit_system`).toBe(true);
    }
    // a «منع» on the ONLY source refuses the box too
    expect(await box('admin-denied-edit', 'users.delete')).toBe(false);
    expect(await box('admin-denied-edit', 'users.shift')).toBe(false);
    expect(await box('admin-denied-apps', 'apps.tokens')).toBe(false);
    expect(await box('manager-denied-edit', 'users.delete')).toBe(false);
    expect(await box('editor-denied-edit', 'users.shift')).toBe(false);
    expect(await box('both-denied-edit', 'users.delete')).toBe(false);
    expect(await box('both-denied-edit', 'apps.tokens')).toBe(true); // …and only the box whose source was refused
    expect(await box('both-denied-apps', 'apps.tokens')).toBe(false);
    expect(await box('both-denied-apps', 'users.shift')).toBe(true);
    expect(await box('apps-denied-apps', 'apps.tokens')).toBe(false);
    // a role that CARRIES the name gives it to nobody whose own role string is something else (no door gained)…
    for (const uid of ['named-role-other-string', 'named-role-moderator', 'named-role-and-apps-allow']) {
      expect(await box(uid, 'users.security'), `${uid} security`).toBe(false);
      expect(await box(uid, 'roles.edit_system'), `${uid} edit_system`).toBe(false);
    }
    // …while the key it carried through a personal «سماح» still opens its own box
    expect(await box('named-role-and-apps-allow', 'apps.tokens')).toBe(true);
    // a manager (users.edit) is NOT the owner: delete and shift yes, security and system templates no
    expect(await box('manager', 'users.delete')).toBe(true);
    expect(await box('manager', 'users.security')).toBe(false);
    // an unrelated exception moved nothing
    expect(await box('admin-denied-other', 'users.security')).toBe(true);
    expect(await box('admin-allowed-other', 'apps.tokens')).toBe(true);
    // people with no stored role: the personal «سماح» opens the box, the fallback does not invent one
    expect(await box('stranger-allowed-edit', 'users.delete')).toBe(true);
    expect(await box('stranger-allowed-apps', 'apps.tokens')).toBe(true);
    expect(await box('stranger', 'users.delete')).toBe(false);
    expect(await box('legacy-follow-up', 'users.security')).toBe(false);
    expect(await box('legacy-follow-up-allowed-edit', 'users.shift')).toBe(true);
    expect(await box('nothing', 'apps.tokens')).toBe(false);
  });

  it('writes the box into the role AND its baseline, so «إرجاع للافتراضي» does not take it back', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    for (const r of db1.roles) {
      const hasBaseline = db0.defaults.some((d) => d.roleId === r.id);
      for (const k of NEW_KEYS) {
        const inRole = db1.rolePerms.some((p) => p.roleId === r.id && p.permission === k);
        const inDefaults = db1.defaults.some((p) => p.roleId === r.id && p.permission === k);
        // a role that HAS a baseline gets the box into it (the baseline is what the reset restores)
        if (inRole && hasBaseline) expect(inDefaults, `${r.name}/${k}: بلا خط أساس`).toBe(true);
      }
    }
    // the baseline holds exactly what the role holds, for the five keys, on the roles that had one
    const tAdmin = db1.roles.find((r) => r.name === 'COMPANY_ADMIN' && r.companyId === null)!;
    const baseline = db1.defaults.filter((d) => d.roleId === tAdmin.id && NEW_KEYS.includes(d.permission)).map((d) => d.permission).sort();
    expect(baseline).toEqual([...NEW_KEYS].sort());
  });

  it('a rowless COMPANY_ADMIN system template keeps its people on the in-code matrix: no door lost, none gained, and its matrix is not switched off', async () => {
    const db0: Rows = {
      users: [{ id: 'bare-admin', role: 'COMPANY_ADMIN', roleId: null }],
      roles: [{ id: 'bare', companyId: null, name: 'COMPANY_ADMIN' }],
      rolePerms: [], defaults: [], userPerms: [],
    };
    const db1 = applyTheMigration(db0);
    expect(db1.rolePerms, 'the template stays rowless').toEqual([]);
    const before = await holder(db0, 'bare-admin');
    const after = await holder(db1, 'bare-admin');
    expect([...after.permissions].sort()).toEqual([...before.permissions].sort());
    expect(after.permissions.length, 'the fallback matrix is still there').toBeGreaterThan(10);
    const { lost, gained } = await everyDoorOfEveryone(db0);
    expect(lost).toEqual([]);
    expect(gained).toEqual([]);
    // NEGATIVE, by breaking the replay: two live rows on that template switch the fallback off
    const broken = applyTheMigration(db0, 'rowless-template');
    expect(broken.rolePerms.length).toBeGreaterThan(0);
    expect((await holder(broken, 'bare-admin')).permissions.length).toBeLessThan(5);
  });

  it('NEVER creates a baseline where a role had none - a one-box baseline would be read as the shipped matrix and the first reset would wipe the role', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const noBaseline = db0.roles.filter((r) => !db0.defaults.some((d) => d.roleId === r.id));
    expect(noBaseline.length, 'الأدوار بلا خط أساس بالفيكستشر').toBeGreaterThanOrEqual(2);
    for (const r of noBaseline) expect(db1.defaults.filter((d) => d.roleId === r.id), r.name).toEqual([]);
    // ...yet their LIVE role rows are given as usual (the role keeps its doors)
    const other = db1.roles.find((r) => r.name === 'COMPANY_ADMIN' && r.companyId === 'c2')!;
    expect(db1.rolePerms.filter((p) => p.roleId === other.id && NEW_KEYS.includes(p.permission)).map((p) => p.permission).sort()).toEqual(['apps.tokens', 'roles.edit_system', 'users.delete', 'users.security', 'users.shift']);
    // NEGATIVE, by breaking the replay: writing a baseline for every role named like the owner would create the hazard
    const hazard = applyTheMigration(db0, 'baseline-for-all');
    expect(hazard.defaults.filter((d) => d.roleId === other.id).length, 'الخطر').toBeGreaterThan(0);
  });

  it('writes nothing for SUPER_ADMIN — no row for the owner, and no row on a template nobody reads', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const rootRows = db1.userPerms.filter((p) => p.userId === 'root');
    expect(rootRows).toEqual([]);
    // and the migration touches only the five keys, and only rows it tagged
    const written = [...db1.userPerms, ...db1.rolePerms, ...db1.defaults].filter((p) => p.id.startsWith('ur13-'));
    for (const w of written) expect(NEW_KEYS).toContain(w.permission);
    expect(written.length).toBe(db1.userPerms.length + db1.rolePerms.length + db1.defaults.length - db0.userPerms.length - db0.rolePerms.length - db0.defaults.length);
  });

  it('runs twice without changing anything the second time (it is re-runnable)', async () => {
    const db0 = fixture();
    const once = applyTheMigration(db0);
    const twice = applyTheMigration(once);
    const key = (r: Rows) => [
      ...r.userPerms.map((p) => `u|${p.userId}|${p.permission}|${p.effect}`),
      ...r.rolePerms.map((p) => `r|${p.roleId}|${p.permission}`),
      ...r.defaults.map((p) => `d|${p.roleId}|${p.permission}`),
    ].sort();
    expect(key(twice)).toEqual(key(once));
    const second = await everyDoorOfEveryone(once, applyTheMigration);
    expect(second.lost).toEqual([]);
    expect(second.gained).toEqual([]);
  });

  it('NEGATIVE, by breaking the replay on purpose: each missing step is caught by the same comparison', async () => {
    const db0 = fixture();
    // no «منع» carried → people gain doors
    expect((await everyDoorOfEveryone(db0, (r) => applyTheMigration(r, 'deny'))).gained.length, 'منع').toBeGreaterThan(0);
    // sources read without their «منع» → people gain doors
    expect((await everyDoorOfEveryone(db0, (r) => applyTheMigration(r, 'denied-sources'))).gained.length, 'منع على المصدر').toBeGreaterThan(0);
    // no personal «سماح» → people lose doors
    expect((await everyDoorOfEveryone(db0, (r) => applyTheMigration(r, 'allow'))).lost.length, 'سماح').toBeGreaterThan(0);
    // no role rows → roles lose their doors
    expect((await everyDoorOfEveryone(db0, (r) => applyTheMigration(r, 'roles'))).lost.length, 'الأدوار').toBeGreaterThan(0);
    // the names not read → the company admin loses the owner's two doors
    const noNames = await everyDoorOfEveryone(db0, (r) => applyTheMigration(r, 'names'));
    expect(noNames.lost.some((l) => l.includes('users.security')), 'الأسماء').toBe(true);
    expect(noNames.lost.some((l) => l.includes('roles.edit_system')), 'الأسماء').toBe(true);
    // a personal «سماح» not allowed to replace the role's row → the replay mis-reads who holds what
    // (it changes nothing for these keys, which carry no scope — the line exists to prove the replay is not vacuous elsewhere)
    expect((await everyDoorOfEveryone(db0, (r) => applyTheMigration(r, 'own-allow-replaces-role'))).lost).toEqual([]);
  });

  it('NEGATIVE: the baseline is what «إرجاع للافتراضي» restores — without its rows the first reset takes the box away again', () => {
    const db1 = applyTheMigration(fixture(), 'defaults');
    const tAdmin = db1.roles.find((r) => r.name === 'COMPANY_ADMIN' && r.companyId === null)!;
    expect(db1.defaults.filter((d) => d.roleId === tAdmin.id && NEW_KEYS.includes(d.permission))).toEqual([]);
    const good = applyTheMigration(fixture());
    expect(good.defaults.filter((d) => d.roleId === tAdmin.id && NEW_KEYS.includes(d.permission)).length).toBe(5);
  });
});

describe('THE WAY BACK IN: nobody can lock themselves out, and nobody can lock everybody out', () => {
  /** An engine whose every row is a «منع» on all five keys and whose role holds nothing: the worst case a bad tick can make. */
  const hostile: GrantSource = {
    roleRows: async () => [],
    overrideRows: async () => NEW_KEYS.map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
  };

  it('SUPER_ADMIN passes all five doors through the engine itself, whatever rows say', async () => {
    const g = await computeEffectiveGrants({ id: 'root', role: 'SUPER_ADMIN', roleId: null }, hostile);
    expect(g.fullAccess).toBe(true);
    const root = attachGrants({ id: 'root', role: 'SUPER_ADMIN', status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser, g);
    for (const k of NEW_KEYS) {
      expect(can(root, k), k).toBe(true);
      // …and the screen's question says the same, so no button is hidden from the one person who must see it
      expect(userCan(root, k), `${k} (الشاشة)`).toBe(true);
    }
  });

  it('NEGATIVE: the same hostile rows DO take the doors from an ordinary admin — so the line above is the owner’s, not an accident of the test', async () => {
    const g = await computeEffectiveGrants({ id: 'a', role: 'COMPANY_ADMIN', roleId: null }, hostile);
    expect(g.fullAccess).toBe(false);
    const admin = attachGrants({ id: 'a', role: 'COMPANY_ADMIN', status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser, g);
    for (const k of NEW_KEYS) expect(can(admin, k), k).toBe(false);
  });

  it('after the migration, unticking every box from every ordinary role still leaves the owner every door', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    // the worst tick: the owner (or a mistake) removes the five keys from every role and baseline
    const stripped: Rows = { ...clone(db1), rolePerms: db1.rolePerms.filter((p) => !NEW_KEYS.includes(p.permission)), defaults: db1.defaults.filter((p) => !NEW_KEYS.includes(p.permission)) };
    // (every ordinary role now holds nothing of the five — which is exactly the lock-out being asked about)
    const root = await holder(stripped, 'root');
    for (const k of NEW_KEYS) expect(can(root, k), k).toBe(true);
  });

  it('and the owner’s account is never one the migration writes a row for, so no later cleanup of "this migration’s rows" can touch it', () => {
    const db1 = applyTheMigration(fixture());
    expect(db1.userPerms.filter((p) => p.userId === 'root')).toEqual([]);
    expect(db1.users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.id)).toEqual(['root']);
  });
});

describe('the in-code fallback, for a person with no stored role and no template', () => {
  const source = (rows: Array<{ permission: string }> = [], overrides: Array<{ permission: string; effect: string }> = []): GrantSource => ({
    roleRows: async () => rows.map((r) => ({ ...r, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => overrides.map((o) => ({ ...o, scope: null, scopeIds: null })),
  });

  it('keeps the two name-fed doors for the company admin by NAME, and gives no other role anything', async () => {
    const admin = await computeEffectiveGrants({ id: 'a', role: 'COMPANY_ADMIN', roleId: null }, source());
    expect(Object.keys(admin.grants)).toEqual(expect.arrayContaining(['users.security', 'roles.edit_system']));
    for (const r of ['MANAGER', 'ACCOUNTANT', 'MODERATOR', 'FOLLOW_UP_AGENT', 'SETTLEMENT_OFFICER', 'CONFIRMATION_AGENT']) {
      const g = await computeEffectiveGrants({ id: 'm', role: r, roleId: null }, source());
      for (const k of ['users.security', 'roles.edit_system']) expect(g.grants[k], `${r}/${k}`).toBeUndefined();
    }
  });

  it('a «منع» on the box wins over the name, in the fallback too', async () => {
    const g = await computeEffectiveGrants({ id: 'a', role: 'COMPANY_ADMIN', roleId: null }, source([], [{ permission: 'users.security', effect: 'DENY' }]));
    expect(g.grants['users.security']).toBeUndefined();
    expect(g.grants['roles.edit_system']).toBeDefined();
  });

  it('the legacy baseline («إرجاع للافتراضي» for a shipped role) carries the same boxes', () => {
    const admin = legacyEffectiveKeys('COMPANY_ADMIN');
    for (const k of ['users.security', 'roles.edit_system', 'users.delete', 'users.shift']) expect(admin, k).toContain(k);
    const manager = legacyEffectiveKeys('MANAGER');
    for (const k of ['users.security', 'roles.edit_system', 'users.delete', 'users.shift', 'apps.tokens']) expect(manager, k).not.toContain(k);
  });
});
