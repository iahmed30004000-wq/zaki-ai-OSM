import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A NEW MEMBER OF STAFF OPENS ON «نظيف» — AND NOBODY WHO ALREADY WORKS HERE
 * IS TOUCHED, AND THE OWNER'S ROLE LOOK STILL ANSWERS FIRST.
 *
 * Three promises, each held by the doors themselves rather than by a
 * reading of the source:
 *   1. the creation door writes «نظيف» into the new person's own
 *      column (called for real, with the database stubbed, and the row
 *      they hand to `create` inspected);
 *   2. a role the owner published a look for keeps it: the new hire's own
 *      column stays empty, so `openingTheme` reaches the role's base;
 *   3. no path that changes an EXISTING user writes it — no update, no
 *      upsert, no migration, no backfill.
 *
 * ── THE MUTATIONS THIS WAS RUN AGAINST (each turned it red) ──
 *   · `newStaffTheme` returning «نظيف» always      → the role-look test
 *   · `systemTheme: …` deleted from /api/users      → the users-door test
 *   · `systemTheme: …` deleted from /api/moderators → the moderators-door test
 *   · `NEW_STAFF_THEME = 'lyl'` (a typo)            → «is a real theme»
 *   · an update path writing `systemTheme: 'clean'` → the existing-users sweep
 *   · a second door writing a user's look           → «only two doors write a user's look»
 *
 * 18/11/2026 (R5) — RENAMED from a-new-member-of-staff-opens-on-layl.test.ts.
 * It said «ليل» (`layl`); it says «نظيف» (`clean`) now, because the plan of
 * 17/11 makes the new look what a new employee opens on. The three promises
 * did not change — only the look. Everybody who already works here is
 * OFFERED it once (src/components/shell/TryTheNewLook.tsx), and only their
 * own press writes it, through /api/profile/theme.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, tx, requirePermission, requireCompanyTenant, logAudit } = vi.hoisted(() => {
  const tx = { user: { create: vi.fn() } };
  return {
    tx,
    db: {
      role: { findUnique: vi.fn() },
      user: { findUnique: vi.fn(), create: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
    requirePermission: vi.fn(),
    requireCompanyTenant: vi.fn(),
    logAudit: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: () => true,
}));
vi.mock('@/lib/auth', () => ({
  hashPassword: async () => 'hashed',
  resolveSingleCompanyId: async () => 'co-1',
  requireCompanyTenant: (...a: unknown[]) => requireCompanyTenant(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/user-permissions', () => ({ canConferRole: async () => ({ ok: true }) }));
vi.mock('@/lib/geo-access', () => ({ geoAccessError: async () => null, replaceGeoAccess: async () => undefined }));
vi.mock('@/lib/commission', () => ({ commissionByUserForOrders: async () => new Map() }));

import { NEW_STAFF_THEME, SHEET_THEMES, SYSTEM_THEMES, newStaffTheme, openingTheme } from './system-themes';
import { stripComments } from './guard-source';
import { POST as createUser } from '@/app/api/users/route';
import { POST as createModerator } from '@/app/api/moderators/route';

const ROLE_ID = '0b6f3c2e-6d5a-4c1e-9f0a-2b7d8e9c1a34';
// Synthetic, and shaped only to pass the house's own password rules.
const SAMPLE_PASSWORD = 'Sample-Pass-123';

const post = (body: unknown) =>
  new Request('http://local.test/api', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  requirePermission.mockResolvedValue({ id: 'admin-1', role: 'SUPER_ADMIN', companyId: 'co-1', name: 'المالك' });
  requireCompanyTenant.mockResolvedValue({ user: { id: 'admin-1' }, companyId: 'co-1' });
  db.user.findUnique.mockResolvedValue(null);
  tx.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-1', ...data }));
  db.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-2', ...data }));
});

describe('the rule itself', () => {
  it('— «نظيف» is a real theme, and not one the first-load sheet carries, so it costs that sheet nothing', () => {
    expect(SYSTEM_THEMES.some((t) => t.key === NEW_STAFF_THEME)).toBe(true);
    expect(NEW_STAFF_THEME).toBe('clean');
    expect((SHEET_THEMES as readonly string[]).includes(NEW_STAFF_THEME)).toBe(false);
  });

  it('— no role look: the new person is given «نظيف», and opens on it', () => {
    expect(newStaffTheme(null)).toBe('clean');
    expect(newStaffTheme(undefined)).toBe('clean');
    expect(newStaffTheme('')).toBe('clean');
    expect(openingTheme(newStaffTheme(null), null)).toBe('clean');
  });

  it('— a role the owner published a look for: the own column stays empty, and the role answers', () => {
    expect(newStaffTheme('day')).toBeNull();
    expect(openingTheme(newStaffTheme('day'), 'day')).toBe('day');
  });
});

describe('the two creation doors write it — called for real', () => {
  it('— /api/users, with a role that has no look of its own: «نظيف»', async () => {
    db.role.findUnique.mockResolvedValue({ id: ROLE_ID, name: 'WAREHOUSE', companyId: null, systemTheme: null });
    const res = await createUser(post({ name: 'موظف جديد', email: 'new.hire@example.test', password: SAMPLE_PASSWORD, roleId: ROLE_ID }) as never);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    expect(tx.user.create.mock.calls[0][0].data.systemTheme).toBe('clean');
  });

  it('— /api/users, with a role the owner gave «نهاري»: nothing written, so «نهاري» is what they open on', async () => {
    db.role.findUnique.mockResolvedValue({ id: ROLE_ID, name: 'WAREHOUSE', companyId: null, systemTheme: 'day' });
    const res = await createUser(post({ name: 'موظف جديد', email: 'new.hire@example.test', password: SAMPLE_PASSWORD, roleId: ROLE_ID }) as never);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.systemTheme ?? null).toBeNull();
    expect(openingTheme(data.systemTheme, 'day')).toBe('day');
  });

  it('— /api/users, by the legacy role name (no role row, so no role look): «نظيف»', async () => {
    const res = await createUser(post({ name: 'موظف جديد', email: 'new.hire@example.test', password: SAMPLE_PASSWORD, role: 'MODERATOR' }) as never);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(db.role.findUnique).not.toHaveBeenCalled();
    expect(tx.user.create.mock.calls[0][0].data.systemTheme).toBe('clean');
  });

  // `/api/moderators` was the third door that made staff. It is closed now
  // (410 — it skipped the role and password checks `/api/users` makes), so
  // the rule here is that it makes nobody at all, theme or no theme.
  it('— /api/moderators: closed, and makes nobody', async () => {
    const res = await createModerator();
    expect(res.status).toBe(410);
    expect(db.user.create).not.toHaveBeenCalled();
  });
});

describe('and nobody who already exists is touched', () => {
  const ROOT = process.cwd();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  // One door now: `/api/moderators` is closed (410) and creates nobody.
  it('— «نظيف» is written only where a user is CREATED: the one door, through the one rule', () => {
    const writers = walk(join(ROOT, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /newStaffTheme\(|NEW_STAFF_THEME/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(ROOT.length + 1).split('\\').join('/'))
      .sort();
    expect(writers).toEqual(['src/app/api/users/route.ts', 'src/lib/system-themes.ts']);
    for (const door of ['src/app/api/users/route.ts']) {
      const body = stripComments(readFileSync(join(ROOT, door), 'utf8'));
      // Inside the `data` of a `create`, and in no update of any kind.
      const call = body.indexOf('systemTheme: newStaffTheme(');
      expect(call, door).toBeGreaterThan(-1);
      const opener = body.lastIndexOf('.create(', call);
      expect(opener, `${door}: الثيم خارج create`).toBeGreaterThan(-1);
      expect(body.slice(opener, call)).not.toMatch(/\.(update|updateMany|upsert)\(/);
    }
  });

  it('— no update, upsert or raw statement anywhere writes the literal theme into a user', () => {
    const offenders: string[] = [];
    for (const f of walk(join(ROOT, 'src')).filter((x) => /\.(ts|tsx)$/.test(x) && !/\.test\.tsx?$/.test(x))) {
      const body = stripComments(readFileSync(f, 'utf8'));
      if (/systemTheme:\s*'(clean|layl)'|system_theme\s*=\s*'(clean|layl)'/.test(body)) offenders.push(f.slice(ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it('— and no migration backfills it: the column already existed, and existing rows keep what they chose', () => {
    const dir = join(ROOT, 'prisma', 'migrations');
    const sql = walk(dir).filter((f) => f.endsWith('.sql'));
    expect(sql.length).toBeGreaterThan(0);
    for (const f of sql) expect(readFileSync(f, 'utf8'), f).not.toMatch(/layl|'clean'/);
  });

  /*
   * ONLY TWO DOORS WRITE A PERSON'S LOOK: the creation door (through
   * `newStaffTheme`) and the person's own press (`/api/profile/theme` — the
   * profile's picker and the shell's «جرّب الشكل الجديد» line both use it).
   * Every `user.create/update/upsert(…)` in the source is read to its closing
   * bracket; a raw statement naming the column is a writer too.
   */
  it("— only two doors write a user's look: /api/users (creation) and /api/profile/theme (their own press)", () => {
    const writers = new Set<string>();
    for (const f of walk(join(ROOT, 'src')).filter((x) => /\.(ts|tsx)$/.test(x) && !/\.test\.tsx?$/.test(x))) {
      const body = stripComments(readFileSync(f, 'utf8'));
      const rel = f.slice(ROOT.length + 1).split('\\').join('/');
      const call = /\buser\.(create|createMany|update|updateMany|upsert)\(/g;
      for (let m = call.exec(body); m; m = call.exec(body)) {
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < body.length; end++) {
          if (body[end] === '(') depth++;
          else if (body[end] === ')' && --depth === 0) break;
        }
        if (/systemTheme/.test(body.slice(m.index, end))) writers.add(rel);
      }
      if (/(UPDATE|INSERT)[^;]*system_theme/i.test(body)) writers.add(rel);
    }
    expect([...writers].sort()).toEqual(['src/app/api/profile/theme/route.ts', 'src/app/api/users/route.ts']);
  });
});
