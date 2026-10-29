import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER ACTIONS GET A BOX EACH — AND NOBODY LOSES A DOOR OR GAINS ONE (perm-plan PR-6).
 *
 * Seven keys: orders.change_price · orders.change_fee · orders.cancel · orders.note · orders.request_change ·
 * orders.rating_link · control.blacklist_manage. Before this change each door asked a wider key (orders.edit,
 * orders.change_status, orders.unlock, orders.view | confirmation.work, orders.view, control.blacklist). The migration
 * 20261030130000_order_action_keys gives each box to exactly the roles and people who passed that door, carries every
 * «منع», and gives the ONE scoped box (the price) the SAME scope the order edit had.
 *
 * The owner's rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 * ⚠️ WHAT THIS FILE IS, SAID PLAINLY. There is no database in CI, so the SQL cannot be run here. Two things are done
 * instead, and neither is the SQL running:
 *   1. the SQL is READ as text — its shape (what it writes, in which order, from which keys) is pinned;
 *   2. the SQL's logic is REPLAYED by `applyTheMigration` below, a statement-for-statement copy over in-memory rows, and
 *      the people it produces are judged by the REAL engine (computeEffectiveGrants + can + getPermissionScope): for
 *      every person and every door, "could they pass yesterday" must equal "can they pass today".
 * The copy can drift from the SQL; the reviewer's own rehearsal of the SQL inside a rolled-back transaction is the
 * stronger evidence, and the pull request says what was and was not done.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants, can, getPermissionScope } from './authorization';
import { userCan } from './can';
import { ALL_CATALOG_KEYS, catalogItem } from './permission-catalog';
import { computeEffectiveGrants, legacyEffectiveKeys, type GrantSource } from './permissions-core';
import { ORDER_ACTION_KEYS_FROM } from './order-action-keys';
import type { SessionUser } from '@/types/auth';

const NAME = '20261030130000_order_action_keys';
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
const GATE = ORDER_ACTION_KEYS_FROM.flatMap((r) => r.from.map((src) => ({ newKey: r.key, src, copy: r.copyScope })));
const NEW_KEYS = ORDER_ACTION_KEYS_FROM.map((r) => r.key);
const SRC_KEYS = [...new Set(GATE.map((g) => g.src))];

