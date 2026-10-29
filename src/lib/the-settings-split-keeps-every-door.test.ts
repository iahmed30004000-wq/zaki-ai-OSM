import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SETTINGS DOORS GET A BOX EACH — AND NOBODY LOSES A DOOR OR GAINS ONE (perm-plan PR-4).
 *
 * Ten keys: settings.jobs · settings.messages · penalties.rules · team.settings · offers.rules ·
 * commission.view · commission.manage · settings.delivery_fees · settings.tracking · orders.migrate.
 * Before this change each of those doors asked for settings.manage / settings.edit / settings.view (the
 * migration of past orders: orders.import AND settings.manage). The migration
 * 20261029150000_settings_split_keys gives each box to exactly the roles and people who passed that door.
 *
 * ⚠️ WHAT THIS FILE IS, SAID PLAINLY. There is no database in CI, so the SQL cannot be run here. Two things are
 * done instead, and neither is the SQL running:
 *   1. the SQL is READ as text — its shape (what it writes, in which order, from which keys) is pinned;
 *   2. the SQL's logic is REPLAYED by `applyTheMigration` below, a line-for-line copy of its statements over
 *      in-memory rows, and the people it produces are judged by the REAL engine (computeEffectiveGrants + can):
 *      for every person and every door, "could they pass yesterday" must equal "can they pass today".
 * The copy can drift from the SQL; the reviewer's own rehearsal (the SQL run for real inside a transaction that
 * is rolled back) is the stronger evidence, and the pull request says what it measured.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants, can } from './authorization';
import { userCan } from './can';
import { ALL_CATALOG_KEYS, catalogItem, MODULE_LABELS, PERMISSION_MODULES } from './permission-catalog';
import { computeEffectiveGrants, legacyEffectiveKeys, SPLIT_FROM_SETTINGS, type GrantSource } from './permissions-core';
import { ALL_ROUTES } from './route-registry';
import type { SessionUser } from '@/types/auth';

const DIR = path.join(process.cwd(), 'prisma', 'migrations', '20261029150000_settings_split_keys');
const sql = readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
const rollback = readFileSync(path.join(DIR, 'rollback.sql'), 'utf8');
/** The statements, comments dropped. */
const statements = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);

/** The ten boxes, and the key each door asked before. `orders.migrate` asked for two. */
const NEW_KEYS = [
  'settings.jobs', 'settings.messages', 'penalties.rules', 'team.settings', 'offers.rules',
  'commission.view', 'commission.manage', 'settings.delivery_fees', 'settings.tracking', 'orders.migrate',
] as const;

