import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CATEGORIES AND THE CAMPAIGNS GET A KEY EACH — AND NOBODY LOSES A DOOR OR GAINS ONE, EXCEPT D1m (perm-plan PR-11).
 *
 * Three keys: categories.manage · campaigns.view · campaigns.manage. Before this change the campaigns' list, their eight writes
 * and the two pulls from the ad platforms all asked `reports.view`, and the categories' writes asked `products.edit` without
 * reading its scope. The migration 20261030180000_categories_campaign_keys gives each box to exactly the roles and people who
 * passed that door — with ONE deliberate narrowing (D1m): categories.manage goes only to whoever holds `products.edit` «كل
 * الشركة», because a scoped editor could rename and delete the whole company's shelves.
 *
 * The owner’s rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 * ⚠️ WHAT THIS FILE IS, SAID PLAINLY. There is no database in CI, so the SQL cannot be run here. Two things are done instead,
 * and neither is the SQL running:
 *   1. the SQL is READ as text — its shape (what it writes, in which order, from which keys) is pinned;
 *   2. the SQL's logic is REPLAYED by `applyTheMigration` below, a statement-for-statement copy over in-memory rows, and the
 *      people it produces are judged by the REAL engine (computeEffectiveGrants + can): for every person and every door,
 *      "could they pass yesterday" must equal "can they pass today" — except the people D1m narrows, who are named.
 * The copy can drift from the SQL; the reviewer's own rehearsal of the SQL inside a rolled-back transaction is the stronger
 * evidence, and the pull request says what was and was not done.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants, can } from './authorization';
import { userCan } from './can';
import { ALL_CATALOG_KEYS, catalogItem, orphanPairs } from './permission-catalog';
import { computeEffectiveGrants, legacyEffectiveKeys, type GrantSource } from './permissions-core';
import { CATEGORIES_CAMPAIGNS_KEYS_FROM } from './categories-campaigns-keys';
import { ALL_ROUTES } from './route-registry';
import { ROLE_PERMISSIONS } from '../types/auth';
import type { SessionUser } from '@/types/auth';

const NAME = '20261030180000_categories_campaign_keys';
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
const GATE = CATEGORIES_CAMPAIGNS_KEYS_FROM.flatMap((r) => r.from.map((src) => ({ newKey: r.key, src, onlyAll: r.allCompanyOnly })));
const NEW_KEYS = CATEGORIES_CAMPAIGNS_KEYS_FROM.map((r) => r.key);
const SRC_KEYS = [...new Set(GATE.map((g) => g.src))];

describe('the three boxes are in the catalog, each with the screen key it sits behind', () => {
  it('are exactly these three, in the list the migration and the engine fallback read', () => {
    expect([...NEW_KEYS].sort()).toEqual(['campaigns.manage', 'campaigns.view', 'categories.manage']);
    expect(NEW_KEYS).toHaveLength(3);
  });

  it('can all be ticked on «الصلاحيات», with an Arabic and an English label', () => {
    for (const k of NEW_KEYS) {
      const item = catalogItem(k);
      expect(item, k).toBeDefined();
      expect(ALL_CATALOG_KEYS.has(k), k).toBe(true);
      expect(item!.ar.trim().length, k).toBeGreaterThan(8);
      expect(item!.en.trim().length, k).toBeGreaterThan(8);
      expect(item!.scopes, `${k} بلا مدى`).toBeUndefined();
    }
  });

  it('the manage key sits behind the view key of its screen; the categories’ behind the products’', () => {
    expect(catalogItem('campaigns.manage')!.requires).toBe('campaigns.view');
    expect(catalogItem('categories.manage')!.requires).toBe('products.view');
    expect(catalogItem('campaigns.view')!.requires).toBeUndefined();
  });

  it('NEGATIVE: unticking the campaigns’ view takes the writes with it, so none is left ticked without its screen', () => {
    expect(orphanPairs(['campaigns.manage']).map((p) => `${p.action}>${p.view}`)).toEqual(['campaigns.manage>campaigns.view']);
    expect(orphanPairs(['campaigns.manage', 'campaigns.view'])).toEqual([]);
    expect(orphanPairs(['categories.manage']).map((p) => `${p.action}>${p.view}`)).toEqual(['categories.manage>products.view']);
  });

  it('the campaigns screen opens on the campaigns’ view, and says so in the key’s own “opens” line', () => {
    const route = ALL_ROUTES.find((r) => r.path === '/growth/campaigns')!;
    expect(route.permissions).toEqual(['campaigns.view']);
    expect(catalogItem('campaigns.view')!.opens).toEqual([route.label]);
    // NEGATIVE: the reports key no longer opens the page, and the page is not open to the write key alone either.
    expect(route.permissions).not.toContain('reports.view');
    expect(route.permissions).not.toContain('campaigns.manage');
  });

  it('categories.view stays: a route still asks it, so it is not retired', () => {
    expect(ALL_CATALOG_KEYS.has('categories.view')).toBe(true);
  });
});

