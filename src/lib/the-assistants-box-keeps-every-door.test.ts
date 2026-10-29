import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HELPERS' BOX (ai.assist) — AND NOBODY LOSES A HELPER OR GAINS A DOOR (perm-plan PR-5).
 *
 * Five helpers answered to the key of the work they sit in: the confirmation assistant (confirmation.work), the picking
 * assistant (ops.prepare), the landing-page writer (landing_pages.edit), the AI step of order entry (orders.create) and
 * «لخّصلي اليوم» (orders.view). Each now asks that key AND ai.assist. The migration 20261030120000_ai_assist_key hands
 * ai.assist to everybody who passed any of the five doors yesterday and carries every «منع».
 *
 * ⚠️ WHAT THIS FILE IS, SAID PLAINLY. There is no database in CI, so the SQL cannot be run here. Two things are done
 * instead, and neither is the SQL running:
 *   1. the SQL is READ as text — its shape (what it writes, in which order, from which keys) is pinned;
 *   2. the SQL's logic is REPLAYED by `applyTheMigration` below, a statement-for-statement copy over in-memory rows, and
 *      the people it produces are judged by the REAL engine (computeEffectiveGrants + can): for every person and every
 *      door, "could they pass yesterday" must equal "can they pass today" (the key of the work AND ai.assist).
 * The copy can drift from the SQL; a rehearsal of the SQL itself inside a rolled-back transaction is the stronger
 * evidence, and the pull request says what was and was not done.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants, can } from './authorization';
import { userCan } from './can';
import { AI_ASSIST_FROM, AI_ASSIST_KEY } from './ai-assistants';
import { ALL_CATALOG_KEYS, catalogItem } from './permission-catalog';
import { computeEffectiveGrants, legacyEffectiveKeys, type GrantSource } from './permissions-core';
import type { SessionUser } from '@/types/auth';
import type { UserRole } from '@/types/auth';

const DIR = path.join(process.cwd(), 'prisma', 'migrations', '20261030120000_ai_assist_key');
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

/** The five doors: the key each asked yesterday. Today each asks it AND ai.assist. */
const DOORS = [...AI_ASSIST_FROM];

describe('the box is in the catalog, standalone, with a note', () => {
  it('can be ticked on «الصلاحيات»: Arabic and English label, no screen key, a note that says why', () => {
    // The server doors write the literal (the catalog's "nothing lists a key nothing checks" guard reads literals): same string.
    expect(AI_ASSIST_KEY).toBe('ai.assist');
    const item = catalogItem(AI_ASSIST_KEY)!;
    expect(item).toBeDefined();
    expect(ALL_CATALOG_KEYS.has(AI_ASSIST_KEY)).toBe(true);
    expect(item.requires).toBeNull();
    expect((item.note ?? '').length).toBeGreaterThan(20);
    expect(item.ar).toMatch(/المساعد/);
    expect(item.en.length).toBeGreaterThan(10);
  });

  it('the five sources are exactly the five keys the five helpers asked before', () => {
    expect([...AI_ASSIST_FROM].sort()).toEqual(['confirmation.work', 'landing_pages.edit', 'ops.prepare', 'orders.create', 'orders.view']);
  });
});