describe('the ten boxes are in the catalog, each with the screen key it sits behind', () => {
  const REQUIRES: Record<string, string | undefined> = {
    'settings.jobs': 'settings.view',
    'settings.messages': 'settings.view',
    'settings.delivery_fees': 'settings.view',
    'settings.tracking': 'settings.view',
    'penalties.rules': 'settings.view',
    'team.settings': 'settings.view',
    'offers.rules': 'settings.view',
    'commission.view': undefined,
    'commission.manage': 'commission.view',
    'orders.migrate': 'orders.import',
  };

  it('all ten can be ticked on «الصلاحيات», with an Arabic and an English label', () => {
    for (const k of NEW_KEYS) {
      const item = catalogItem(k);
      expect(item, `${k} مش بالقائمة`).toBeDefined();
      expect(item!.ar.trim().length).toBeGreaterThan(8);
      expect(item!.en.trim().length).toBeGreaterThan(8);
      expect(item!.requires ?? undefined, `${k}: مفتاح الشاشة`).toBe(REQUIRES[k]);
    }
    expect(NEW_KEYS).toHaveLength(10);
  });

  it('the commission module has a title, and the page key opens the page the menu calls «العمولات»', () => {
    expect(MODULE_LABELS.commission).toBeDefined();
    expect(catalogItem('commission.view')!.opens).toEqual(['العمولات']);
    const page = ALL_ROUTES.find((r) => r.path === '/settings/commission')!;
    expect(page.permissions).toEqual(['commission.view']);
  });

  it('settings.manage no longer claims the scheduled jobs: its label names the credentials, and only them', () => {
    const label = catalogItem('settings.manage')!;
    expect(label.ar).toMatch(/مفاتيح/);
    expect(label.ar).not.toMatch(/المهام المجدولة/);
    expect(catalogItem('settings.jobs')!.ar).toMatch(/المهام المجدولة/);
  });

  it('NEGATIVE: no box is declared twice, and none is an alias of another key', () => {
    const all = PERMISSION_MODULES.flatMap((m) => m.items.map((i) => i.key));
    for (const k of NEW_KEYS) expect(all.filter((x) => x === k), k).toHaveLength(1);
    expect(ALL_CATALOG_KEYS.has('settings.jobs')).toBe(true);
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
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'sp4-' || gen_random_uuid()::text`);
    }
    for (const s of statements.filter((x) => !x.startsWith('INSERT INTO'))) {
      expect(s.startsWith('DROP TABLE IF EXISTS pg_temp.sp4_') || s.startsWith('CREATE TEMP TABLE sp4_'), s.slice(0, 70)).toBe(true);
      if (s.startsWith('DROP')) expect(s).not.toMatch(/\bpublic\b|"(users|roles|role_permissions|user_permissions)"/);
    }
    for (const s of statements) expect(s).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|ALTER)\b/i);
  });

  it('has no BEGIN or COMMIT, so a rehearsal inside a transaction can really be rolled back', () => {
    expect(statements.filter((s) => /^(BEGIN|COMMIT|START TRANSACTION|ROLLBACK)\b/i.test(s))).toEqual([]);
  });

  it('writes the box in all three places a grant lives — the role, its baseline, and the person (both effects)', () => {
    const into = statements.filter((s) => s.startsWith('INSERT INTO')).map((s) => s.match(/^INSERT INTO "(\w+)"/)![1]);
    expect(into).toEqual(['user_permissions', 'user_permissions', 'role_permissions', 'role_permission_defaults']);
    const writes = statements.filter((s) => s.startsWith('INSERT INTO'));
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
    // The «منع» and «سماح» statements ask only the snapshot. The old plan asked "does this role hold a source?"
    // AFTER the role rows were written, and counted the new row as a source.
    for (const s of statements.filter((x) => x.startsWith('INSERT INTO "user_permissions"'))) {
      const reads = s.slice(s.indexOf('SELECT'));
      expect(reads).not.toContain('"role_permissions"');
      expect(reads).not.toContain('"user_permissions"');
      expect(reads).toMatch(/sp4_pass/);
    }
    // And no snapshot is ever read with a new key as its source.
    for (const [newKey] of SPLIT_FROM_SETTINGS) {
      const asSource = statements.filter((s) => s.includes(`"permission" = '${newKey}'`) || s.includes(`k = '${newKey}'`));
      expect(asSource, newKey).toEqual([]);
    }
  });

  it('the gate table is EXACTLY the one the engine fallback and the screens read (SPLIT_FROM_SETTINGS)', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp4_gate'))!;
    const rows = [...gate.matchAll(/\('([a-z_.]+)',\s*'([a-z_.]+)'\)/g)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual(SPLIT_FROM_SETTINGS.map(([n, s]) => [n, s]));
    // Nine single-key doors in the table; the tenth (orders.migrate) is the intersection written out below it.
    expect(rows).toHaveLength(9);
    expect([...rows.map((r) => r[0]), 'orders.migrate'].sort()).toEqual([...NEW_KEYS].sort());
  });

  it('the migration box needs BOTH halves: import and sensitive settings — in the people, the roles and the baselines', () => {
    const pass = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp4_pass'))!;
    expect(pass).toContain(`i.k = 'orders.import'`);
    expect(pass).toContain(`m.k = 'settings.manage'`);
    for (const t of ['sp4_role_gets', 'sp4_default_gets']) {
      const s = statements.find((x) => x.startsWith(`CREATE TEMP TABLE ${t}`))!;
      expect(s).toContain(`a."permission" = 'orders.import'`);
      expect(s).toContain(`b."permission" = 'settings.manage'`);
    }
  });

  it('the two statements that decide a person say exactly what the replay does — a flipped condition is caught HERE, since the replay is a copy', () => {
    const flat = (s: string) => s.replace(/\s+/g, ' ').replace(/\( /g, '(');
    const deny = flat(statements.find((s) => s.includes(`'DENY'`) && s.startsWith('INSERT INTO'))!);
    // the role receives the box AND the person did not pass the door
    expect(deny).toContain('FROM sp4_user_role ur JOIN sp4_role_gets rg ON rg.rid = ur.rid');
    expect(deny).toContain('WHERE NOT EXISTS (SELECT 1 FROM sp4_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)');
    const allow = flat(statements.find((s) => s.includes(`'ALLOW'`) && s.startsWith('INSERT INTO'))!);
    // the person passed the door AND no role of theirs receives the box
    expect(allow).toContain('FROM sp4_pass p WHERE NOT EXISTS (SELECT 1 FROM sp4_user_role ur JOIN sp4_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key WHERE ur.uid = p.uid)');
    // roles and baselines are given the box straight from their own snapshot
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!)).toContain('FROM sp4_role_gets rg');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!)).toContain('FROM sp4_default_gets dg');
    // the source of a role's box is the role's own rows, of a baseline the baseline's
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp4_role_gets'))!)).toContain('FROM "role_permissions" rp JOIN sp4_gate g ON g.src = rp."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp4_default_gets'))!)).toContain('FROM "role_permission_defaults" d JOIN sp4_gate g ON g.src = d."permission"');
    // holding a source means: through the role or an ALLOW, and NOT under a DENY
    const holds = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp4_holds'))!);
    expect(holds).toContain(`up."effect" = 'ALLOW'`);
    expect(holds).toContain(`d."effect" = 'DENY'`);
    expect(holds).toContain('AND NOT EXISTS');
  });

  it('reads the role the way the engine reads it, and leaves SUPER_ADMIN alone', () => {
    const ur = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp4_user_role'))!;
    expect(ur).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
    expect(ur).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
    expect(ur).toContain(`u."role" <> 'SUPER_ADMIN'`);
    const holds = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp4_holds'))!;
    expect(holds).toContain(`u."role" <> 'SUPER_ADMIN'`);
    // A «منع» on the source removes it from what a person holds.
    expect(holds).toMatch(/NOT EXISTS \([\s\S]*d\."effect" = 'DENY'/);
  });

  it('its rollback removes only what it wrote, in all three places, and its own row in the migrations table', () => {
    const body = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const deletes = body.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'sp4-%'`);
    expect(deletes[3]).toContain(`'20261029150000_settings_split_keys'`);
    expect(new Set(deletes.slice(0, 3).map((d) => d.match(/FROM "(\w+)"/)![1]))).toEqual(new Set(grantTables));
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

/** `sp4_user_role`: (uid, rid) — the engine's own reading of "which role are this person's grants from". */
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

/** Statement-for-statement the SQL of migration.sql. */
function applyTheMigration(before: Rows, skip?: 'deny' | 'allow' | 'roles'): Rows {
  const db = clone(before);
  const gate = SPLIT_FROM_SETTINGS; // the VALUES table (a test above proves it is the same list)
  const SRC_KEYS = ['settings.view', 'settings.edit', 'settings.manage', 'orders.import'];

  // ── the snapshot: everything below is read from `before`, never from rows written here ──
  const ur = userRole(before);
  const superIds = new Set(before.users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.id));
  const denied = (uid: string, k: string) => before.userPerms.some((d) => d.userId === uid && d.permission === k && d.effect === 'DENY');

  // sp4_holds
  const holdsRaw = new Set<string>();
  for (const x of ur) for (const rp of before.rolePerms) if (rp.roleId === x.rid) holdsRaw.add(`${x.uid}|${rp.permission}`);
  for (const up of before.userPerms) if (up.effect === 'ALLOW' && !superIds.has(up.userId)) holdsRaw.add(`${up.userId}|${up.permission}`);
  const holds = new Set([...holdsRaw].filter((e) => {
    const [uid, k] = e.split('|');
    return SRC_KEYS.includes(k) && !denied(uid, k);
  }));
  const holdsOf = (uid: string, k: string) => holds.has(`${uid}|${k}`);

  // sp4_pass
  const pass = new Set<string>();
  const uids = new Set([...holds].map((e) => e.split('|')[0]));
  for (const uid of uids) {
    for (const [newKey, src] of gate) if (holdsOf(uid, src)) pass.add(`${uid}|${newKey}`);
    if (holdsOf(uid, 'orders.import') && holdsOf(uid, 'settings.manage')) pass.add(`${uid}|orders.migrate`);
  }

  // sp4_role_gets / sp4_default_gets
  const gets = (table: Array<{ roleId: string; permission: string }>) => {
    const out = new Set<string>();
    for (const rp of table) for (const [newKey, src] of gate) if (rp.permission === src) out.add(`${rp.roleId}|${newKey}`);
    for (const a of table) {
      if (a.permission === 'orders.import' && table.some((b) => b.roleId === a.roleId && b.permission === 'settings.manage')) out.add(`${a.roleId}|orders.migrate`);
    }
    return out;
  };
  const roleGets = gets(before.rolePerms);
  const defaultGets = gets(before.defaults);

  let n = 0;
  const id = () => `sp4-${++n}`;
  const hasUserRow = (uid: string, k: string) => db.userPerms.some((p) => p.userId === uid && p.permission === k);

  // 1. «منع» — the role receives the box, the person did not pass the door.
  for (const x of skip === 'deny' ? [] : ur) {
    for (const e of roleGets) {
      const [rid, newKey] = e.split('|');
      if (rid !== x.rid) continue;
      if (!pass.has(`${x.uid}|${newKey}`) && !hasUserRow(x.uid, newKey)) db.userPerms.push({ id: id(), userId: x.uid, permission: newKey, effect: 'DENY' });
    }
  }
  // 2. «سماح» — the person passed, the role does not receive the box.
  for (const e of skip === 'allow' ? [] : pass) {
    const [uid, newKey] = e.split('|');
    const roleReceives = ur.some((x) => x.uid === uid && roleGets.has(`${x.rid}|${newKey}`));
    if (!roleReceives && !hasUserRow(uid, newKey)) db.userPerms.push({ id: id(), userId: uid, permission: newKey, effect: 'ALLOW' });
  }
  // 3. roles
  for (const e of skip === 'roles' ? [] : roleGets) {
    const [roleId, permission] = e.split('|');
    if (!db.rolePerms.some((p) => p.roleId === roleId && p.permission === permission)) db.rolePerms.push({ id: id(), roleId, permission });
  }
  // 4. baselines
  for (const e of defaultGets) {
    const [roleId, permission] = e.split('|');
    if (!db.defaults.some((p) => p.roleId === roleId && p.permission === permission)) db.defaults.push({ id: id(), roleId, permission });
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

/** The door's OLD rule, asked of the old rows through the real engine. */
async function passedYesterday(db0: Rows, uid: string, newKey: string): Promise<boolean> {
  const u = await holder(db0, uid);
  if (newKey === 'orders.migrate') return can(u, 'orders.import') && can(u, 'settings.manage');
  const src = SPLIT_FROM_SETTINGS.find(([k]) => k === newKey)![1];
  return can(u, src);
}

let nextId = 0;
const role = (name: string, companyId: string | null = null) => ({ id: `r${++nextId}`, companyId, name });

function fixture(): Rows {
  nextId = 0;
  const tAdmin = role('COMPANY_ADMIN'); // system template
  const tManager = role('MANAGER');
  const cOps = role('عمليات', 'c1'); // company roles
  const cFees = role('أجور', 'c1');
  const cImporter = role('مستورد', 'c1');
  const cBoth = role('مالك', 'c1');
  const cViewer = role('مشاهد', 'c1');
  const cEmpty = role('فاضي', 'c1');
  const perms: Array<[typeof tAdmin, string[]]> = [
    [tAdmin, ['settings.view', 'settings.edit', 'settings.manage', 'orders.import', 'orders.view']],
    [tManager, ['settings.view', 'settings.edit', 'orders.view']],
    [cOps, ['settings.view', 'settings.manage']], // the owner unticked settings.edit
    [cFees, ['settings.view', 'settings.edit']], // the owner unticked settings.manage on 28/10
    [cImporter, ['orders.import', 'orders.view']],
    [cBoth, ['orders.import', 'settings.manage', 'settings.view']],
    [cViewer, ['settings.view']],
  ];
  const rows: Rows = { users: [], roles: [tAdmin, tManager, cOps, cFees, cImporter, cBoth, cViewer, cEmpty], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  for (const [r, keys] of perms) {
    for (const permission of keys) {
      rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission });
      // every role has a baseline except cFees — a role that was never issued one
      if (r.id !== cFees.id) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission });
    }
  }
  const user = (id: string, roleName: string, roleId: string | null) => rows.users.push({ id, role: roleName, roleId });
  const ur = (userId: string, permission: string, effect: 'ALLOW' | 'DENY') => rows.userPerms.push({ id: `up${++i}`, userId, permission, effect });

  user('admin', 'COMPANY_ADMIN', tAdmin.id);
  user('admin-no-role-id', 'COMPANY_ADMIN', null); // reads the template named like the role
  user('manager', 'MANAGER', tManager.id);
  user('ops', 'MODERATOR', cOps.id);
  user('fees', 'MODERATOR', cFees.id);
  user('importer', 'MODERATOR', cImporter.id);
  user('both', 'MODERATOR', cBoth.id);
  user('viewer', 'MODERATOR', cViewer.id);
  user('empty', 'MODERATOR', cEmpty.id);
  user('root', 'SUPER_ADMIN', null);
  user('stranger', 'ROLE_NOBODY_KNOWS', null); // no role id, no template: the fallback, which is empty
  user('fallback-admin', 'ACCOUNTANT', null); // no template of that name: the in-code fallback
  // ── the same roles, with a personal «منع» / «سماح» on a source key ──
  user('admin-denied-manage', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-manage', 'settings.manage', 'DENY');
  user('admin-denied-edit', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-edit', 'settings.edit', 'DENY');
  user('admin-denied-view', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-view', 'settings.view', 'DENY');
  user('admin-denied-import', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-import', 'orders.import', 'DENY');
  user('ops-denied-manage', 'MODERATOR', cOps.id); ur('ops-denied-manage', 'settings.manage', 'DENY');
  user('fees-denied-edit', 'MODERATOR', cFees.id); ur('fees-denied-edit', 'settings.edit', 'DENY');
  user('both-denied-import', 'MODERATOR', cBoth.id); ur('both-denied-import', 'orders.import', 'DENY');
  user('viewer-allowed-manage', 'MODERATOR', cViewer.id); ur('viewer-allowed-manage', 'settings.manage', 'ALLOW');
  user('viewer-allowed-edit', 'MODERATOR', cViewer.id); ur('viewer-allowed-edit', 'settings.edit', 'ALLOW');
  user('importer-allowed-manage', 'MODERATOR', cImporter.id); ur('importer-allowed-manage', 'settings.manage', 'ALLOW'); // half of the migration door by exception
  user('ops-allowed-import', 'MODERATOR', cOps.id); ur('ops-allowed-import', 'orders.import', 'ALLOW'); // the other half
  user('empty-allowed-both', 'MODERATOR', cEmpty.id); ur('empty-allowed-both', 'orders.import', 'ALLOW'); ur('empty-allowed-both', 'settings.manage', 'ALLOW');
  user('empty-allowed-view', 'MODERATOR', cEmpty.id); ur('empty-allowed-view', 'settings.view', 'ALLOW');
  user('fallback-allowed-edit', 'ACCOUNTANT', null); ur('fallback-allowed-edit', 'settings.edit', 'ALLOW');
  user('fallback-denied-manage', 'COMPANY_ADMIN_LEGACY', null); ur('fallback-denied-manage', 'settings.manage', 'DENY');
  user('fallback-denied-view', 'ACCOUNTANT', null); ur('fallback-denied-view', 'settings.view', 'DENY');
  // an unrelated exception must not move anything
  user('admin-denied-other', 'COMPANY_ADMIN', tAdmin.id); ur('admin-denied-other', 'orders.view', 'DENY');
  return rows;
}

async function everyDoorOfEveryone(db0: Rows) {
  const db1 = applyTheMigration(db0);
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
  }
  return { db1, lost, gained };
}

describe('the replay: every person, every door — yesterday against today, through the real engine', () => {
  it('nobody loses a door and nobody gains one (28 fixture people, 10 boxes each)', async () => {
    const db0 = fixture();
    const { lost, gained } = await everyDoorOfEveryone(db0);
    expect(lost, 'خسروا باباً').toEqual([]);
    expect(gained, 'كسبوا باباً').toEqual([]);
    expect(db0.users.length).toBeGreaterThanOrEqual(28);
  });

  it('the fixture really exercises the cases (a replay that finds nothing would pass for the wrong reason)', async () => {
    const db0 = fixture();
    // somebody passes the doors…
    let passers = 0;
    for (const u of db0.users) for (const k of NEW_KEYS) if (await passedYesterday(db0, u.id, k)) passers++;
    expect(passers, 'من يمر من الأبواب').toBeGreaterThan(60);
    // …somebody is refused…
    expect(await passedYesterday(db0, 'viewer', 'settings.tracking')).toBe(false);
    // …and the migration has real work to do for «سماح», for «منع», for roles and for baselines.
    const db1 = applyTheMigration(db0);
    const written = (rows: Array<{ id: string }>, before: Array<{ id: string }>) => rows.length - before.length;
    expect(written(db1.userPerms, db0.userPerms)).toBeGreaterThan(10);
    expect(written(db1.rolePerms, db0.rolePerms)).toBeGreaterThan(20);
    expect(written(db1.defaults, db0.defaults)).toBeGreaterThan(15);
    expect(db1.userPerms.filter((p) => p.id.startsWith('sp4-') && p.effect === 'DENY').length).toBeGreaterThan(5);
    expect(db1.userPerms.filter((p) => p.id.startsWith('sp4-') && p.effect === 'ALLOW').length).toBeGreaterThan(5);
  });

  it('each case by name: a «منع» travels, a «سماح» travels, an unticked box is not given back', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const can1 = async (uid: string, k: string) => can(await holder(db1, uid), k);
    // «منع» on settings.manage: refused the five manage-boxes, keeps the edit-boxes (he still held settings.edit)
    expect(await can1('admin-denied-manage', 'settings.jobs')).toBe(false);
    expect(await can1('admin-denied-manage', 'offers.rules')).toBe(false);
    expect(await can1('admin-denied-manage', 'settings.tracking')).toBe(true);
    expect(await can1('admin-denied-manage', 'orders.migrate')).toBe(false);
    // «منع» on settings.edit: the reverse
    expect(await can1('admin-denied-edit', 'settings.tracking')).toBe(false);
    expect(await can1('admin-denied-edit', 'commission.manage')).toBe(false);
    expect(await can1('admin-denied-edit', 'settings.jobs')).toBe(true);
    // «منع» on settings.view: refused the commission page and nothing else
    expect(await can1('admin-denied-view', 'commission.view')).toBe(false);
    expect(await can1('admin-denied-view', 'settings.tracking')).toBe(true);
    // «منع» on the import half: refused the migration, keeps the rest
    expect(await can1('admin-denied-import', 'orders.migrate')).toBe(false);
    expect(await can1('admin-denied-import', 'settings.jobs')).toBe(true);
    // the role that never had settings.edit (the owner unticked it) is not given the edit-boxes back
    expect(await can1('ops', 'settings.jobs')).toBe(true);
    expect(await can1('ops', 'settings.tracking')).toBe(false);
    expect(await can1('ops', 'commission.manage')).toBe(false);
    // the role that lost settings.manage on 28/10 is not given the manage-boxes back
    expect(await can1('fees', 'settings.jobs')).toBe(false);
    expect(await can1('fees', 'settings.delivery_fees')).toBe(true);
    // a «سماح» on one key reaches exactly that key's boxes
    expect(await can1('viewer-allowed-manage', 'settings.messages')).toBe(true);
    expect(await can1('viewer-allowed-manage', 'settings.tracking')).toBe(false);
    expect(await can1('viewer-allowed-edit', 'settings.delivery_fees')).toBe(true);
    expect(await can1('viewer-allowed-edit', 'penalties.rules')).toBe(false);
    // the migration door by exception: one half from the role and one half from the person
    expect(await can1('importer-allowed-manage', 'orders.migrate')).toBe(true);
    expect(await can1('ops-allowed-import', 'orders.migrate')).toBe(true);
    expect(await can1('importer', 'orders.migrate')).toBe(false);
    expect(await can1('ops', 'orders.migrate')).toBe(false);
    expect(await can1('both', 'orders.migrate')).toBe(true);
    // nobody who is not a source holder got anything
    expect(await can1('viewer', 'settings.jobs')).toBe(false);
    expect(await can1('viewer', 'commission.view')).toBe(true); // settings.view -> commission.view
    expect(await can1('empty', 'commission.view')).toBe(false);
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
    const ids = [...once.userPerms, ...once.rolePerms, ...once.defaults].map((x) => x.id);
    const old = new Set([...db0.userPerms, ...db0.rolePerms, ...db0.defaults].map((x) => x.id));
    const added = ids.filter((i) => !old.has(i));
    expect(added.length).toBeGreaterThan(40);
    for (const i of added) expect(i).toMatch(/^sp4-/);
    // Nothing that existed before was changed or removed.
    for (const p of db0.userPerms) expect(once.userPerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.rolePerms) expect(once.rolePerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.defaults) expect(once.defaults.find((q) => q.id === p.id)).toEqual(p);
  });

  it('NEGATIVE (the test of the test): a migration with one step removed is CAUGHT — no «منع», no «سماح», no role rows', async () => {
    const db0 = fixture();
    for (const [skip, what] of [['deny', 'gained'], ['allow', 'lost'], ['roles', 'lost']] as const) {
      const broken = applyTheMigration(db0, skip);
      let found = 0;
      for (const u of db0.users) {
        const after = await holder(broken, u.id);
        for (const k of NEW_KEYS) {
          const was = await passedYesterday(db0, u.id, k);
          const is = can(after, k);
          if (what === 'gained' ? !was && is : was && !is) found++;
        }
      }
      expect(found, `without the "${skip}" step somebody must ${what} a door`).toBeGreaterThan(0);
    }
  });

  it('NEGATIVE: the old plan’s step 4, replayed on purpose, WOULD have given a denied person the door — so this test can tell', async () => {
    // Step 4 of the old plan asked "does this role hold a source?" AFTER writing the role rows. For a source that is
    // also the new key (settings.manage ← settings.edit, settings.manage) the row just written counted. Here: the
    // person is denied settings.edit, his role holds only settings.edit.
    const db0: Rows = {
      users: [{ id: 'p', role: 'MODERATOR', roleId: 'rx' }],
      roles: [{ id: 'rx', companyId: 'c1', name: 'x' }],
      rolePerms: [{ id: '1', roleId: 'rx', permission: 'settings.edit' }],
      defaults: [],
      userPerms: [{ id: '2', userId: 'p', permission: 'settings.edit', effect: 'DENY' }],
    };
    const wrongOrder = clone(db0);
    wrongOrder.rolePerms.push({ id: '3', roleId: 'rx', permission: 'settings.manage' }); // step 1 first…
    const sources = ['settings.edit', 'settings.manage'];
    const roleHoldsASource = wrongOrder.rolePerms.some((p) => p.roleId === 'rx' && sources.includes(p.permission));
    const deniedEveryOne = sources.every((s) => wrongOrder.userPerms.some((d) => d.userId === 'p' && d.permission === s && d.effect === 'DENY'));
    // …then step 4's "denied every source the role carries" is FALSE (the new row is a source he is not denied),
    // so no DENY is written and he gains the door:
    expect(roleHoldsASource && !deniedEveryOne).toBe(true);
    expect(can(await holder(wrongOrder, 'p'), 'settings.manage')).toBe(true);
    // The real order — carry the «منع» from the snapshot — does not.
    const right = applyTheMigration({ ...db0, roles: db0.roles, rolePerms: db0.rolePerms });
    expect(can(await holder(right, 'p'), 'commission.manage')).toBe(false); // denied settings.edit -> denied the edit-box
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
  const SRC = ['settings.view', 'settings.edit', 'settings.manage', 'orders.import', 'orders.view', 'users.view'];
  const rows: Rows = { users: [], roles: [], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  const templateNames = ['COMPANY_ADMIN', 'MANAGER', 'MODERATOR'];
  for (const name of templateNames) rows.roles.push({ id: `t-${name}`, companyId: null, name });
  for (let r = 0; r < 12; r++) rows.roles.push({ id: `c${r}`, companyId: 'c1', name: `role${r}` });
  for (const r of rows.roles) {
    for (const k of SRC) {
      if (rand() < 0.5) rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission: k });
      if (rand() < 0.4) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission: k });
    }
  }
  for (let u = 0; u < 200; u++) {
    const kind = rand();
    const row =
      kind < 0.6 ? { role: 'MODERATOR', roleId: pick(rows.roles.filter((x) => x.companyId !== null)).id }
      : kind < 0.8 ? { role: pick(templateNames), roleId: null }
      : kind < 0.9 ? { role: pick(['ACCOUNTANT', 'COMPANY_ADMIN_X', 'MANAGER_X']), roleId: null }
      : kind < 0.95 ? { role: 'SUPER_ADMIN', roleId: null }
      : { role: 'MODERATOR', roleId: pick(rows.roles).id };
    rows.users.push({ id: `u${u}`, ...row });
    for (const k of SRC) {
      const x = rand();
      if (x < 0.12) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'DENY' });
      else if (x < 0.24) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'ALLOW' });
    }
  }
  return rows;
}

