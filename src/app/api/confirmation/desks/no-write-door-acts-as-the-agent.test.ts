import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «قراءة بس» IS A SERVER FACT, NOT A SCREEN THAT HIDES ITS BUTTONS.
 *
 * «شاشة موظفة» opens a colleague's desk for reading (desk-watch.ts). The screen
 * draws no pull, no confirm, no postpone, no cancel on it — and that is the
 * courtesy. The guarantee is here: no door that writes reads WHO to act as.
 *
 *   1. Every API route that exports a write verb is read, and none of them
 *      reads an `agent` parameter or imports the watching rule.
 *   2. The desk doors themselves export GET and nothing else.
 *   3. The pull takes no request at all, so there is nothing to name an agent in.
 *   4. The confirmation door, asked with `?agent=<the holder>` in the address AND
 *      `agent` / `asUserId` in the body, answers exactly as it does without them:
 *      a bound watcher is refused NOT_HELD on the colleague's order and nothing is
 *      written; the owner's confirmation is written under HIS id, never hers.
 *   5. THE ONE EXCEPTION (the owner, 8/11: «واذا ساحبيتو رجعهم»): `POST /api/confirmation/desks/[agentId]/return-no-answer`,
 *      «أرجِع «لا يرد» للطابور». It names a desk — the agent is in the PATH, as whose pile it is — and so it imports the
 *      watching rule. It is the exception, not the rule: it is listed here by name (`NAMES_A_DESK`), the list is asserted to be
 *      exactly that one file, and the file is asserted to ask BOTH the watching rule and `orders.unlock`, to take the agent only
 *      from the path, and to act as nobody but the presser (its history line, notice and audit row carry HIS id; nothing is
 *      written «as» her). Behaviour — the refusals, the counts — is `the-manager-returns-her-pile-through-the-real-engine.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const API = join(process.cwd(), 'src', 'app', 'api');

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routes(full));
    else if (name === 'route.ts') out.push(relative(process.cwd(), full).replace(/\\/g, '/'));
  }
  return out;
}

const WRITE_VERB = /export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\b/;

/**
 * The only write door that names a desk (point 5 above). Growing this list is deciding that another door may be pointed at a
 * colleague’s desk — a decision for the owner, and a new line in the test below that says why it acts as nobody but the presser.
 */
const NAMES_A_DESK = ['src/app/api/confirmation/desks/[agentId]/return-no-answer/route.ts'];

describe('the source: no write door reads whom to act as', () => {
  const all = routes(API);

  it('the walk found the doors (a guard over an empty list proves nothing)', () => {
    const writers = all.filter((f) => WRITE_VERB.test(stripComments(repoFile(f))));
    expect(all.length).toBeGreaterThan(100);
    expect(writers.length).toBeGreaterThan(50);
    expect(writers).toContain('src/app/api/orders/[id]/confirmation/route.ts');
  });

  it('none of them reads `agent` from the address or the body, or reaches for the watching rule', () => {
    const offenders: string[] = [];
    for (const f of all) {
      // The one named exception (point 5) is held to its own, narrower, assertions below.
      if (NAMES_A_DESK.includes(f)) continue;
      const src = stripComments(repoFile(f));
      if (!WRITE_VERB.test(src)) continue;
      if (/\.get\(\s*['"]agent['"]\s*\)/.test(src) || /\bbody\.agent\b|\bagent\s*:\s*z\./.test(src) || src.includes('desk-watch')) {
        offenders.push(f);
      }
    }
    expect(offenders, `بابُ كتابةٍ يقرأ «agent»:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the exception is ONE file, it is a write door, and it is found by the walk (an exception that matches nothing excuses nothing)', () => {
    expect(NAMES_A_DESK).toHaveLength(1);
    for (const f of NAMES_A_DESK) {
      expect(all, f).toContain(f);
      expect(WRITE_VERB.test(stripComments(repoFile(f))), f).toBe(true);
    }
  });

  it('and the exception is narrow: it asks the watching rule AND `orders.unlock`, takes the agent from the path alone, and acts as nobody but the presser', () => {
    const src = stripComments(repoFile(NAMES_A_DESK[0]));
    // both halves of the question are asked, and the desk is checked the way the desk door checks it
    expect(src).toMatch(/mayWatchDesks\(\s*user\s*\)/);
    expect(src).toMatch(/watchedAgent\(\s*companyId\s*,\s*storeId\s*,\s*agentId\s*\)/);
    expect(src).toMatch(/can\(\s*user\s*,\s*RETURN_PILE_KEY\s*\)/);
    // the agent comes from the path segment, never from the address or the body
    expect(src).toMatch(/params:\s*Promise<\{\s*agentId:\s*string\s*\}>/);
    expect(src).not.toMatch(/\.get\(\s*['"]agent(Id)?['"]\s*\)/);
    expect(src).not.toMatch(/\bbody\.agent|req\.json\(|request\.json\(|\.formData\(/);
    // every write is made under the presser’s own identity
    expect(src).toMatch(/by:\s*\{\s*id:\s*user\.id\s*,\s*name:\s*user\.name\s*\}/);
    expect(src).toMatch(/userId:\s*user\.id/);
    expect(src, 'the agent’s id must never be the actor of a write').not.toMatch(/userId:\s*agent(Id)?\b|by:\s*\{\s*id:\s*agent/);
    // and it never reaches for a way to hold the agent’s identity
    expect(src).not.toMatch(/asUserId|impersonat|signIn|createSession|requireAuth\(\s*agent/);
  });

  it('the two desk doors answer GET and nothing else', () => {
    for (const f of ['src/app/api/confirmation/mine/route.ts', 'src/app/api/confirmation/desks/route.ts']) {
      const src = stripComments(repoFile(f));
      expect(WRITE_VERB.test(src), f).toBe(false);
      expect(src, f).toMatch(/export async function GET\(/);
    }
  });

  it('and the only file that reads `?agent=` at all is the desk door', () => {
    const readers = all.filter((f) => /\.get\(\s*['"]agent['"]\s*\)/.test(stripComments(repoFile(f))));
    expect(readers).toEqual(['src/app/api/confirmation/mine/route.ts']);
  });
});

/* ───────────────────────── the confirmation door, asked «as» her ───────────────────────── */

const { db, requireContext, assertOrderAccess, reserveOrderLines } = vi.hoisted(() => ({
  db: {
    // `findMany`, `orderItem` and `$executeRaw` are the confirmed-twin guard's (#165): the customer's lock, her lines, no twin.
    order: { updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(async () => []) },
    orderItem: { findMany: vi.fn(async () => []) },
    $executeRaw: vi.fn(async () => 0),
    customer: { findUnique: vi.fn(async () => null), update: vi.fn() },
    orderContactAttempt: { count: vi.fn(async () => 1) },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  reserveOrderLines: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', async (orig) => ({ ...(await orig<Record<string, unknown>>()), requirePermission: vi.fn() }));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/reservation', () => ({ releaseOrderLines: vi.fn(async () => undefined), reserveOrderLines: (...a: unknown[]) => reserveOrderLines(...(a as [])) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/blacklist', () => ({ AlreadyBlocked: class extends Error {}, blockPhone: vi.fn() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { POST as confirmDoor } from '@/app/api/orders/[id]/confirmation/route';
import { POST as pullDoor } from '@/app/api/confirmation/pull/route';

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

/** Sara holds it, called once, governorate set — confirmable by HER. */
const SARAS_ORDER: Record<string, unknown> = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 3, orderNumber: 'ORD-2026-2000',
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  claimedById: 'sara', lockedById: null, lockExpiresAt: null, confirmedAt: null, customerId: 'cu1',
  nextFollowUpAt: null, followUpStatus: null, moderatorId: null,
  shippingBatchId: null, shippingBatch: null, deliveryProviderId: null, trackingNumber: null,
  courierSendStartedAt: null, totalAmount: 10, currency: 'USD', regionId: 'r1',
};

async function confirmAs(user: SessionUser, asHer: boolean) {
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false } });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...SARAS_ORDER } });
  db.order.findFirst.mockResolvedValue({ ...SARAS_ORDER });
  db.order.findUnique.mockResolvedValue({ ...SARAS_ORDER });
  const url = asHer ? 'http://localhost/api/orders/o1/confirmation?agent=sara' : 'http://localhost/api/orders/o1/confirmation';
  const body = asHer
    ? { action: 'confirm', expectedVersion: 3, agent: 'sara', asUserId: 'sara', claimedById: 'sara' }
    : { action: 'confirm', expectedVersion: 3 };
  const res = await confirmDoor(
    new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The supervisor template with «متابعة أداء الفريق» ticked: a watcher, and bound by «اسحبه أولاً». */
const WATCHING_SUPERVISOR = ['confirmation.work', 'confirmation.supervise', 'orders.view', 'orders.confirm', 'orders.contact_log', 'team.monitor'];

beforeEach(() => {
  vi.clearAllMocks();
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('the door, asked to act as the agent whose desk is open', () => {
  it('a watching supervisor is refused NOT_HELD on Sara’s order — with or without «agent», the same answer, nothing written', async () => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', WATCHING_SUPERVISOR);
    const plain = await confirmAs(sup, false);
    const asHer = await confirmAs(sup, true);
    expect(plain.status).toBe(403);
    expect(plain.body.code).toBe('NOT_HELD');
    expect(asHer).toEqual(plain);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(reserveOrderLines).not.toHaveBeenCalled();
  });

  it('the owner may confirm by his own keys — and it is written as HIS confirmation, never hers', async () => {
    const owner = await person('owner', 'SUPER_ADMIN', []);
    const res = await confirmAs(owner, true);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    const data = (db.order.updateMany.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.confirmedById).toBe('owner');
    expect(JSON.stringify(db.order.updateMany.mock.calls)).not.toContain('"confirmedById":"sara"');
  });

  it('the pull takes no request — there is nowhere to name an agent', () => {
    expect(pullDoor.length).toBe(0);
  });
});
