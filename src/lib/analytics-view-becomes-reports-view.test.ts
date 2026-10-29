import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «عرض التحليلات» (analytics.view) IS RETIRED — PR-3, THE REST OF IT.
 *
 * The owner's rule, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 * `LEGACY_ALIAS` made «عرض التحليلات» and «عرض التقارير» one door with two
 * names. Now the dashboard's two doors ask `dashboard.view`, every report,
 * board and growth door asks `reports.view` alone, and the performance board
 * has its own answer (`/api/analytics/performance`). The migration
 * 20261029130000_analytics_view_becomes_reports_view makes sure NOBODY LOSES A
 * DOOR on the day.
 *
 * ⚠️ There is no database in CI, so the migration is read here as TEXT, and its
 * RULES are replayed over fixture people by `migrate()` below — a row-by-row
 * mirror of the four statements, run through the REAL engine
 * (`computeEffectiveGrants`) before and after. The text checks tie the SQL to
 * the mirror; the mirror proves the rules. Neither is the SQL RUNNING, and the
 * pull request says so: the stronger evidence is the same fixture run against a
 * scratch database inside a rolled-back transaction, which this change did not
 * do (the builder may not touch a database).
 */

vi.mock('@/lib/db', () => ({ db: {} }));
const { requireAuth, requireContext, answer } = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireContext: vi.fn(),
  answer: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ requireAuth: (...a: unknown[]) => requireAuth(...a) }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/analytics-answer', () => ({ answerAnalytics: (...a: unknown[]) => answer(...a) }));

import { attachGrants, can } from './authorization';
import { ALL_CATALOG_KEYS, RETIRED_KEYS } from './permission-catalog';
import { LEGACY_ALIAS } from './permission-aliases';
import { computeEffectiveGrants, type GrantSource } from './permissions-core';
import { stripComments } from './guard-source';
import type { SessionUser } from '@/types/auth';

import { GET as dashboardApi } from '@/app/api/analytics/route';
import { GET as performanceApi } from '@/app/api/analytics/performance/route';

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const code = (p: string) => stripComments(read(p));

/* ─────────────────────────────  the doors  ───────────────────────────── */

const person = (keys: string[]): SessionUser =>
  attachGrants(
    { id: 'u1', name: 'x', email: 'x@x', role: 'MANAGER', status: 'ACTIVE', companyId: 'c1', permissions: keys } as unknown as SessionUser,
    { fullAccess: false, grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])) } as never,
  );

const asking = (keys: string[]) => {
  const user = person(keys);
  requireAuth.mockResolvedValue(user);
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });
};

describe('the two answers, each at its own door', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    answer.mockResolvedValue(Response.json({ ok: true }));
  });
  const ask = (get: (r: Request) => Promise<Response>) => get(new Request('http://x/api/analytics'));

  it('the dashboard answers «عرض لوحة التحكم» and nothing else', async () => {
    asking(['dashboard.view']);
    expect((await ask(dashboardApi)).status).toBe(200);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: «عرض التقارير» alone no longer opens the dashboard’s API, and the retired key opens nothing', async () => {
    for (const keys of [['reports.view'], ['analytics.view'], ['reports.view', 'analytics.view'], []]) {
      asking(keys);
      expect((await ask(dashboardApi)).status, keys.join(',')).toBe(403);
    }
    expect(answer).not.toHaveBeenCalled();
  });

  it('the performance board answers «عرض التقارير» — a bookkeeper with no dashboard reads it', async () => {
    asking(['reports.view']);
    expect((await ask(performanceApi)).status).toBe(200);
    expect(answer).toHaveBeenCalledTimes(1);
    // …through the SAME builder as the dashboard, with its own rate window
    expect(answer.mock.calls[0][2]).toBe('analytics-performance');
  });

  it('NEGATIVE: the dashboard key alone does not open the board’s API, and neither does the retired key', async () => {
    for (const keys of [['dashboard.view'], ['analytics.view'], []]) {
      asking(keys);
      expect((await ask(performanceApi)).status, keys.join(',')).toBe(403);
    }
    expect(answer).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the engine no longer reads «reports.view» as «analytics.view», nor the reverse', () => {
    expect(LEGACY_ALIAS['analytics.view']).toBeUndefined();
    expect(can(person(['reports.view']), 'analytics.view')).toBe(false);
    expect(can(person(['analytics.view']), 'reports.view')).toBe(false);
    expect(can(person(['analytics.view']), 'dashboard.view')).toBe(false);
  });

  it('the key is retired the way a retired key is: out of the catalog, named in RETIRED_KEYS', () => {
    expect(ALL_CATALOG_KEYS.has('analytics.view')).toBe(false);
    expect(RETIRED_KEYS).toContain('analytics.view');
  });
});