describe('the SQL, read as text', () => {
  const grantTables = ['user_permissions', 'role_permissions', 'role_permission_defaults'];

  it('only ADDS rows to the three grant tables — and only drops its own temporary tables', () => {
    const inserts = statements.filter((s) => s.startsWith('INSERT INTO'));
    expect(inserts).toHaveLength(4);
    for (const s of inserts) {
      expect(grantTables).toContain(s.match(/^INSERT INTO "(\w+)"/)![1]);
      expect(s).toMatch(/ON CONFLICT \("(roleId|userId)", "permission"\) DO NOTHING$/);
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'aia-' || gen_random_uuid()::text`);
      expect(s, 'only the new key').toContain(`'ai.assist'`);
    }
    for (const s of statements.filter((x) => !x.startsWith('INSERT INTO'))) {
      expect(s.startsWith('DROP TABLE IF EXISTS pg_temp.sp5_') || s.startsWith('CREATE TEMP TABLE sp5_'), s.slice(0, 70)).toBe(true);
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
    // two statements that decide a person read only the snapshot, and the new key is never a source.
    for (const s of statements.filter((x) => x.startsWith('INSERT INTO "user_permissions"'))) {
      const reads = s.slice(s.indexOf('SELECT'));
      expect(reads).not.toContain('"role_permissions"');
      expect(reads).not.toContain('"user_permissions"');
      expect(reads).toMatch(/sp5_pass/);
    }
    for (const s of statements.filter((x) => x.startsWith('CREATE TEMP TABLE'))) {
      expect(s).not.toContain(`'ai.assist'`);
    }
  });

  it('the source table is EXACTLY the five keys the engine fallback and the screens read (AI_ASSIST_FROM)', () => {
    const src = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp5_src'))!;
    const keys = [...src.matchAll(/\('([a-z_.]+)'\)/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...AI_ASSIST_FROM].sort());
  });

  it('the two statements that decide a person say exactly what the replay does — a flipped condition is caught HERE, since the replay is a copy', () => {
    const deny = flat(statements.find((s) => s.includes(`'DENY'`) && s.startsWith('INSERT INTO'))!);
    // the role receives the box AND the person did not pass any door
    expect(deny).toContain('FROM sp5_user_role ur JOIN sp5_role_gets rg ON rg.rid = ur.rid');
    expect(deny).toContain('WHERE NOT EXISTS (SELECT 1 FROM sp5_pass p WHERE p.uid = ur.uid)');
    const allow = flat(statements.find((s) => s.includes(`'ALLOW'`) && s.startsWith('INSERT INTO'))!);
    // the person passed AND no role of theirs receives the box
    expect(allow).toContain('FROM sp5_pass p WHERE NOT EXISTS (SELECT 1 FROM sp5_user_role ur JOIN sp5_role_gets rg ON rg.rid = ur.rid WHERE ur.uid = p.uid)');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!)).toContain('FROM sp5_role_gets rg');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!)).toContain('FROM sp5_default_gets dg');
    // the source of a role's box is the role's own rows, of a baseline the baseline's
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp5_role_gets'))!)).toContain('FROM "role_permissions" rp JOIN sp5_src s ON s.k = rp."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp5_default_gets'))!)).toContain('FROM "role_permission_defaults" d JOIN sp5_src s ON s.k = d."permission"');
    // holding a source means: through the role or an ALLOW, and NOT under a DENY
    const holds = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp5_holds'))!);
    expect(holds).toContain(`up."effect" = 'ALLOW'`);
    expect(holds).toContain(`d."effect" = 'DENY'`);
    expect(holds).toContain('AND NOT EXISTS');
    expect(holds).toContain('h.k IN (SELECT k FROM sp5_src)');
  });

  it('reads the role the way the engine reads it, and leaves SUPER_ADMIN alone', () => {
    const ur = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp5_user_role'))!;
    expect(ur).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
    expect(ur).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
    expect(ur).toContain(`u."role" <> 'SUPER_ADMIN'`);
    expect(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp5_holds'))!).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('its rollback removes only what it wrote, in all three places, and its own row in the migrations table', () => {
    const body = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const deletes = body.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'aia-%'`);
    expect(deletes[3]).toContain(`'20261030120000_ai_assist_key'`);
    expect(new Set(deletes.slice(0, 3).map((d) => d.match(/FROM "(\w+)"/)![1]))).toEqual(new Set(grantTables));
  });

  it('the tag is its own: no other migration writes ids that start with it', () => {
    const others = ['20261027000000_sensitive_settings_own_key', '20261029000000_tracking_returns_view_key', '20261029130000_analytics_view_becomes_reports_view', '20261029120000_shortfall_penalty'];
    for (const m of others) {
      const text = readFileSync(path.join(process.cwd(), 'prisma', 'migrations', m, 'migration.sql'), 'utf8');
      expect(text, m).not.toContain(`'aia-'`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE REPLAY — the SQL's statements, one by one, over in-memory rows.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rows {
  users: Array<{ id: string; role: string; roleId: string | null }>;
  roles: Array<{ id: string; companyId: string | null; name: string }>;
  rolePerms: Array<{ roleId: string; permission: string; id: string }>;
  defaults: Array<{ roleId: string; permission: string; id: string }>;
  userPerms: Array<{ userId: string; permission: string; effect: 'ALLOW' | 'DENY'; id: string }>;
}

const clone = (r: Rows): Rows => JSON.parse(JSON.stringify(r)) as Rows;

/** `sp5_user_role`: (uid, rid) — the engine's own reading of "which role are this person's grants from". */
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

type Skip = 'deny' | 'allow' | 'roles' | 'baselines' | 'denied-sources' | 'after-roles';

/** Statement-for-statement the SQL of migration.sql. */
function applyTheMigration(before: Rows, skip?: Skip): Rows {
  const db = clone(before);
  const SRC = new Set<string>(AI_ASSIST_FROM);

  // ── the snapshot: everything below is read from `before`, never from rows written here ──
  const ur = userRole(before);
  const superIds = new Set(before.users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.id));
  const denied = (uid: string, k: string) => before.userPerms.some((d) => d.userId === uid && d.permission === k && d.effect === 'DENY');

  // sp5_holds
  const holdsRaw = new Set<string>();
  for (const x of ur) for (const rp of before.rolePerms) if (rp.roleId === x.rid) holdsRaw.add(`${x.uid}|${rp.permission}`);
  for (const up of before.userPerms) if (up.effect === 'ALLOW' && !superIds.has(up.userId)) holdsRaw.add(`${up.userId}|${up.permission}`);
  const holds = [...holdsRaw].filter((e) => {
    const [uid, k] = e.split('|');
    return SRC.has(k) && (skip === 'denied-sources' || !denied(uid, k)); // 'denied-sources': forget that a «منع» removes a source
  });

  // sp5_pass
  const pass = new Set(holds.map((e) => e.split('|')[0]));

  // sp5_role_gets / sp5_default_gets
  const gets = (table: Array<{ roleId: string; permission: string }>) =>
    new Set(table.filter((rp) => SRC.has(rp.permission)).map((rp) => rp.roleId));
  const roleGets = gets(before.rolePerms);
  const defaultGets = gets(before.defaults);

  let n = 0;
  const id = () => `aia-${++n}`;
  const hasUserRow = (uid: string) => db.userPerms.some((p) => p.userId === uid && p.permission === AI_ASSIST_KEY);

  // 3. roles — written FIRST only in the broken variant (the old plan's order), to show the order is what protects
  const writeRoles = () => {
    for (const roleId of skip === 'roles' ? [] : roleGets) {
      if (!db.rolePerms.some((p) => p.roleId === roleId && p.permission === AI_ASSIST_KEY)) db.rolePerms.push({ id: id(), roleId, permission: AI_ASSIST_KEY });
    }
  };
  if (skip === 'after-roles') writeRoles();

  // 1. «منع» — the role receives the box, the person did not pass a door.
  for (const x of skip === 'deny' ? [] : ur) {
    // In the broken variant the question is asked of the rows written so far ("does his role hold a source?" counts the box).
    const roleReceives = skip === 'after-roles' ? db.rolePerms.some((p) => p.roleId === x.rid && p.permission === AI_ASSIST_KEY) : roleGets.has(x.rid);
    const passed = skip === 'after-roles' ? true : pass.has(x.uid);
    if (roleReceives && !passed && !hasUserRow(x.uid)) db.userPerms.push({ id: id(), userId: x.uid, permission: AI_ASSIST_KEY, effect: 'DENY' });
  }
  // 2. «سماح» — the person passed, no role of theirs receives the box.
  for (const uid of skip === 'allow' ? [] : pass) {
    const roleReceives = ur.some((x) => x.uid === uid && roleGets.has(x.rid));
    if (!roleReceives && !hasUserRow(uid)) db.userPerms.push({ id: id(), userId: uid, permission: AI_ASSIST_KEY, effect: 'ALLOW' });
  }
  // 3. roles
  if (skip !== 'after-roles') writeRoles();
  // 4. baselines
  for (const roleId of skip === 'baselines' ? [] : defaultGets) {
    if (!db.defaults.some((p) => p.roleId === roleId && p.permission === AI_ASSIST_KEY)) db.defaults.push({ id: id(), roleId, permission: AI_ASSIST_KEY });
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
      .map((p) => ({ permission: p.permission, scope: 'ALL_COMPANY', scopeIds: null })),
  overrideRows: async (userId) =>
    db.userPerms.filter((p) => p.userId === userId).map((p) => ({ permission: p.permission, effect: p.effect, scope: null, scopeIds: null })),
});

async function holder(db: Rows, uid: string): Promise<SessionUser> {
  const row = db.users.find((u) => u.id === uid)!;
  const g = await computeEffectiveGrants({ id: row.id, role: row.role, roleId: row.roleId }, sourceOf(db));
  const user = { id: row.id, name: uid, email: `${uid}@x`, role: row.role, status: 'ACTIVE', companyId: 'c1', permissions: Object.keys(g.grants) } as unknown as SessionUser;
  return attachGrants(user, g);
}

/** Does this person have a stored role (a roleId, or a system template named like theirs)? Otherwise the in-code fallback reads for them. */
const hasStoredRole = (db: Rows, uid: string) => {
  const u = db.users.find((x) => x.id === uid)!;
  return u.roleId !== null || db.roles.some((r) => r.companyId === null && r.name === u.role);
};

let nextId = 0;
const role = (name: string, companyId: string | null = null) => ({ id: `r${++nextId}`, companyId, name });

function fixture(): Rows {
  nextId = 0;
  const tAdmin = role('COMPANY_ADMIN'); // system templates
  const tMod = role('MODERATOR');
  const tAgent = role('CONFIRMATION_AGENT');
  const cWork = role('تأكيد', 'c1'); // company roles
  const cPack = role('مجهّز', 'c1');
  const cPublisher = role('ناشر', 'c1');
  const cViewer = role('مشاهد', 'c1');
  const cNoView = role('بلا عرض', 'c1'); // the owner unticked orders.view on 28/10
  const cMoney = role('مالية', 'c1'); // holds none of the five
  const cEmpty = role('فاضي', 'c1');
  const perms: Array<[typeof tAdmin, string[]]> = [
    [tAdmin, ['orders.view', 'orders.create', 'confirmation.work', 'ops.prepare', 'landing_pages.edit', 'settings.view']],
    [tMod, ['orders.view', 'orders.create', 'customers.view']],
    [tAgent, ['confirmation.work', 'orders.view']],
    [cWork, ['confirmation.work']],
    [cPack, ['ops.prepare', 'inventory.view']],
    [cPublisher, ['landing_pages.edit', 'landing_pages.view']],
    [cViewer, ['orders.view']],
    [cNoView, ['orders.create']],
    [cMoney, ['finance.view', 'settlement.view']],
  ];
  const rows: Rows = { users: [], roles: [tAdmin, tMod, tAgent, cWork, cPack, cPublisher, cViewer, cNoView, cMoney, cEmpty], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  for (const [r, keys] of perms) {
    for (const permission of keys) {
      rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission });
      // every role has a baseline except cPublisher — a role that was never issued one
      if (r.id !== cPublisher.id) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission });
    }
  }
  const user = (id: string, roleName: string, roleId: string | null) => rows.users.push({ id, role: roleName, roleId });
  const ur = (userId: string, permission: string, effect: 'ALLOW' | 'DENY') => rows.userPerms.push({ id: `up${++i}`, userId, permission, effect });

  user('admin', 'COMPANY_ADMIN', tAdmin.id);
  user('admin-no-role-id', 'COMPANY_ADMIN', null); // reads the template named like the role
  user('mod', 'MODERATOR', tMod.id);
  user('agent', 'CONFIRMATION_AGENT', tAgent.id);
  user('work', 'MODERATOR', cWork.id);
  user('pack', 'MODERATOR', cPack.id);
  user('publisher', 'MODERATOR', cPublisher.id);
  user('viewer', 'MODERATOR', cViewer.id);
  user('no-view', 'MODERATOR', cNoView.id);
  user('money', 'MODERATOR', cMoney.id);
  user('empty', 'MODERATOR', cEmpty.id);
  user('root', 'SUPER_ADMIN', null);
  user('stranger', 'ROLE_NOBODY_KNOWS', null); // no role id, no template: the fallback, which is empty
  user('fallback-accountant', 'ACCOUNTANT', null); // no template of that name: the in-code fallback
  // ── the same roles, with a personal «منع» / «سماح» on a source key ──
  user('admin-denied-view', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-view', 'orders.view', 'DENY');
  user('admin-denied-create', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-create', 'orders.create', 'DENY');
  user('admin-denied-work', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-work', 'confirmation.work', 'DENY');
  user('admin-denied-prepare', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-prepare', 'ops.prepare', 'DENY');
  user('admin-denied-landing', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-landing', 'landing_pages.edit', 'DENY');
  user('admin-denied-all-five', 'COMPANY_ADMIN', tAdmin.id);
  for (const k of AI_ASSIST_FROM) ur('admin-denied-all-five', k, 'DENY');
  user('work-denied-work', 'MODERATOR', cWork.id); ur('work-denied-work', 'confirmation.work', 'DENY'); // the role's only source, refused
  user('viewer-denied-view', 'MODERATOR', cViewer.id); ur('viewer-denied-view', 'orders.view', 'DENY');
  user('mod-denied-create', 'MODERATOR', tMod.id); ur('mod-denied-create', 'orders.create', 'DENY'); // still has orders.view
  user('money-allowed-view', 'MODERATOR', cMoney.id); ur('money-allowed-view', 'orders.view', 'ALLOW');
  user('empty-allowed-prepare', 'MODERATOR', cEmpty.id); ur('empty-allowed-prepare', 'ops.prepare', 'ALLOW');
  user('empty-allowed-two', 'MODERATOR', cEmpty.id); ur('empty-allowed-two', 'landing_pages.edit', 'ALLOW'); ur('empty-allowed-two', 'orders.create', 'ALLOW');
  user('viewer-allowed-work', 'MODERATOR', cViewer.id); ur('viewer-allowed-work', 'confirmation.work', 'ALLOW');
  user('fallback-allowed-prepare', 'ACCOUNTANT', null); ur('fallback-allowed-prepare', 'ops.prepare', 'ALLOW');
  user('fallback-denied-view', 'ACCOUNTANT', null); ur('fallback-denied-view', 'orders.view', 'DENY');
  user('stranger-allowed-landing', 'ROLE_NOBODY_KNOWS', null); ur('stranger-allowed-landing', 'landing_pages.edit', 'ALLOW');
  // an unrelated exception must not move anything
  user('admin-denied-other', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-other', 'settings.view', 'DENY');
  return rows;
}

/** Yesterday a door asked its key; today it asks the key AND the box. */
async function everyDoorOfEveryone(db0: Rows) {
  const db1 = applyTheMigration(db0);
  const lost: string[] = [];
  const gained: string[] = [];
  const keyGained: string[] = [];
  for (const u of db0.users) {
    const before = await holder(db0, u.id);
    const after = await holder(db1, u.id);
    let passedAny = false;
    for (const k of DOORS) {
      const was = can(before, k);
      const is = can(after, k) && can(after, AI_ASSIST_KEY);
      passedAny ||= was;
      if (was && !is) lost.push(`${u.id} lost the helper behind ${k}`);
      if (!was && is) gained.push(`${u.id} gained the helper behind ${k}`);
      expect(userCan(after, AI_ASSIST_KEY), `${u.id}: الشاشة والخادم`).toBe(can(after, AI_ASSIST_KEY));
    }
    // The stricter promise: the BOX itself is not handed to a person who passed no door (stored roles; see the fallback test).
    if (!passedAny && can(after, AI_ASSIST_KEY) && hasStoredRole(db0, u.id)) keyGained.push(`${u.id} holds the box without having passed a door`);
  }
  return { db1, lost, gained, keyGained };
}

describe('the replay: every person, every door — yesterday against today, through the real engine', () => {
  it('nobody loses a helper and nobody gains a door (30 fixture people, 5 doors each)', async () => {
    const db0 = fixture();
    const { lost, gained, keyGained } = await everyDoorOfEveryone(db0);
    expect(lost, 'خسروا مساعداً').toEqual([]);
    expect(gained, 'كسبوا باباً').toEqual([]);
    expect(keyGained, 'نالوا المفتاح بلا باب').toEqual([]);
    expect(db0.users.length).toBeGreaterThanOrEqual(30);
  });

  it('the fixture really exercises the cases (a replay that finds nothing would pass for the wrong reason)', async () => {
    const db0 = fixture();
    let passers = 0;
    for (const u of db0.users) {
      const h = await holder(db0, u.id);
      for (const k of DOORS) if (can(h, k)) passers++;
    }
    expect(passers, "من يمر من الأبواب").toBeGreaterThan(40);
    const db1 = applyTheMigration(db0);
    expect(db1.userPerms.filter((p) => p.id.startsWith('aia-') && p.effect === 'DENY').length).toBeGreaterThanOrEqual(3);
    expect(db1.userPerms.filter((p) => p.id.startsWith('aia-') && p.effect === 'ALLOW').length).toBeGreaterThanOrEqual(4);
    expect(db1.rolePerms.length - db0.rolePerms.length).toBeGreaterThanOrEqual(8);
    expect(db1.defaults.length - db0.defaults.length).toBeGreaterThanOrEqual(7);
  });

  it('each case by name: every source reaches the box, a «منع» travels, a «سماح» travels, a role with no source gets nothing', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const box = async (uid: string) => can(await holder(db1, uid), AI_ASSIST_KEY);
    // every one of the five sources, alone, is enough
    expect(await box('work')).toBe(true); // confirmation.work
    expect(await box('pack')).toBe(true); // ops.prepare
    expect(await box('publisher')).toBe(true); // landing_pages.edit
    expect(await box('no-view')).toBe(true); // orders.create
    expect(await box('viewer')).toBe(true); // orders.view
    // a role with none of the five is not handed the box
    expect(await box('money')).toBe(false);
    expect(await box('empty')).toBe(false);
    // a «منع» on ONE source of several does not take the box: he still passes the others
    expect(await box('admin-denied-view')).toBe(true);
    expect(await box('admin-denied-landing')).toBe(true);
    expect(await box('mod-denied-create')).toBe(true);
    // a «منع» on the role's ONLY source: he passed no door yesterday, so he is refused the box too
    expect(await box('work-denied-work')).toBe(false);
    expect(await box('viewer-denied-view')).toBe(false);
    expect(await box('admin-denied-all-five')).toBe(false);
    // a «سماح» on a source reaches the box, in a role that has none
    expect(await box('money-allowed-view')).toBe(true);
    expect(await box('empty-allowed-prepare')).toBe(true);
    expect(await box('empty-allowed-two')).toBe(true);
    expect(await box('viewer-allowed-work')).toBe(true);
    // and the person outside any stored role keeps the box through the «سماح» row the migration wrote
    expect(await box('stranger-allowed-landing')).toBe(true);
    expect(await box('fallback-allowed-prepare')).toBe(true);
    // an unrelated exception moved nothing
    expect(await box('admin-denied-other')).toBe(true);
  });

  it('the work keeps working when the box is taken: the owner unticks it and the DESK keeps its key', async () => {
    const db1 = applyTheMigration(fixture());
    // The owner's next step, after the deploy: a «منع» on the box for the packer.
    db1.userPerms.push({ id: 'owner-1', userId: 'pack', permission: AI_ASSIST_KEY, effect: 'DENY' });
    const pack = await holder(db1, 'pack');
    expect(can(pack, 'ops.prepare')).toBe(true);
    expect(can(pack, AI_ASSIST_KEY)).toBe(false);
  });

  it('what the owner unticked before is not given back: a role without orders.view does not get the box through it', async () => {
    const db1 = applyTheMigration(fixture());
    // `no-view` holds orders.create only; he got the box through THAT, not through the orders.view he lost on 28/10.
    const noView = await holder(db1, 'no-view');
    expect(can(noView, 'orders.view')).toBe(false);
    expect(can(noView, 'orders.create')).toBe(true);
    expect(can(noView, AI_ASSIST_KEY)).toBe(true);
    // and the palette's «لخّصلي اليوم» (orders.view AND the box) stays shut for him, as it was
    expect(can(noView, 'orders.view') && can(noView, AI_ASSIST_KEY)).toBe(false);
  });

  it('SUPER_ADMIN is untouched: no row is written for him, and he still passes everything', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    expect(db1.userPerms.filter((p) => p.userId === 'root')).toEqual([]);
    expect(can(await holder(db1, 'root'), AI_ASSIST_KEY)).toBe(true);
  });

  it('every row it writes is tagged, and a second run changes nothing (it steps aside for what is there)', () => {
    const db0 = fixture();
    const once = applyTheMigration(db0);
    const twice = applyTheMigration(once);
    const wrote = (r: Rows) => ({ u: r.userPerms.length, r: r.rolePerms.length, d: r.defaults.length });
    expect(wrote(twice)).toEqual(wrote(once));
    const old = new Set([...db0.userPerms, ...db0.rolePerms, ...db0.defaults].map((x) => x.id));
    const added = [...once.userPerms, ...once.rolePerms, ...once.defaults].map((x) => x.id).filter((i) => !old.has(i));
    expect(added.length).toBeGreaterThan(15);
    for (const i of added) expect(i).toMatch(/^aia-/);
    for (const p of db0.userPerms) expect(once.userPerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.rolePerms) expect(once.rolePerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.defaults) expect(once.defaults.find((q) => q.id === p.id)).toEqual(p);
  });

  it('the «إرجاع للافتراضي» baseline carries the box, so the first reset after the deploy does not take it away', () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const withSource = new Set(db0.defaults.filter((d) => (AI_ASSIST_FROM as readonly string[]).includes(d.permission)).map((d) => d.roleId));
    const boxed = new Set(db1.defaults.filter((d) => d.permission === AI_ASSIST_KEY).map((d) => d.roleId));
    expect(boxed).toEqual(withSource);
    expect(boxed.size).toBeGreaterThanOrEqual(7);
  });

  it('NEGATIVE (the test of the test): a migration with one step removed is CAUGHT', async () => {
    const db0 = fixture();
    const count = async (skip: Skip) => {
      const broken = applyTheMigration(db0, skip);
      const found = { lost: 0, keyGained: 0 };
      for (const u of db0.users) {
        const before = await holder(db0, u.id);
        const after = await holder(broken, u.id);
        let passedAny = false;
        for (const k of DOORS) {
          passedAny ||= can(before, k);
          if (can(before, k) && !(can(after, k) && can(after, AI_ASSIST_KEY))) found.lost++;
        }
        if (!passedAny && can(after, AI_ASSIST_KEY) && hasStoredRole(db0, u.id)) found.keyGained++;
      }
      return found;
    };
    expect((await count('deny')).keyGained, 'بلا «منع» يُمنح المفتاح بلا باب').toBeGreaterThan(0);
    expect((await count('allow')).lost, 'بلا «سماح» يخسر صاحب الاستثناء').toBeGreaterThan(0);
    expect((await count('roles')).lost, 'بلا صفوف الأدوار يخسر الجميع').toBeGreaterThan(0);
    expect((await count('denied-sources')).keyGained, 'إن نسي أنّ «المنع» يُسقط المصدر').toBeGreaterThan(0);
    // The baselines do not change who passes today; they change what the first reset does — so assert THAT.
    const noBaselines = applyTheMigration(db0, 'baselines');
    expect(noBaselines.defaults.filter((d) => d.permission === AI_ASSIST_KEY)).toEqual([]);
  });

  it('NEGATIVE: the old plan’s order (the role rows first, then "does his role hold a source?") would hand the box to someone who passed no door', async () => {
    const db0 = fixture();
    const wrong = applyTheMigration(db0, 'after-roles');
    // `work-denied-work`: the role's only source is refused to him. Asked AFTER the box landed on his role, "is he refused
    // every source his role carries?" is answered by the box row — and no «منع» is written.
    expect(wrong.userPerms.some((p) => p.userId === 'work-denied-work' && p.permission === AI_ASSIST_KEY)).toBe(false);
    expect(can(await holder(wrong, 'work-denied-work'), AI_ASSIST_KEY)).toBe(true);
    // The real order refuses him.
    const right = applyTheMigration(db0);
    expect(can(await holder(right, 'work-denied-work'), AI_ASSIST_KEY)).toBe(false);
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
  const KEYS = [...AI_ASSIST_FROM, 'settings.view', 'finance.view', 'customers.view'];
  const rows: Rows = { users: [], roles: [], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  const templateNames = ['COMPANY_ADMIN', 'MANAGER', 'MODERATOR'];
  for (const name of templateNames) rows.roles.push({ id: `t-${name}`, companyId: null, name });
  for (let r = 0; r < 12; r++) rows.roles.push({ id: `c${r}`, companyId: 'c1', name: `role${r}` });
  for (const r of rows.roles) {
    for (const k of KEYS) {
      if (rand() < 0.35) rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission: k });
      if (rand() < 0.3) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission: k });
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
      if (x < 0.12) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'DENY' });
      else if (x < 0.22) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'ALLOW' });
    }
  }
  return rows;
}