describe('a seeded fuzz: 40 random companies, 200 people each — nobody loses a door, nobody gains one', () => {
  it('holds for every seed', async () => {
    let people = 0;
    let withChanges = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const db0 = randomWorld(seed);
      const { db1, lost, gained } = await everyDoorOfEveryone(db0);
      expect(lost, `seed ${seed}`).toEqual([]);
      expect(gained, `seed ${seed}`).toEqual([]);
      people += db0.users.length;
      if (db1.userPerms.length > db0.userPerms.length) withChanges++;
    }
    expect(people).toBe(8000);
    expect(withChanges, 'the fuzz must make the migration write exceptions').toBeGreaterThan(30);
  }, 120_000);

  it('and nothing else about anybody moves: every other key a person holds is exactly what it was', async () => {
    for (const seed of [3, 11, 29]) {
      const db0 = randomWorld(seed);
      const db1 = applyTheMigration(db0);
      for (const u of db0.users.slice(0, 120)) {
        const a = await holder(db0, u.id);
        const b = await holder(db1, u.id);
        const strip = (x: SessionUser) => (x.permissions ?? []).filter((k) => !(NEW_KEYS as readonly string[]).includes(k)).sort();
        expect(strip(b), `${u.id}`).toEqual(strip(a));
      }
    }
  }, 60_000);
});

describe('the engine fallback: a person with no stored role keeps the box their legacy key opened', () => {
  it('legacyEffectiveKeys gives the nine boxes to the roles that held the old keys, and the commission page to settings.view', () => {
    const admin = legacyEffectiveKeys('COMPANY_ADMIN');
    for (const k of ['settings.jobs', 'settings.messages', 'penalties.rules', 'team.settings', 'offers.rules', 'commission.view', 'commission.manage', 'settings.delivery_fees', 'settings.tracking']) {
      expect(admin, k).toContain(k);
    }
    // NEGATIVE: orders.migrate needs orders.import, which no legacy key carries — so no legacy role gets it.
    for (const r of ['COMPANY_ADMIN', 'MANAGER', 'SUPER_ADMIN'] as const) expect(legacyEffectiveKeys(r)).not.toContain('orders.migrate');
    // NEGATIVE: a role without settings.view / settings.manage gets none of them.
    const agent = legacyEffectiveKeys('CONFIRMATION_AGENT');
    for (const k of NEW_KEYS) expect(agent, k).not.toContain(k);
  });
});