describe('the seven boxes are in the catalog, each with the screen key it sits behind', () => {
  const REQUIRES: Record<string, string> = {
    'orders.change_price': 'orders.edit',
    'orders.change_fee': 'orders.change_status',
    'orders.cancel': 'orders.view',
    'orders.note': 'orders.view',
    'orders.request_change': 'orders.view',
    'orders.rating_link': 'orders.view',
    'control.blacklist_manage': 'control.blacklist',
  };

  it('are exactly these seven, in the list the migration and the engine fallback read', () => {
    expect([...NEW_KEYS].sort()).toEqual(Object.keys(REQUIRES).sort());
    expect(NEW_KEYS).toHaveLength(7);
  });

  it('can all be ticked on «الصلاحيات», with an Arabic and an English label and the key they sit behind', () => {
    for (const k of NEW_KEYS) {
      const item = catalogItem(k);
      expect(item, k).toBeDefined();
      expect(ALL_CATALOG_KEYS.has(k), k).toBe(true);
      expect(item!.requires, `${k}: مفتاح الشاشة`).toBe(REQUIRES[k]);
      expect(item!.ar.trim().length, k).toBeGreaterThan(8);
      expect(item!.en.trim().length, k).toBeGreaterThan(8);
    }
  });

  it('the price is the one box with a scope — the three the order edit had, no more', () => {
    expect(catalogItem('orders.change_price')!.scopes).toEqual(['ALL_COMPANY', 'OWN', 'ASSIGNED']);
    expect(catalogItem('orders.edit')!.scopes).toEqual(['ALL_COMPANY', 'OWN', 'ASSIGNED']);
    for (const k of NEW_KEYS.filter((x) => x !== 'orders.change_price')) expect(catalogItem(k)!.scopes, k).toBeUndefined();
  });

  it('only the price copies a scope; and the three doors that took EITHER of two keys list both', () => {
    expect(ORDER_ACTION_KEYS_FROM.filter((r) => r.copyScope).map((r) => r.key)).toEqual(['orders.change_price']);
    expect(ORDER_ACTION_KEYS_FROM.find((r) => r.key === 'orders.note')!.from).toEqual(['orders.view', 'confirmation.work']);
    expect(ORDER_ACTION_KEYS_FROM.find((r) => r.key === 'orders.request_change')!.from).toEqual(['orders.view', 'confirmation.work']);
  });

  it('NEGATIVE: orders.cancel is NOT sourced from ops.ship — the stand-down door did not move onto it', () => {
    expect(ORDER_ACTION_KEYS_FROM.find((r) => r.key === 'orders.cancel')!.from).toEqual(['orders.unlock']);
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
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'oa6-' || gen_random_uuid()::text`);
    }
    for (const s of statements.filter((x) => !x.startsWith('INSERT INTO'))) {
      expect(s.startsWith('DROP TABLE IF EXISTS pg_temp.sp6_') || s.startsWith('CREATE TEMP TABLE sp6_'), s.slice(0, 70)).toBe(true);
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
    // The old plan asked "does this role hold a source?" AFTER writing the role rows and counted the new row. Here the
    // two statements that decide a person read only the snapshot, and no new key is ever a source.
    for (const s of statements.filter((x) => x.startsWith('INSERT INTO "user_permissions"'))) {
      const reads = s.slice(s.indexOf('SELECT'));
      expect(reads).not.toContain('"role_permissions"');
      expect(reads).not.toContain('"user_permissions"');
      expect(reads).toMatch(/sp6_pass/);
    }
    for (const s of statements.filter((x) => x.startsWith('CREATE TEMP TABLE'))) {
      for (const k of NEW_KEYS) {
        // a new key may appear only as the LEFT column of the gate table, never in a snapshot of what people hold
        if (!s.startsWith('CREATE TEMP TABLE sp6_gate')) expect(s, `${k} in ${s.slice(0, 40)}`).not.toContain(`'${k}'`);
      }
    }
  });

  it('the gate table is EXACTLY the one the engine fallback and the screens read (ORDER_ACTION_KEYS_FROM)', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp6_gate'))!;
    const rows = [...gate.matchAll(/\('([a-z_.]+)',\s*'([a-z_.]+)',\s*(true|false)\)/g)].map((m) => ({ newKey: m[1], src: m[2], copy: m[3] === 'true' }));
    const key = (r: { newKey: string; src: string; copy: boolean }) => `${r.newKey}<${r.src}<${r.copy}`;
    expect(rows.map(key).sort()).toEqual(GATE.map(key).sort());
    expect(rows).toHaveLength(9);
  });

  it('the snapshot of what people hold reads exactly the source keys of the gate table', () => {
    const holds = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp6_holds'))!);
    expect(holds).toContain('h.k IN (SELECT src FROM sp6_gate)');
    expect(holds).toContain(`up."effect" = 'ALLOW'`);
    expect(holds).toContain(`d."effect" = 'DENY'`);
    expect(holds).toContain(`u."role" <> 'SUPER_ADMIN'`);
    // a person's own «سماح» REPLACES the role's row for the same key — the engine's rule — so the role's is read only without one
    expect(holds).toContain(`a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW'`);
    expect(SRC_KEYS).toContain('confirmation.work');
  });

  it('the two statements that decide a person say exactly what the replay does — a flipped condition is caught HERE, since the replay is a copy', () => {
    const deny = flat(statements.find((s) => s.includes(`'DENY'`) && s.startsWith('INSERT INTO'))!);
    // the role receives the box AND the person did not pass THAT door
    expect(deny).toContain('FROM sp6_user_role ur JOIN sp6_role_gets rg ON rg.rid = ur.rid');
    expect(deny).toContain('WHERE NOT EXISTS (SELECT 1 FROM sp6_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)');
    const allow = flat(statements.find((s) => s.includes(`'ALLOW'`) && s.startsWith('INSERT INTO'))!);
    // the person passed AND (it is the scoped box set by their own «سماح», OR no role of theirs receives the box)
    expect(allow).toContain('FROM sp6_pass p WHERE (p.copy_scope AND p.own_allow) OR NOT EXISTS (SELECT 1 FROM sp6_user_role ur JOIN sp6_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key WHERE ur.uid = p.uid)');
    expect(allow).toContain(`'ALLOW', p.scope, p.scope_ids`);
    // the scope is copied ONLY where the gate row says so
    for (const t of ['sp6_pass', 'sp6_role_gets', 'sp6_default_gets']) {
      const s = flat(statements.find((x) => x.startsWith(`CREATE TEMP TABLE ${t}`))!);
      expect(s, t).toContain('CASE WHEN g.copy_scope THEN');
      expect(s, t).toContain(`ELSE 'ALL_COMPANY' END AS scope`);
    }
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!)).toContain('FROM sp6_role_gets rg');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!)).toContain('FROM sp6_default_gets dg');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp6_role_gets'))!)).toContain('FROM "role_permissions" rp JOIN sp6_gate g ON g.src = rp."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp6_default_gets'))!)).toContain('FROM "role_permission_defaults" d JOIN sp6_gate g ON g.src = d."permission"');
  });

  it('reads the role the way the engine reads it, and leaves SUPER_ADMIN alone', () => {
    const ur = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp6_user_role'))!;
    expect(ur).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
    expect(ur).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
    expect(ur).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('its rollback removes only what it wrote, in all three places, and its own row in the migrations table', () => {
    const body = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const deletes = body.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'oa6-%'`);
    expect(deletes[3]).toContain(`'${NAME}'`);
    expect(new Set(deletes.slice(0, 3).map((d) => d.match(/FROM "(\w+)"/)![1]))).toEqual(new Set(grantTables));
  });

  it('the tag is its own: no other migration writes ids that start with it', () => {
    const others = [
      '20261027000000_sensitive_settings_own_key', '20261029000000_tracking_returns_view_key', '20261029130000_analytics_view_becomes_reports_view',
      '20261029120000_shortfall_penalty', '20261029150000_settings_split_keys', '20261030120000_ai_assist_key',
    ];
    for (const m of others) {
      const text = readFileSync(path.join(process.cwd(), 'prisma', 'migrations', m, 'migration.sql'), 'utf8');
      expect(text, m).not.toContain(`'oa6-'`);
    }
  });

  it('runs after the migration of the previous permission box (#87), so every key it reads is already there', () => {
    expect(NAME > '20261030120000_ai_assist_key').toBe(true);
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

/** `sp6_user_role`: (uid, rid) — the engine's own reading of "which role are this person's grants from". */
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

type Skip = 'deny' | 'allow' | 'roles' | 'scope' | 'own-allow' | 'denied-sources';

/** Statement-for-statement the SQL of migration.sql. */
function applyTheMigration(before: Rows, skip?: Skip): Rows {
  const db = clone(before);

  // ── the snapshot: everything below is read from `before`, never from rows written here ──
  const ur = userRole(before);
  const superIds = new Set(before.users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.id));
  const denied = (uid: string, k: string) => skip !== 'denied-sources' && before.userPerms.some((d) => d.userId === uid && d.permission === k && d.effect === 'DENY');

  // sp6_holds — a person's own «سماح» REPLACES the role's row for the same key
  const holds: Array<{ uid: string; k: string; scope: string; scopeIds: unknown[] | null; ownAllow: boolean }> = [];
  for (const up of before.userPerms) {
    if (up.effect === 'ALLOW' && !superIds.has(up.userId) && SRC_KEYS.includes(up.permission) && !denied(up.userId, up.permission)) {
      holds.push({ uid: up.userId, k: up.permission, scope: up.scope ?? 'ALL_COMPANY', scopeIds: up.scopeIds, ownAllow: true });
    }
  }
  for (const x of ur) {
    for (const rp of before.rolePerms) {
      if (rp.roleId !== x.rid || !SRC_KEYS.includes(rp.permission)) continue;
      if (before.userPerms.some((a) => a.userId === x.uid && a.permission === rp.permission && a.effect === 'ALLOW')) continue;
      if (denied(x.uid, rp.permission)) continue;
      holds.push({ uid: x.uid, k: rp.permission, scope: rp.scope, scopeIds: rp.scopeIds, ownAllow: false });
    }
  }

  // sp6_pass
  const pass = holds.flatMap((h) =>
    GATE.filter((g) => g.src === h.k).map((g) => ({
      uid: h.uid, newKey: g.newKey, copy: g.copy, ownAllow: h.ownAllow,
      scope: g.copy && skip !== 'scope' ? h.scope : 'ALL_COMPANY',
      scopeIds: g.copy && skip !== 'scope' ? h.scopeIds : null,
    }))
  );

  // sp6_role_gets / sp6_default_gets
  const gets = (table: Grant[]) =>
    table.flatMap((rp) =>
      GATE.filter((g) => g.src === rp.permission).map((g) => ({
        rid: rp.roleId, newKey: g.newKey,
        scope: g.copy && skip !== 'scope' ? rp.scope : 'ALL_COMPANY',
        scopeIds: g.copy && skip !== 'scope' ? rp.scopeIds : null,
      }))
    );
  const roleGets = gets(before.rolePerms);
  const defaultGets = gets(before.defaults);

  let n = 0;
  const id = () => `oa6-${++n}`;
  const hasUserRow = (uid: string, k: string) => db.userPerms.some((p) => p.userId === uid && p.permission === k);

  // 1. «منع» — the role receives the box, the person did not pass THAT door.
  for (const x of skip === 'deny' ? [] : ur) {
    for (const rg of roleGets) {
      if (rg.rid !== x.rid) continue;
      if (!pass.some((p) => p.uid === x.uid && p.newKey === rg.newKey) && !hasUserRow(x.uid, rg.newKey)) {
        db.userPerms.push({ id: id(), userId: x.uid, permission: rg.newKey, effect: 'DENY', scope: null, scopeIds: null });
      }
    }
  }
  // 2. «سماح» — the person passed; no role of theirs receives the box, or it is the scoped box set by their own «سماح».
  for (const p of skip === 'allow' ? [] : pass) {
    const roleReceives = ur.some((x) => x.uid === p.uid && roleGets.some((rg) => rg.rid === x.rid && rg.newKey === p.newKey));
    const viaOwnScope = skip !== 'own-allow' && p.copy && p.ownAllow;
    if ((viaOwnScope || !roleReceives) && !hasUserRow(p.uid, p.newKey)) {
      db.userPerms.push({ id: id(), userId: p.uid, permission: p.newKey, effect: 'ALLOW', scope: p.scope, scopeIds: p.scopeIds });
    }
  }
  // 3. roles
  for (const rg of skip === 'roles' ? [] : roleGets) {
    if (!db.rolePerms.some((p) => p.roleId === rg.rid && p.permission === rg.newKey)) {
      db.rolePerms.push({ id: id(), roleId: rg.rid, permission: rg.newKey, scope: rg.scope, scopeIds: rg.scopeIds });
    }
  }
  // 4. baselines
  for (const dg of defaultGets) {
    if (!db.defaults.some((p) => p.roleId === dg.rid && p.permission === dg.newKey)) {
      db.defaults.push({ id: id(), roleId: dg.rid, permission: dg.newKey, scope: dg.scope, scopeIds: dg.scopeIds });
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
  return ORDER_ACTION_KEYS_FROM.find((r) => r.key === newKey)!.from.some((src) => can(u, src));
}

const sameScope = (a: ReturnType<typeof getPermissionScope>, b: ReturnType<typeof getPermissionScope>) =>
  a?.scope === b?.scope && JSON.stringify(a?.scopeIds ?? null) === JSON.stringify(b?.scopeIds ?? null);

let nextId = 0;
const role = (name: string, companyId: string | null = null) => ({ id: `r${++nextId}`, companyId, name });

function fixture(): Rows {
  nextId = 0;
  const tAdmin = role('COMPANY_ADMIN'); // system templates
  const tMod = role('MODERATOR');
  const tAgent = role('CONFIRMATION_AGENT');
  const cEditAll = role('محرّر', 'c1'); // company roles
  const cDesk = role('مكتب', 'c1'); // confirmation.work only: the work door WITHOUT orders.view
  const cReader = role('قارئ', 'c1'); // orders.view only
  const cShip = role('شحن', 'c1'); // orders.change_status
  const cKeys = role('مفاتيح', 'c1'); // orders.unlock
  const cList = role('قائمة', 'c1'); // control.blacklist
  const cNothing = role('فاضي', 'c1');
  const cNoView = role('بلا عرض', 'c1'); // the owner unticked orders.view on 28/10; still has edit
  const perms: Array<[typeof tAdmin, Array<[string, Scope?]>]> = [
    [tAdmin, [['orders.view'], ['orders.edit'], ['orders.change_status'], ['orders.unlock'], ['confirmation.work'], ['control.blacklist']]],
    [tMod, [['orders.view'], ['orders.edit', 'ASSIGNED'], ['orders.create']]],
    [tAgent, [['orders.view', 'ASSIGNED'], ['orders.edit', 'ASSIGNED'], ['confirmation.work'], ['orders.confirm']]],
    [cEditAll, [['orders.edit', 'OWN'], ['orders.view', 'OWN']]],
    [cDesk, [['confirmation.work']]],
    [cReader, [['orders.view']]],
    [cShip, [['orders.change_status']]],
    [cKeys, [['orders.unlock'], ['orders.view']]],
    [cList, [['control.blacklist']]],
    [cNoView, [['orders.edit', 'ASSIGNED'], ['orders.create']]],
  ];
  const rows: Rows = { users: [], roles: [tAdmin, tMod, tAgent, cEditAll, cDesk, cReader, cShip, cKeys, cList, cNothing, cNoView], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  for (const [r, keys] of perms) {
    for (const [permission, scope = 'ALL_COMPANY'] of keys) {
      rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission, scope, scopeIds: null });
      // every role has a baseline except cReader — a role that was never issued one
      if (r.id !== cReader.id) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission, scope, scopeIds: null });
    }
  }
  const user = (id: string, roleName: string, roleId: string | null) => rows.users.push({ id, role: roleName, roleId });
  const ur = (userId: string, permission: string, effect: 'ALLOW' | 'DENY', scope: string | null = null) =>
    rows.userPerms.push({ id: `up${++i}`, userId, permission, effect, scope: effect === 'ALLOW' ? scope ?? 'ALL_COMPANY' : null, scopeIds: null });

  user('admin', 'COMPANY_ADMIN', tAdmin.id);
  user('admin-no-role-id', 'COMPANY_ADMIN', null); // reads the template named like the role
  user('mod', 'MODERATOR', tMod.id);
  user('agent', 'CONFIRMATION_AGENT', tAgent.id);
  user('editor-own', 'MODERATOR', cEditAll.id);
  user('desk', 'MODERATOR', cDesk.id);
  user('reader', 'MODERATOR', cReader.id);
  user('ship', 'MODERATOR', cShip.id);
  user('keys', 'MODERATOR', cKeys.id);
  user('list', 'MODERATOR', cList.id);
  user('nothing', 'MODERATOR', cNothing.id);
  user('no-view', 'MODERATOR', cNoView.id);
  user('root', 'SUPER_ADMIN', null);
  user('stranger', 'ROLE_NOBODY_KNOWS', null); // no role id, no template: the fallback, which is empty
  user('fallback-accountant', 'ACCOUNTANT', null); // no template of that name: the in-code fallback (orders.view)
  user('fallback-moderator', 'MODERATOR_LEGACY', null);
  // ── the same roles, with a personal «منع» / «سماح» on a source key ──
  user('admin-denied-edit', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-edit', 'orders.edit', 'DENY');
  user('admin-denied-ship', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-ship', 'orders.change_status', 'DENY');
  user('admin-denied-unlock', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-unlock', 'orders.unlock', 'DENY');
  user('admin-denied-view', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-view', 'orders.view', 'DENY'); // still holds confirmation.work: passes note/request through it
  user('admin-denied-work', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-work', 'confirmation.work', 'DENY'); // still holds orders.view
  user('admin-denied-both', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-both', 'orders.view', 'DENY'); ur('admin-denied-both', 'confirmation.work', 'DENY'); // passes NEITHER door of note / request
  user('admin-denied-list', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-list', 'control.blacklist', 'DENY');
  user('desk-denied-work', 'MODERATOR', cDesk.id); ur('desk-denied-work', 'confirmation.work', 'DENY'); // the role's only source, refused
  user('reader-denied-view', 'MODERATOR', cReader.id); ur('reader-denied-view', 'orders.view', 'DENY');
  user('mod-denied-edit', 'MODERATOR', tMod.id); ur('mod-denied-edit', 'orders.edit', 'DENY'); // still has view
  user('reader-allowed-edit', 'MODERATOR', cReader.id); ur('reader-allowed-edit', 'orders.edit', 'ALLOW', 'OWN'); // a scoped «سماح» in a role without edit
  user('mod-allowed-edit-all', 'MODERATOR', tMod.id); ur('mod-allowed-edit-all', 'orders.edit', 'ALLOW', 'ALL_COMPANY'); // widens the role's ASSIGNED
  user('editor-allowed-assigned', 'MODERATOR', cEditAll.id); ur('editor-allowed-assigned', 'orders.edit', 'ALLOW', 'ASSIGNED'); // narrows the role's OWN to ASSIGNED
  user('nothing-allowed-work', 'MODERATOR', cNothing.id); ur('nothing-allowed-work', 'confirmation.work', 'ALLOW');
  user('nothing-allowed-view', 'MODERATOR', cNothing.id); ur('nothing-allowed-view', 'orders.view', 'ALLOW');
  user('nothing-allowed-all', 'MODERATOR', cNothing.id);
  for (const k of ['orders.edit', 'orders.change_status', 'orders.unlock', 'control.blacklist', 'confirmation.work', 'orders.view']) ur('nothing-allowed-all', k, 'ALLOW', k === 'orders.edit' ? 'ASSIGNED' : 'ALL_COMPANY');
  user('stranger-allowed-edit', 'ROLE_NOBODY_KNOWS', null); ur('stranger-allowed-edit', 'orders.edit', 'ALLOW', 'OWN');
  user('stranger-allowed-unlock', 'ROLE_NOBODY_KNOWS', null); ur('stranger-allowed-unlock', 'orders.unlock', 'ALLOW');
  user('fallback-denied-view', 'ACCOUNTANT', null); ur('fallback-denied-view', 'orders.view', 'DENY');
  user('fallback-allowed-list', 'ACCOUNTANT', null); ur('fallback-allowed-list', 'control.blacklist', 'ALLOW');
  // an unrelated exception must not move anything
  user('admin-denied-other', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-other', 'settings.view', 'DENY');
  return rows;
}

async function everyDoorOfEveryone(db0: Rows) {
  const db1 = applyTheMigration(db0);
  const lost: string[] = [];
  const gained: string[] = [];
  const scopeMoved: string[] = [];
  for (const u of db0.users) {
    const before = await holder(db0, u.id);
    const after = await holder(db1, u.id);
    for (const k of NEW_KEYS) {
      const was = await passedYesterday(db0, u.id, k);
      const is = can(after, k);
      if (was && !is) lost.push(`${u.id} lost ${k}`);
      if (!was && is) gained.push(`${u.id} gained ${k}`);
      // The screen's own question agrees with the server's.
      expect(userCan(after, k), `${u.id}/${k}: الشاشة والخادم`).toBe(is);
    }
    // THE SCOPE: the price reaches exactly the orders the order edit reached.
    if (can(before, 'orders.edit') && !sameScope(getPermissionScope(before, 'orders.edit'), getPermissionScope(after, 'orders.change_price'))) {
      scopeMoved.push(`${u.id}: edit ${JSON.stringify(getPermissionScope(before, 'orders.edit'))} → price ${JSON.stringify(getPermissionScope(after, 'orders.change_price'))}`);
    }
  }
  return { db1, lost, gained, scopeMoved };
}

describe('the replay: every person, every door — yesterday against today, through the real engine', () => {
  it('nobody loses a door, nobody gains one, and the price keeps the scope the edit had (37 fixture people, 7 boxes each)', async () => {
    const db0 = fixture();
    const { lost, gained, scopeMoved } = await everyDoorOfEveryone(db0);
    expect(lost, 'خسروا باباً').toEqual([]);
    expect(gained, 'كسبوا باباً').toEqual([]);
    expect(scopeMoved, 'تغيّر مدى السعر عن مدى التعديل').toEqual([]);
    expect(db0.users.length).toBeGreaterThanOrEqual(37);
  });

  it('the fixture really exercises the cases (a replay that finds nothing would pass for the wrong reason)', async () => {
    const db0 = fixture();
    let passers = 0;
    for (const u of db0.users) for (const k of NEW_KEYS) if (await passedYesterday(db0, u.id, k)) passers++;
    expect(passers, 'من يمر من الأبواب').toBeGreaterThan(90);
    expect(await passedYesterday(db0, 'nothing', 'orders.note')).toBe(false);
    const db1 = applyTheMigration(db0);
    const written = (rows: Array<{ id: string }>, before: Array<{ id: string }>) => rows.length - before.length;
    expect(written(db1.userPerms, db0.userPerms)).toBeGreaterThan(12);
    expect(written(db1.rolePerms, db0.rolePerms)).toBeGreaterThan(20);
    expect(written(db1.defaults, db0.defaults)).toBeGreaterThan(18);
    expect(db1.userPerms.filter((p) => p.id.startsWith('oa6-') && p.effect === 'DENY').length).toBeGreaterThan(4);
    expect(db1.userPerms.filter((p) => p.id.startsWith('oa6-') && p.effect === 'ALLOW').length).toBeGreaterThan(8);
    // and the three scopes of the price are really in play
    const priceScopes = new Set([...db1.rolePerms, ...db1.userPerms].filter((p) => p.permission === 'orders.change_price' && ('effect' in p ? p.effect === 'ALLOW' : true)).map((p) => p.scope));
    expect([...priceScopes].sort()).toEqual(['ALL_COMPANY', 'ASSIGNED', 'OWN']);
  });

  it('each case by name: the box follows the door it came from, and not another one', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const box = async (uid: string, k: string) => can(await holder(db1, uid), k);
    // every one of the seven doors, alone, is enough
    expect(await box('no-view', 'orders.change_price')).toBe(true); // orders.edit
    expect(await box('ship', 'orders.change_fee')).toBe(true); // orders.change_status
    expect(await box('keys', 'orders.cancel')).toBe(true); // orders.unlock
    expect(await box('reader', 'orders.rating_link')).toBe(true); // orders.view
    expect(await box('list', 'control.blacklist_manage')).toBe(true); // control.blacklist
    // the work door: orders.view OR confirmation.work — either one reaches the note and the request
    expect(await box('desk', 'orders.note')).toBe(true); // confirmation.work, and NO orders.view
    expect(await box('desk', 'orders.request_change')).toBe(true);
    expect(await box('reader', 'orders.note')).toBe(true); // orders.view, and NO confirmation.work
    expect(await box('reader', 'orders.request_change')).toBe(true);
    // …and the review link was orders.view ONLY: the desk, which never held it, does not gain it
    expect(await box('desk', 'orders.rating_link')).toBe(false);
    // nothing else leaks: the fee does not come with the price, the cancel does not come with the fee
    expect(await box('no-view', 'orders.change_fee')).toBe(false);
    expect(await box('ship', 'orders.cancel')).toBe(false);
    expect(await box('keys', 'orders.change_price')).toBe(false);
    expect(await box('list', 'orders.note')).toBe(false);
    // a role with none of the sources is handed nothing
    expect(await box('nothing', 'orders.note')).toBe(false);
    expect(await box('nothing', 'orders.cancel')).toBe(false);
    // a «منع» on ONE source of two does not take the box: he still passes the other
    expect(await box('admin-denied-view', 'orders.note')).toBe(true);
    expect(await box('admin-denied-work', 'orders.request_change')).toBe(true);
    // …on both: he passed neither door, so he is refused the box too
    expect(await box('admin-denied-both', 'orders.note')).toBe(false);
    expect(await box('admin-denied-both', 'orders.request_change')).toBe(false);
    // a «منع» on the role's ONLY source
    expect(await box('desk-denied-work', 'orders.note')).toBe(false);
    expect(await box('reader-denied-view', 'orders.rating_link')).toBe(false);
    expect(await box('admin-denied-edit', 'orders.change_price')).toBe(false);
    expect(await box('admin-denied-ship', 'orders.change_fee')).toBe(false);
    expect(await box('admin-denied-unlock', 'orders.cancel')).toBe(false);
    expect(await box('admin-denied-list', 'control.blacklist_manage')).toBe(false);
    // a «سماح» reaches the box in a role that has none
    expect(await box('nothing-allowed-work', 'orders.note')).toBe(true);
    expect(await box('nothing-allowed-view', 'orders.rating_link')).toBe(true);
    expect(await box('stranger-allowed-unlock', 'orders.cancel')).toBe(true);
    expect(await box('fallback-allowed-list', 'control.blacklist_manage')).toBe(true);
    // an unrelated exception moved nothing
    expect(await box('admin-denied-other', 'orders.change_price')).toBe(true);
  });

  it('THE SCOPE: a role’s ASSIGNED, a person’s own «سماح» OWN / ALL / ASSIGNED — the price reaches what the edit reached', async () => {
    const db1 = applyTheMigration(fixture());
    const price = async (uid: string) => getPermissionScope(await holder(db1, uid), 'orders.change_price')?.scope;
    expect(await price('mod')).toBe('ASSIGNED'); // role
    expect(await price('agent')).toBe('ASSIGNED');
    expect(await price('editor-own')).toBe('OWN');
    expect(await price('admin')).toBe('ALL_COMPANY');
    expect(await price('reader-allowed-edit')).toBe('OWN'); // the person's own «سماح», in a role without edit
    expect(await price('mod-allowed-edit-all')).toBe('ALL_COMPANY'); // the «سماح» WIDENS the role's ASSIGNED — and so does the price
    expect(await price('editor-allowed-assigned')).toBe('ASSIGNED'); // …and narrows the role's OWN — and so does the price
    expect(await price('stranger-allowed-edit')).toBe('OWN'); // no stored role at all
    expect(await price('root')).toBe('ALL_COMPANY');
    // NEGATIVE: an agent who edits only her own orders does NOT price the company's
    expect(await price('mod')).not.toBe('ALL_COMPANY');
  });

  it('the work keeps working when a box is taken: the owner unticks the price and the EDIT stays', async () => {
    const db1 = applyTheMigration(fixture());
    // The owner's next step, after the deploy: a «منع» on the price for the moderator.
    db1.userPerms.push({ id: 'owner-1', userId: 'mod', permission: 'orders.change_price', effect: 'DENY', scope: null, scopeIds: null });
    const mod = await holder(db1, 'mod');
    expect(can(mod, 'orders.edit')).toBe(true);
    expect(can(mod, 'orders.change_price')).toBe(false);
  });

  it('what the owner unticked before is not given back: a role without orders.view does not get the review link through it', async () => {
    const db1 = applyTheMigration(fixture());
    const noView = await holder(db1, 'no-view');
    expect(can(noView, 'orders.view')).toBe(false);
    expect(can(noView, 'orders.rating_link')).toBe(false);
    expect(can(noView, 'orders.note')).toBe(false);
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
    expect(added.length).toBeGreaterThan(50);
    for (const i of added) expect(i).toMatch(/^oa6-/);
    // Nothing that existed before was changed or removed.
    for (const p of db0.userPerms) expect(once.userPerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.rolePerms) expect(once.rolePerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.defaults) expect(once.defaults.find((q) => q.id === p.id)).toEqual(p);
  });

  it('the «إرجاع للافتراضي» baseline carries the boxes — with the SAME scope — so the first reset after the deploy does not take them away', () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    for (const rule of ORDER_ACTION_KEYS_FROM) {
      const withSource = new Set(db0.defaults.filter((d) => rule.from.includes(d.permission)).map((d) => d.roleId));
      const boxed = new Set(db1.defaults.filter((d) => d.permission === rule.key).map((d) => d.roleId));
      expect(boxed, rule.key).toEqual(withSource);
    }
    // the price's baseline keeps the edit's baseline scope
    const edit = db0.defaults.filter((d) => d.permission === 'orders.edit');
    for (const e of edit) expect(db1.defaults.find((d) => d.roleId === e.roleId && d.permission === 'orders.change_price')!.scope).toBe(e.scope);
  });

  it('NEGATIVE (the test of the test): a migration with one step removed is CAUGHT — no «منع», no «سماح», no role rows, no scope copy', async () => {
    const db0 = fixture();
    const count = async (skip: Skip) => {
      const broken = applyTheMigration(db0, skip);
      const found = { lost: 0, gained: 0, scope: 0 };
      for (const u of db0.users) {
        const before = await holder(db0, u.id);
        const after = await holder(broken, u.id);
        for (const k of NEW_KEYS) {
          const was = await passedYesterday(db0, u.id, k);
          const is = can(after, k);
          if (was && !is) found.lost++;
          if (!was && is) found.gained++;
        }
        if (can(before, 'orders.edit') && !sameScope(getPermissionScope(before, 'orders.edit'), getPermissionScope(after, 'orders.change_price'))) found.scope++;
      }
      return found;
    };
    expect((await count('deny')).gained, 'بلا «منع» يُمنح المفتاح بلا باب').toBeGreaterThan(0);
    expect((await count('allow')).lost, 'بلا «سماح» يخسر صاحب الاستثناء').toBeGreaterThan(0);
    expect((await count('roles')).lost, 'بلا صفوف الأدوار يخسر الجميع').toBeGreaterThan(0);
    expect((await count('scope')).scope, 'بلا نسخ المدى يسعّر الجميع كلَّ الشركة').toBeGreaterThan(0);
    expect((await count('own-allow')).scope, 'بلا «سماح» المدى الشخصي يتغيّر مدى من وسّعه أو ضيّقه').toBeGreaterThan(0);
    expect((await count('denied-sources')).gained, 'إن نسي أنّ «المنع» يُسقط المصدر').toBeGreaterThan(0);
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
  const KEYS = [...SRC_KEYS, 'settings.view', 'finance.view', 'orders.create'];
  const SCOPES: Scope[] = ['ALL_COMPANY', 'OWN', 'ASSIGNED'];
  const rows: Rows = { users: [], roles: [], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  const templateNames = ['COMPANY_ADMIN', 'MANAGER', 'MODERATOR'];
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
      : kind < 0.9 ? { role: pick(['ACCOUNTANT', 'COMPANY_ADMIN_X', 'WAREHOUSE']), roleId: null }
      : kind < 0.95 ? { role: 'SUPER_ADMIN', roleId: null }
      : { role: 'MODERATOR', roleId: pick(rows.roles).id };
    rows.users.push({ id: `u${u}`, ...row });
    for (const k of KEYS) {
      const x = rand();
      if (x < 0.12) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'DENY', scope: null, scopeIds: null });
      else if (x < 0.22) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'ALLOW', scope: pick(SCOPES), scopeIds: null });
    }
  }
  return rows;
}

describe('a seeded fuzz: 40 random companies, 200 people each — nobody loses a door, nobody gains one, no scope moves', () => {
  it('holds for every seed', async () => {
    let people = 0;
    let withRows = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const db0 = randomWorld(seed);
      const { db1, lost, gained, scopeMoved } = await everyDoorOfEveryone(db0);
      expect(lost, `seed ${seed}`).toEqual([]);
      expect(gained, `seed ${seed}`).toEqual([]);
      expect(scopeMoved, `seed ${seed}`).toEqual([]);
      people += db0.users.length;
      if (db1.userPerms.length > db0.userPerms.length) withRows++;
    }
    expect(people).toBe(8000);
    expect(withRows, 'the fuzz must make the migration write exceptions').toBeGreaterThan(30);
  }, 180_000);

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
  const fallback = async (role: string, ex: Array<{ permission: string; effect: string; scope?: string | null }> = []) =>
    computeEffectiveGrants({ id: 'f1', role, roleId: null }, {
      roleRows: async () => [],
      overrideRows: async () => ex.map((e) => ({ ...e, scope: e.scope ?? null, scopeIds: null })),
    });

  it('a legacy role gets a box exactly when it held a key the door asked — no more, no less', async () => {
    // The fallback holds the LEGACY names (orders.update, orders.shipping_status…), and the doors ask the canonical ones, so a
    // legacy role passes a door only through a key whose name is the same in both lists (orders.view, orders.unlock). The box
    // follows the door, not the label: what yesterday's engine answered is what today's answers.
    for (const r of ['COMPANY_ADMIN', 'MANAGER', 'MODERATOR', 'CONFIRMATION_AGENT', 'FOLLOW_UP_AGENT', 'DELIVERY_MANAGER', 'ACCOUNTANT', 'PENDING_USER', 'WAREHOUSE', 'CONFIRMATION_SUPERVISOR']) {
      const g = (await fallback(r)).grants;
      for (const rule of ORDER_ACTION_KEYS_FROM) {
        const was = rule.from.some((src) => g[src] !== undefined);
        expect(g[rule.key] !== undefined, `${r}/${rule.key}`).toBe(was);
      }
    }
  });

  it('by name: the admin keeps the cancel, the note, the request and the review link; the agent keeps the note; the empty roles keep nothing', async () => {
    const admin = Object.keys((await fallback('COMPANY_ADMIN')).grants);
    for (const k of ['orders.cancel', 'orders.note', 'orders.request_change', 'orders.rating_link']) expect(admin, k).toContain(k);
    // control.blacklist is no legacy key, so no legacy role reaches the blacklist box
    expect(admin).not.toContain('control.blacklist_manage');
    const agent = Object.keys((await fallback('CONFIRMATION_AGENT')).grants);
    expect(agent).toContain('orders.note');
    expect(agent).not.toContain('orders.cancel');
    for (const r of ['PENDING_USER', 'WAREHOUSE', 'CONFIRMATION_SUPERVISOR']) {
      const keys = Object.keys((await fallback(r)).grants);
      for (const k of NEW_KEYS) expect(keys, `${r}/${k}`).not.toContain(k);
    }
  });

  it('the price keeps the scope of the edit it comes from, in the fallback too — through a personal «سماح»', async () => {
    for (const scope of ['OWN', 'ASSIGNED', 'ALL_COMPANY']) {
      const g = (await fallback('ACCOUNTANT_X', [{ permission: 'orders.edit', effect: 'ALLOW', scope }])).grants;
      expect(g['orders.change_price'], scope).toMatchObject({ scope });
    }
  });

  it('NEGATIVE: a «منع» on the box, or on the key it comes from, wins over the fallback', async () => {
    expect(Object.keys((await fallback('MODERATOR', [{ permission: 'orders.change_price', effect: 'DENY' }])).grants)).not.toContain('orders.change_price');
    expect(Object.keys((await fallback('MODERATOR', [{ permission: 'orders.edit', effect: 'DENY' }])).grants)).not.toContain('orders.change_price');
    // …and the OTHER boxes of the same person are untouched
    expect(Object.keys((await fallback('MODERATOR', [{ permission: 'orders.edit', effect: 'DENY' }])).grants)).toContain('orders.note');
    // a «سماح» of the person’s own on the source reaches the box, at ITS scope
    const g = await fallback('ACCOUNTANT_X', [{ permission: 'orders.edit', effect: 'ALLOW', scope: 'OWN' }]);
    expect(g.grants['orders.change_price']).toMatchObject({ scope: 'OWN' });
  });

  it('the parity list (the reset-to-default baseline of a legacy role) carries the boxes for the same roles', () => {
    const admin = legacyEffectiveKeys('COMPANY_ADMIN');
    for (const k of ['orders.change_price', 'orders.change_fee', 'orders.cancel', 'orders.note', 'orders.request_change', 'orders.rating_link']) expect(admin, k).toContain(k);
    expect(legacyEffectiveKeys('CONFIRMATION_AGENT')).toContain('orders.note');
    expect(legacyEffectiveKeys('CONFIRMATION_AGENT')).not.toContain('orders.cancel');
    expect(legacyEffectiveKeys('PENDING_USER')).not.toContain('orders.note');
  });
});
