import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HOLDER'S OWN WINDOW GETS A KEY — AND THE DAY IT SHIPS IT GOES TO THE AGENTS, THE SUPERVISORS AND THE FOLLOW-UP ROLE, NOBODY ELSE.
 *
 * `orders.edit_confirmed` — «تعديل وتأجيل وإلغاء طلب مؤكَّد قبل دخوله دفعة شحن» (the owner, 2/11). Unlike its siblings
 * (`the-order-actions-keep-every-door.test.ts`) it is not a door split off a wider key: it is a power that did not exist, so the
 * rule is not «who passed a door yesterday» but «every role that holds BOTH `confirmation.work` AND `orders.request_change`» —
 * and a person the owner REFUSED either of the two is refused the box too (a «منع» row), so no one gains it by being in a role
 * that receives it. The migration is 20261102120000_edit_confirmed_before_batch.
 *
 * ⚠️ WHAT THIS FILE IS, SAID PLAINLY. There is no database in CI, so the SQL cannot be run here. Two things are done instead, and
 * neither is the SQL running:
 *   1. the SQL is READ as text — its shape (what it writes, in which order, from which keys) is pinned;
 *   2. the SQL's logic is REPLAYED by `applyTheMigration` below, a statement-for-statement copy over in-memory rows, and the people
 *      it produces are judged by the REAL engine (computeEffectiveGrants + can) against an oracle written from the rule, not from
 *      the replay.
 * The copy can drift from the SQL; a rehearsal of the SQL inside a rolled-back transaction on a real database is the stronger
 * evidence, and the pull request says whether it was done.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants, can } from './authorization';
import { userCan } from './can';
import { ALL_CATALOG_KEYS, catalogItem, dependentsOf, requiredChain } from './permission-catalog';
import { computeEffectiveGrants, legacyEffectiveKeys, type GrantSource } from './permissions-core';
import { EDIT_CONFIRMED_KEY, EDIT_CONFIRMED_NEEDS } from './edit-confirmed-key';
import type { SessionUser } from '@/types/auth';

const MIGRATIONS = path.join(process.cwd(), 'prisma', 'migrations');
const NAME = '20261102120000_edit_confirmed_before_batch';
const DIR = path.join(MIGRATIONS, NAME);
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
const GRANT_TABLES = ['user_permissions', 'role_permissions', 'role_permission_defaults'];

describe('the key is in the catalogue, behind the request key, with the owner’s words', () => {
  it('can be ticked on «الصلاحيات»: Arabic and English labels, behind orders.request_change, no scope of its own', () => {
    const item = catalogItem(EDIT_CONFIRMED_KEY);
    expect(ALL_CATALOG_KEYS.has(EDIT_CONFIRMED_KEY)).toBe(true);
    expect(item).toBeDefined();
    expect(item!.ar).toBe('تعديل وتأجيل وإلغاء طلب مؤكَّد قبل دخوله دفعة شحن');
    expect(item!.en).toBe('Edit, postpone or cancel a confirmed order before it enters a shipping batch');
    expect(item!.requires).toBe('orders.request_change');
    expect(item!.scopes).toBeUndefined();
  });

  it('the chain behind it ends at the orders list, and unticking the request key unticks it', () => {
    expect(requiredChain(EDIT_CONFIRMED_KEY)).toEqual(['orders.request_change', 'orders.view']);
    expect(dependentsOf('orders.request_change')).toContain(EDIT_CONFIRMED_KEY);
    expect(dependentsOf('orders.view')).toContain(EDIT_CONFIRMED_KEY);
  });

  it('sits in the Orders section, beside the request key', async () => {
    const { PERMISSION_MODULES } = await import('./permission-catalog');
    const orders = PERMISSION_MODULES.find((m) => m.module === 'orders')!.items.map((i) => i.key);
    expect(orders).toContain(EDIT_CONFIRMED_KEY);
    expect(Math.abs(orders.indexOf(EDIT_CONFIRMED_KEY) - orders.indexOf('orders.request_change'))).toBe(1);
  });
});