describe('a seeded fuzz: 40 random companies, 200 people each — nobody loses a helper, nobody gains a door', () => {
  it('holds for every seed', async () => {
    let people = 0;
    let withRows = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const db0 = randomWorld(seed);
      const { db1, lost, gained, keyGained } = await everyDoorOfEveryone(db0);
      expect(lost, `seed ${seed}`).toEqual([]);
      expect(gained, `seed ${seed}`).toEqual([]);
      expect(keyGained, `seed ${seed}`).toEqual([]);
      people += db0.users.length;
      if (db1.userPerms.length > db0.userPerms.length) withRows++;
    }
    expect(people).toBe(8000);
    expect(withRows, 'the fuzz must make the migration write exceptions').toBeGreaterThan(30);
  }, 120_000);

  it('and nothing else about anybody moves: every other key a person holds is exactly what it was', async () => {
    for (const seed of [3, 11, 29]) {
      const db0 = randomWorld(seed);
      const db1 = applyTheMigration(db0);
      for (const u of db0.users.slice(0, 120)) {
        const a = await holder(db0, u.id);
        const b = await holder(db1, u.id);
        const strip = (x: SessionUser) => (x.permissions ?? []).filter((k) => k !== AI_ASSIST_KEY).sort();
        expect(strip(b), `${u.id}`).toEqual(strip(a));
      }
    }
  }, 60_000);
});