describe('every door that used to answer to two names answers to one', () => {
  const DOORS: Record<string, string> = {
    'src/app/api/analytics/route.ts': 'dashboard.view',
    'src/app/api/analytics/loss/route.ts': 'dashboard.view',
    'src/app/api/analytics/performance/route.ts': 'reports.view',
    'src/app/api/settings/channels/performance/route.ts': 'reports.view',
    'src/app/api/growth/attribution/route.ts': 'reports.view',
    'src/app/api/growth/landing-analytics/route.ts': 'reports.view',
    'src/app/api/growth/campaigns/route.ts': 'reports.view',
    'src/app/api/growth/campaigns/[id]/route.ts': 'reports.view',
    'src/app/api/growth/campaigns/bulk/route.ts': 'reports.view',
    'src/app/api/growth/campaigns/duplicates/route.ts': 'reports.view',
    'src/app/api/growth/campaigns/import/route.ts': 'reports.view',
    'src/app/api/growth/campaigns/order/route.ts': 'reports.view',
    'src/app/api/growth/campaigns/sync/route.ts': 'reports.view',
    'src/app/api/products/grades/route.ts': 'reports.view',
  };

  for (const [file, key] of Object.entries(DOORS)) {
    it(`${file} asks «${key}» and no fallback`, () => {
      const src = code(file);
      expect(src).toContain(file.includes('grades') ? `can(user, '${key}')` : `requirePermission('${key}')`);
      expect(src, 'the retired key is asked by nothing').not.toContain('analytics.view');
      // NEGATIVE: no OR-chain on the entry gate (R7): a `.catch` that asks a second key
      for (const line of src.split('\n').filter((l) => l.includes(`requirePermission('${key}')`))) {
        expect(line, line.trim()).not.toContain('.catch');
      }
    });
  }

  it('and no API route anywhere asks the retired key', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
      });
    const offenders = walk(path.join(root, 'src', 'app', 'api'))
      .filter((p) => stripComments(readFileSync(p, 'utf8')).includes('analytics.view'))
      .map((p) => path.relative(root, p));
    expect(offenders).toEqual([]);
  });

  it('the performance board’s menu line answers reports.view only', () => {
    const line = code('src/lib/route-registry.ts')
      .split('\n')
      .find((l) => l.includes(`r('/growth/performance'`))!;
    expect(line).toContain(`['reports.view']`);
    expect(line).not.toContain('analytics');
  });

  it('the screen of the board asks the board’s answer, not the dashboard’s', () => {
    const board = code('src/components/screens/PerformanceScreen.tsx');
    expect(board).toContain('/api/analytics/performance?');
    expect(board).not.toMatch(/\/api\/analytics\?/);
    const dash = code('src/components/screens/DashboardScreen.tsx');
    expect(dash).toContain('/api/analytics?period=');
  });
});

/* ─────────────────────────  the migration, as text  ───────────────────────── */

const NAME = '20261029130000_analytics_view_becomes_reports_view';
const DIR = path.join(root, 'prisma', 'migrations', NAME);
const sql = readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
const stripped = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');
const statements = stripped
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);
const [denyStmt, roleStmt, defaultsStmt, allowStmt] = statements;