describe('the rule table', () => {
  it('is exactly what the plan says: the sources, and D1m only on the categories', () => {
    expect(CATEGORIES_CAMPAIGNS_KEYS_FROM).toEqual([
      { key: 'categories.manage', from: ['products.edit'], allCompanyOnly: true },
      { key: 'campaigns.view', from: ['reports.view'], allCompanyOnly: false },
      { key: 'campaigns.manage', from: ['reports.view'], allCompanyOnly: false },
    ]);
  });

  it('NEGATIVE: the retired analytics.view is a source of nothing — the migration of 29/10 already gave its holders reports.view', () => {
    for (const r of CATEGORIES_CAMPAIGNS_KEYS_FROM) expect(r.from).not.toContain('analytics.view');
    expect(sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')).not.toContain('analytics.view');
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
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'cc11-' || gen_random_uuid()::text`);
    }
    for (const s of statements.filter((x) => !x.startsWith('INSERT INTO'))) {
      expect(s.startsWith('DROP TABLE IF EXISTS pg_temp.sp11_') || s.startsWith('CREATE TEMP TABLE sp11_'), s.slice(0, 70)).toBe(true);
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
      expect(reads).toMatch(/sp11_pass/);
    }
    for (const s of statements.filter((x) => x.startsWith('CREATE TEMP TABLE'))) {
      for (const k of NEW_KEYS) {
        // a new key may appear only as the LEFT column of the gate table, never in a snapshot of what people hold
        if (!s.startsWith('CREATE TEMP TABLE sp11_gate')) expect(s, `${k} in ${s.slice(0, 40)}`).not.toContain(`'${k}'`);
      }
    }
  });

  it('the gate table is EXACTLY the one the engine fallback reads (CATEGORIES_CAMPAIGNS_KEYS_FROM)', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp11_gate'))!;
    const rows = [...gate.matchAll(/\('([a-z_.]+)',\s*'([a-z_.]+)',\s*(true|false)\)/g)].map((m) => ({ newKey: m[1], src: m[2], onlyAll: m[3] === 'true' }));
    const key = (r: { newKey: string; src: string; onlyAll: boolean }) => `${r.newKey}<${r.src}:${r.onlyAll}`;
    expect(rows.map(key).sort()).toEqual(GATE.map(key).sort());
    expect(rows).toHaveLength(3);
  });

  it('D1m is in the SQL three times — who passed, which roles receive the box, which baselines do — and nowhere else', () => {
    const onlyAll = (name: string) => flat(statements.find((s) => s.startsWith(`CREATE TEMP TABLE ${name}`))!);
    expect(onlyAll('sp11_pass')).toContain(`WHERE NOT g.all_company_only OR h.scope = 'ALL_COMPANY'`);
    expect(onlyAll('sp11_role_gets')).toContain(`WHERE NOT g.all_company_only OR COALESCE(rp."scope", 'ALL_COMPANY') = 'ALL_COMPANY'`);
    expect(onlyAll('sp11_default_gets')).toContain(`WHERE NOT g.all_company_only OR COALESCE(d."scope", 'ALL_COMPANY') = 'ALL_COMPANY'`);
    // the snapshot of what people hold carries the scope, a personal «سماح» replacing the role's row (and its scope)
    const holds = onlyAll('sp11_holds');
    expect(holds).toContain(`COALESCE(up."scope", 'ALL_COMPANY') AS scope`);
    expect(holds).toContain(`COALESCE(rp."scope", 'ALL_COMPANY')`);
    expect(holds).toContain('h.k IN (SELECT src FROM sp11_gate)');
    expect(holds).toContain(`up."effect" = 'ALLOW'`);
    expect(holds).toContain(`d."effect" = 'DENY'`);
    expect(holds).toContain(`u."role" <> 'SUPER_ADMIN'`);
    expect(holds).toContain(`a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW'`);
  });

  it('the statements that decide a person say exactly what the replay does — a flipped condition is caught HERE, since the replay is a copy', () => {
    const deny = flat(statements.find((s) => s.includes(`'DENY'`) && s.startsWith('INSERT INTO'))!);
    expect(deny).toContain('FROM sp11_user_role ur JOIN sp11_role_gets rg ON rg.rid = ur.rid');
    expect(deny).toContain('WHERE NOT EXISTS (SELECT 1 FROM sp11_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)');
    const allow = flat(statements.find((s) => s.includes(`'ALLOW'`) && s.startsWith('INSERT INTO'))!);
    expect(allow).toContain('FROM sp11_pass p WHERE NOT EXISTS (SELECT 1 FROM sp11_user_role ur JOIN sp11_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key WHERE ur.uid = p.uid)');
    expect(allow).toContain(`'ALLOW', 'ALL_COMPANY', NULL`);
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!)).toContain('FROM sp11_role_gets rg');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!)).toContain('FROM sp11_default_gets dg');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp11_role_gets'))!)).toContain('FROM "role_permissions" rp JOIN sp11_gate g ON g.src = rp."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp11_default_gets'))!)).toContain('FROM "role_permission_defaults" d JOIN sp11_gate g ON g.src = d."permission"');
    expect(flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp11_pass'))!)).toContain('FROM sp11_holds h JOIN sp11_gate g ON g.src = h.k');
  });

  it('reads the role the way the engine reads it, and leaves SUPER_ADMIN alone', () => {
    const ur = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp11_user_role'))!;
    expect(ur).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
    expect(ur).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
    expect(ur).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('its rollback removes only what it wrote, in all three places, and its own row in the migrations table', () => {
    const body = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const deletes = body.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'cc11-%'`);
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
      expect(text, m).not.toContain(`'cc11-'`);
    }
  });

  it('runs after the migration that retired analytics.view and after the previous permission boxes, so every key it reads is final', () => {
    expect(NAME > '20261029130000_analytics_view_becomes_reports_view').toBe(true);
    expect(NAME > '20261030150000_finance_split_keys').toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE REPLAY — the SQL's statements, one by one, over in-memory rows.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Scope = 'ALL_COMPANY' | 'OWN' | 'ASSIGNED' | 'CATEGORY' | 'SPECIFIC';
interface Grant { id: string; roleId: string; permission: string; scope: string; scopeIds: unknown[] | null }
interface Rows {
  users: Array<{ id: string; role: string; roleId: string | null }>;
  roles: Array<{ id: string; companyId: string | null; name: string }>;
  rolePerms: Grant[];
  defaults: Grant[];
  userPerms: Array<{ id: string; userId: string; permission: string; effect: 'ALLOW' | 'DENY'; scope: string | null; scopeIds: unknown[] | null }>;
}

const clone = (r: Rows): Rows => JSON.parse(JSON.stringify(r)) as Rows;

/** `sp11_user_role`: (uid, rid) — the engine's own reading of "which role are this person's grants from". */
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

type Skip = 'deny' | 'allow' | 'roles' | 'defaults' | 'denied-sources' | 'own-allow-replaces-role' | 'company-wide-only';

/** Statement-for-statement the SQL of migration.sql. */
function applyTheMigration(before: Rows, skip?: Skip): Rows {
  const db = clone(before);
  const wide = (onlyAll: boolean, scope: string) => skip === 'company-wide-only' || !onlyAll || scope === 'ALL_COMPANY';

  // ── the snapshot: everything below is read from `before`, never from rows written here ──
  const ur = userRole(before);
  const superIds = new Set(before.users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.id));
  const denied = (uid: string, k: string) => skip !== 'denied-sources' && before.userPerms.some((d) => d.userId === uid && d.permission === k && d.effect === 'DENY');

  // sp11_holds — a person's own «سماح» REPLACES the role's row for the same key, and its scope with it
  const holds: Array<{ uid: string; k: string; scope: string }> = [];
  for (const up of before.userPerms) {
    if (up.effect === 'ALLOW' && !superIds.has(up.userId) && SRC_KEYS.includes(up.permission) && !denied(up.userId, up.permission)) {
      holds.push({ uid: up.userId, k: up.permission, scope: up.scope ?? 'ALL_COMPANY' });
    }
  }
  for (const x of ur) {
    for (const rp of before.rolePerms) {
      if (rp.roleId !== x.rid || !SRC_KEYS.includes(rp.permission)) continue;
      if (skip !== 'own-allow-replaces-role' && before.userPerms.some((a) => a.userId === x.uid && a.permission === rp.permission && a.effect === 'ALLOW')) continue;
      if (denied(x.uid, rp.permission)) continue;
      holds.push({ uid: x.uid, k: rp.permission, scope: rp.scope ?? 'ALL_COMPANY' });
    }
  }

  // sp11_pass
  const pass = holds.flatMap((h) => GATE.filter((g) => g.src === h.k && wide(g.onlyAll, h.scope)).map((g) => ({ uid: h.uid, newKey: g.newKey })));

  // sp11_role_gets / sp11_default_gets
  const gets = (table: Grant[]) =>
    table.flatMap((rp) => GATE.filter((g) => g.src === rp.permission && wide(g.onlyAll, rp.scope ?? 'ALL_COMPANY')).map((g) => ({ rid: rp.roleId, newKey: g.newKey })));
  const roleGets = gets(before.rolePerms);
  const defaultGets = gets(before.defaults);

  let n = 0;
  const id = () => `cc11-${++n}`;
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

/** The scope at which the REAL engine says this person holds `products.edit` today (null = not at all). */
async function editScope(db: Rows, uid: string): Promise<string | null> {
  const row = db.users.find((u) => u.id === uid)!;
  const g = await computeEffectiveGrants({ id: row.id, role: row.role, roleId: row.roleId }, sourceOf(db));
  if (g.fullAccess) return 'ALL_COMPANY';
  return g.grants['products.edit']?.scope ?? null;
}

/** The door's OLD rule, asked of the old rows through the real engine: ANY of the keys it asked, at ANY scope. */
async function passedYesterday(db0: Rows, uid: string, newKey: string): Promise<boolean> {
  const u = await holder(db0, uid);
  return CATEGORIES_CAMPAIGNS_KEYS_FROM.find((r) => r.key === newKey)!.from.some((src) => can(u, src));
}

/** What the new rule says should be true today: yesterday’s answer, narrowed by D1m for the categories only. */
async function shouldPassToday(db0: Rows, uid: string, newKey: string): Promise<boolean> {
  const was = await passedYesterday(db0, uid, newKey);
  if (!was) return false;
  const rule = CATEGORIES_CAMPAIGNS_KEYS_FROM.find((r) => r.key === newKey)!;
  return !rule.allCompanyOnly || (await editScope(db0, uid)) === 'ALL_COMPANY';
}

let nextId = 0;
const role = (name: string, companyId: string | null = null) => ({ id: `r${++nextId}`, companyId, name });

function fixture(): Rows {
  nextId = 0;
  const tAdmin = role('COMPANY_ADMIN'); // system templates
  const tManager = role('MANAGER'); // reads reports, edits products company-wide
  const tModerator = role('MODERATOR'); // products edited for CERTAIN categories only
  const cEditor = role('محرر', 'c1'); // company roles
  const cScopedCat = role('محرر تصنيفات', 'c1'); // products.edit for certain categories
  const cScopedProd = role('محرر منتجات', 'c1'); // products.edit for certain products
  const cReporter = role('تقارير', 'c1'); // reports.view only
  const cBoth = role('محرر وتقارير', 'c1'); // both sources
  const cNoBaseline = role('بلا افتراضي', 'c1'); // both, never issued a baseline
  const cNothing = role('فاضي', 'c1');
  const cViewOnly = role('مشاهد', 'c1'); // products.view only: not a door of this change
  const A = 'ALL_COMPANY';
  const perms: Array<[typeof tAdmin, Array<[string, string]>]> = [
    [tAdmin, [['products.view', A], ['products.edit', A], ['reports.view', A]]],
    [tManager, [['products.view', A], ['products.edit', A], ['reports.view', A]]],
    [tModerator, [['products.view', 'CATEGORY'], ['products.edit', 'CATEGORY']]],
    [cEditor, [['products.view', A], ['products.edit', A]]],
    [cScopedCat, [['products.view', 'CATEGORY'], ['products.edit', 'CATEGORY']]],
    [cScopedProd, [['products.view', 'SPECIFIC'], ['products.edit', 'SPECIFIC']]],
    [cReporter, [['reports.view', A]]],
    [cBoth, [['products.view', A], ['products.edit', A], ['reports.view', A]]],
    [cNoBaseline, [['products.view', A], ['products.edit', A], ['reports.view', A]]],
    [cViewOnly, [['products.view', A]]],
  ];
  const rows: Rows = {
    users: [],
    roles: [tAdmin, tManager, tModerator, cEditor, cScopedCat, cScopedProd, cReporter, cBoth, cNoBaseline, cNothing, cViewOnly],
    rolePerms: [], defaults: [], userPerms: [],
  };
  let i = 0;
  for (const [r, keys] of perms) {
    for (const [permission, scope] of keys) {
      rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission, scope, scopeIds: scope === A ? null : ['x'] });
      if (r.id !== cNoBaseline.id) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission, scope, scopeIds: scope === A ? null : ['x'] });
    }
  }
  const user = (id: string, roleName: string, roleId: string | null) => rows.users.push({ id, role: roleName, roleId });
  const ex = (userId: string, permission: string, effect: 'ALLOW' | 'DENY', scope: string | null = effect === 'ALLOW' ? A : null) =>
    rows.userPerms.push({ id: `up${++i}`, userId, permission, effect, scope, scopeIds: scope && scope !== A ? ['x'] : null });

  user('admin', 'COMPANY_ADMIN', tAdmin.id);
  user('admin-no-role-id', 'COMPANY_ADMIN', null); // reads the template named like the role
  user('manager', 'MANAGER', null);
  user('moderator', 'MODERATOR', null); // category-scoped editor by template
  user('editor', 'MODERATOR', cEditor.id);
  user('scoped-cat', 'MODERATOR', cScopedCat.id);
  user('scoped-prod', 'MODERATOR', cScopedProd.id);
  user('reporter', 'MODERATOR', cReporter.id);
  user('both', 'MODERATOR', cBoth.id);
  user('no-baseline', 'MODERATOR', cNoBaseline.id);
  user('nothing', 'MODERATOR', cNothing.id);
  user('view-only', 'MODERATOR', cViewOnly.id);
  user('root', 'SUPER_ADMIN', null);
  user('stranger', 'ROLE_NOBODY_KNOWS', null); // no role id, no template: the fallback, which is empty
  user('fallback-warehouse', 'WAREHOUSE', null); // no template of that name: the in-code fallback
  // ── the same roles, with a personal «منع» / «سماح» on a source key ──
  user('admin-denied-edit', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-edit', 'products.edit', 'DENY'); // still reports
  user('admin-denied-reports', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-reports', 'reports.view', 'DENY'); // still edits
  user('admin-denied-both', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-both', 'products.edit', 'DENY'); ex('admin-denied-both', 'reports.view', 'DENY');
  user('editor-denied-edit', 'MODERATOR', cEditor.id); ex('editor-denied-edit', 'products.edit', 'DENY'); // the role’s ONLY source, refused
  user('reporter-denied-reports', 'MODERATOR', cReporter.id); ex('reporter-denied-reports', 'reports.view', 'DENY');
  user('both-denied-edit', 'MODERATOR', cBoth.id); ex('both-denied-edit', 'products.edit', 'DENY');
  user('both-denied-reports', 'MODERATOR', cBoth.id); ex('both-denied-reports', 'reports.view', 'DENY');
  user('nothing-allowed-edit', 'MODERATOR', cNothing.id); ex('nothing-allowed-edit', 'products.edit', 'ALLOW'); // company-wide «سماح»
  user('nothing-allowed-edit-cat', 'MODERATOR', cNothing.id); ex('nothing-allowed-edit-cat', 'products.edit', 'ALLOW', 'CATEGORY'); // D1m
  user('nothing-allowed-edit-prod', 'MODERATOR', cNothing.id); ex('nothing-allowed-edit-prod', 'products.edit', 'ALLOW', 'SPECIFIC'); // D1m
  user('nothing-allowed-reports', 'MODERATOR', cNothing.id); ex('nothing-allowed-reports', 'reports.view', 'ALLOW');
  user('nothing-allowed-both', 'MODERATOR', cNothing.id); ex('nothing-allowed-both', 'products.edit', 'ALLOW'); ex('nothing-allowed-both', 'reports.view', 'ALLOW');
  // the personal «سماح» REPLACES the role's row, and its scope with it:
  user('editor-narrowed-to-cat', 'MODERATOR', cEditor.id); ex('editor-narrowed-to-cat', 'products.edit', 'ALLOW', 'CATEGORY'); // role wide, own narrow: D1m
  user('scoped-widened', 'MODERATOR', cScopedCat.id); ex('scoped-widened', 'products.edit', 'ALLOW', A); // role narrow, own wide: passes
  user('editor-allowed-wide', 'MODERATOR', cEditor.id); ex('editor-allowed-wide', 'products.edit', 'ALLOW', A); // redundant
  user('stranger-allowed-edit', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-edit', 'products.edit', 'ALLOW');
  user('stranger-allowed-reports', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-reports', 'reports.view', 'ALLOW');
  user('stranger-allowed-edit-cat', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-edit-cat', 'products.edit', 'ALLOW', 'CATEGORY');
  // an unrelated exception must not move anything
  user('admin-denied-other', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-other', 'settings.view', 'DENY');
  // someone denied the NEW key already (the owner pre-empted it): the deny stays, nothing re-grants it
  user('editor-pre-denied-manage', 'MODERATOR', cEditor.id); ex('editor-pre-denied-manage', 'categories.manage', 'DENY');
  return rows;
}

async function everyDoorOfEveryone(db0: Rows) {
  const db1 = applyTheMigration(db0);
  const lost: string[] = [];
  const gained: string[] = [];
  const narrowed: string[] = [];
  for (const u of db0.users) {
    const after = await holder(db1, u.id);
    for (const k of NEW_KEYS) {
      const was = await passedYesterday(db0, u.id, k);
      const expected = await shouldPassToday(db0, u.id, k);
      const is = can(after, k);
      // A key the owner had ALREADY denied by hand is the one deliberate exception: the migration never re-grants it.
      const preDenied = db0.userPerms.some((p) => p.userId === u.id && p.permission === k && p.effect === 'DENY');
      if (expected && !is && !preDenied) lost.push(`${u.id} lost ${k}`);
      if (!expected && is) gained.push(`${u.id} gained ${k}`);
      if (was && !expected) narrowed.push(`${u.id} ${k}`);
      // The screen's own question agrees with the server's.
      expect(userCan(after, k), `${u.id}/${k}: الشاشة والخادم`).toBe(is);
    }
  }
  return { db1, lost, gained, narrowed };
}

describe('the replay: every person, every door — yesterday against today, through the real engine', () => {
  it('nobody loses a door, nobody gains one — the only people who lose anything are D1m’s, and they are named', async () => {
    const db0 = fixture();
    const { lost, gained, narrowed } = await everyDoorOfEveryone(db0);
    expect(lost, 'خسروا باباً').toEqual([]);
    expect(gained, 'كسبوا باباً').toEqual([]);
    // D1m: exactly the product editors who are not «كل الشركة», and only on the categories’ box.
    expect(narrowed.sort()).toEqual([
      'editor-narrowed-to-cat categories.manage',
      'moderator categories.manage',
      'nothing-allowed-edit-cat categories.manage',
      'nothing-allowed-edit-prod categories.manage',
      'scoped-cat categories.manage',
      'scoped-prod categories.manage',
      'stranger-allowed-edit-cat categories.manage',
    ]);
    expect(db0.users.length).toBeGreaterThanOrEqual(30);
  });

  it('the fixture really exercises the cases (a replay that finds nothing would pass for the wrong reason)', async () => {
    const db0 = fixture();
    let passers = 0;
    for (const u of db0.users) for (const k of NEW_KEYS) if (await passedYesterday(db0, u.id, k)) passers++;
    expect(passers, 'من يمر من الأبواب').toBeGreaterThan(40);
    expect(await passedYesterday(db0, 'nothing', 'campaigns.manage')).toBe(false);
    const db1 = applyTheMigration(db0);
    const written = (rows: Array<{ id: string }>, before: Array<{ id: string }>) => rows.length - before.length;
    expect(written(db1.userPerms, db0.userPerms)).toBeGreaterThan(8);
    expect(written(db1.rolePerms, db0.rolePerms)).toBeGreaterThan(10);
    expect(written(db1.defaults, db0.defaults)).toBeGreaterThan(8);
    expect(db1.userPerms.filter((p) => p.id.startsWith('cc11-') && p.effect === 'DENY').length).toBeGreaterThan(4);
    expect(db1.userPerms.filter((p) => p.id.startsWith('cc11-') && p.effect === 'ALLOW').length).toBeGreaterThan(4);
  });

  it('each case by name: a box follows the key its door asked, and not another one', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const box = async (uid: string, k: string) => can(await holder(db1, uid), k);
    // reports.view gives the campaigns’ two boxes — and NOT the shelves
    for (const k of ['campaigns.view', 'campaigns.manage']) {
      expect(await box('reporter', k), `reporter/${k}`).toBe(true);
      expect(await box('manager', k), `manager/${k}`).toBe(true);
      expect(await box('editor', k), `editor/${k}`).toBe(false);
      expect(await box('view-only', k), `view-only/${k}`).toBe(false);
      expect(await box('nothing', k), `nothing/${k}`).toBe(false);
    }
    expect(await box('reporter', 'categories.manage')).toBe(false);
    // a company-wide product edit gives the shelves — and NOT the campaigns
    expect(await box('editor', 'categories.manage')).toBe(true);
    expect(await box('admin', 'categories.manage')).toBe(true);
    expect(await box('manager', 'categories.manage')).toBe(true);
    // D1m: a narrower edit does not
    expect(await box('moderator', 'categories.manage')).toBe(false);
    expect(await box('scoped-cat', 'categories.manage')).toBe(false);
    expect(await box('scoped-prod', 'categories.manage')).toBe(false);
    // …and that is ALL it loses: the product edit itself is untouched
    expect(can(await holder(db1, 'scoped-cat'), 'products.edit')).toBe(true);
    expect(can(await holder(db1, 'moderator'), 'products.edit')).toBe(true);
    // both sources: all three
    for (const k of NEW_KEYS) expect(await box('both', k), `both/${k}`).toBe(true);
    // a «منع» on ONE source of two takes only that source’s boxes
    expect(await box('admin-denied-edit', 'categories.manage')).toBe(false);
    expect(await box('admin-denied-edit', 'campaigns.manage')).toBe(true);
    expect(await box('admin-denied-reports', 'campaigns.view')).toBe(false);
    expect(await box('admin-denied-reports', 'campaigns.manage')).toBe(false);
    expect(await box('admin-denied-reports', 'categories.manage')).toBe(true);
    for (const k of NEW_KEYS) expect(await box('admin-denied-both', k), `admin-denied-both/${k}`).toBe(false);
    // a «منع» on the role’s ONLY source
    expect(await box('editor-denied-edit', 'categories.manage')).toBe(false);
    expect(await box('reporter-denied-reports', 'campaigns.view')).toBe(false);
    expect(await box('both-denied-edit', 'categories.manage')).toBe(false);
    expect(await box('both-denied-edit', 'campaigns.manage')).toBe(true);
    expect(await box('both-denied-reports', 'campaigns.manage')).toBe(false);
    expect(await box('both-denied-reports', 'categories.manage')).toBe(true);
    // a «سماح» reaches the box in a role that has none — and a COMPANY-WIDE one only
    expect(await box('nothing-allowed-edit', 'categories.manage')).toBe(true);
    expect(await box('nothing-allowed-edit', 'campaigns.manage')).toBe(false);
    expect(await box('nothing-allowed-edit-cat', 'categories.manage')).toBe(false);
    expect(await box('nothing-allowed-edit-prod', 'categories.manage')).toBe(false);
    expect(await box('nothing-allowed-reports', 'campaigns.view')).toBe(true);
    expect(await box('nothing-allowed-reports', 'categories.manage')).toBe(false);
    expect(await box('nothing-allowed-both', 'campaigns.manage')).toBe(true);
    expect(await box('stranger-allowed-edit', 'categories.manage')).toBe(true);
    expect(await box('stranger-allowed-reports', 'campaigns.manage')).toBe(true);
    expect(await box('stranger-allowed-edit-cat', 'categories.manage')).toBe(false);
    // the personal «سماح» replaces the role's row, and its scope with it
    expect(await box('editor-narrowed-to-cat', 'categories.manage')).toBe(false);
    expect(await box('scoped-widened', 'categories.manage')).toBe(true);
    expect(await box('editor-allowed-wide', 'categories.manage')).toBe(true);
    // an unrelated exception moved nothing
    expect(await box('admin-denied-other', 'campaigns.manage')).toBe(true);
  });

  it('the work keeps working when a box is taken: the owner unticks the writes and the VIEW stays — and the reports board stays too', async () => {
    const db1 = applyTheMigration(fixture());
    db1.userPerms.push({ id: 'owner-1', userId: 'manager', permission: 'campaigns.manage', effect: 'DENY', scope: null, scopeIds: null });
    const manager = await holder(db1, 'manager');
    expect(can(manager, 'campaigns.view')).toBe(true);
    expect(can(manager, 'campaigns.manage')).toBe(false);
    expect(can(manager, 'reports.view')).toBe(true);
    expect(can(manager, 'categories.manage')).toBe(true);
  });

  it('what the owner unticked before is not given back: a «منع» he already put on the new key stays, and so does the role that lost the source', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    expect(can(await holder(db1, 'editor-pre-denied-manage'), 'categories.manage')).toBe(false);
    // a role that holds no source today receives nothing
    const nothingRole = db0.roles.find((r) => r.name === 'فاضي')!;
    expect(db1.rolePerms.filter((p) => p.roleId === nothingRole.id)).toEqual([]);
    expect(db1.defaults.filter((p) => p.roleId === nothingRole.id)).toEqual([]);
    // and the narrower roles got no shelves row, in the role or in its baseline
    for (const name of ['محرر تصنيفات', 'محرر منتجات', 'MODERATOR']) {
      const r = db0.roles.find((x) => x.name === name)!;
      expect(db1.rolePerms.filter((p) => p.roleId === r.id && p.permission === 'categories.manage'), name).toEqual([]);
      expect(db1.defaults.filter((p) => p.roleId === r.id && p.permission === 'categories.manage'), name).toEqual([]);
    }
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
    expect(added.length).toBeGreaterThan(30);
    for (const i of added) expect(i).toMatch(/^cc11-/);
    // Nothing that existed before was changed or removed.
    for (const p of db0.userPerms) expect(once.userPerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.rolePerms) expect(once.rolePerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.defaults) expect(once.defaults.find((q) => q.id === p.id)).toEqual(p);
  });

  it('the «إرجاع للافتراضي» baseline carries the boxes (company-wide only for the shelves), so the first reset after the deploy does not take them away', () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    for (const rule of CATEGORIES_CAMPAIGNS_KEYS_FROM) {
      const withSource = new Set(
        db0.defaults.filter((d) => rule.from.includes(d.permission) && (!rule.allCompanyOnly || d.scope === 'ALL_COMPANY')).map((d) => d.roleId)
      );
      const boxed = new Set(db1.defaults.filter((d) => d.permission === rule.key).map((d) => d.roleId));
      expect(boxed, rule.key).toEqual(withSource);
    }
  });

  it('NEGATIVE (the test of the test): a migration with one step removed is CAUGHT — no «منع», no «سماح», no role rows, a source read through a «منع», a scope forgotten', async () => {
    const db0 = fixture();
    const count = async (skip: Skip) => {
      const broken = applyTheMigration(db0, skip);
      const found = { lost: 0, gained: 0 };
      for (const u of db0.users) {
        const after = await holder(broken, u.id);
        for (const k of NEW_KEYS) {
          const expected = await shouldPassToday(db0, u.id, k);
          const is = can(after, k);
          if (expected && !is) found.lost++;
          if (!expected && is) found.gained++;
        }
      }
      return found;
    };
    expect((await count('deny')).gained, 'بلا «منع» يُمنح المفتاح بلا باب').toBeGreaterThan(0);
    expect((await count('allow')).lost, 'بلا «سماح» يخسر صاحب الاستثناء').toBeGreaterThan(0);
    expect((await count('roles')).lost, 'بلا صفوف الأدوار يخسر الجميع').toBeGreaterThan(0);
    expect((await count('denied-sources')).gained, 'إن نسي أنّ «المنع» يُسقط المصدر').toBeGreaterThan(0);
    expect((await count('company-wide-only')).gained, 'إن نسي D1m يربح المحرر المقيّد أبواب الشركة كلها').toBeGreaterThan(0);
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
  const KEYS = [...SRC_KEYS, 'products.view', 'orders.create'];
  const SCOPES: Scope[] = ['ALL_COMPANY', 'ALL_COMPANY', 'CATEGORY', 'SPECIFIC', 'OWN'];
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

describe('a seeded fuzz: 40 random companies, 200 people each — nobody loses a door, nobody gains one, beyond D1m', () => {
  it('holds for every seed', async () => {
    let people = 0;
    let withRows = 0;
    let narrowedPeople = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const db0 = randomWorld(seed);
      const { db1, lost, gained, narrowed } = await everyDoorOfEveryone(db0);
      expect(lost, `seed ${seed}`).toEqual([]);
      expect(gained, `seed ${seed}`).toEqual([]);
      // D1m narrows the shelves’ box and nothing else
      for (const n of narrowed) expect(n.endsWith(' categories.manage'), `seed ${seed}: ${n}`).toBe(true);
      narrowedPeople += narrowed.length;
      people += db0.users.length;
      if (db1.userPerms.length > db0.userPerms.length) withRows++;
    }
    expect(people).toBe(8000);
    expect(withRows, 'the fuzz must make the migration write exceptions').toBeGreaterThan(30);
    expect(narrowedPeople, 'the fuzz must reach D1m').toBeGreaterThan(50);
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
      overrideRows: async () => ex.map((e) => ({ scope: null, scopeIds: null, ...e })),
    });

  it('a legacy role gets a box exactly when it held a key the door asked — no more, no less, for every role in the code', async () => {
    const roles = Object.keys(ROLE_PERMISSIONS);
    expect(roles.length).toBeGreaterThan(8);
    let boxes = 0;
    for (const r of roles) {
      const g = (await fallback(r)).grants;
      for (const rule of CATEGORIES_CAMPAIGNS_KEYS_FROM) {
        const was = rule.from.some((src) => g[src] !== undefined);
        expect(g[rule.key] !== undefined, `${r}/${rule.key}`).toBe(was);
        if (was) boxes++;
      }
    }
    expect(boxes, 'a fallback that reaches no role would pass for the wrong reason').toBeGreaterThan(6);
  });

  it('by name: a legacy role that holds the reports key gets both campaign boxes; one that holds nothing gets none', async () => {
    const admin = Object.keys((await fallback('COMPANY_ADMIN')).grants);
    expect(admin).toContain('campaigns.view');
    expect(admin).toContain('campaigns.manage');
    // The in-code fallback holds the OLD names (products.update, products.manage): it never held the literal key products.edit,
    // so no legacy role passed the shelves’ door yesterday and none gets the box today — nobody gained, nobody lost.
    expect(admin).not.toContain('products.edit');
    expect(admin).not.toContain('categories.manage');
    const pending = Object.keys((await fallback('PENDING_USER')).grants);
    for (const k of NEW_KEYS) expect(pending, k).not.toContain(k);
  });

  it('NEGATIVE: a «منع» on the box, or on the key it comes from, wins over the fallback — and the other boxes of the same person stay', async () => {
    expect(Object.keys((await fallback('COMPANY_ADMIN', [{ permission: 'campaigns.manage', effect: 'DENY' }])).grants)).not.toContain('campaigns.manage');
    const noReports = Object.keys((await fallback('COMPANY_ADMIN', [{ permission: 'reports.view', effect: 'DENY' }])).grants);
    expect(noReports).not.toContain('campaigns.view');
    expect(noReports).not.toContain('campaigns.manage');
    // a person holding both sources by «سماح», denied only the product edit: keeps the campaigns, loses the shelves
    const noEdit = Object.keys((await fallback('COMPANY_ADMIN', [{ permission: 'products.edit', effect: 'DENY' }, { permission: 'categories.manage', effect: 'DENY' }])).grants);
    expect(noEdit).not.toContain('categories.manage');
    expect(noEdit).toContain('campaigns.manage');
    const denyBoxOnly = (await fallback('WAREHOUSE', [{ permission: 'products.edit', effect: 'ALLOW', scope: 'ALL_COMPANY' }, { permission: 'categories.manage', effect: 'DENY' }])).grants;
    expect(denyBoxOnly['categories.manage'], 'a «منع» on the box wins').toBeUndefined();
    expect(denyBoxOnly['products.edit']).toBeDefined();
  });

  it('a personal «سماح» on the old key reaches the boxes in the fallback too — the shelves only when it is company-wide (D1m)', async () => {
    const g = (await fallback('WAREHOUSE', [{ permission: 'reports.view', effect: 'ALLOW' }])).grants;
    expect(g['campaigns.view']).toBeDefined();
    expect(g['campaigns.manage']).toBeDefined();
    expect(g['categories.manage']).toBeUndefined();
    const wide = (await fallback('WAREHOUSE', [{ permission: 'products.edit', effect: 'ALLOW', scope: 'ALL_COMPANY' }])).grants;
    expect(wide['categories.manage']).toBeDefined();
    expect(wide['campaigns.manage']).toBeUndefined();
    const narrow = (await fallback('WAREHOUSE', [{ permission: 'products.edit', effect: 'ALLOW', scope: 'CATEGORY' }])).grants;
    expect(narrow['categories.manage'], 'D1m: a category-scoped edit gives no shelves').toBeUndefined();
    expect(narrow['products.edit']).toBeDefined();
  });

  it('the parity list (the reset-to-default baseline of a legacy role) carries the boxes for the same roles', () => {
    const admin = legacyEffectiveKeys('COMPANY_ADMIN');
    for (const k of NEW_KEYS) expect(admin, k).toContain(k);
    expect(legacyEffectiveKeys('PENDING_USER')).not.toContain('campaigns.view');
    expect(legacyEffectiveKeys('PENDING_USER')).not.toContain('categories.manage');
  });
});