describe('the engine fallback: a person with no stored role keeps the helpers their legacy keys reached', () => {
  const fallback = async (role: string, ex: Array<{ permission: string; effect: string }> = []) =>
    computeEffectiveGrants({ id: 'f1', role, roleId: null }, {
      roleRows: async () => [],
      overrideRows: async () => ex.map((e) => ({ ...e, scope: null, scopeIds: null })),
    });

  it('the roles that held orders.view or orders.create get the box; the empty roles do not', async () => {
    for (const r of ['COMPANY_ADMIN', 'MANAGER', 'MODERATOR', 'CONFIRMATION_AGENT'] as const) {
      expect(Object.keys((await fallback(r)).grants), r).toContain(AI_ASSIST_KEY);
    }
    for (const r of ['PENDING_USER', 'WAREHOUSE', 'CONFIRMATION_SUPERVISOR']) {
      expect(Object.keys((await fallback(r)).grants), r).not.toContain(AI_ASSIST_KEY);
    }
  });

  it('NEGATIVE: a «منع» on the box wins over the fallback', async () => {
    const g = await fallback('MODERATOR', [{ permission: AI_ASSIST_KEY, effect: 'DENY' }]);
    expect(Object.keys(g.grants)).not.toContain(AI_ASSIST_KEY);
  });

  it('the parity list (the reset-to-default baseline of a legacy role) carries the box for the same roles', () => {
    for (const r of ['COMPANY_ADMIN', 'MANAGER', 'MODERATOR', 'CONFIRMATION_AGENT'] as UserRole[]) {
      expect(legacyEffectiveKeys(r), r).toContain(AI_ASSIST_KEY);
    }
    for (const r of ['PENDING_USER', 'WAREHOUSE'] as UserRole[]) expect(legacyEffectiveKeys(r), r).not.toContain(AI_ASSIST_KEY);
  });

  it('KNOWN, INERT: a fallback person denied every source still gets the key from the matrix, and no door with it', async () => {
    // The fallback is decided before the exceptions are read, so the key is there — but every door ANDs it with a source
    // he is denied, so nothing opens. The migration never touches such a person (no stored role).
    const g = await fallback('MODERATOR', ['orders.view', 'orders.create'].map((permission) => ({ permission, effect: 'DENY' })));
    const keys = Object.keys(g.grants);
    expect(keys).toContain(AI_ASSIST_KEY);
    for (const k of DOORS.filter((d) => d === 'orders.view' || d === 'orders.create')) expect(keys).not.toContain(k);
  });
});
