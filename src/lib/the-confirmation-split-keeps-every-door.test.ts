import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CONFIRMATION AND CHANGE-REQUEST DOORS GET A BOX EACH — AND NOBODY LOSES A DOOR OR GAINS ONE (perm-plan PR-7).
 *
 * Six keys: confirmation.winback · confirmation.reassign · confirmation.issues_correct · confirmation.raise_issue ·
 * control.change_requests_view · ops.decide_changes. Two keys that already existed are also given: customers.view_basic
 * (the orphan: the full customer tier without its page key) and orders.change_price (to whoever could decide a change request
 * yesterday without holding orders.edit, because deciding one that moves a figure now asks it).
 *
 * The migration 20261030140000_confirmation_split_keys gives each box to exactly the roles and people who passed the old
 * door — by KEY, and where the old door read a role NAME (the desk's four names, WAREHOUSE) by that name — and carries every
 * «منع». The owner's rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 * THE ONE GAIN, and it is deliberate (D14): a CONFIRMATION_AGENT receives confirmation.raise_issue, because the button
 * «إدخال إشكال» on her own desk always answered 403. The replay below lists the gains and the list is EXACTLY her.
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
import {
  CHANGE_DESK_ROLE_NAMES, CONFIRMATION_SPLIT_KEYS_FROM, DECIDER_KEYS, ISSUE_RAISER_ROLE_NAMES, WAREHOUSE_ROLE_NAMES,
  rolesThatPassedByName,
} from './confirmation-split-keys';
import type { SessionUser } from '@/types/auth';

const NAME = '20261030140000_confirmation_split_keys';
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

interface GateRow { newKey: string; src: string | null; role: string | null; copy: boolean; unless: string | null }
/** The gate table, one row per (box, key the door asked) and one per (box, role name the door read). */
const GATE: GateRow[] = CONFIRMATION_SPLIT_KEYS_FROM.flatMap((r) => [
  ...r.from.map((src) => ({ newKey: r.key, src, role: null, copy: r.copyScope, unless: r.unless ?? null })),
  ...rolesThatPassedByName(r).map((role) => ({ newKey: r.key, src: null, role, copy: r.copyScope, unless: r.unless ?? null })),
]);
const NEW_KEYS = [...new Set(CONFIRMATION_SPLIT_KEYS_FROM.map((r) => r.key))];
/** Keys that existed before this change. Everything else is brand new. */
const EXISTING_KEYS = ['customers.view_basic', 'orders.change_price'];
const BRAND_NEW = NEW_KEYS.filter((k) => !EXISTING_KEYS.includes(k));
const SRC_KEYS = [...new Set(GATE.flatMap((g) => (g.src ? [g.src] : [])))];
const HOLD_KEYS = [...new Set([...SRC_KEYS, ...GATE.flatMap((g) => (g.unless ? [g.unless] : []))])];

describe('the six new boxes are in the catalog, each with the screen key it sits behind', () => {
  const REQUIRES: Record<string, string | null | undefined> = {
    'confirmation.winback': 'confirmation.supervise',
    'confirmation.reassign': 'confirmation.supervise',
    'confirmation.issues_correct': 'confirmation.issues',
    'confirmation.raise_issue': null,
    'control.change_requests_view': undefined,
    'ops.decide_changes': null,
  };

  it('are exactly these six brand-new ones, in the list the migration and the engine fallback read', () => {
    expect([...BRAND_NEW].sort()).toEqual(Object.keys(REQUIRES).sort());
    expect(BRAND_NEW).toHaveLength(6);
    expect([...NEW_KEYS].sort()).toEqual([...BRAND_NEW, ...EXISTING_KEYS].sort());
  });

  it('can all be ticked on «الصلاحيات», with an Arabic and an English label', () => {
    for (const k of BRAND_NEW) {
      const item = catalogItem(k);
      expect(item, k).toBeDefined();
      expect(ALL_CATALOG_KEYS.has(k), k).toBe(true);
      expect(item!.requires, `${k}: مفتاح الشاشة`).toBe(REQUIRES[k]);
      expect(item!.ar.trim().length, k).toBeGreaterThan(8);
      expect(item!.en.trim().length, k).toBeGreaterThan(8);
    }
  });

  it('the two standalone ones say why they need no screen, and the decision key now needs the view of the whole desk', () => {
    for (const k of ['confirmation.raise_issue', 'ops.decide_changes']) expect((catalogItem(k)!.note ?? '').length, k).toBeGreaterThan(20);
    expect(catalogItem('control.change_requests')!.requires).toBe('control.change_requests_view');
    // NEGATIVE: the page still opens on the DECISION key — the view key opens no screen (cutting the page onto it would give the
    // page to a role that could only read the desk through its name, which is a gain).
    expect(catalogItem('control.change_requests')!.opens).toEqual(['طلبات التعديل']);
    expect(catalogItem('control.change_requests_view')!.opens).toBeUndefined();
  });

  it('NEGATIVE: the three keys whose old door had a NAME are the only ones that list names; the money key is the only one with an `unless`', () => {
    const named = CONFIRMATION_SPLIT_KEYS_FROM.filter((r) => rolesThatPassedByName(r).length > 0).map((r) => r.key).sort();
    expect(named).toEqual(['confirmation.raise_issue', 'control.change_requests_view', 'ops.decide_changes', 'orders.change_price']);
    expect(CONFIRMATION_SPLIT_KEYS_FROM.filter((r) => r.unless).map((r) => r.key)).toEqual(['orders.change_price']);
    expect(CONFIRMATION_SPLIT_KEYS_FROM.filter((r) => r.copyScope).map((r) => r.key)).toEqual(['customers.view_basic']);
    // the deliberate gain is the agent and nobody else
    expect(CONFIRMATION_SPLIT_KEYS_FROM.flatMap((r) => r.newForRoles ?? [])).toEqual(['CONFIRMATION_AGENT']);
    expect([...CHANGE_DESK_ROLE_NAMES]).toEqual(['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'CONFIRMATION_SUPERVISOR']);
    expect([...WAREHOUSE_ROLE_NAMES]).toEqual(['WAREHOUSE']);
    expect([...ISSUE_RAISER_ROLE_NAMES]).toEqual(['CONFIRMATION_AGENT']);
  });

  it('the keys a person could decide a request through are exactly the desk, the packing table and the holders of a claim', () => {
    expect([...DECIDER_KEYS]).toEqual(['control.change_requests', 'ops.ship', 'confirmation.pull', 'confirmation.work', 'orders.claim']);
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
      expect(s, 'tagged, so the rollback finds them and nothing else').toContain(`'cs7-' || gen_random_uuid()::text`);
    }
    for (const s of statements.filter((x) => !x.startsWith('INSERT INTO'))) {
      expect(s.startsWith('DROP TABLE IF EXISTS pg_temp.sp7_') || s.startsWith('CREATE TEMP TABLE sp7_'), s.slice(0, 70)).toBe(true);
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
      expect(reads).not.toContain('"user_permissions"');
      expect(reads).not.toContain('"role_permissions"');
      expect(reads).toMatch(/sp7_pass/);
      expect(reads).toMatch(/sp7_has/);
    }
    // a new key may appear only as the LEFT column of the gate table, never in a snapshot of what people hold
    for (const s of statements.filter((x) => x.startsWith('CREATE TEMP TABLE') && !x.startsWith('CREATE TEMP TABLE sp7_gate'))) {
      for (const k of NEW_KEYS) expect(s, `${k} in ${s.slice(0, 40)}`).not.toContain(`'${k}'`);
    }
  });

  it('the gate table is EXACTLY the one the engine fallback and the screens read (CONFIRMATION_SPLIT_KEYS_FROM)', () => {
    const gate = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp7_gate'))!;
    const lit = `(NULL::text|'[A-Za-z_.]+')`;
    const re = new RegExp(`\\('([a-z_.]+)',\\s*${lit},\\s*${lit},\\s*(true|false),\\s*${lit}\\)`, 'g');
    const strip = (x: string) => (x === 'NULL::text' ? null : x.replace(/'/g, ''));
    const rows = [...gate.matchAll(re)].map((m) => ({ newKey: m[1], src: strip(m[2]), role: strip(m[3]), copy: m[4] === 'true', unless: strip(m[5]) }));
    const key = (r: GateRow) => `${r.newKey}<${r.src}<${r.role}<${r.copy}<${r.unless}`;
    expect(rows.map(key).sort()).toEqual(GATE.map(key).sort());
    expect(rows).toHaveLength(GATE.length);
    // a row names a key OR a role, never both and never neither
    for (const r of rows) expect((r.src === null) !== (r.role === null), key(r)).toBe(true);
  });

  it('the snapshot of what people hold reads exactly the source keys of the gate table and the key it lets off', () => {
    const holds = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp7_holds'))!);
    expect(holds).toContain('h.k IN (SELECT src FROM sp7_gate WHERE src IS NOT NULL UNION SELECT unless_key FROM sp7_gate WHERE unless_key IS NOT NULL)');
    expect(holds).toContain(`up."effect" = 'ALLOW'`);
    expect(holds).toContain(`d."effect" = 'DENY'`);
    expect(holds).toContain(`u."role" <> 'SUPER_ADMIN'`);
    // a person's own «سماح» REPLACES the role's row for the same key — the engine's rule — so the role's is read only without one
    expect(holds).toContain(`a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW'`);
    expect(HOLD_KEYS).toContain('orders.edit');
    expect(HOLD_KEYS).toContain('confirmation.work');
  });

  it('the snapshot of who ALREADY holds a box leaves a person row of either kind to decide, else the role', () => {
    const has = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp7_has'))!);
    expect(has).toContain(`up."effect" = 'ALLOW' AND up."permission" IN (SELECT new_key FROM sp7_gate)`);
    expect(has).toContain('rp."permission" IN (SELECT new_key FROM sp7_gate)');
    expect(has).toContain('NOT EXISTS (SELECT 1 FROM "user_permissions" o WHERE o."userId" = ur.uid AND o."permission" = rp."permission")');
  });

  it('the statements that decide a person say exactly what the replay does — a flipped condition is caught HERE, since the replay is a copy', () => {
    const deny = flat(statements.find((s) => s.includes(`'DENY'`) && s.startsWith('INSERT INTO'))!);
    // the role receives the box AND the person did not pass THAT door AND does not already hold the box
    expect(deny).toContain('FROM sp7_user_role ur JOIN sp7_role_gets rg ON rg.rid = ur.rid');
    expect(deny).toContain('WHERE NOT EXISTS (SELECT 1 FROM sp7_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)');
    expect(deny).toContain('AND NOT EXISTS (SELECT 1 FROM sp7_has x WHERE x.uid = ur.uid AND x.k = rg.new_key)');
    // NEGATIVE: whoever the gate row lets off (an orders.edit holder without the price key) is NOT skipped here: the role's new row must not give it back
    expect(deny).not.toContain('unless_key');
    const allow = flat(statements.find((s) => s.includes(`'ALLOW'`) && s.startsWith('INSERT INTO'))!);
    // the person passed AND (it is the scoped box set by their own «سماح», OR no role of theirs receives the box) AND does not already hold it
    expect(allow).toContain('FROM sp7_pass p WHERE ((p.copy_scope AND p.own_allow) OR NOT EXISTS (SELECT 1 FROM sp7_user_role ur JOIN sp7_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key WHERE ur.uid = p.uid))');
    expect(allow).toContain('AND NOT EXISTS (SELECT 1 FROM sp7_has x WHERE x.uid = p.uid AND x.k = p.new_key)');
    // a SCOPED box is not written for a person with no stored role: the fallback in code answers, and it can see the legacy tier this file cannot
    expect(allow).toContain('AND (NOT p.copy_scope OR EXISTS (SELECT 1 FROM sp7_user_role ur WHERE ur.uid = p.uid))');
    expect(allow).toContain(`'ALLOW', p.scope, p.scope_ids`);
    // the scope is copied ONLY where the gate row says so
    for (const t of ['sp7_pass', 'sp7_role_gets', 'sp7_default_gets']) {
      const s = flat(statements.find((x) => x.startsWith(`CREATE TEMP TABLE ${t}`))!);
      expect(s, t).toContain('CASE WHEN g.copy_scope THEN');
      expect(s, t).toContain(`ELSE 'ALL_COMPANY' END AS scope`);
    }
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!)).toContain('FROM sp7_role_gets rg');
    expect(flat(statements.find((s) => s.startsWith('INSERT INTO "role_permission_defaults"'))!)).toContain('FROM sp7_default_gets dg');
  });

  it('a role is judged by the key it holds OR the name it carries, and the unless-key leaves a role alone — in both the role table and the baseline', () => {
    for (const [t, from, col] of [['sp7_role_gets', '"role_permissions" rp', 'rp."permission"'], ['sp7_default_gets', '"role_permission_defaults" d', 'd."permission"']] as const) {
      const s = flat(statements.find((x) => x.startsWith(`CREATE TEMP TABLE ${t}`))!);
      expect(s, t).toContain(`FROM ${from} JOIN sp7_gate g ON g.src = ${col}`);
      expect(s, t).toContain('FROM "roles" r JOIN sp7_gate g ON g.role_name = r."name"');
      expect(s, t).toContain('g.unless_key IS NULL OR NOT EXISTS');
    }
  });

  it('a person is judged by the key they hold OR the name of their role, and the unless-key leaves them alone', () => {
    const pass = flat(statements.find((s) => s.startsWith('CREATE TEMP TABLE sp7_pass'))!);
    expect(pass).toContain('FROM sp7_holds h JOIN sp7_gate g ON g.src = h.k');
    expect(pass).toContain('FROM "users" u JOIN sp7_gate g ON g.role_name = u."role"');
    expect(pass).toContain(`u."role" <> 'SUPER_ADMIN'`);
    expect(pass.match(/g\.unless_key IS NULL/g)).toHaveLength(2);
  });

  it('reads the role the way the engine reads it, and leaves SUPER_ADMIN alone', () => {
    const ur = statements.find((s) => s.startsWith('CREATE TEMP TABLE sp7_user_role'))!;
    expect(ur).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
    expect(ur).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
    expect(ur).toContain(`u."role" <> 'SUPER_ADMIN'`);
  });

  it('its rollback removes only what it wrote, in all three places, and its own row in the migrations table', () => {
    const body = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const deletes = body.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'cs7-%'`);
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
      expect(text, m).not.toContain(`'cs7-'`);
    }
  });

  it('runs after the migration of the previous permission box (#92), so every key it reads is already there — orders.change_price included', () => {
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

/** `sp7_user_role`: (uid, rid) — the engine's own reading of "which role are this person's grants from". */
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

type Skip = 'deny' | 'allow' | 'roles' | 'defaults' | 'scope' | 'own-allow' | 'denied-sources' | 'has' | 'unless' | 'names' | 'no-role-guard';

/** Statement-for-statement the SQL of migration.sql. */
function applyTheMigration(before: Rows, skip?: Skip): Rows {
  const db = clone(before);
  const gate = GATE.filter((g) => !(skip === 'names' && g.role !== null)).map((g) => (skip === 'unless' ? { ...g, unless: null } : g));

  // ── the snapshot: everything below is read from `before`, never from rows written here ──
  const ur = userRole(before);
  const superIds = new Set(before.users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.id));
  const denied = (uid: string, k: string) => skip !== 'denied-sources' && before.userPerms.some((d) => d.userId === uid && d.permission === k && d.effect === 'DENY');
  const holdKeys = new Set(gate.flatMap((g) => [...(g.src ? [g.src] : []), ...(g.unless ? [g.unless] : [])]));

  // sp7_holds — a person's own «سماح» REPLACES the role's row for the same key
  const holds: Array<{ uid: string; k: string; scope: string; scopeIds: unknown[] | null; ownAllow: boolean }> = [];
  for (const up of before.userPerms) {
    if (up.effect === 'ALLOW' && !superIds.has(up.userId) && holdKeys.has(up.permission) && !denied(up.userId, up.permission)) {
      holds.push({ uid: up.userId, k: up.permission, scope: up.scope ?? 'ALL_COMPANY', scopeIds: up.scopeIds, ownAllow: true });
    }
  }
  for (const x of ur) {
    for (const rp of before.rolePerms) {
      if (rp.roleId !== x.rid || !holdKeys.has(rp.permission)) continue;
      if (before.userPerms.some((a) => a.userId === x.uid && a.permission === rp.permission && a.effect === 'ALLOW')) continue;
      if (denied(x.uid, rp.permission)) continue;
      holds.push({ uid: x.uid, k: rp.permission, scope: rp.scope, scopeIds: rp.scopeIds, ownAllow: false });
    }
  }
  const holdsKey = (uid: string, k: string) => holds.some((h) => h.uid === uid && h.k === k);

  // sp7_has — who already holds a box this file would give
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

  // sp7_pass
  const pass: Array<{ uid: string; newKey: string; copy: boolean; ownAllow: boolean; scope: string; scopeIds: unknown[] | null }> = [];
  for (const h of holds) {
    for (const g of gate) {
      if (g.src !== h.k) continue;
      if (g.unless && holdsKey(h.uid, g.unless)) continue;
      pass.push({
        uid: h.uid, newKey: g.newKey, copy: g.copy, ownAllow: h.ownAllow,
        scope: g.copy && skip !== 'scope' ? h.scope : 'ALL_COMPANY',
        scopeIds: g.copy && skip !== 'scope' ? h.scopeIds : null,
      });
    }
  }
  for (const u of before.users) {
    if (u.role === 'SUPER_ADMIN') continue;
    for (const g of gate) {
      if (g.role !== u.role) continue;
      if (g.unless && holdsKey(u.id, g.unless)) continue;
      pass.push({ uid: u.id, newKey: g.newKey, copy: g.copy, ownAllow: false, scope: 'ALL_COMPANY', scopeIds: null });
    }
  }

  // sp7_role_gets / sp7_default_gets
  const gets = (table: Grant[]) => {
    const out: Array<{ rid: string; newKey: string; scope: string; scopeIds: unknown[] | null; unless: string | null }> = [];
    const roleHolds = (rid: string, k: string) => table.some((e) => e.roleId === rid && e.permission === k);
    for (const rp of table) {
      for (const g of gate) {
        if (g.src !== rp.permission) continue;
        if (g.unless && roleHolds(rp.roleId, g.unless)) continue;
        out.push({
          rid: rp.roleId, newKey: g.newKey,
          scope: g.copy && skip !== 'scope' ? rp.scope : 'ALL_COMPANY',
          scopeIds: g.copy && skip !== 'scope' ? rp.scopeIds : null,
          unless: g.unless,
        });
      }
    }
    for (const r of before.roles) {
      for (const g of gate) {
        if (g.role !== r.name) continue;
        if (g.unless && roleHolds(r.id, g.unless)) continue;
        out.push({ rid: r.id, newKey: g.newKey, scope: 'ALL_COMPANY', scopeIds: null, unless: g.unless });
      }
    }
    return out;
  };
  const roleGets = gets(before.rolePerms);
  const defaultGets = gets(before.defaults);

  let n = 0;
  const id = () => `cs7-${++n}`;
  const hasUserRow = (uid: string, k: string) => db.userPerms.some((p) => p.userId === uid && p.permission === k);

  // 1. «منع» — the role receives the box, the person did not pass THAT door, does not already hold it, and is not covered by the unless-key.
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
  // 2. «سماح» — the person passed; no role of theirs receives the box, or it is the scoped box set by their own «سماح».
  for (const p of skip === 'allow' ? [] : pass) {
    const roleReceives = ur.some((x) => x.uid === p.uid && roleGets.some((rg) => rg.rid === x.rid && rg.newKey === p.newKey));
    const viaOwnScope = skip !== 'own-allow' && p.copy && p.ownAllow;
    if (!(viaOwnScope || !roleReceives)) continue;
    if (has.has(`${p.uid}|${p.newKey}`)) continue;
    if (skip !== 'no-role-guard' && p.copy && !ur.some((x) => x.uid === p.uid)) continue;
    if (!hasUserRow(p.uid, p.newKey)) {
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
  for (const dg of skip === 'defaults' ? [] : defaultGets) {
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

const roleOf = (db: Rows, uid: string) => db.users.find((u) => u.id === uid)!.role;

/** Could this person decide a change request yesterday — by the desk, by the packing table (key or name), or by holding the order? */
function decided(u: SessionUser, role: string): boolean {
  return can(u, 'control.change_requests') || can(u, 'ops.ship') || (WAREHOUSE_ROLE_NAMES as readonly string[]).includes(role) ||
    can(u, 'confirmation.pull') || can(u, 'confirmation.work') || can(u, 'orders.claim');
}

/**
 * A person with NO stored role and no template with rows is answered by the in-code fallback, which does not derive the price
 * key (`inFallback: false`): the legacy keys it holds are not the stored rows the migration reads. Such a person does not exist
 * in a migrated database; for them the deciding keys count only when they stand as personal rows, as the migration reads them.
 */
const answeredByTheFallback = (db: Rows, uid: string) => {
  const u = db.users.find((x) => x.id === uid)!;
  if (u.role === 'SUPER_ADMIN' || u.roleId !== null) return false;
  return !db.roles.some((r) => r.companyId === null && r.name === u.role && db.rolePerms.some((p) => p.roleId === r.id));
};
function passedByRows(db: Rows, uid: string, u: SessionUser, role: string): boolean {
  if (db.userPerms.some((p) => p.userId === uid && p.permission === 'orders.change_price' && p.effect === 'DENY')) return false;
  if (can(u, 'orders.change_price')) return true;
  const decides =
    db.userPerms.some((p) => p.userId === uid && p.effect === 'ALLOW' && (DECIDER_KEYS as readonly string[]).includes(p.permission)) ||
    (WAREHOUSE_ROLE_NAMES as readonly string[]).includes(role);
  return decides && !can(u, 'orders.edit');
}

/**
 * The OLD door, asked of the OLD rows through the real engine — what each box must equal the day after.
 *
 * The money key is the odd one out and the comment says why: a person must hold it after if they held it before, OR if they
 * could decide yesterday and hold NO orders.edit. Whoever holds orders.edit and lacks the key lacks it because the owner took it
 * away after the previous migration — that choice is kept.
 */
async function passedYesterday(db0: Rows, uid: string, key: string): Promise<boolean> {
  const u = await holder(db0, uid);
  const role = roleOf(db0, uid);
  if (key === 'orders.change_price' && answeredByTheFallback(db0, uid)) return passedByRows(db0, uid, u, role);
  // The owner’s own «منع» on a key that EXISTED (the page key, the price key) stands: nothing is given over it.
  if (role !== 'SUPER_ADMIN' && EXISTING_KEYS.includes(key) && db0.userPerms.some((p) => p.userId === uid && p.permission === key && p.effect === 'DENY')) return false;
  switch (key) {
    case 'confirmation.winback':
    case 'confirmation.reassign':
      return can(u, 'confirmation.supervise');
    case 'confirmation.issues_correct':
    case 'confirmation.raise_issue':
      return can(u, 'confirmation.issues');
    case 'control.change_requests_view':
      return can(u, 'control.change_requests') || (CHANGE_DESK_ROLE_NAMES as readonly string[]).includes(role);
    case 'ops.decide_changes':
      return can(u, 'ops.ship') || (WAREHOUSE_ROLE_NAMES as readonly string[]).includes(role);
    case 'customers.view_basic':
      return can(u, 'customers.view_basic') || can(u, 'customers.view');
    case 'orders.change_price':
      return can(u, 'orders.change_price') || (decided(u, role) && !can(u, 'orders.edit'));
    default:
      throw new Error(key);
  }
}

/** The one deliberate gain. */
const deliberateGain = (db: Rows, uid: string, key: string) =>
  key === 'confirmation.raise_issue' && (ISSUE_RAISER_ROLE_NAMES as readonly string[]).includes(roleOf(db, uid));

const sameScope = (a: ReturnType<typeof getPermissionScope>, b: ReturnType<typeof getPermissionScope>) =>
  a?.scope === b?.scope && JSON.stringify(a?.scopeIds ?? null) === JSON.stringify(b?.scopeIds ?? null);

let nextId = 0;
const role = (name: string, companyId: string | null = null) => ({ id: `r${++nextId}`, companyId, name });

/** The world AFTER the previous migration (#92): every orders.edit holder already has orders.change_price at the edit's scope. */
function fixture(): Rows {
  nextId = 0;
  const tAdmin = role('COMPANY_ADMIN'); // system templates
  const tMgr = role('MANAGER');
  const tMod = role('MODERATOR');
  const tAgent = role('CONFIRMATION_AGENT');
  const tSup = role('CONFIRMATION_SUPERVISOR');
  const tWh = role('WAREHOUSE');
  const tDm = role('DELIVERY_MANAGER');
  const cUnticked = role('محرّر بلا سعر', 'c1'); // orders.edit and the desk — the owner took orders.change_price away
  const cDesk = role('مكتب', 'c1'); // confirmation.work only
  const cShip = role('شحن', 'c1'); // ops.ship only
  const cCust = role('عملاء', 'c1'); // customers.view OWN, no basic tier
  const cBasic = role('أساسي', 'c1'); // customers.view_basic only
  const cBoth = role('كلاهما', 'c1'); // customers.view ALL + customers.view_basic OWN
  const cClaim = role('استلام', 'c1'); // orders.claim
  const cPull = role('سحب', 'c1'); // confirmation.pull
  const cSup = role('مشرف مخصص', 'c1'); // control.change_requests + confirmation.supervise + confirmation.issues, NO orders.edit
  const cNothing = role('فاضي', 'c1');
  const cNamedLikeDesk = role('MANAGER', 'c1'); // a COMPANY role named like a desk name, holding nothing
  const perms: Array<[typeof tAdmin, Array<[string, Scope?]>]> = [
    [tAdmin, [['orders.view'], ['orders.edit'], ['orders.change_price'], ['control.change_requests'], ['confirmation.supervise'], ['confirmation.issues'], ['confirmation.work'], ['ops.ship'], ['customers.view'], ['orders.claim']]],
    [tMgr, [['orders.view'], ['orders.edit'], ['orders.change_price'], ['control.change_requests'], ['confirmation.supervise'], ['confirmation.issues'], ['customers.view'], ['customers.view_basic']]],
    [tMod, [['orders.view'], ['orders.edit', 'ASSIGNED'], ['orders.change_price', 'ASSIGNED'], ['orders.claim'], ['confirmation.issues'], ['customers.view', 'OWN']]],
    [tAgent, [['orders.view', 'ASSIGNED'], ['orders.edit', 'ASSIGNED'], ['orders.change_price', 'ASSIGNED'], ['confirmation.work'], ['confirmation.pull'], ['customers.view_basic']]],
    [tSup, [['confirmation.work'], ['confirmation.supervise'], ['confirmation.issues'], ['control.change_requests'], ['orders.view'], ['customers.view_basic']]],
    [tWh, [['ops.prepare'], ['ops.labels']]],
    [tDm, [['control.change_requests'], ['orders.view'], ['customers.view']]],
    [cUnticked, [['orders.edit'], ['control.change_requests'], ['orders.view']]],
    [cDesk, [['confirmation.work']]],
    [cShip, [['ops.ship']]],
    [cCust, [['customers.view', 'OWN']]],
    [cBasic, [['customers.view_basic']]],
    [cBoth, [['customers.view'], ['customers.view_basic', 'OWN']]],
    [cClaim, [['orders.claim'], ['orders.view']]],
    [cPull, [['confirmation.pull']]],
    [cSup, [['control.change_requests'], ['confirmation.supervise'], ['confirmation.issues']]],
    [cNothing, [['settings.view']]],
    [cNamedLikeDesk, [['settings.view']]],
  ];
  const rows: Rows = {
    users: [],
    roles: [tAdmin, tMgr, tMod, tAgent, tSup, tWh, tDm, cUnticked, cDesk, cShip, cCust, cBasic, cBoth, cClaim, cPull, cSup, cNothing, cNamedLikeDesk],
    rolePerms: [], defaults: [], userPerms: [],
  };
  let i = 0;
  for (const [r, keys] of perms) {
    for (const [permission, scope = 'ALL_COMPANY'] of keys) {
      rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission, scope, scopeIds: null });
      // every role has a baseline except cDesk — a role that was never issued one
      if (r.id !== cDesk.id) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission, scope, scopeIds: null });
    }
  }
  const user = (id: string, roleName: string, roleId: string | null) => rows.users.push({ id, role: roleName, roleId });
  const ex = (userId: string, permission: string, effect: 'ALLOW' | 'DENY', scope: string | null = null) =>
    rows.userPerms.push({ id: `up${++i}`, userId, permission, effect, scope: effect === 'ALLOW' ? scope ?? 'ALL_COMPANY' : null, scopeIds: null });

  user('admin', 'COMPANY_ADMIN', tAdmin.id);
  user('admin-no-role-id', 'COMPANY_ADMIN', null); // reads the template named like the role
  user('manager', 'MANAGER', tMgr.id);
  user('mod', 'MODERATOR', tMod.id);
  user('agent', 'CONFIRMATION_AGENT', tAgent.id);
  user('agent-no-role-id', 'CONFIRMATION_AGENT', null);
  user('sup', 'CONFIRMATION_SUPERVISOR', tSup.id);
  user('wh', 'WAREHOUSE', tWh.id);
  user('wh-no-role-id', 'WAREHOUSE', null);
  user('dm', 'DELIVERY_MANAGER', tDm.id);
  user('unticked', 'MODERATOR', cUnticked.id);
  user('desk', 'MODERATOR', cDesk.id);
  user('ship', 'MODERATOR', cShip.id);
  user('cust', 'MODERATOR', cCust.id);
  user('basic', 'MODERATOR', cBasic.id);
  user('both', 'MODERATOR', cBoth.id);
  user('claim', 'MODERATOR', cClaim.id);
  user('pull', 'MODERATOR', cPull.id);
  user('custom-sup', 'MODERATOR', cSup.id);
  user('nothing', 'MODERATOR', cNothing.id);
  user('named-like-desk', 'MODERATOR', cNamedLikeDesk.id);
  user('root', 'SUPER_ADMIN', null);
  user('stranger', 'ROLE_NOBODY_KNOWS', null); // no role id, no template: the fallback, which is empty
  user('legacy-follow-up', 'FOLLOW_UP_AGENT', null); // no template of that name: the in-code fallback (it holds orders.edit and orders.claim by legacy name)
  user('legacy-accountant', 'ACCOUNTANT', null);
  // ── the same roles, with a personal «منع» / «سماح» on a source key ──
  user('admin-denied-cr', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-cr', 'control.change_requests', 'DENY'); // passed the view BY NAME
  user('manager-denied-cr', 'MANAGER', tMgr.id); ex('manager-denied-cr', 'control.change_requests', 'DENY');
  user('sup-denied-cr', 'CONFIRMATION_SUPERVISOR', tSup.id); ex('sup-denied-cr', 'control.change_requests', 'DENY');
  user('dm-denied-cr', 'DELIVERY_MANAGER', tDm.id); ex('dm-denied-cr', 'control.change_requests', 'DENY'); // a name NOT on the desk list: loses it
  user('admin-denied-supervise', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-supervise', 'confirmation.supervise', 'DENY');
  user('admin-denied-issues', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-issues', 'confirmation.issues', 'DENY');
  user('agent-denied-issues', 'CONFIRMATION_AGENT', tAgent.id); ex('agent-denied-issues', 'confirmation.issues', 'DENY'); // D14 by name, still
  user('admin-denied-ship', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-ship', 'ops.ship', 'DENY');
  user('wh-denied-ship', 'WAREHOUSE', tWh.id); ex('wh-denied-ship', 'ops.ship', 'DENY'); // passed by name
  user('admin-denied-edit', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-edit', 'orders.edit', 'DENY'); // decides, holds no edit: the price key comes
  user('manager-denied-price', 'MANAGER', tMgr.id); ex('manager-denied-price', 'orders.change_price', 'DENY'); // the owner's choice, kept
  user('admin-denied-customers', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-customers', 'customers.view', 'DENY');
  user('both-denied-view', 'MODERATOR', cBoth.id); ex('both-denied-view', 'customers.view', 'DENY'); // keeps the basic tier it held
  user('basic-denied-basic', 'MODERATOR', cBasic.id); ex('basic-denied-basic', 'customers.view_basic', 'DENY');
  user('cust-denied-view', 'MODERATOR', cCust.id); ex('cust-denied-view', 'customers.view', 'DENY');
  user('desk-denied-work', 'MODERATOR', cDesk.id); ex('desk-denied-work', 'confirmation.work', 'DENY'); // the role's only decider key, refused
  user('custom-sup-denied-cr', 'MODERATOR', cSup.id); ex('custom-sup-denied-cr', 'control.change_requests', 'DENY');
  user('nothing-allowed-cr', 'MODERATOR', cNothing.id); ex('nothing-allowed-cr', 'control.change_requests', 'ALLOW');
  user('nothing-allowed-ship', 'MODERATOR', cNothing.id); ex('nothing-allowed-ship', 'ops.ship', 'ALLOW');
  user('nothing-allowed-work', 'MODERATOR', cNothing.id); ex('nothing-allowed-work', 'confirmation.work', 'ALLOW');
  user('nothing-allowed-claim', 'MODERATOR', cNothing.id); ex('nothing-allowed-claim', 'orders.claim', 'ALLOW');
  user('nothing-allowed-supervise', 'MODERATOR', cNothing.id); ex('nothing-allowed-supervise', 'confirmation.supervise', 'ALLOW');
  user('nothing-allowed-issues', 'MODERATOR', cNothing.id); ex('nothing-allowed-issues', 'confirmation.issues', 'ALLOW');
  user('nothing-allowed-customers-own', 'MODERATOR', cNothing.id); ex('nothing-allowed-customers-own', 'customers.view', 'ALLOW', 'OWN');
  user('cust-allowed-customers-all', 'MODERATOR', cCust.id); ex('cust-allowed-customers-all', 'customers.view', 'ALLOW', 'ALL_COMPANY'); // widens the role's OWN
  user('both-allowed-view-own', 'MODERATOR', cBoth.id); ex('both-allowed-view-own', 'customers.view', 'ALLOW', 'OWN'); // narrows the role's ALL
  user('nothing-allowed-cr-and-edit', 'MODERATOR', cNothing.id); ex('nothing-allowed-cr-and-edit', 'control.change_requests', 'ALLOW'); ex('nothing-allowed-cr-and-edit', 'orders.edit', 'ALLOW', 'OWN'); ex('nothing-allowed-cr-and-edit', 'orders.change_price', 'ALLOW', 'OWN'); // already keyed by the previous migration
  user('sup-allowed-edit', 'CONFIRMATION_SUPERVISOR', tSup.id); ex('sup-allowed-edit', 'orders.edit', 'ALLOW', 'OWN'); ex('sup-allowed-edit', 'orders.change_price', 'ALLOW', 'OWN'); // personal edit in a role without it
  user('sup-allowed-edit-unticked', 'CONFIRMATION_SUPERVISOR', tSup.id); ex('sup-allowed-edit-unticked', 'orders.edit', 'ALLOW', 'OWN'); ex('sup-allowed-edit-unticked', 'orders.change_price', 'DENY'); // …and the owner took the price away
  user('stranger-allowed-cr', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-cr', 'control.change_requests', 'ALLOW');
  user('stranger-allowed-supervise', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-supervise', 'confirmation.supervise', 'ALLOW');
  user('stranger-allowed-customers', 'ROLE_NOBODY_KNOWS', null); ex('stranger-allowed-customers', 'customers.view', 'ALLOW', 'OWN');
  user('legacy-follow-up-allowed-cr', 'FOLLOW_UP_AGENT', null); ex('legacy-follow-up-allowed-cr', 'control.change_requests', 'ALLOW'); // legacy edit by name, a decider by «سماح»
  user('legacy-accountant-allowed-claim', 'ACCOUNTANT', null); ex('legacy-accountant-allowed-claim', 'orders.claim', 'ALLOW');
  user('wh-no-role-id-denied-view', 'WAREHOUSE', null); ex('wh-no-role-id-denied-view', 'ops.ship', 'DENY');
  user('legacy-follow-up-allowed-customers-own', 'FOLLOW_UP_AGENT', null); ex('legacy-follow-up-allowed-customers-own', 'customers.view', 'ALLOW', 'OWN'); // the legacy basic tier at ALL by the fallback, a «سماح» on the full tier at OWN
  user('agent-no-role-id-allowed-issues', 'CONFIRMATION_AGENT', null); ex('agent-no-role-id-allowed-issues', 'confirmation.issues', 'ALLOW');
  // a person on a role named like a desk name but whose own role string is something else
  user('named-role-other-string', 'ACCOUNTANT', cNamedLikeDesk.id);
  // a person whose role string is a desk name but whose roleId is a custom role holding nothing of the kind
  user('manager-in-custom-role', 'MANAGER', cNothing.id);
  user('admin-in-custom-role', 'COMPANY_ADMIN', cNothing.id);
  user('sup-in-custom-role', 'CONFIRMATION_SUPERVISOR', cNothing.id);
  user('wh-in-custom-role', 'WAREHOUSE', cNothing.id);
  user('agent-in-custom-role', 'CONFIRMATION_AGENT', cNothing.id);
  // an unrelated exception must not move anything
  user('admin-denied-other', 'COMPANY_ADMIN', tAdmin.id); ex('admin-denied-other', 'settings.view', 'DENY');
  return rows;
}

async function everyDoorOfEveryone(db0: Rows, migrate: (r: Rows) => Rows = applyTheMigration) {
  const db1 = migrate(db0);
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
      if (!was && is && !deliberateGain(db0, u.id, k)) gained.push(`${u.id} gained ${k}`);
      // The screen's own question agrees with the server's.
      expect(userCan(after, k), `${u.id}/${k}: الشاشة والخادم`).toBe(is);
    }
    // THE SCOPE of the page key: whoever gets it from the full tier gets it at the full tier's scope; whoever had it keeps theirs.
    const ownDeny = db0.userPerms.some((p) => p.userId === u.id && p.permission === 'customers.view_basic' && p.effect === 'DENY');
    if (ownDeny) {
      // the owner’s «منع» stands; nothing is given over it
    } else if (!can(before, 'customers.view_basic') && can(before, 'customers.view')) {
      if (!sameScope(getPermissionScope(before, 'customers.view'), getPermissionScope(after, 'customers.view_basic'))) {
        scopeMoved.push(`${u.id}: view ${JSON.stringify(getPermissionScope(before, 'customers.view'))} → basic ${JSON.stringify(getPermissionScope(after, 'customers.view_basic'))}`);
      }
    } else if (can(before, 'customers.view_basic') && !sameScope(getPermissionScope(before, 'customers.view_basic'), getPermissionScope(after, 'customers.view_basic'))) {
      scopeMoved.push(`${u.id}: basic moved`);
    }
    // THE PRICE KEEPS THE SCOPE IT HAD, and a decider given the key gets no edit door with it.
    if (can(before, 'orders.change_price') && !sameScope(getPermissionScope(before, 'orders.change_price'), getPermissionScope(after, 'orders.change_price'))) {
      scopeMoved.push(`${u.id}: price moved`);
    }
    if (can(before, 'orders.edit') !== can(after, 'orders.edit')) gained.push(`${u.id}: orders.edit changed`);
  }
  return { db1, lost, gained, scopeMoved };
}

describe('the replay: every person, every door — yesterday against today, through the real engine', () => {
  it('nobody loses a door, nobody gains one (but the agent’s own «إدخال إشكال»), and no scope moves', async () => {
    const db0 = fixture();
    const { lost, gained, scopeMoved } = await everyDoorOfEveryone(db0);
    expect(lost, 'خسروا باباً').toEqual([]);
    expect(gained, 'كسبوا باباً').toEqual([]);
    expect(scopeMoved, 'تغيّر مدى').toEqual([]);
    expect(db0.users.length).toBeGreaterThanOrEqual(60);
  });

  it('the gains are EXACTLY the agents’ raise_issue — listed, so an accidental one is not hidden behind the deliberate one', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const gains: string[] = [];
    for (const u of db0.users) {
      const after = await holder(db1, u.id);
      for (const k of NEW_KEYS) {
        if (can(after, k) && !(await passedYesterday(db0, u.id, k))) gains.push(`${u.id}:${k}`);
      }
    }
    // exactly the confirmation agents who did NOT hold the issues list yesterday, and exactly one key
    const agentsWithoutTheList: string[] = [];
    for (const u of db0.users.filter((x) => x.role === 'CONFIRMATION_AGENT')) {
      if (!(await passedYesterday(db0, u.id, 'confirmation.raise_issue'))) agentsWithoutTheList.push(`${u.id}:confirmation.raise_issue`);
    }
    expect(agentsWithoutTheList.length).toBeGreaterThanOrEqual(4);
    expect(gains.sort()).toEqual(agentsWithoutTheList.sort());
  });

  it('the fixture really exercises the cases (a replay that finds nothing would pass for the wrong reason)', async () => {
    const db0 = fixture();
    let passers = 0;
    for (const u of db0.users) for (const k of NEW_KEYS) if (await passedYesterday(db0, u.id, k)) passers++;
    expect(passers, 'من يمر من الأبواب').toBeGreaterThan(150);
    const db1 = applyTheMigration(db0);
    const written = (rows: Array<{ id: string }>, before: Array<{ id: string }>) => rows.length - before.length;
    expect(written(db1.userPerms, db0.userPerms)).toBeGreaterThan(25);
    expect(written(db1.rolePerms, db0.rolePerms)).toBeGreaterThan(25);
    expect(written(db1.defaults, db0.defaults)).toBeGreaterThan(20);
    expect(db1.userPerms.filter((p) => p.id.startsWith('cs7-') && p.effect === 'DENY').length).toBeGreaterThan(3);
    expect(db1.userPerms.filter((p) => p.id.startsWith('cs7-') && p.effect === 'ALLOW').length).toBeGreaterThan(15);
  });

  it('each case by name: the box follows the door it came from, and not another one', async () => {
    const db1 = applyTheMigration(fixture());
    const box = async (uid: string, k: string) => can(await holder(db1, uid), k);
    // every key, alone, is enough
    expect(await box('custom-sup', 'confirmation.winback')).toBe(true); // confirmation.supervise
    expect(await box('custom-sup', 'confirmation.reassign')).toBe(true);
    expect(await box('nothing-allowed-supervise', 'confirmation.winback')).toBe(true); // a personal «سماح»
    expect(await box('mod', 'confirmation.issues_correct')).toBe(true); // confirmation.issues
    expect(await box('mod', 'confirmation.raise_issue')).toBe(true);
    expect(await box('ship', 'ops.decide_changes')).toBe(true); // ops.ship
    expect(await box('dm', 'control.change_requests_view')).toBe(true); // control.change_requests
    // …and the lists do not leak into one another
    expect(await box('mod', 'confirmation.winback')).toBe(false); // issues is not supervise
    expect(await box('custom-sup', 'ops.decide_changes')).toBe(false);
    expect(await box('ship', 'control.change_requests_view')).toBe(false);
    expect(await box('nothing', 'confirmation.reassign')).toBe(false);
    // by NAME: the desk's four names see the whole desk even with the key unticked — the leak is kept for the day, then it is a tick
    expect(await box('manager-denied-cr', 'control.change_requests_view')).toBe(true);
    expect(await box('admin-denied-cr', 'control.change_requests_view')).toBe(true);
    expect(await box('sup-denied-cr', 'control.change_requests_view')).toBe(true);
    expect(await box('manager-in-custom-role', 'control.change_requests_view')).toBe(true); // role string MANAGER, custom roleId
    expect(await box('sup-in-custom-role', 'control.change_requests_view')).toBe(true);
    expect(await box('admin-in-custom-role', 'control.change_requests_view')).toBe(true);
    // …and a name that was NOT on the list does not get it with the key denied
    expect(await box('dm-denied-cr', 'control.change_requests_view')).toBe(false);
    expect(await box('named-role-other-string', 'control.change_requests_view')).toBe(false); // a company role named MANAGER, a person who is not
    // the packing table: the key OR the name WAREHOUSE
    expect(await box('wh', 'ops.decide_changes')).toBe(true);
    expect(await box('wh-no-role-id', 'ops.decide_changes')).toBe(true);
    expect(await box('wh-in-custom-role', 'ops.decide_changes')).toBe(true);
    expect(await box('wh-denied-ship', 'ops.decide_changes')).toBe(true);
    // a «منع» on the ONLY source refuses the box too
    expect(await box('admin-denied-supervise', 'confirmation.winback')).toBe(false);
    expect(await box('admin-denied-issues', 'confirmation.issues_correct')).toBe(false);
    expect(await box('admin-denied-ship', 'ops.decide_changes')).toBe(false);
    expect(await box('custom-sup-denied-cr', 'control.change_requests_view')).toBe(false);
    // the deliberate gain, and its limits: the agent by name — not the moderator, not the supervisor
    expect(await box('agent', 'confirmation.raise_issue')).toBe(true);
    expect(await box('agent-no-role-id', 'confirmation.raise_issue')).toBe(true);
    expect(await box('agent-in-custom-role', 'confirmation.raise_issue')).toBe(true);
    expect(await box('agent', 'confirmation.issues_correct')).toBe(false); // she gets the BUTTON, not the list’s correction
    expect(await box('agent', 'confirmation.winback')).toBe(false);
    expect(await box('desk', 'confirmation.raise_issue')).toBe(false);
    expect(await box('wh', 'confirmation.raise_issue')).toBe(false);
    // an unrelated exception moved nothing
    expect(await box('admin-denied-other', 'confirmation.winback')).toBe(true);
  });

  it('THE MONEY RULE: whoever decided yesterday and holds no orders.edit receives the price key; the others’ choice stands', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const price = async (db: Rows, uid: string) => can(await holder(db, uid), 'orders.change_price');
    // deciders WITHOUT orders.edit: given
    for (const uid of ['sup', 'dm', 'custom-sup', 'wh', 'wh-no-role-id', 'ship', 'claim', 'pull', 'desk', 'nothing-allowed-cr', 'nothing-allowed-ship', 'nothing-allowed-work', 'nothing-allowed-claim',
      'wh-in-custom-role', 'manager-in-custom-role']) {
      if (uid === 'manager-in-custom-role') {
        // a desk NAME alone decided nothing (the name stopped counting on 15/10) — nothing is given for it
        expect(await price(db1, uid), uid).toBe(false);
        continue;
      }
      expect(await price(db0, uid), `${uid} قبل`).toBe(false);
      expect(await price(db1, uid), `${uid} بعد`).toBe(true);
    }
    // holders of orders.edit: untouched — the previous migration judged them
    expect(await price(db1, 'manager-denied-price'), 'اختيار المالك').toBe(false);
    expect(await price(db1, 'sup-allowed-edit-unticked'), 'اختيار المالك').toBe(false);
    expect(await price(db1, 'unticked'), 'اختيار المالك — دور بلا سعر').toBe(false);
    expect(await price(db1, 'admin')).toBe(true);
    // and the key opens NO edit door: nobody gained orders.edit
    for (const u of db0.users) {
      expect(can(await holder(db1, u.id), 'orders.edit'), `${u.id}: orders.edit`).toBe(can(await holder(db0, u.id), 'orders.edit'));
    }
    // a person with NO stored role who decided by a «سماح» of their own gets the key too
    expect(await price(db1, 'stranger-allowed-cr')).toBe(true);
    expect(await price(db1, 'legacy-follow-up-allowed-cr')).toBe(true);
    // …while one who decides only by a LEGACY key of the code fallback is not handed it (such a person does not exist once migrated)
    expect(await price(db1, 'legacy-follow-up')).toBe(false);
    // an explicit «منع» on the price key itself stands over everything above it
    expect(await price(db1, 'manager-denied-price')).toBe(false);
  });

  it('customers: the orphan is mended — every holder of the full tier holds the page key at the SAME scope, and nobody else does', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    const scopeOf = async (db: Rows, uid: string, k: string) => getPermissionScope(await holder(db, uid), k)?.scope ?? null;
    for (const u of db0.users) {
      const a = await holder(db0, u.id);
      const b = await holder(db1, u.id);
      if (can(a, 'customers.view')) expect(can(b, 'customers.view_basic'), `${u.id} عنده الأعلى بلا الأساسي`).toBe(true);
      if (!can(a, 'customers.view') && !can(a, 'customers.view_basic')) expect(can(b, 'customers.view_basic'), `${u.id} كسب`).toBe(false);
    }
    expect(await scopeOf(db1, 'cust', 'customers.view_basic')).toBe('OWN'); // the role’s OWN
    expect(await scopeOf(db1, 'mod', 'customers.view_basic')).toBe('OWN');
    expect(await scopeOf(db1, 'admin', 'customers.view_basic')).toBe('ALL_COMPANY');
    expect(await scopeOf(db1, 'cust-allowed-customers-all', 'customers.view_basic')).toBe('ALL_COMPANY'); // the «سماح» widens the role’s OWN — and so does the page key
    expect(await scopeOf(db1, 'nothing-allowed-customers-own', 'customers.view_basic')).toBe('OWN');
    // NEGATIVE: one who held the basic tier at OWN, with the full tier at ALL, keeps OWN (no widening of a key they already had)
    expect(await scopeOf(db1, 'both', 'customers.view_basic')).toBe('OWN');
    // NEGATIVE: a «منع» of the person’s own on the basic tier is not undone
    expect(can(await holder(db1, 'basic-denied-basic'), 'customers.view_basic')).toBe(false);
    // …and the full tier itself was not touched
    expect(await scopeOf(db1, 'cust', 'customers.view')).toBe('OWN');
    // the pre-deploy question: no role holds the full tier without the page key any more
    for (const r of db1.roles) {
      const keys = new Set(db1.rolePerms.filter((p) => p.roleId === r.id).map((p) => p.permission));
      if (keys.has('customers.view')) expect(keys.has('customers.view_basic'), `${r.name}: عملاء كاملة بلا أساسية`).toBe(true);
    }
    for (const r of db1.roles) {
      const keys = new Set(db1.defaults.filter((p) => p.roleId === r.id).map((p) => p.permission));
      if (keys.has('customers.view')) expect(keys.has('customers.view_basic'), `${r.name}: خط الرجوع`).toBe(true);
    }
  });

  it('what the owner unticked before is not given back: a role without the source does not get the box', async () => {
    const db1 = applyTheMigration(fixture());
    // the role had its control.change_requests unticked? — it has none: nothing is written for a role that holds no source and carries no name
    const nothing = await holder(db1, 'nothing');
    for (const k of BRAND_NEW) expect(can(nothing, k), k).toBe(false);
    expect(can(nothing, 'orders.change_price')).toBe(false);
  });

  it('SUPER_ADMIN is untouched: no row is written for him, and he still passes everything', async () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    expect(db1.userPerms.filter((p) => p.userId === 'root')).toEqual([]);
    const root = await holder(db1, 'root');
    for (const k of NEW_KEYS) expect(can(root, k)).toBe(true);
  });

  it('every row it writes is tagged, and a second run changes nothing (it steps aside for what is there)', async () => {
    const db0 = fixture();
    const once = applyTheMigration(db0);
    const twice = applyTheMigration(once);
    const wrote = (r: Rows) => ({ u: r.userPerms.length, r: r.rolePerms.length, d: r.defaults.length });
    expect(wrote(twice)).toEqual(wrote(once));
    const old = new Set([...db0.userPerms, ...db0.rolePerms, ...db0.defaults].map((x) => x.id));
    const added = [...once.userPerms, ...once.rolePerms, ...once.defaults].map((x) => x.id).filter((i) => !old.has(i));
    expect(added.length).toBeGreaterThan(80);
    for (const i of added) expect(i).toMatch(/^cs7-/);
    // Nothing that existed before was changed or removed.
    for (const p of db0.userPerms) expect(once.userPerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.rolePerms) expect(once.rolePerms.find((q) => q.id === p.id)).toEqual(p);
    for (const p of db0.defaults) expect(once.defaults.find((q) => q.id === p.id)).toEqual(p);
    // …and a run twice leaves every person where once left them
    for (const u of db0.users) {
      const a = [...((await holder(once, u.id)).permissions ?? [])].sort();
      const b = [...((await holder(twice, u.id)).permissions ?? [])].sort();
      expect(b, u.id).toEqual(a);
    }
  });

  it('the «إرجاع للافتراضي» baseline carries the boxes — so the first reset after the deploy does not take them away', () => {
    const db0 = fixture();
    const db1 = applyTheMigration(db0);
    for (const rule of CONFIRMATION_SPLIT_KEYS_FROM.filter((r) => !r.unless)) {
      const named = new Set(db0.roles.filter((r) => rolesThatPassedByName(rule).includes(r.name)).map((r) => r.id));
      const withSource = new Set([...db0.defaults.filter((d) => rule.from.includes(d.permission)).map((d) => d.roleId), ...named]);
      // roles that already carried the key in their baseline are in the set too (nothing was removed)
      const already = new Set(db0.defaults.filter((d) => d.permission === rule.key).map((d) => d.roleId));
      const boxed = new Set(db1.defaults.filter((d) => d.permission === rule.key).map((d) => d.roleId));
      expect(boxed, rule.key).toEqual(new Set([...withSource, ...already]));
    }
    // the page key’s baseline keeps the full tier’s baseline scope
    for (const e of db0.defaults.filter((d) => d.permission === 'customers.view')) {
      const got = db1.defaults.find((d) => d.roleId === e.roleId && d.permission === 'customers.view_basic');
      expect(got, `baseline ${e.roleId}`).toBeDefined();
      const had = db0.defaults.find((d) => d.roleId === e.roleId && d.permission === 'customers.view_basic');
      expect(got!.scope).toBe(had ? had.scope : e.scope);
    }
  });

  it('NEGATIVE (the test of the test): a migration with one step removed is CAUGHT', async () => {
    const db0 = fixture();
    const count = async (skip: Skip) => {
      const found = { lost: 0, gained: 0, scope: 0 };
      const { lost, gained, scopeMoved } = await everyDoorOfEveryone(db0, (r) => applyTheMigration(r, skip));
      found.lost = lost.length;
      found.gained = gained.length;
      found.scope = scopeMoved.length;
      return found;
    };
    expect((await count('deny')).gained, 'بلا «منع» يُمنح المفتاح بلا باب').toBeGreaterThan(0);
    expect((await count('allow')).lost, 'بلا «سماح» يخسر صاحب الاستثناء').toBeGreaterThan(0);
    expect((await count('roles')).lost, 'بلا صفوف الأدوار يخسر الجميع').toBeGreaterThan(0);
    expect((await count('names')).lost, 'بلا الأسماء يخسر مدير بالاسم وأمين المستودع').toBeGreaterThan(0);
    expect((await count('denied-sources')).gained, 'إن نسي أنّ «المنع» يُسقط المصدر').toBeGreaterThan(0);
    const noScope = await count('scope');
    expect(noScope.scope, 'بلا نسخ المدى تتّسع صفحة العملاء').toBeGreaterThan(0);
    expect((await count('own-allow')).scope, 'بلا «سماح» المدى الشخصي يتغيّر المدى').toBeGreaterThan(0);
    const noHas = await count('has');
    expect(noHas.lost + noHas.gained + noHas.scope, 'بلا «من يحمله أصلاً» يُكتب «منع» فوق مفتاح يعمل').toBeGreaterThan(0);
    expect((await count('unless')).scope + (await count('unless')).gained, 'بلا «إلا من عنده التعديل» يُعطى السعر لمن شيله المالك').toBeGreaterThan(0);
    const noGuard = await count('no-role-guard');
    expect(noGuard.scope + noGuard.lost + noGuard.gained, 'بلا حارس «بلا دور مخزَّن» يضيق مدى صفحة العملاء للاحتياطي').toBeGreaterThan(0);
    // the baseline is only read by «إرجاع للافتراضي», so the replay of people cannot see it: the baseline test above does
    const noDefaults = applyTheMigration(db0, 'defaults');
    expect(noDefaults.defaults.length).toBe(db0.defaults.length);
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
  const KEYS = [...HOLD_KEYS, 'customers.view_basic', 'orders.change_price', 'orders.view', 'settings.view'];
  const SCOPES: Scope[] = ['ALL_COMPANY', 'OWN', 'ASSIGNED'];
  const rows: Rows = { users: [], roles: [], rolePerms: [], defaults: [], userPerms: [] };
  let i = 0;
  const templateNames = ['COMPANY_ADMIN', 'MANAGER', 'MODERATOR', 'WAREHOUSE', 'CONFIRMATION_SUPERVISOR'];
  for (const name of templateNames) rows.roles.push({ id: `t-${name}`, companyId: null, name });
  for (let r = 0; r < 12; r++) rows.roles.push({ id: `c${r}`, companyId: 'c1', name: pick(['MANAGER', 'WAREHOUSE', `role${r}`, `role${r}`]) });
  for (const r of rows.roles) {
    for (const k of KEYS) {
      if (rand() < 0.35) rows.rolePerms.push({ id: `rp${++i}`, roleId: r.id, permission: k, scope: pick(SCOPES), scopeIds: null });
      if (rand() < 0.3) rows.defaults.push({ id: `d${++i}`, roleId: r.id, permission: k, scope: pick(SCOPES), scopeIds: null });
    }
  }
  const allNames = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'CONFIRMATION_SUPERVISOR', 'WAREHOUSE', 'CONFIRMATION_AGENT', 'MODERATOR', 'ACCOUNTANT', 'FOLLOW_UP_AGENT', 'DELIVERY_MANAGER'];
  for (let u = 0; u < 200; u++) {
    const kind = rand();
    const row =
      kind < 0.55 ? { role: pick(allNames.filter((n) => n !== 'SUPER_ADMIN')), roleId: pick(rows.roles.filter((x) => x.companyId !== null)).id }
      : kind < 0.8 ? { role: pick(templateNames), roleId: null }
      : kind < 0.9 ? { role: pick(['ACCOUNTANT', 'COMPANY_ADMIN_X', 'FOLLOW_UP_AGENT', 'CONFIRMATION_AGENT', 'DELIVERY_MANAGER']), roleId: null }
      : kind < 0.94 ? { role: 'SUPER_ADMIN', roleId: null }
      : { role: pick(allNames.filter((n) => n !== 'SUPER_ADMIN')), roleId: pick(rows.roles).id };
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

describe('the engine fallback: a person with no stored role keeps what the old keys and the old NAMES opened', () => {
  const fallback = async (roleName: string, ex: Array<{ permission: string; effect: string; scope?: string | null }> = []) =>
    computeEffectiveGrants({ id: 'f1', role: roleName, roleId: null }, {
      roleRows: async () => [],
      overrideRows: async () => ex.map((e) => ({ ...e, scope: e.scope ?? null, scopeIds: null })),
    });
  const keysOf = async (roleName: string, ex: Array<{ permission: string; effect: string; scope?: string | null }> = []) =>
    Object.keys((await fallback(roleName, ex)).grants);

  it('by NAME: the desk’s four see the whole desk, the warehouse decides at the table, the confirmation agent raises an issue', async () => {
    for (const r of ['COMPANY_ADMIN', 'MANAGER', 'CONFIRMATION_SUPERVISOR']) expect(await keysOf(r), r).toContain('control.change_requests_view');
    expect(await keysOf('WAREHOUSE')).toContain('ops.decide_changes');
    expect(await keysOf('CONFIRMATION_AGENT')).toContain('confirmation.raise_issue');
    // NEGATIVE: and only those names
    for (const r of ['ACCOUNTANT', 'DELIVERY_MANAGER', 'MODERATOR', 'PENDING_USER', 'SETTLEMENT_OFFICER']) {
      expect(await keysOf(r), r).not.toContain('control.change_requests_view');
      expect(await keysOf(r), r).not.toContain('ops.decide_changes');
    }
    for (const r of ['WAREHOUSE', 'MODERATOR', 'ACCOUNTANT', 'COMPANY_ADMIN']) expect(await keysOf(r), r).not.toContain('confirmation.raise_issue');
  });

  it('by KEY: a «سماح» of the person’s own on the old key reaches the box; a «منع» on the box or on the key wins', async () => {
    expect(await keysOf('ACCOUNTANT', [{ permission: 'confirmation.supervise', effect: 'ALLOW' }])).toEqual(expect.arrayContaining(['confirmation.winback', 'confirmation.reassign']));
    expect(await keysOf('ACCOUNTANT', [{ permission: 'confirmation.issues', effect: 'ALLOW' }])).toEqual(expect.arrayContaining(['confirmation.issues_correct', 'confirmation.raise_issue']));
    expect(await keysOf('ACCOUNTANT', [{ permission: 'control.change_requests', effect: 'ALLOW' }])).toContain('control.change_requests_view');
    expect(await keysOf('ACCOUNTANT', [{ permission: 'ops.ship', effect: 'ALLOW' }])).toContain('ops.decide_changes');
    // NEGATIVE
    expect(await keysOf('WAREHOUSE', [{ permission: 'ops.decide_changes', effect: 'DENY' }])).not.toContain('ops.decide_changes');
    expect(await keysOf('ACCOUNTANT', [{ permission: 'confirmation.supervise', effect: 'ALLOW' }, { permission: 'confirmation.winback', effect: 'DENY' }])).not.toContain('confirmation.winback');
    // …and the other box of the same source is untouched
    expect(await keysOf('ACCOUNTANT', [{ permission: 'confirmation.supervise', effect: 'ALLOW' }, { permission: 'confirmation.winback', effect: 'DENY' }])).toContain('confirmation.reassign');
    // the agent denied the box by name is denied
    expect(await keysOf('CONFIRMATION_AGENT', [{ permission: 'confirmation.raise_issue', effect: 'DENY' }])).not.toContain('confirmation.raise_issue');
  });

  it('the price key given to a decider is NOT derived by the fallback — it comes from stored rows (a person answered by the fallback does not exist in a migrated database)', async () => {
    // the legacy FOLLOW_UP_AGENT holds the claim, and WAREHOUSE is a name: both deciders, neither is handed the key in code
    for (const r of ['FOLLOW_UP_AGENT', 'WAREHOUSE', 'MODERATOR', 'CONFIRMATION_AGENT']) expect(await keysOf(r), r).not.toContain('orders.change_price');
    // …except through the previous migration’s own rule (PR-6): a personal «سماح» on orders.edit still gives the price, at ITS scope
    const edits = (await fallback('FOLLOW_UP_AGENT', [{ permission: 'orders.edit', effect: 'ALLOW', scope: 'OWN' }])).grants;
    expect(edits['orders.change_price']).toMatchObject({ scope: 'OWN' });
    // and a «منع» on the price key wins over that
    expect((await fallback('FOLLOW_UP_AGENT', [{ permission: 'orders.edit', effect: 'ALLOW', scope: 'OWN' }, { permission: 'orders.change_price', effect: 'DENY' }])).grants['orders.change_price']).toBeUndefined();
  });

  it('the page key: a legacy role that holds the full customer tier holds the basic tier at the same scope', async () => {
    for (const r of ['COMPANY_ADMIN', 'MANAGER', 'MODERATOR', 'DELIVERY_MANAGER']) {
      const g = (await fallback(r)).grants;
      expect(g['customers.view'], r).toBeDefined();
      expect(g['customers.view_basic'], r).toBeDefined();
      expect(g['customers.view_basic'].scope, r).toBe(g['customers.view'].scope);
    }
    // NEGATIVE: a legacy role without the full tier gets nothing it did not have
    for (const r of ['SETTLEMENT_OFFICER', 'ACCOUNTANT']) expect(await keysOf(r)).not.toContain('customers.view_basic');
  });

  it('the parity list (the reset-to-default baseline of a legacy role) carries the boxes for the same roles', () => {
    expect(legacyEffectiveKeys('WAREHOUSE')).toContain('ops.decide_changes');
    expect(legacyEffectiveKeys('WAREHOUSE')).not.toContain('orders.change_price');
    expect(legacyEffectiveKeys('CONFIRMATION_AGENT')).toContain('confirmation.raise_issue');
    expect(legacyEffectiveKeys('MANAGER')).toContain('control.change_requests_view');
    expect(legacyEffectiveKeys('MANAGER')).toContain('customers.view_basic');
    // NEGATIVE
    expect(legacyEffectiveKeys('ACCOUNTANT')).not.toContain('control.change_requests_view');
    expect(legacyEffectiveKeys('PENDING_USER')).not.toContain('confirmation.raise_issue');
    expect(legacyEffectiveKeys('MODERATOR')).not.toContain('ops.decide_changes');
  });
});
