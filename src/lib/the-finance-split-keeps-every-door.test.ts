import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CASH BOX AND THE STATEMENT APPROVAL GET A BOX EACH — AND NOBODY LOSES A DOOR OR GAINS ONE (perm-plan PR-9).
 *
 * Four keys: finance.cashbox_view · finance.wallets_manage · finance.closing_approve · settlement.approve. Before this
 * change each door asked a wider key (finance.cashbox for the first three, settlement.review for the fourth). The migration
 * 20261030150000_finance_split_keys gives each box to exactly the roles and people who passed that door, and carries every
 * «منع». None of the four has a scope.
 *
 * The owner’s rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
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
import { FINANCE_SPLIT_KEYS_FROM } from './finance-split-keys';
import { ROLE_PERMISSIONS } from '../types/auth';
import type { SessionUser } from '@/types/auth';

const NAME = '20261030150000_finance_split_keys';
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
const GATE = FINANCE_SPLIT_KEYS_FROM.flatMap((r) => r.from.map((src) => ({ newKey: r.key, src })));
const NEW_KEYS = FINANCE_SPLIT_KEYS_FROM.map((r) => r.key);
const SRC_KEYS = [...new Set(GATE.map((g) => g.src))];

describe('the four boxes are in the catalog, each with the screen key it sits behind', () => {
  const REQUIRES: Record<string, string> = {
    'finance.cashbox_view': '',
    'finance.wallets_manage': 'finance.cashbox_view',
    'finance.closing_approve': 'finance.cashbox_view',
    'settlement.approve': 'settlement.view',
  };

  it('are exactly these four, in the list the migration and the engine fallback read', () => {
    expect([...NEW_KEYS].sort()).toEqual(Object.keys(REQUIRES).sort());
    expect(NEW_KEYS).toHaveLength(4);
  });

  it('can all be ticked on «الصلاحيات», with an Arabic and an English label and the key they sit behind', () => {
    for (const k of NEW_KEYS) {
      const item = catalogItem(k);
      expect(item, k).toBeDefined();
      expect(ALL_CATALOG_KEYS.has(k), k).toBe(true);
      expect(item!.requires ?? '', `${k}: مفتاح الشاشة`).toBe(REQUIRES[k]);
      expect(item!.ar.trim().length, k).toBeGreaterThan(8);
      expect(item!.en.trim().length, k).toBeGreaterThan(8);
      expect(item!.scopes, `${k} بلا مدى`).toBeUndefined();
    }
  });

  it('the cash box’s VIEW is the one that opens the three screens, and the action key now sits behind it', () => {
    expect(catalogItem('finance.cashbox_view')!.opens).toEqual(['الإغلاق اليومي', 'المحافظ والحركات', 'التحويلات']);
    expect(catalogItem('finance.cashbox')!.opens).toBeUndefined();
    expect(catalogItem('finance.cashbox')!.requires).toBe('finance.cashbox_view');
  });

  it('NEGATIVE: unticking the cash box’s view takes its three actions with it, so none is left ticked without a screen', () => {
    const held = ['finance.cashbox', 'finance.wallets_manage', 'finance.closing_approve'];
    expect(orphanPairs(held).map((p) => p.action).sort()).toEqual([...held].sort());
    expect(orphanPairs([...held, 'finance.cashbox_view'])).toEqual([]);
  });

  it('settlement.review and settlement.upload are unchanged — the approval is the only door that left the reviewer', () => {
    expect(catalogItem('settlement.review')!.requires).toBe('settlement.view');
    expect(catalogItem('settlement.upload')!.requires).toBe('settlement.view');
    expect(catalogItem('settlement.review')!.opens).toEqual(['المطابقة']);
  });

  it('D12: the expense and the withdrawal stay on finance.create — only the NAME says so', () => {
    const create = catalogItem('finance.create')!;
    expect(create.requires).toBe('finance.view');
    expect(create.ar).toContain('المصروفات');
    expect(create.ar).toContain('سحبها من المحفظة');
    expect(catalogItem('finance.expense_withdraw')).toBeUndefined();
  });

  it('NEGATIVE: finance.cashbox is NOT also sourced from settlement.review, nor settlement.approve from the cash key', () => {
    expect(FINANCE_SPLIT_KEYS_FROM.find((r) => r.key === 'settlement.approve')!.from).toEqual(['settlement.review']);
    for (const k of ['finance.cashbox_view', 'finance.wallets_manage', 'finance.closing_approve']) {
      expect(FINANCE_SPLIT_KEYS_FROM.find((r) => r.key === k)!.from, k).toEqual(['finance.cashbox']);
    }
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
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'fs9-' || gen_random_uuid()::text`);
    }
    for (const s of statements.filter((x) => !x.startsWith('INSERT INTO'))) {
      expect(s.startsWith('DROP TABLE IF EXISTS pg_temp.sp9_') || s.startsWith('CREATE TEMP TABLE sp9_'), s.slice(0, 70)).toBe(true);
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
      expect(reads).toMatch(/sp9_pass/);
    }
    for (const s of statements.filter((x) => x.startsWith('CREATE TEMP TABLE'))) {
      for (const k of NEW_KEYS) {
        // a new key may appear only as the LEFT column of the gate table, never in a snapshot of what people hold
        if (!s.startsWith('CREATE TEMP TABLE sp9_gate')) expect(s, `${k} in ${s.slice(0, 40)}`).not.toContain(`'${k}'`);
      }
    }
  });

  it('the gate table is EXACTLY the one the engine fallback reads (FINANCE_SPLIT_KEYS_FROM)', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp9_gate'))!;
    const rows = [...gate.matchAll(/\('([a-z_.]+)',\s*'([a-z_.]+)'\)/g)].map((m) => ({ newKey: m[1], src: m[2] }));
    const key = (r: { newKey: string; src: string }) => `${r.newKey}<${r.src}`;
    expect(rows.map(key).sort()).toEqual(GATE.map(key).sort());
    expect(rows).toHaveLength(4);
  });

  it('NEGATIVE: it writes nothing for settlement.view — that would hand the statements list and the custody screen to people who do not see them today', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp9_gate'))!;
    expect(gate).not.toContain(`'settlement.view'`);
    expect(gate).not.toContain(`'settlement.upload'`);
    for (const s of statements.filter((x) => x.startsWith('INSERT INTO'))) expect(s).not.toContain('settlement.view');
  });

  it('the snapshot of what people hold reads exactly the source keys of the gate table', () => {
    const holds = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp9_holds'))!);
    expect(holds).toContain('h.k IN (SELECT src FROM sp9_gate)');
    expect(holds).toContain(`up."effect" = 'ALLOW'`);
    expect(holds).toContain(`d."effect" = 'DENY'`);
    expect(holds).toContain(`u."role" <> 'SUPER_ADMIN'`);
    // a person's own «سماح» REPLACES the role's row for the same key — the engine's rule — so the role's is read only without one
    expect(holds).toContain(`a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW'`);
  });

  it('the two statements that decide a person say exactly what the replay does — a flipped condition is caught HERE, since the replay is a copy', () => {
    const deny = flat(statements.find((s) => s.includes(`'DENY'`) && s.startsWith('INSERT INTO'))!);
    // the role receives the box AND the person did not pass THAT door
    expect(deny).toContain('FROM sp9_user_role ur JOIN sp9_role_gets rg ON rg.rid = ur.rid');
    expect(deny).toContain('WHERE NOT EXISTS (SELECT 1 FROM sp9_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)');
    const allow = flat(statements.find((s) => s.includes(`'ALLOW'`) && s.startsWith('INSERT INTO'))!);
    // the person passed AND no role of theirs receives the box
    expect(allow).toContain('FROM sp9_pass p WHERE NOT EXISTS (SELECT 1 FROM sp9_user_role ur JOIN sp9_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key WHERE ur.uid = p.uid)');
    expect(allow).toContain(`'ALLOW', 'ALL_COMPANY', NULL`);
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!)).toContain('FROM sp9_role_gets rg');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!)).toContain('FROM sp9_default_gets dg');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp9_role_gets'))!)).toContain('FROM "role_permissions" rp JOIN sp9_gate g ON g.src = rp."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp9_default_gets'))!)).toContain('FROM "role_permission_defaults" d JOIN sp9_gate g ON g.src = d."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp9_pass'))!)).toContain('FROM sp9_holds h JOIN sp9_gate g ON g.src = h.k');
  });

  it('reads the role the way the engine reads it, and leaves SUPER_ADMIN alone', () => {
    const ur = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp9_user_role'))!;
    expect(ur).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
    expect(ur).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
    expect(ur).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('its rollback removes only what it wrote, in all three places, and its own row in the migrations table', () => {
    const body = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const deletes = body.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'fs9-%'`);
    expect(deletes[3]).toContain(`'${NAME}'`);
    expect(new Set(deletes.slice(0, 3).map((d) => d.match(/FROM "(\w+)"/)![1]))).toEqual(new Set(grantTables));
  });

  it('the tag is its own: no other migration writes ids that start with it', () => {
    const others = [
      '20261027000000_sensitive_settings_own_key', '20261029000000_tracking_returns_view_key', '20261029130000_analytics_view_becomes_reports_view',
      '20261029120000_shortfall_penalty', '20261029150000_settings_split_keys', '20261030120000_ai_assist_key', '20261030130000_order_action_keys',
    ];
    for (const m of others) {
      const text = readFileSync(path.join(process.cwd(), 'prisma', 'migrations', m, 'migration.sql'), 'utf8');
      expect(text, m).not.toContain(`'fs9-'`);
    }
  });

  it('runs after the migration of the previous permission box (#92), so every key it reads is already there', () => {
    expect(NAME > '20261030130000_order_action_keys').toBe(true);
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

/** `sp9_user_role`: (uid, rid) — the engine's own reading of "which role are this person's grants from". */
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

type Skip = 'deny' | 'allow' | 'roles' | 'defaults' | 'denied-sources' | 'own-allow-replaces-role';

/** Statement-for-statement the SQL of migration.sql. */
function applyTheMigration(before: Rows, skip?: Skip): Rows {
  const db = clone(before);

  // ── the snapshot: everything below is read from `before`, never from rows written here ──
  const ur = userRole(before);
  const superIds = new Set(before.users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.id));
  const denied = (uid: string, k: string) => skip !== 'denied-sources' && before.userPerms.some((d) => d.userId === uid && d.permission === k && d.effect === 'DENY');

  // sp9_holds — a person's own «سماح» REPLACES the role's row for the same key
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

  // sp9_pass
  const pass = holds.flatMap((h) => GATE.filter((g) => g.src === h.k).map((g) => ({ uid: h.uid, newKey: g.newKey })));

  // sp9_role_gets / sp9_default_gets
  const gets = (table: Grant[]) => table.flatMap((rp) => GATE.filter((g) => g.src === rp.permission).map((g) => ({ rid: rp.roleId, newKey: g.newKey })));
  const roleGets = gets(before.rolePerms);
  const defaultGets = gets(before.defaults);

  let n = 0;
  const id = () => `fs9-${++n}`;
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
  // 2. «سماح» — the person passed; no role of theirs receives the box.
  for (const p of skip === 'allow' ? [] : pass) {
    const roleReceives = ur.some((x) => x.uid === p.uid && roleGets.some((rg) => rg.rid === x.rid && rg.newKey === p.newKey));
    if (!roleReceives && !hasUserRow(p.uid, p.newKey)) {
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
  return FINANCE_SPLIT_KEYS_FROM.find((r) => r.key === newKey)!.from.some((src) => can(u, src));
}

let nextId = 0;
const role = (name: string, companyId: string | null = null) => ({ id: `r${++nextId}`, companyId, name });

function fixture(): Rows {
  nextId = 0;
  const tAdmin = role('COMPANY_ADMIN'); // system templates
  const tAccountant = role('ACCOUNTANT'); // settlement work, no cash box
  const tOfficer = role('SETTLEMENT_OFFICER');
  const cCashier = role('أمين صندوق', 'c1'); // company roles
  const cReviewer = role('مراجع', 'c1'); // settlement.review WITHOUT settlement.view
  const cViewer = role('قارئ', 'c1'); // settlement.view only
  const cBoth = role('مالي', 'c1'); // the cash key AND the review key
  const cNoBaseline = role('بلا افتراضي', 'c1'); // has the cash key, never issued a baseline
  const cNothing = role('فاضي', 'c1');
  const cViewOnly = role('مشاهد المال', 'c1'); // finance.view only: not a door of this change
  const perms: Array<[typeof tAdmin, string[]]> = [
    [tAdmin, ['finance.view', 'finance.cashbox', 'settlement.view', 'settlement.upload', 'settlement.review']],
    [tAccountant, ['finance.view', 'settlement.view', 'settlement.upload', 'settlement.review']],
    [tOfficer, ['settlement.view', 'settlement.upload']],
    [cCashier, ['finance.cashbox']],
    [cReviewer, ['settlement.review']],
    [cViewer, ['settlement.view']],
    [cBoth, ['finance.cashbox', 'settlement.review', 'settlement.view']],
    [cNoBaseline, ['finance.cashbox']],
    [cViewOnly, ['finance.view']],
  ];
  const rows: Rows = { users: [], roles: [tAdmin, tAccountant, tOfficer, cCashier, cReviewer, cViewer, cBoth, cNoBaseline, cNothing, cViewOnly], rolePerms: [], defaults: [], userPerms: [] };
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
  user('accountant', 'ACCOUNTANT', tAccountant.id);
  user('officer', 'SETTLEMENT_OFFICER', null);
  user('cashier', 'MODERATOR', cCashier.id);
  user('reviewer', 'MODERATOR', cReviewer.id);
  user('viewer', 'MODERATOR', cViewer.id);
  user('both', 'MODERATOR', cBoth.id);
  user('no-baseline', 'MODERATOR', cNoBaseline.id);
  user('nothing', 'MODERATOR', cNothing.id);
  user('view-only', 'MODERATOR', cViewOnly.id);
  user('root', 'SUPER_ADMIN', null);
  user('stranger', 'ROLE_NOBODY_KNOWS', null); // no role id, no template: the fallback, which is empty
  user('fallback-warehouse', 'WAREHOUSE', null); // no template of that name: the in-code fallback
  // ── the same roles, with a personal «منع» / «سماح» on a source key ──
  user('admin-denied-cash', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-cash', 'finance.cashbox', 'DENY'); // still reviews
  user('admin-denied-review', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-review', 'settlement.review', 'DENY'); // still holds the cash
  user('admin-denied-both', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-both', 'finance.cashbox', 'DENY'); ex('admin-denied-both', 'settlement.review', 'DENY');
  user('cashier-denied-cash', 'MODERATOR', cCashier.id); ex('cashier-denied-cash', 'finance.cashbox', 'DENY'); // the role’s ONLY source, refused
  user('reviewer-denied-review', 'MODERATOR', cReviewer.id); ex('reviewer-denied-review', 'settlement.review', 'DENY');
  user('both-denied-cash', 'MODERATOR', cBoth.id); ex('both-denied-cash', 'finance.cashbox', 'DENY');
  user('both-denied-review', 'MODERATOR', cBoth.id); ex('both-denied-review', 'settlement.review', 'DENY');
  user('nothing-allowed-cash', 'MODERATOR', cNothing.id); ex('nothing-allowed-cash', 'finance.cashbox', 'ALLOW');
  user('nothing-allowed-review', 'MODERATOR', cNothing.id); ex('nothing-allowed-review', 'settlement.review', 'ALLOW');
  user('nothing-allowed-both', 'MODERATOR', cNothing.id); ex('nothing-allowed-both', 'finance.cashbox', 'ALLOW'); ex('nothing-allowed-both', 'settlement.review', 'ALLOW');
  user('cashier-allowed-cash', 'MODERATOR', cCashier.id); ex('cashier-allowed-cash', 'finance.cashbox', 'ALLOW'); // redundant: the role has it too
  user('reviewer-allowed-cash', 'MODERATOR', cReviewer.id); ex('reviewer-allowed-cash', 'finance.cashbox', 'ALLOW');
  user('stranger-allowed-cash', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-cash', 'finance.cashbox', 'ALLOW');
  user('stranger-allowed-review', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-review', 'settlement.review', 'ALLOW');
  user('fallback-denied-review', 'SETTLEMENT_OFFICER', null); ex('fallback-denied-review', 'settlement.review', 'DENY');
  // an unrelated exception must not move anything
  user('admin-denied-other', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-other', 'settings.view', 'DENY');
  // someone denied the NEW key already (the owner pre-empted it): the deny stays, nothing re-grants it
  user('cashier-pre-denied-view', 'MODERATOR', cCashier.id); ex('cashier-pre-denied-view', 'finance.cashbox_view', 'DENY');
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
      // A key the owner had ALREADY denied by hand is the one deliberate exception: the migration never re-grants it.
      const preDenied = db0.userPerms.some((p) => p.userId === u.id && p.permission === k && p.effect === 'DENY');
      if (was && !is && !preDenied) lost.push(`${u.id} lost ${k}`);
      if (!was && is) gained.push(`${u.id} gained ${k}`);
      // The screen's own question agrees with the server's.
      expect(userCan(after, k), `${u.id}/${k}: الشاشة والخادم`).toBe(is);
    }
  }
  return { db1, lost, gained };
}

describe('the replay: every person, every door — yesterday against today, through the real engine', () => {
  it('nobody loses a door, nobody gains one (fixture people, 4 boxes each)', async () => {
    const db0 = fixture();
    const { lost, gained } = await everyDoorOfEveryone(db0);
    expect(lost, 'خسروا باباً').toEqual([]);
    expect(gained, 'كسبوا باباً').toEqual([]);
    expect(db0.users.length).toBeGreaterThanOrEqual(30);
  });

  it('the fixture really exercises the cases (a replay that finds nothing would pass for the wrong reason)', async () => {
    const db0 = fixture();
    let passers = 0;
    for (const u of db0.users) for (const k of NEW_KEYS) if (await passedYesterday(db0, u.id, k)) passers++;
    expect(passers, 'من يمر من الأبواب').toBeGreaterThan(40);
    expect(await passedYesterday(db0, 'nothing', 'settlement.approve')).toBe(false);
    const db1 = applyTheMigration(db0);
    const written = (rows: Array<{ id: string }>, before: Array<{ id: string }>) => rows.length - before.length;
    expect(written(db1.userPerms, db0.userPerms)).toBeGreaterThan(10);
    expect(written(db1.rolePerms, db0.rolePerms)).toBeGreaterThan(10);
    expect(written(db1.defaults, db0.defaults)).toBeGreaterThan(8);
    expect(db1.userPerms.filter((p) => p.id.startsWith('fs9-') && p.effect === 'DENY').length).toBeGreaterThan(4);
    expect(db1.userPerms.filter((p) => p.id.startsWith('fs9-') && p.effect === 'ALLOW').length).toBeGreaterThan(6);
  });

  it('each case by name: a box follows the key its door asked, and not another one', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const box = async (uid: string, k: string) => can(await holder(db1, uid), k);
    // the cash key gives the view, the wallets and the closing’s approval — all three — and NOT the statement approval
    for (const k of ['finance.cashbox_view', 'finance.wallets_manage', 'finance.closing_approve']) {
      expect(await box('cashier', k), `cashier/${k}`).toBe(true);
      expect(await box('reviewer', k), `reviewer/${k}`).toBe(false);
      expect(await box('viewer', k), `viewer/${k}`).toBe(false);
    }
    expect(await box('cashier', 'settlement.approve')).toBe(false);
    // the review key gives the approval — and NOT any cash box
    expect(await box('reviewer', 'settlement.approve')).toBe(true);
    expect(await box('accountant', 'settlement.approve')).toBe(true);
    for (const k of ['finance.cashbox_view', 'finance.wallets_manage', 'finance.closing_approve']) {
      expect(await box('accountant', k), `accountant/${k}`).toBe(false);
    }
    // upload/view alone are NOT the approval (the officer uploads and sees; she did not approve yesterday)
    expect(await box('officer', 'settlement.approve')).toBe(false);
    expect(await box('viewer', 'settlement.approve')).toBe(false);
    // the finance view is not a door of this change
    for (const k of NEW_KEYS) expect(await box('view-only', k), `view-only/${k}`).toBe(false);
    for (const k of NEW_KEYS) expect(await box('nothing', k), `nothing/${k}`).toBe(false);
    // both keys: all four
    for (const k of NEW_KEYS) expect(await box('both', k), `both/${k}`).toBe(true);
    // a «منع» on ONE source of two takes only that source’s boxes
    expect(await box('admin-denied-cash', 'finance.wallets_manage')).toBe(false);
    expect(await box('admin-denied-cash', 'finance.closing_approve')).toBe(false);
    expect(await box('admin-denied-cash', 'finance.cashbox_view')).toBe(false);
    expect(await box('admin-denied-cash', 'settlement.approve')).toBe(true);
    expect(await box('admin-denied-review', 'settlement.approve')).toBe(false);
    expect(await box('admin-denied-review', 'finance.wallets_manage')).toBe(true);
    expect(await box('admin-denied-both', 'settlement.approve')).toBe(false);
    expect(await box('admin-denied-both', 'finance.closing_approve')).toBe(false);
    // a «منع» on the role’s ONLY source
    expect(await box('cashier-denied-cash', 'finance.cashbox_view')).toBe(false);
    expect(await box('reviewer-denied-review', 'settlement.approve')).toBe(false);
    expect(await box('both-denied-cash', 'finance.cashbox_view')).toBe(false);
    expect(await box('both-denied-review', 'settlement.approve')).toBe(false);
    expect(await box('both-denied-review', 'finance.cashbox_view')).toBe(true);
    // a «سماح» reaches the box in a role that has none
    expect(await box('nothing-allowed-cash', 'finance.wallets_manage')).toBe(true);
    expect(await box('nothing-allowed-cash', 'settlement.approve')).toBe(false);
    expect(await box('nothing-allowed-review', 'settlement.approve')).toBe(true);
    expect(await box('nothing-allowed-review', 'finance.cashbox_view')).toBe(false);
    expect(await box('nothing-allowed-both', 'finance.closing_approve')).toBe(true);
    expect(await box('reviewer-allowed-cash', 'finance.cashbox_view')).toBe(true);
    expect(await box('stranger-allowed-cash', 'finance.wallets_manage')).toBe(true);
    expect(await box('stranger-allowed-review', 'settlement.approve')).toBe(true);
    // an unrelated exception moved nothing
    expect(await box('admin-denied-other', 'finance.wallets_manage')).toBe(true);
  });

  it('the work keeps working when a box is taken: the owner unticks the wallets’ management and the cash STAYS', async () => {
    const db1 = applyTheMigration(fixture());
    db1.userPerms.push({ id: 'owner-1', userId: 'cashier', permission: 'finance.wallets_manage', effect: 'DENY', scope: null, scopeIds: null });
    const cashier = await holder(db1, 'cashier');
    expect(can(cashier, 'finance.cashbox')).toBe(true);
    expect(can(cashier, 'finance.cashbox_view')).toBe(true);
    expect(can(cashier, 'finance.wallets_manage')).toBe(false);
    expect(can(cashier, 'finance.closing_approve')).toBe(true);
  });

  it('what the owner unticked before is not given back: a «منع» he already put on the new key stays, and so does the role that lost the source', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    expect(can(await holder(db1, 'cashier-pre-denied-view'), 'finance.cashbox_view')).toBe(false);
    expect(can(await holder(db1, 'cashier-pre-denied-view'), 'finance.wallets_manage')).toBe(true);
    // a role that holds no source today receives nothing
    const nothingRole = db0.roles.find((r) => r.name === 'فاضي')!;
    expect(db1.rolePerms.filter((p) => p.roleId === nothingRole.id)).toEqual([]);
    expect(db1.defaults.filter((p) => p.roleId === nothingRole.id)).toEqual([]);
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
    for (const i of added) expect(i).toMatch(/^fs9-/);
    // Nothing that existed before was changed or removed.
    for (const p of db0.userPerms) expect(once.userPerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.rolePerms) expect(once.rolePerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.defaults) expect(once.defaults.find((q) => q.id === p.id)).toEqual(p);
  });

  it('the «إرجاع للافتراضي» baseline carries the boxes, so the first reset after the deploy does not take them away', () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    for (const rule of FINANCE_SPLIT_KEYS_FROM) {
      const withSource = new Set(db0.defaults.filter((d) => rule.from.includes(d.permission)).map((d) => d.roleId));
      const boxed = new Set(db1.defaults.filter((d) => d.permission === rule.key).map((d) => d.roleId));
      expect(boxed, rule.key).toEqual(withSource);
    }
  });

  it('NEGATIVE (the test of the test): a migration with one step removed is CAUGHT — no «منع», no «سماح», no role rows, a source read through a «منع»', async () => {
    const db0 = fixture();
    const count = async (skip: Skip) => {
      const broken = applyTheMigration(db0, skip);
      const found = { lost: 0, gained: 0 };
      for (const u of db0.users) {
        const after = await holder(broken, u.id);
        for (const k of NEW_KEYS) {
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
  const KEYS = [...SRC_KEYS, 'settlement.view', 'settlement.upload', 'finance.view', 'orders.create'];
  const SCOPES: Scope[] = ['ALL_COMPANY', 'OWN', 'ASSIGNED'];
  const rows: Rows = { users: [], roles: [], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  const templateNames = ['COMPANY_ADMIN', 'MANAGER', 'ACCOUNTANT'];
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
      : kind < 0.9 ? { role: pick(['WAREHOUSE', 'COMPANY_ADMIN_X', 'SETTLEMENT_OFFICER']), roleId: null }
      : kind < 0.95 ? { role: 'SUPER_ADMIN', roleId: null }
      : { role: 'MODERATOR', roleId: pick(rows.roles).id };
    rows.users.push({ id: `u${u}`, ...row });
    for (const k of KEYS) {
      const x = rand();
      if (x < 0.12) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'DENY', scope: null, scopeIds: null });
      else if (x < 0.22) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: k, effect: 'ALLOW', scope: pick(SCOPES), scopeIds: null });
    }
    // The owner pre-empted a box here and there: a «منع» on a NEW key that exists before the migration. It is kept.
    if (rand() < 0.05) rows.userPerms.push({ id: `up${++i}`, userId: `u${u}`, permission: pick(NEW_KEYS), effect: 'DENY', scope: null, scopeIds: null });
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
      // The fuzz may hand a person a «منع» on a NEW key before the migration; that is the owner’s own choice and is kept.
      expect(lost, `seed ${seed}`).toEqual([]);
      expect(gained, `seed ${seed}`).toEqual([]);
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
  const fallback = async (role: string, ex: Array<{ permission: string; effect: string }> = []) =>
    computeEffectiveGrants({ id: 'f1', role, roleId: null }, {
      roleRows: async () => [],
      overrideRows: async () => ex.map((e) => ({ ...e, scope: null, scopeIds: null })),
    });

  it('a legacy role gets a box exactly when it held a key the door asked — no more, no less, for every role in the code', async () => {
    const roles = Object.keys(ROLE_PERMISSIONS);
    expect(roles.length).toBeGreaterThan(8);
    let boxes = 0;
    for (const r of roles) {
      const g = (await fallback(r)).grants;
      for (const rule of FINANCE_SPLIT_KEYS_FROM) {
        const was = rule.from.some((src) => g[src] !== undefined);
        expect(g[rule.key] !== undefined, `${r}/${rule.key}`).toBe(was);
        if (was) boxes++;
      }
    }
    expect(boxes, 'a fallback that reaches no role would pass for the wrong reason').toBeGreaterThan(6);
  });

  it('by name: the roles that hold the cash key get its three boxes; the roles that review get the approval; the rest get none', async () => {
    const admin = Object.keys((await fallback('COMPANY_ADMIN')).grants);
    for (const k of NEW_KEYS) expect(admin, k).toContain(k);
    const pending = Object.keys((await fallback('PENDING_USER')).grants);
    for (const k of NEW_KEYS) expect(pending, k).not.toContain(k);
  });

  it('NEGATIVE: a «منع» on the box, or on the key it comes from, wins over the fallback — and the other boxes of the same person stay', async () => {
    expect(Object.keys((await fallback('COMPANY_ADMIN', [{ permission: 'finance.wallets_manage', effect: 'DENY' }])).grants)).not.toContain('finance.wallets_manage');
    const noCash = Object.keys((await fallback('COMPANY_ADMIN', [{ permission: 'finance.cashbox', effect: 'DENY' }])).grants);
    for (const k of ['finance.cashbox_view', 'finance.wallets_manage', 'finance.closing_approve']) expect(noCash, k).not.toContain(k);
    expect(noCash).toContain('settlement.approve');
    const noReview = Object.keys((await fallback('COMPANY_ADMIN', [{ permission: 'settlement.review', effect: 'DENY' }])).grants);
    expect(noReview).not.toContain('settlement.approve');
    expect(noReview).toContain('finance.wallets_manage');
  });

  it('a personal «سماح» on the old key reaches the boxes in the fallback too', async () => {
    const g = (await fallback('WAREHOUSE', [{ permission: 'finance.cashbox', effect: 'ALLOW' }])).grants;
    for (const k of ['finance.cashbox_view', 'finance.wallets_manage', 'finance.closing_approve']) expect(g[k], k).toBeDefined();
    expect(g['settlement.approve']).toBeUndefined();
    const h = (await fallback('WAREHOUSE', [{ permission: 'settlement.review', effect: 'ALLOW' }])).grants;
    expect(h['settlement.approve']).toBeDefined();
    expect(h['finance.cashbox_view']).toBeUndefined();
  });

  it('the parity list (the reset-to-default baseline of a legacy role) carries the boxes for the same roles', () => {
    const admin = legacyEffectiveKeys('COMPANY_ADMIN');
    for (const k of NEW_KEYS) expect(admin, k).toContain(k);
    expect(legacyEffectiveKeys('PENDING_USER')).not.toContain('finance.cashbox_view');
    expect(legacyEffectiveKeys('PENDING_USER')).not.toContain('settlement.approve');
  });
});