describe('the SQL, read as text', () => {
  it('only ADDS rows to the three grant tables — and only drops its own temporary tables', () => {
    const inserts = statements.filter((s) => s.startsWith('INSERT INTO'));
    expect(inserts).toHaveLength(3);
    for (const s of inserts) {
      expect(GRANT_TABLES).toContain(s.match(/^INSERT INTO "(\w+)"/)![1]);
      expect(s).toMatch(/ON CONFLICT \("(roleId|userId)", "permission"\) DO NOTHING$/);
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'edc-' || gen_random_uuid()::text`);
      expect(s).toContain(`'orders.edit_confirmed'`);
    }
    for (const s of statements.filter((x) => !x.startsWith('INSERT INTO'))) {
      expect(s.startsWith('DROP TABLE IF EXISTS pg_temp.ec_') || s.startsWith('CREATE TEMP TABLE ec_'), s.slice(0, 70)).toBe(true);
      if (s.startsWith('DROP')) expect(s).not.toMatch(/\bpublic\b|"(users|roles|role_permissions|user_permissions)"/);
    }
    for (const s of statements) expect(s).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|ALTER)\b/i);
  });

  it('has no BEGIN or COMMIT, so a rehearsal inside a transaction can really be rolled back', () => {
    expect(statements.filter((s) => /^(BEGIN|COMMIT|START TRANSACTION|ROLLBACK)\b/i.test(s))).toEqual([]);
  });

  it('writes the box in the three places a grant lives, «منع» first, then the roles, then their baselines', () => {
    const writes = statements.filter((s) => s.startsWith('INSERT INTO'));
    expect(writes.map((s) => s.match(/^INSERT INTO "(\w+)"/)![1])).toEqual(['user_permissions', 'role_permissions', 'role_permission_defaults']);
    expect(writes[0]).toContain(`'DENY'`);
    expect(writes[0]).not.toContain(`'ALLOW'`);
    const firstInsert = statements.findIndex((s) => s.startsWith('INSERT INTO'));
    const lastSnapshot = Math.max(...statements.map((s, i) => (s.startsWith('CREATE TEMP TABLE') ? i : -1)));
    expect(lastSnapshot, 'every question is asked of a snapshot taken BEFORE the first row is written').toBeLessThan(firstInsert);
  });

  it('gives it to nobody it should not: no «سماح» row at all, and none for SUPER_ADMIN', () => {
    expect(sql).not.toContain(`'ALLOW'`);
    const ur = statements.find((s) => s.startsWith('CREATE TEMP TABLE ec_user_role'))!;
    expect(ur).toContain(`u."role" <> 'SUPER_ADMIN'`);
    expect(ur).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
    expect(ur).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
  });

  it('the pair it reads is EXACTLY the one the engine fallback and the screens read (EDIT_CONFIRMED_NEEDS)', () => {
    const need = statements.find((s) => s.startsWith('CREATE TEMP TABLE ec_need'))!;
    const keys = [...need.matchAll(/\('([a-z_.]+)'\)/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...EDIT_CONFIRMED_NEEDS].sort());
    expect(keys).toHaveLength(2);
    // a role receives it only holding ALL of them — the count must equal the pair’s size, in both the role and the baseline
    for (const t of ['ec_role_gets', 'ec_default_gets']) {
      const s = flat(statements.find((x) => x.startsWith(`CREATE TEMP TABLE ${t}`))!);
      expect(s, t).toContain('GROUP BY');
      expect(s, t).toContain('HAVING COUNT(DISTINCT');
      expect(s, t).toContain('= (SELECT COUNT(*) FROM ec_need)');
    }
    expect(flat(statements.find((x) => x.startsWith('CREATE TEMP TABLE ec_role_gets'))!)).toContain('FROM "role_permissions" rp');
    expect(flat(statements.find((x) => x.startsWith('CREATE TEMP TABLE ec_default_gets'))!)).toContain('FROM "role_permission_defaults" d');
  });

  it('the «منع» statement says exactly what the replay does: the role receives the box AND the person is refused one of the two keys', () => {
    const deny = flat(statements.find((s) => s.startsWith('INSERT INTO "user_permissions"'))!);
    expect(deny).toContain('FROM ec_user_role ur JOIN ec_role_gets rg ON rg.rid = ur.rid');
    expect(deny).toContain(`d."userId" = ur.uid AND d."effect" = 'DENY' AND d."permission" IN (SELECT k FROM ec_need)`);
    expect(deny).toContain(`'DENY', NULL, NULL`);
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!)).toContain('FROM ec_role_gets rg');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!)).toContain('FROM ec_default_gets dg');
  });

  it('its rollback removes only what it wrote, in all three places, and its own row in the migrations table', () => {
    const body = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const deletes = body.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'edc-%'`);
    expect(deletes[3]).toContain(`'${NAME}'`);
    expect(new Set(deletes.slice(0, 3).map((d) => d.match(/FROM "(\w+)"/)![1]))).toEqual(new Set(GRANT_TABLES));
  });

  it('the tag is its own: no other migration writes ids that start with it', () => {
    const others = readdirSync(MIGRATIONS).filter((d) => !d.endsWith('.toml') && d !== NAME);
    for (const m of others) {
      let text = '';
      try {
        text = readFileSync(path.join(MIGRATIONS, m, 'migration.sql'), 'utf8');
      } catch {
        continue;
      }
      expect(text, m).not.toContain(`'edc-'`);
    }
  });

  it('runs after every migration that existed when it was written, so every key it reads is already there', () => {
    const names = readdirSync(MIGRATIONS).filter((d) => !d.endsWith('.toml'));
    expect(names).toContain(NAME);
    expect(NAME > '20261030190000_users_roles_apps_keys').toBe(true);
    expect(NAME > '20261101120000_product_fixed_cost').toBe(true);
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

/** `ec_user_role`: (uid, rid) — the engine's own reading of "which role are this person's grants from". */
function userRole(db: Rows) {
  const out: Array<{ uid: string; rid: string }> = [];
  for (const u of db.users) {
    if (u.role === 'SUPER_ADMIN') continue;
    for (const r of db.roles) {
      if ((u.roleId !== null && r.id === u.roleId) || (u.roleId === null && r.companyId === null && r.name === u.role)) out.push({ uid: u.id, rid: r.id });
    }
  }
  return out;
}

type Skip = 'deny' | 'roles' | 'defaults' | 'both-keys' | 'denied-either';

/** Statement-for-statement the SQL of migration.sql. */
function applyTheMigration(before: Rows, skip?: Skip): Rows {
  const db = clone(before);

  // ── the snapshot: everything below is read from `before`, never from rows written here ──
  const ur = userRole(before);
  const receives = (perms: Grant[]) => {
    const ids = new Set(perms.map((p) => p.roleId));
    return [...ids].filter((rid) => {
      const held = EDIT_CONFIRMED_NEEDS.filter((k) => perms.some((p) => p.roleId === rid && p.permission === k)).length;
      return skip === 'both-keys' ? held >= 1 : held === EDIT_CONFIRMED_NEEDS.length;
    });
  };
  const roleGets = receives(before.rolePerms);
  const defaultGets = receives(before.defaults);

  let n = 0;
  const id = () => `edc-${++n}`;
  const hasUserRow = (uid: string) => db.userPerms.some((p) => p.userId === uid && p.permission === EDIT_CONFIRMED_KEY);

  // 1. «منع» — the role receives the box, the person is refused one of the two keys.
  for (const x of skip === 'deny' ? [] : ur) {
    if (!roleGets.includes(x.rid)) continue;
    const refused =
      skip === 'denied-either'
        ? false
        : before.userPerms.some((d) => d.userId === x.uid && d.effect === 'DENY' && (EDIT_CONFIRMED_NEEDS as readonly string[]).includes(d.permission));
    if (refused && !hasUserRow(x.uid)) {
      db.userPerms.push({ id: id(), userId: x.uid, permission: EDIT_CONFIRMED_KEY, effect: 'DENY', scope: null, scopeIds: null });
    }
  }
  // 2. roles
  for (const rid of skip === 'roles' ? [] : roleGets) {
    if (!db.rolePerms.some((p) => p.roleId === rid && p.permission === EDIT_CONFIRMED_KEY)) {
      db.rolePerms.push({ id: id(), roleId: rid, permission: EDIT_CONFIRMED_KEY, scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  // 3. baselines
  for (const rid of skip === 'defaults' ? [] : defaultGets) {
    if (!db.defaults.some((p) => p.roleId === rid && p.permission === EDIT_CONFIRMED_KEY)) {
      db.defaults.push({ id: id(), roleId: rid, permission: EDIT_CONFIRMED_KEY, scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  return db;
}

// ── the REAL engine over in-memory rows ──

const sourceOf = (db: Rows): GrantSource => ({
  roleRows: async (u) =>
    db.rolePerms
      .filter((p) =>
        u.roleId ? p.roleId === u.roleId : db.roles.some((r) => r.id === p.roleId && r.companyId === null && r.name === u.role))
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
 * THE ORACLE, written from the rule and not from the replay: a person with a stored role holds the box after the deploy exactly when
 * her ROLE holds both keys and she has no personal «منع» on either. (SUPER_ADMIN holds every key and needs no row.)
 */
function oracle(db0: Rows, uid: string): boolean {
  const u = db0.users.find((x) => x.id === uid)!;
  if (u.role === 'SUPER_ADMIN') return true;
  const rids = userRole(db0).filter((x) => x.uid === uid).map((x) => x.rid);
  if (rids.length === 0) return false;
  const roleHoldsBoth = rids.some((rid) => EDIT_CONFIRMED_NEEDS.every((k) => db0.rolePerms.some((p) => p.roleId === rid && p.permission === k)));
  const denied = db0.userPerms.some((d) => d.userId === uid && d.effect === 'DENY' && (EDIT_CONFIRMED_NEEDS as readonly string[]).includes(d.permission));
  return roleHoldsBoth && !denied;
}

let nextId = 0;
const role = (name: string, companyId: string | null = null) => ({ id: `r${++nextId}`, companyId, name });

function fixture(): Rows {
  nextId = 0;
  const tAgent = role('CONFIRMATION_AGENT'); // system templates
  const tSup = role('CONFIRMATION_SUPERVISOR');
  const tFollow = role('FOLLOW_UP_AGENT');
  const tMod = role('MODERATOR');
  const tWare = role('WAREHOUSE');
  const tAdmin = role('COMPANY_ADMIN');
  const cBoth = role('فريق التأكيد', 'c1'); // company roles
  const cWorkOnly = role('مكتب', 'c1'); // confirmation.work, and no request key
  const cRequestOnly = role('مُرسِل', 'c1'); // orders.request_change, and no work key
  const cNothing = role('فاضي', 'c1');
  const cNoDefaults = role('بلا افتراضي', 'c1'); // holds both, was never issued a baseline
  const perms: Array<[typeof tAgent, string[]]> = [
    [tAgent, ['confirmation.work', 'orders.request_change', 'orders.view', 'orders.change_price']],
    [tSup, ['confirmation.work', 'orders.request_change', 'orders.view', 'control.change_requests']],
    [tFollow, ['confirmation.work', 'orders.request_change', 'orders.view']],
    [tMod, ['orders.view', 'orders.request_change', 'orders.create']],
    [tWare, ['orders.view', 'ops.ship', 'ops.decide_changes']],
    [tAdmin, ['confirmation.work', 'orders.request_change', 'orders.view', 'orders.unlock', 'control.change_requests']],
    [cBoth, ['confirmation.work', 'orders.request_change', 'orders.view']],
    [cWorkOnly, ['confirmation.work', 'orders.view']],
    [cRequestOnly, ['orders.request_change', 'orders.view']],
    [cNoDefaults, ['confirmation.work', 'orders.request_change', 'orders.view']],
  ];
  const rows: Rows = { users: [], roles: [tAgent, tSup, tFollow, tMod, tWare, tAdmin, cBoth, cWorkOnly, cRequestOnly, cNothing, cNoDefaults], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  for (const [r, keys] of perms) {
    for (const permission of keys) {
      rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission, scope: 'ALL_COMPANY', scopeIds: null });
      if (r.id !== cNoDefaults.id) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission, scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  const user = (id: string, roleName: string, roleId: string | null) => rows.users.push({ id, role: roleName, roleId });
  const ur = (userId: string, permission: string, effect: 'ALLOW' | 'DENY') =>
    rows.userPerms.push({ id: `up${++i}`, userId, permission, effect, scope: effect === 'ALLOW' ? 'ALL_COMPANY' : null, scopeIds: null });

  user('agent', 'CONFIRMATION_AGENT', tAgent.id);
  user('agent-no-role-id', 'CONFIRMATION_AGENT', null); // reads the template named like the role
  user('supervisor', 'CONFIRMATION_SUPERVISOR', tSup.id);
  user('follow-up', 'FOLLOW_UP_AGENT', tFollow.id);
  user('moderator', 'MODERATOR', tMod.id); // request key, no work key
  user('warehouse', 'WAREHOUSE', tWare.id);
  user('admin', 'COMPANY_ADMIN', tAdmin.id);
  user('company-both', 'MODERATOR', cBoth.id);
  user('company-work-only', 'MODERATOR', cWorkOnly.id);
  user('company-request-only', 'MODERATOR', cRequestOnly.id);
  user('company-nothing', 'MODERATOR', cNothing.id);
  user('company-no-defaults', 'MODERATOR', cNoDefaults.id);
  user('root', 'SUPER_ADMIN', null);
  user('stranger', 'ROLE_NOBODY_KNOWS', null); // no role id, no template: the fallback, which is empty
  // ── the same roles, with personal exceptions ──
  user('agent-denied-work', 'CONFIRMATION_AGENT', tAgent.id); ur('agent-denied-work', 'confirmation.work', 'DENY');
  user('agent-denied-request', 'CONFIRMATION_AGENT', tAgent.id); ur('agent-denied-request', 'orders.request_change', 'DENY');
  user('agent-denied-both', 'CONFIRMATION_AGENT', tAgent.id); ur('agent-denied-both', 'confirmation.work', 'DENY'); ur('agent-denied-both', 'orders.request_change', 'DENY');
  user('agent-denied-other', 'CONFIRMATION_AGENT', tAgent.id); ur('agent-denied-other', 'orders.change_price', 'DENY'); // unrelated: moves nothing
  user('agent-allowed-other', 'CONFIRMATION_AGENT', tAgent.id); ur('agent-allowed-other', 'orders.edit', 'ALLOW');
  // a personal «سماح» on BOTH keys in a role that has neither: she reaches both keys, and still does not receive the box
  user('nothing-allowed-both', 'MODERATOR', cNothing.id); ur('nothing-allowed-both', 'confirmation.work', 'ALLOW'); ur('nothing-allowed-both', 'orders.request_change', 'ALLOW');
  // a personal «سماح» on the missing key in a role that has the other: same
  user('work-only-allowed-request', 'MODERATOR', cWorkOnly.id); ur('work-only-allowed-request', 'orders.request_change', 'ALLOW');
  // the role does hold both, and the person is also given the keys: still just the role’s box
  user('company-both-allowed', 'MODERATOR', cBoth.id); ur('company-both-allowed', 'confirmation.work', 'ALLOW');
  user('stranger-allowed-both', 'ROLE_NOBODY_KNOWS', null); ur('stranger-allowed-both', 'confirmation.work', 'ALLOW'); ur('stranger-allowed-both', 'orders.request_change', 'ALLOW');
  return rows;
}

async function everyoneAgainstTheOracle(db0: Rows) {
  const db1 = applyTheMigration(db0);
  const wrong: string[] = [];
  for (const u of db0.users) {
    // The stranger has no stored role: the in-code fallback answers, and it has its own table below.
    if (userRole(db0).every((x) => x.uid !== u.id) && u.role !== 'SUPER_ADMIN') continue;
    const after = await holder(db1, u.id);
    const holds = can(after, EDIT_CONFIRMED_KEY);
    if (holds !== oracle(db0, u.id)) wrong.push(`${u.id}: oracle ${oracle(db0, u.id)}, engine ${holds}`);
    // The screen’s own question agrees with the server’s.
    expect(userCan(after, EDIT_CONFIRMED_KEY), `${u.id}: الشاشة والخادم`).toBe(holds);
  }
  return { db1, wrong };
}

describe('the replay: every person, through the real engine, against the rule written out', () => {
  it('holds the box exactly when her role holds BOTH keys and she is refused neither — and nobody else', async () => {
    const { wrong } = await everyoneAgainstTheOracle(fixture());
    expect(wrong, 'من حصل أو خسر خطأً').toEqual([]);
  });

  it('each case by name', async () => {
    const db1 = applyTheMigration(fixture());
    const box = async (uid: string) => can(await holder(db1, uid), EDIT_CONFIRMED_KEY);
    // the agents, the supervisors and the follow-up role get it the day it ships — template and company role alike
    for (const uid of ['agent', 'agent-no-role-id', 'supervisor', 'follow-up', 'admin', 'company-both', 'company-no-defaults']) expect(await box(uid), uid).toBe(true);
    // nobody else
    for (const uid of ['moderator', 'warehouse', 'company-work-only', 'company-request-only', 'company-nothing', 'stranger']) expect(await box(uid), uid).toBe(false);
    // a «منع» on EITHER of the two keys refuses the box; one on an unrelated key does not
    expect(await box('agent-denied-work')).toBe(false);
    expect(await box('agent-denied-request')).toBe(false);
    expect(await box('agent-denied-both')).toBe(false);
    expect(await box('agent-denied-other')).toBe(true);
    expect(await box('agent-allowed-other')).toBe(true);
    // a personal «سماح» does not make a role that lacks a key receive it: «nobody else» is the rule
    expect(await box('nothing-allowed-both')).toBe(false);
    expect(await box('work-only-allowed-request')).toBe(false);
    expect(await box('company-both-allowed')).toBe(true);
    // …except a person with NO stored role at all: the in-code fallback answers her (it reads the keys AFTER the overrides, as every
    // box before this one does) — and no such person exists in a migrated database, where every system role has its template.
    expect(await box('stranger-allowed-both')).toBe(true);
    // SUPER_ADMIN holds every key, with no row written for him
    expect(await box('root')).toBe(true);
    expect(db1.userPerms.filter((p) => p.userId === 'root')).toEqual([]);
  });

  it('the «منع» rows are written for exactly the people who were refused one of the two keys', () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const written = db1.userPerms.filter((p) => p.id.startsWith('edc-'));
    expect(written.every((p) => p.effect === 'DENY' && p.permission === EDIT_CONFIRMED_KEY && p.scope === null)).toBe(true);
    expect(written.map((p) => p.userId).sort()).toEqual(['agent-denied-both', 'agent-denied-request', 'agent-denied-work']);
  });

  it('writes the role rows and the baseline rows for the same roles — a reset does not take the box away', () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const withBoth = (perms: Grant[]) =>
      new Set(perms.filter((p) => p.permission === 'confirmation.work').map((p) => p.roleId).filter((rid) => perms.some((q) => q.roleId === rid && q.permission === 'orders.request_change')));
    const rolesBox = new Set(db1.rolePerms.filter((p) => p.permission === EDIT_CONFIRMED_KEY).map((p) => p.roleId));
    const defaultsBox = new Set(db1.defaults.filter((p) => p.permission === EDIT_CONFIRMED_KEY).map((p) => p.roleId));
    expect(rolesBox).toEqual(withBoth(db0.rolePerms));
    expect(defaultsBox).toEqual(withBoth(db0.defaults));
    // the role that was never issued a baseline gets a role row and no baseline row, exactly as its other keys
    const noDefaults = db0.roles.find((r) => r.name === 'بلا افتراضي')!.id;
    expect(rolesBox.has(noDefaults)).toBe(true);
    expect(defaultsBox.has(noDefaults)).toBe(false);
    // …at the whole company, because the box has no narrower scope
    for (const p of [...db1.rolePerms, ...db1.defaults].filter((x) => x.permission === EDIT_CONFIRMED_KEY)) expect(p.scope).toBe('ALL_COMPANY');
  });

  it('what the owner unticked before is not given back: a role that lost the request key does not receive the box through the other', async () => {
    const db1 = applyTheMigration(fixture());
    const workOnly = await holder(db1, 'company-work-only');
    expect(can(workOnly, 'confirmation.work')).toBe(true);
    expect(can(workOnly, 'orders.request_change')).toBe(false);
    expect(can(workOnly, EDIT_CONFIRMED_KEY)).toBe(false);
  });

  it('nothing else about anybody moves: every other key a person holds is exactly what it was', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    for (const u of db0.users) {
      const a = await holder(db0, u.id);
      const b = await holder(db1, u.id);
      const strip = (x: SessionUser) => (x.permissions ?? []).filter((k) => k !== EDIT_CONFIRMED_KEY).sort();
      expect(strip(b), u.id).toEqual(strip(a));
    }
  });

  it('every row it writes is tagged, nothing that existed was changed, and a second run changes nothing', () => {
    const db0 = fixture();
    const once = applyTheMigration(db0);
    const twice = applyTheMigration(once);
    const counts = (r: Rows) => ({ u: r.userPerms.length, r: r.rolePerms.length, d: r.defaults.length });
    expect(counts(twice)).toEqual(counts(once));
    const old = new Set([...db0.userPerms, ...db0.rolePerms, ...db0.defaults].map((x) => x.id));
    const added = [...once.userPerms, ...once.rolePerms, ...once.defaults].map((x) => x.id).filter((i) => !old.has(i));
    expect(added.length).toBeGreaterThan(10);
    for (const i of added) expect(i).toMatch(/^edc-/);
    for (const p of db0.userPerms) expect(once.userPerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.rolePerms) expect(once.rolePerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.defaults) expect(once.defaults.find((q) => q.id === p.id)).toEqual(p);
  });

  it('the rollback undoes it: dropping the rows tagged edc- leaves exactly the rows that were there before', () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const rolledBack: Rows = {
      ...db1,
      userPerms: db1.userPerms.filter((p) => !p.id.startsWith('edc-')),
      rolePerms: db1.rolePerms.filter((p) => !p.id.startsWith('edc-')),
      defaults: db1.defaults.filter((p) => !p.id.startsWith('edc-')),
    };
    expect(rolledBack).toEqual(db0);
  });

  it('NEGATIVE (the test of the test): a migration with one step wrong is CAUGHT — no «منع», no role rows, either-key instead of both-keys', async () => {
    const db0 = fixture();
    const wrongOf = async (skip: Skip) => {
      const broken = applyTheMigration(db0, skip);
      let wrong = 0;
      for (const u of db0.users) {
        if (userRole(db0).every((x) => x.uid !== u.id) && u.role !== 'SUPER_ADMIN') continue;
        if (can(await holder(broken, u.id), EDIT_CONFIRMED_KEY) !== oracle(db0, u.id)) wrong++;
      }
      return wrong;
    };
    expect(await wrongOf('deny'), 'بلا «منع» يكسب المحرومون المفتاح').toBeGreaterThan(0);
    expect(await wrongOf('denied-either'), 'إن لم يقرأ «المنع» على المفتاحين').toBeGreaterThan(0);
    expect(await wrongOf('roles'), 'بلا صفوف الأدوار لا يحصل أحد على شيء').toBeGreaterThan(0);
    expect(await wrongOf('both-keys'), 'مفتاح واحد يكفي فيكسب من لا يستحق').toBeGreaterThan(0);
    // and the baseline is the part the oracle cannot see through the engine — it is checked by rows above
    expect(applyTheMigration(db0, 'defaults').defaults.filter((p) => p.permission === EDIT_CONFIRMED_KEY)).toEqual([]);
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
  const KEYS = [...EDIT_CONFIRMED_NEEDS, 'orders.view', 'orders.edit', 'control.change_requests'];
  const rows: Rows = { users: [], roles: [], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  const templateNames = ['CONFIRMATION_AGENT', 'CONFIRMATION_SUPERVISOR', 'MODERATOR'];
  for (const name of templateNames) rows.roles.push({ id: `t-${name}`, companyId: null, name });
  for (let r = 0; r < 10; r++) rows.roles.push({ id: `c${r}`, companyId: 'c1', name: `role${r}` });
  for (const r of rows.roles) {
    for (const k of KEYS) {
      if (rand() < 0.55) rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission: k, scope: 'ALL_COMPANY', scopeIds: null });
      if (rand() < 0.5) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission: k, scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  for (let u = 0; u < 150; u++) {
    const kind = rand();
    const row =
      kind < 0.6 ? { role: 'MODERATOR', roleId: pick(rows.roles.filter((x) => x.companyId !== null)).id }
      : kind < 0.85 ? { role: pick(templateNames), roleId: null }
      : kind < 0.93 ? { role: 'SUPER_ADMIN', roleId: null }
      : { role: 'MODERATOR', roleId: pick(rows.roles).id };
    rows.users.push({ id: `u${u}`, ...row });
    for (const k of KEYS) {
      const x = rand();
      if (x < 0.12) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'DENY', scope: null, scopeIds: null });
      else if (x < 0.22) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'ALLOW', scope: 'ALL_COMPANY', scopeIds: null });
    }
  }
  return rows;
}

describe('a seeded fuzz: 12 random companies, 150 people each — the engine agrees with the rule for every one', () => {
  it('holds for every seed', async () => {
    let people = 0;
    let holders = 0;
    let refused = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const db0 = randomWorld(seed);
      const { db1, wrong } = await everyoneAgainstTheOracle(db0);
      expect(wrong, `seed ${seed}`).toEqual([]);
      people += db0.users.length;
      holders += db1.rolePerms.filter((p) => p.permission === EDIT_CONFIRMED_KEY).length;
      refused += db1.userPerms.filter((p) => p.id.startsWith('edc-')).length;
    }
    expect(people).toBe(1800);
    expect(holders, 'the fuzz must make the migration write role rows').toBeGreaterThan(20);
    expect(refused, 'the fuzz must make the migration write «منع» rows').toBeGreaterThan(5);
  }, 120_000);
});

// ── the engine fallback: a person with no stored role ──

describe('the engine fallback: a person with no stored role gets the box exactly when both keys derive for her', () => {
  const fallback = async (role: string, ex: Array<{ permission: string; effect: string }> = []) =>
    computeEffectiveGrants({ id: 'f1', role, roleId: null }, {
      roleRows: async () => [],
      overrideRows: async () => ex.map((e) => ({ ...e, scope: null, scopeIds: null })),
    });

  const ROLES = ['COMPANY_ADMIN', 'MANAGER', 'MODERATOR', 'CONFIRMATION_AGENT', 'FOLLOW_UP_AGENT', 'DELIVERY_MANAGER', 'ACCOUNTANT', 'PENDING_USER', 'WAREHOUSE', 'CONFIRMATION_SUPERVISOR', 'SETTLEMENT_OFFICER'];

  /** A person with no stored role who was GIVEN the work key by hand: the legacy matrix has no `confirmation.work` for anybody. */
  const GIVEN_WORK = [{ permission: 'confirmation.work', effect: 'ALLOW' }];

  it('for every legacy role, with and without the work key given by hand, the box is held exactly when both keys are', async () => {
    let holders = 0;
    let others = 0;
    for (const r of ROLES) {
      for (const ex of [[], GIVEN_WORK]) {
        const g = (await fallback(r, ex)).grants;
        const both = EDIT_CONFIRMED_NEEDS.every((k) => g[k] !== undefined);
        expect(g[EDIT_CONFIRMED_KEY] !== undefined, `${r}/${ex.length}`).toBe(both);
        if (both) holders++;
        else others++;
      }
    }
    // not vacuous: some of the combinations hold both keys and some do not
    expect(holders).toBeGreaterThan(0);
    expect(others).toBeGreaterThan(0);
  });

  it('by name: a role with the orders list that is GIVEN the work key reaches the box; the same role without it does not', async () => {
    expect(Object.keys((await fallback('ACCOUNTANT', GIVEN_WORK)).grants)).toContain(EDIT_CONFIRMED_KEY);
    expect(Object.keys((await fallback('ACCOUNTANT')).grants)).not.toContain(EDIT_CONFIRMED_KEY);
    // (`orders.request_change` derives from the work key itself in the fallback, exactly as PR-6 gave it to whoever held `confirmation.work`.)
    expect(Object.keys((await fallback('PENDING_USER', GIVEN_WORK)).grants)).toContain(EDIT_CONFIRMED_KEY);
    expect(Object.keys((await fallback('PENDING_USER')).grants)).not.toContain(EDIT_CONFIRMED_KEY);
  });

  it('NEGATIVE: a «منع» on either key, or on the box, wins over the fallback — the other boxes of the same person are untouched', async () => {
    const given = [...GIVEN_WORK];
    expect(Object.keys((await fallback('ACCOUNTANT', given)).grants)).toContain(EDIT_CONFIRMED_KEY);
    expect(Object.keys((await fallback('ACCOUNTANT', [...given, { permission: 'confirmation.work', effect: 'DENY' }])).grants)).not.toContain(EDIT_CONFIRMED_KEY);
    expect(Object.keys((await fallback('ACCOUNTANT', [...given, { permission: 'orders.request_change', effect: 'DENY' }])).grants)).not.toContain(EDIT_CONFIRMED_KEY);
    const denied = (await fallback('ACCOUNTANT', [...given, { permission: EDIT_CONFIRMED_KEY, effect: 'DENY' }])).grants;
    expect(Object.keys(denied)).not.toContain(EDIT_CONFIRMED_KEY);
    expect(Object.keys(denied)).toContain('confirmation.work');
  });

  it('the parity list (the reset-to-default baseline of a legacy role) carries the box exactly when it carries both keys', () => {
    for (const r of ROLES) {
      const keys = legacyEffectiveKeys(r as never);
      expect(keys.includes(EDIT_CONFIRMED_KEY), r).toBe(EDIT_CONFIRMED_NEEDS.every((k) => keys.includes(k)));
    }
  });
});
