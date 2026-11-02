import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HOLDER'S OWN WINDOW GETS A KEY — AND NOBODY RECEIVES IT UNTIL THE OWNER TICKS IT.
 *
 * `orders.edit_confirmed` — «تعديل وتأجيل وإلغاء طلب مؤكَّد قبل دخوله دفعة شحن» (the owner, 2/11). His standing rule: no change
 * grants a permission to anybody («منح صلاحيات لحدا» is his alone). So the box sits in the catalogue UNTICKED: no migration writes
 * it, the in-code fallback derives it for nobody, the reset-to-default baseline of no legacy role carries it. The day it ships it is
 * held by SUPER_ADMIN only — the way SUPER_ADMIN holds every key — and afterwards by exactly the roles or people he ticks it for.
 *
 * Measured with the REAL engine (`computeEffectiveGrants` + `attachGrants` + `can` / `userCan`), not with a hand-kept list: every
 * legacy role with no stored role, the same roles given every key the old migration used to read, the live agent role as it was
 * measured on 1/11 (22 keys), and a role the owner ticked it on.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants, can } from './authorization';
import { userCan } from './can';
import { ALL_CATALOG_KEYS, catalogItem, dependentsOf, requiredChain } from './permission-catalog';
import { computeEffectiveGrants, legacyEffectiveKeys, type GrantSource } from './permissions-core';
import { EDIT_CONFIRMED_KEY } from './edit-confirmed-key';
import type { SessionUser, UserRole } from '@/types/auth';

const MIGRATIONS = path.join(process.cwd(), 'prisma', 'migrations');

/** Every legacy role but SUPER_ADMIN (it is asked on its own below). */
const ROLES: UserRole[] = [
  'COMPANY_ADMIN', 'MANAGER', 'MODERATOR', 'ACCOUNTANT', 'DELIVERY_MANAGER', 'PENDING_USER',
  'CONFIRMATION_AGENT', 'FOLLOW_UP_AGENT', 'SETTLEMENT_OFFICER', 'WAREHOUSE', 'CONFIRMATION_SUPERVISOR',
];

/** CONFIRMATION_AGENT, live, 1/11: all 22 keys, every one at the whole company (`the-live-agent-is-refused-by-the-real-engine.test.ts`). */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];

type Override = { permission: string; effect: 'ALLOW' | 'DENY' };

/** A person as a session builds her: role rows (or none — the in-code fallback), her overrides, then the real engine. */
async function person(role: string, roleKeys: string[] | null, overrides: Override[] = []): Promise<SessionUser> {
  const source: GrantSource = {
    roleRows: async () => (roleKeys ?? []).map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => overrides.map((o) => ({ ...o, scope: null, scopeIds: null })),
  };
  const dbUser = { id: `u-${role}`, role, roleId: roleKeys ? `r-${role}` : null };
  const grants = await computeEffectiveGrants(dbUser, source);
  // `permissions` is what the session hands the screens (`userCan`); `effectiveGrants` is what the server reads (`can`).
  const session = { id: dbUser.id, role, status: 'ACTIVE', companyId: 'c1', permissions: Object.keys(grants.grants) };
  return attachGrants(session as unknown as SessionUser, grants);
}

/** The server's answer and the screen's answer — they must agree. */
const holds = (u: SessionUser) => {
  const server = can(u, EDIT_CONFIRMED_KEY);
  expect(userCan(u, EDIT_CONFIRMED_KEY), `${u.role}: the screen and the server disagree`).toBe(server);
  return server;
};

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

describe('no migration grants it — the owner ticks it himself', () => {
  it('no migration in prisma/migrations names the key at all (not a grant, not a «منع», not a baseline)', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => !d.endsWith('.toml'));
    expect(dirs.length).toBeGreaterThan(50); // not vacuous: the folder was read
    for (const d of dirs) {
      for (const f of ['migration.sql', 'rollback.sql']) {
        const file = path.join(MIGRATIONS, d, f);
        if (!existsSync(file)) continue;
        expect(readFileSync(file, 'utf8'), `${d}/${f}`).not.toContain(EDIT_CONFIRMED_KEY);
      }
    }
  });

  it('the migration the first draft carried (20261102120000_edit_confirmed_before_batch) is gone', () => {
    expect(existsSync(path.join(MIGRATIONS, '20261102120000_edit_confirmed_before_batch'))).toBe(false);
  });
});

describe('who holds it the day it ships, through the real engine: SUPER_ADMIN only', () => {
  it('SUPER_ADMIN holds it — the way it holds every key, with no row', async () => {
    expect(holds(await person('SUPER_ADMIN', null))).toBe(true);
  });

  it('NEGATIVE: no legacy role with no stored role derives it from the in-code fallback', async () => {
    for (const r of ROLES) expect(holds(await person(r, null)), r).toBe(false);
  });

  it('NEGATIVE: not even when the fallback person is GIVEN by hand both keys the first draft read (confirmation.work + orders.request_change)', async () => {
    const given: Override[] = [
      { permission: 'confirmation.work', effect: 'ALLOW' },
      { permission: 'orders.request_change', effect: 'ALLOW' },
    ];
    for (const r of ROLES) {
      const u = await person(r, null, given);
      // not vacuous: she really holds both keys
      expect(can(u, 'confirmation.work') && can(u, 'orders.request_change'), r).toBe(true);
      expect(holds(u), r).toBe(false);
    }
  });

  it('NEGATIVE: the live agent role (22 keys, 1/11) does not hold it — it holds both keys the first draft read', async () => {
    const abeer = await person('CONFIRMATION_AGENT', LIVE_AGENT);
    expect(can(abeer, 'confirmation.work')).toBe(true);
    expect(can(abeer, 'orders.request_change')).toBe(true);
    expect(holds(abeer)).toBe(false);
  });

  it('NEGATIVE: the reset-to-default baseline of no legacy role carries it', () => {
    for (const r of ROLES) expect(legacyEffectiveKeys(r), r).not.toContain(EDIT_CONFIRMED_KEY);
  });
});

describe('once the owner ticks it, it is held — and his «منع» still wins', () => {
  it('a role he ticked it on holds it', async () => {
    expect(holds(await person('CONFIRMATION_AGENT', [...LIVE_AGENT, EDIT_CONFIRMED_KEY]))).toBe(true);
  });

  it('a person he gave it to by a personal «سماح» holds it', async () => {
    expect(holds(await person('CONFIRMATION_AGENT', LIVE_AGENT, [{ permission: EDIT_CONFIRMED_KEY, effect: 'ALLOW' }]))).toBe(true);
  });

  it('NEGATIVE: a personal «منع» on the box takes it away whatever the role gives, and nothing else of hers moves', async () => {
    const u = await person('CONFIRMATION_AGENT', [...LIVE_AGENT, EDIT_CONFIRMED_KEY], [{ permission: EDIT_CONFIRMED_KEY, effect: 'DENY' }]);
    expect(holds(u)).toBe(false);
    for (const k of LIVE_AGENT) expect(can(u, k), k).toBe(true);
  });
});