describe('the migration, read as text', () => {
  it('is the newest one, so it runs after everything it reads', () => {
    const names = readdirSync(path.join(root, 'prisma', 'migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
    expect(names[names.length - 1]).toBe(NAME);
  });

  it('only adds rows — nothing is changed, removed or altered — four statements, each stepping aside for a row already there', () => {
    expect(statements).toHaveLength(4);
    for (const s of statements) {
      expect(s.startsWith('INSERT INTO'), s.slice(0, 50)).toBe(true);
      expect(s).not.toMatch(/\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER|CREATE)\b/i);
      expect(s).toMatch(/ON CONFLICT \("(roleId|userId)", "permission"\) DO NOTHING$/);
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'av2rv-' || gen_random_uuid()::text`);
      expect(s, 'granted FROM the retired key').toContain(`'analytics.view'`);
      expect(s, 'to both of the keys that replace it').toContain(`(VALUES ('reports.view'), ('dashboard.view'))`);
    }
  });

  it('writes the keys in all three places a grant lives — the role, its baseline, the person (a «منع» and a «سماح»)', () => {
    const into = statements.map((s) => s.match(/^INSERT INTO "(\w+)"/)?.[1]);
    expect(into).toEqual(['user_permissions', 'role_permissions', 'role_permission_defaults', 'user_permissions']);
    expect(denyStmt).toContain(`'DENY'`);
    expect(allowStmt).toContain(`'ALLOW'`);
  });

  it('touches nothing but these three keys — above all not settings.manage (the sensitive-settings migration is done)', () => {
    const literals = new Set([...stripped.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]));
    expect([...literals].sort()).toEqual(['analytics.view', 'dashboard.view', 'reports.view']);
    expect(stripped).not.toContain('settings.');
  });

  it('carries the «منع» FIRST, while the roles still show who held what — the order that avoids the step-4 bug', () => {
    const order = statements.findIndex((s) => s === denyStmt);
    expect(order).toBe(0);
    expect(statements.findIndex((s) => s.startsWith('INSERT INTO "role_permissions"'))).toBeGreaterThan(order);
    // The «سماح» comes AFTER the roles, so a role that received the key leaves no stray exception.
    expect(statements.indexOf(allowStmt)).toBeGreaterThan(statements.indexOf(roleStmt));
  });

  it('the «منع» is carried only where it would otherwise be a gain', () => {
    // 1. the role holds analytics.view; 2. and not the target; 3. and no other way in through reports.view.
    expect(denyStmt).toContain(`d."permission" = 'analytics.view'`);
    expect(denyStmt).toContain(`d."effect" = 'DENY'`);
    expect(denyStmt).toMatch(/AND EXISTS \([\s\S]*?rp\."permission" = 'analytics\.view'/);
    expect(denyStmt).toMatch(/AND NOT EXISTS \([\s\S]*?rp\."permission" = t\."perm"/);
    // a person whose role holds reports.view and who is not denied it passed yesterday through it
    expect(denyStmt).toMatch(/AND NOT \(\s*EXISTS \([\s\S]*?rp\."permission" = 'reports\.view'[\s\S]*?AND NOT EXISTS \([\s\S]*?x\."effect" = 'DENY'/);
    // and neither a personal «سماح» on reports.view
    expect(denyStmt).toMatch(/NOT EXISTS \([\s\S]*?x\."permission" = 'reports\.view' AND x\."effect" = 'ALLOW'/);
  });

  it('the «سماح» is written only where the person’s role does not hold the key — no stray exception', () => {
    expect(allowStmt).toMatch(/AND NOT EXISTS \(\s*SELECT 1 FROM "role_permissions" rp JOIN "roles" r ON r\."id" = rp\."roleId"\s*WHERE rp\."permission" = t\."perm"/);
    expect(allowStmt).toContain(`a."permission" = 'analytics.view'`);
    expect(allowStmt).toContain(`a."effect" = 'ALLOW'`);
  });

  it('reads a person’s role the way the engine reads it — the roleId, else the system template named like the role', () => {
    const lookup = `((u."roleId" IS NOT NULL AND r."id" = u."roleId")`;
    const template = `(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`;
    expect(denyStmt.split(lookup)).toHaveLength(4); // three role questions
    expect(denyStmt.split(template)).toHaveLength(4);
    expect(allowStmt).toContain(lookup);
    expect(allowStmt).toContain(template);
  });

  it('writes nothing for SUPER_ADMIN, who passes everything anyway', () => {
    for (const s of [denyStmt, allowStmt]) expect(s).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('the role row, the baseline row and the «سماح» carry the source’s scope; the «منع» carries none', () => {
    expect(roleStmt).toContain('rp."scope", rp."scopeIds"');
    expect(defaultsStmt).toContain('d."scope", d."scopeIds"');
    expect(allowStmt).toContain('a."scope", a."scopeIds"');
    expect(denyStmt).toContain(`'DENY', NULL, NULL, now()`);
  });

  it('its rollback removes only what it wrote', () => {
    const rollback = read(`prisma/migrations/${NAME}/rollback.sql`)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    const deletes = rollback.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'av2rv-%'`);
    expect(deletes[3]).toContain(`'${NAME}'`);
    expect(rollback).not.toMatch(/\bUPDATE\b|\bDROP\b|\bTRUNCATE\b/i);
  });
});

/* ─────────────────  the rules replayed over fixture people  ───────────────── */

type RoleRow = { id: string; roleId: string; permission: string; scope: string; scopeIds: unknown };
type UserRow = { id: string; userId: string; permission: string; effect: 'ALLOW' | 'DENY'; scope: string | null; scopeIds: unknown };
type Role = { id: string; companyId: string | null; name: string };
type Person = { id: string; role: string; roleId: string | null };
interface Db {
  users: Person[];
  roles: Role[];
  rolePerms: RoleRow[];
  defaults: RoleRow[];
  userPerms: UserRow[];
}

const TARGETS = ['reports.view', 'dashboard.view'] as const;
const TAG = 'av2rv-';
let seq = 0;
const mint = () => `${TAG}${++seq}`;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const roleIdOf = (db: Db, u: Person): string | null =>
  u.roleId ?? db.roles.find((r) => r.companyId === null && r.name === u.role)?.id ?? null;
const roleHolds = (db: Db, u: Person, key: string) => {
  const rid = roleIdOf(db, u);
  return rid !== null && db.rolePerms.some((rp) => rp.roleId === rid && rp.permission === key);
};
const own = (db: Db, u: Person, key: string, effect: 'ALLOW' | 'DENY') =>
  db.userPerms.some((x) => x.userId === u.id && x.permission === key && x.effect === effect);

/** Statement 1 — mirrors the SQL one-to-one, reading the state BEFORE the statement. */
function carryDeny(db: Db): UserRow[] {
  const out: UserRow[] = [];
  for (const d of db.userPerms.filter((x) => x.permission === 'analytics.view' && x.effect === 'DENY')) {
    const u = db.users.find((p) => p.id === d.userId)!;
    if (u.role === 'SUPER_ADMIN') continue;
    if (!roleHolds(db, u, 'analytics.view')) continue;
    for (const t of TARGETS) {
      if (roleHolds(db, u, t)) continue;
      if (roleHolds(db, u, 'reports.view') && !own(db, u, 'reports.view', 'DENY')) continue;
      if (own(db, u, 'reports.view', 'ALLOW')) continue;
      out.push({ id: mint(), userId: u.id, permission: t, effect: 'DENY', scope: null, scopeIds: null });
    }
  }
  return out;
}
/** Statements 2 and 3. */
const carryRows = (rows: RoleRow[]): RoleRow[] =>
  rows
    .filter((r) => r.permission === 'analytics.view')
    .flatMap((r) => TARGETS.map((t) => ({ id: mint(), roleId: r.roleId, permission: t, scope: r.scope, scopeIds: r.scopeIds })));
/** Statement 4 — reads the roles AFTER statement 2. */
function carryAllow(db: Db): UserRow[] {
  const out: UserRow[] = [];
  for (const a of db.userPerms.filter((x) => x.permission === 'analytics.view' && x.effect === 'ALLOW')) {
    const u = db.users.find((p) => p.id === a.userId)!;
    if (u.role === 'SUPER_ADMIN') continue;
    for (const t of TARGETS) {
      if (roleHolds(db, u, t)) continue;
      out.push({ id: mint(), userId: u.id, permission: t, effect: 'ALLOW', scope: a.scope, scopeIds: a.scopeIds });
    }
  }
  return out;
}
/** ON CONFLICT DO NOTHING: the first row for (roleId|userId, permission) stays. */
function addRoleRows(into: RoleRow[], rows: RoleRow[]) {
  for (const r of rows) if (!into.some((x) => x.roleId === r.roleId && x.permission === r.permission)) into.push(r);
}
function addUserRows(into: UserRow[], rows: UserRow[]) {
  for (const r of rows) if (!into.some((x) => x.userId === r.userId && x.permission === r.permission)) into.push(r);
}

function migrate(before: Db, opts: { denyLast?: boolean } = {}): Db {
  const db = clone(before);
  const deny = opts.denyLast ? [] : carryDeny(db);
  addUserRows(db.userPerms, deny);
  addRoleRows(db.rolePerms, carryRows(db.rolePerms));
  addRoleRows(db.defaults, carryRows(db.defaults));
  if (opts.denyLast) addUserRows(db.userPerms, carryDeny(db)); // the bug: the roles already show the new rows
  addUserRows(db.userPerms, carryAllow(db));
  return db;
}

/* the fixture */

const roles: Role[] = [
  { id: 'r_a', companyId: 'c1', name: 'تحليلات فقط' },
  { id: 'r_ar', companyId: 'c1', name: 'تحليلات وتقارير' },
  { id: 'r_r', companyId: 'c1', name: 'تقارير فقط' },
  { id: 'r_ad', companyId: 'c1', name: 'تحليلات ولوحة' },
  { id: 'r_d', companyId: 'c1', name: 'لوحة فقط' },
  { id: 'r_n', companyId: 'c1', name: 'لا شيء' },
  { id: 't_mod', companyId: null, name: 'MODERATOR' },
  { id: 't_acc', companyId: null, name: 'ACCOUNTANT' },
];
const held: Record<string, string[]> = {
  r_a: ['analytics.view'],
  r_ar: ['analytics.view', 'reports.view'],
  r_r: ['reports.view'],
  r_ad: ['analytics.view', 'dashboard.view'],
  r_d: ['dashboard.view'],
  r_n: [],
  t_mod: ['analytics.view', 'dashboard.view'],
  t_acc: ['reports.view'],
};
const rolePerms: RoleRow[] = Object.entries(held).flatMap(([roleId, keys]) =>
  keys.map((permission) => ({ id: `rp_${roleId}_${permission}`, roleId, permission, scope: 'ALL_COMPANY', scopeIds: null })),
);

interface Fixture {
  id: string;
  roleId: string | null;
  role?: string;
  deny?: string[];
  allow?: string[];
  /** a reports.view-only door the plan accepts losing: the dashboard's API, which no screen of theirs calls */
  noDashboardApi?: true;
  /** the owner's own «منع» that begins to count — the one deliberate change */
  nowCounts?: ('reports' | 'dashboard')[];
}
const PEOPLE: Fixture[] = [
  { id: 'p_a', roleId: 'r_a' },
  { id: 'p_a_denyA', roleId: 'r_a', deny: ['analytics.view'] },
  { id: 'p_a_denyR', roleId: 'r_a', deny: ['reports.view'], nowCounts: ['reports'] },
  { id: 'p_a_denyD', roleId: 'r_a', deny: ['dashboard.view'], nowCounts: ['dashboard'] },
  { id: 'p_a_denyA_allowR', roleId: 'r_a', deny: ['analytics.view'], allow: ['reports.view'] },
  { id: 'p_ar', roleId: 'r_ar' },
  { id: 'p_ar_denyA', roleId: 'r_ar', deny: ['analytics.view'] },
  { id: 'p_ar_denyR', roleId: 'r_ar', deny: ['reports.view'], nowCounts: ['reports'] },
  { id: 'p_ar_denyA_denyR', roleId: 'r_ar', deny: ['analytics.view', 'reports.view'] },
  { id: 'p_r', roleId: 'r_r', noDashboardApi: true },
  { id: 'p_r_denyR', roleId: 'r_r', deny: ['reports.view'] },
  { id: 'p_ad', roleId: 'r_ad' },
  { id: 'p_ad_denyA', roleId: 'r_ad', deny: ['analytics.view'] },
  { id: 'p_d', roleId: 'r_d' },
  { id: 'p_n', roleId: 'r_n' },
  { id: 'p_n_allowA', roleId: 'r_n', allow: ['analytics.view'] },
  { id: 'p_d_allowA', roleId: 'r_d', allow: ['analytics.view'] },
  { id: 'p_sa', roleId: null, role: 'SUPER_ADMIN', allow: ['analytics.view'], deny: ['reports.view'] },
  { id: 'p_tmod', roleId: null, role: 'MODERATOR' },
  { id: 'p_tmod_denyA', roleId: null, role: 'MODERATOR', deny: ['analytics.view'] },
  { id: 'p_tacc', roleId: null, role: 'ACCOUNTANT', noDashboardApi: true },
];
const users: Person[] = PEOPLE.map((p) => ({ id: p.id, role: p.role ?? 'MANAGER', roleId: p.roleId }));
const userPerms: UserRow[] = PEOPLE.flatMap((p) => [
  ...(p.deny ?? []).map((permission) => ({ id: `up_${p.id}_d_${permission}`, userId: p.id, permission, effect: 'DENY' as const, scope: null, scopeIds: null })),
  ...(p.allow ?? []).map((permission) => ({ id: `up_${p.id}_a_${permission}`, userId: p.id, permission, effect: 'ALLOW' as const, scope: 'ALL_COMPANY', scopeIds: null })),
]);
const BEFORE: Db = {
  users,
  roles,
  rolePerms,
  defaults: rolePerms.map((r) => ({ ...r, id: `d${r.id}` })),
  userPerms,
};

/** The real engine over a snapshot. */
async function doors(db: Db, p: Person) {
  const source: GrantSource = {
    roleRows: async (u) => {
      const rid = u.roleId ?? db.roles.find((r) => r.companyId === null && r.name === u.role)?.id;
      return db.rolePerms.filter((rp) => rp.roleId === rid);
    },
    overrideRows: async (userId) => db.userPerms.filter((x) => x.userId === userId),
  };
  const g = await computeEffectiveGrants(p as never, source);
  const has = (k: string) => g.fullAccess || g.grants[k] !== undefined;
  return {
    /** What the OLD doors answered: analytics.view or reports.view, each through the alias. */
    old: has('analytics.view') || has('reports.view'),
    reports: has('reports.view'),
    dashboard: has('dashboard.view'),
  };
}

describe('the rules, replayed over the fixture people with the real engine', () => {
  const AFTER = migrate(BEFORE);

  it('NOBODY GAINS A REPORTS DOOR: whoever passes the report and growth doors today passed them yesterday', async () => {
    const gained: string[] = [];
    for (const p of users) {
      const was = await doors(BEFORE, p);
      const is = await doors(AFTER, p);
      if (is.reports && !was.old) gained.push(p.id);
    }
    expect(gained).toEqual([]);
  });

  it('NOBODY LOSES A REPORTS DOOR — except where the owner’s own «منع» on reports.view begins to count', async () => {
    const lost: string[] = [];
    for (const p of users) {
      const was = await doors(BEFORE, p);
      const is = await doors(AFTER, p);
      if (was.old && !is.reports) lost.push(p.id);
    }
    expect(lost.sort()).toEqual(PEOPLE.filter((f) => f.nowCounts?.includes('reports')).map((f) => f.id).sort());
    expect(lost).toEqual(expect.arrayContaining(['p_a_denyR', 'p_ar_denyR']));
  });

  it('NOBODY LOSES THE DASHBOARD’S API — except an own «منع» on dashboard.view, and the reports-only roles the plan accepts', async () => {
    const lost: string[] = [];
    for (const p of users) {
      const was = await doors(BEFORE, p);
      const is = await doors(AFTER, p);
      if (was.old && !is.dashboard) lost.push(p.id);
    }
    const expected = PEOPLE.filter((f) => f.nowCounts?.includes('dashboard') || f.noDashboardApi).map((f) => f.id);
    expect(lost.sort()).toEqual(expected.sort());
  });

  it('the one with ONLY analytics.view (the inventory’s case) keeps both doors', async () => {
    const was = await doors(BEFORE, users.find((u) => u.id === 'p_a')!);
    const is = await doors(AFTER, users.find((u) => u.id === 'p_a')!);
    expect(was).toEqual({ old: true, reports: false, dashboard: false });
    expect(is).toEqual({ old: true, reports: true, dashboard: true });
    // …and so does the person who held it through their OWN «سماح», with a role that gives nothing
    expect((await doors(AFTER, users.find((u) => u.id === 'p_n_allowA')!))).toMatchObject({ reports: true, dashboard: true });
  });

  it('the dashboard API is gained only by people who hold dashboard.view — never by anyone else', async () => {
    for (const p of users) {
      const was = await doors(BEFORE, p);
      const is = await doors(AFTER, p);
      if (is.dashboard && !was.old) {
        expect(was.dashboard, `${p.id} passes /api/analytics without holding the dashboard`).toBe(true);
      }
    }
  });

  it('a person denied «عرض التحليلات» with no other way in stays out of BOTH doors', async () => {
    for (const id of ['p_a_denyA', 'p_ar_denyA_denyR']) {
      const is = await doors(AFTER, users.find((u) => u.id === id)!);
      expect(is, id).toMatchObject({ reports: false, dashboard: false });
    }
  });

  it('a person denied «عرض التحليلات» who passed through reports.view keeps passing', async () => {
    for (const id of ['p_ar_denyA', 'p_a_denyA_allowR', 'p_tmod_denyA']) {
      const is = await doors(AFTER, users.find((u) => u.id === id)!);
      expect(is.dashboard, id).toBe(true);
    }
    expect((await doors(AFTER, users.find((u) => u.id === 'p_ar_denyA')!)).reports).toBe(true);
    expect((await doors(AFTER, users.find((u) => u.id === 'p_a_denyA_allowR')!)).reports).toBe(true);
  });

  it('NEGATIVE: carried in the wrong order the migration GAINS doors — the step-4 bug this order avoids', async () => {
    const wrong = migrate(BEFORE, { denyLast: true });
    const gained: string[] = [];
    for (const p of users) {
      const was = await doors(BEFORE, p);
      const is = await doors(wrong, p);
      if (is.reports && !was.old) gained.push(p.id);
    }
    expect(gained.length).toBeGreaterThan(0);
    expect(gained).toContain('p_a_denyA');
  });

  it('SUPER_ADMIN gets no row, whatever rows they carry', () => {
    const rows = AFTER.userPerms.filter((x) => x.userId === 'p_sa' && x.id.startsWith(TAG));
    expect(rows).toEqual([]);
  });

  it('is additive: every row that was there is still there, unchanged, and every new row is tagged', () => {
    for (const key of ['rolePerms', 'defaults', 'userPerms'] as const) {
      for (const row of BEFORE[key]) expect(AFTER[key], `${key} ${row.id}`).toContainEqual(row);
      for (const row of AFTER[key].slice(BEFORE[key].length)) expect(row.id.startsWith(TAG)).toBe(true);
    }
    expect(AFTER.users).toEqual(BEFORE.users);
    expect(AFTER.roles).toEqual(BEFORE.roles);
  });

  it('is idempotent: a second run adds nothing', () => {
    const again = migrate(AFTER);
    for (const key of ['rolePerms', 'defaults', 'userPerms'] as const) expect(again[key].length, key).toBe(AFTER[key].length);
  });

  it('puts the keys in the baseline too, so «إرجاع للافتراضي» does not take the doors away again', () => {
    for (const roleId of ['r_a', 'r_ar', 'r_ad', 't_mod']) {
      for (const t of TARGETS) expect(AFTER.defaults.some((d) => d.roleId === roleId && d.permission === t), `${roleId} ${t}`).toBe(true);
    }
    // NEGATIVE: and a role that never held analytics.view gets nothing it did not have
    expect(AFTER.defaults.filter((d) => d.roleId === 'r_r').map((d) => d.permission)).toEqual(['reports.view']);
    expect(AFTER.rolePerms.filter((d) => d.roleId === 'r_n')).toEqual([]);
  });

  it('a role that already held the key keeps its own row; no redundant exception is left for a role that has the key', () => {
    expect(AFTER.rolePerms.filter((r) => r.roleId === 'r_ar' && r.permission === 'reports.view')).toHaveLength(1);
    expect(AFTER.rolePerms.find((r) => r.roleId === 'r_ar' && r.permission === 'reports.view')!.id).toBe('rp_r_ar_reports.view');
    // p_d_allowA: the role holds dashboard.view already → only reports.view is written for the person
    const mine = AFTER.userPerms.filter((x) => x.userId === 'p_d_allowA' && x.id.startsWith(TAG)).map((x) => x.permission);
    expect(mine).toEqual(['reports.view']);
  });
});
