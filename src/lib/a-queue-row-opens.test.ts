import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SessionUser } from '@/types/auth';

/**
 * A ROW THE QUEUE LISTS IS A ROW THAT OPENS.
 *
 * `orderVisibilityWhere` is the envelope the orders list applies, and for
 * an ASSIGNED-scope role it INCLUDES THE CLAIMABLE QUEUE — unclaimed,
 * unsigned orders still at the NEW intake stage. That is the whole point
 * of the queue: work nobody has taken yet.
 *
 * `assertOrderAccess` asked a different question — is this order assigned
 * to you — and answered NOT_ASSIGNED for every one of them. So the agent's
 * own queue listed orders that answered 403 when opened.
 *
 * Whoever wrote the claim route hit this and patched it there, and left the
 * reason in the file: «Without this the agent sees the order in their queue
 * but gets 403 when actually claiming it». One route was fixed. Reading was
 * not — not the detail, not the timeline, not the notes, not the call log.
 *
 * So the read path now USES the envelope instead of restating it, and a
 * write still asks about assignment: being allowed to pick a parcel up is
 * not owning it.
 *
 * ── AND THE STATUS ──
 *
 * `{ NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 403 }` was written
 * out by hand at eighteen call sites, under a body reading «Order not
 * found». The status is the half a client believes: 404 says «no such
 * order for you», 403 says «it exists, it is a colleague's». Handing that
 * apart to whoever holds an id is the leak.
 */

const root = process.cwd();

function routeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('route.ts')) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(join(root, 'src', 'app', 'api'));
  return out;
}

describe('the status lives in one place', () => {
  const files = routeFiles();

  it('and no route writes its own copy of the map', () => {
    const own = files.filter((f) => /NOT_ASSIGNED:\s*40\d/.test(readFileSync(join(root, f), 'utf8')));
    expect(own, `مساراتٌ تكتب خريطةَ الحالة بيدها:\n${own.join('\n')}`).toEqual([]);
  });

  it('and «not yours» is not «it exists»', async () => {
    const { ORDER_ACCESS_STATUS } = await import('./rbac');
    expect(ORDER_ACCESS_STATUS.NOT_ASSIGNED, 'رقمُ الحالةِ يُفصح عن وجودِ طلبٍ لا يَقرؤه').toBe(404);
    expect(new Set(Object.values(ORDER_ACCESS_STATUS)).size, 'حالتان تُفرِّقان بين «غير موجود» و«ليس لك»').toBe(1);
  });

  it('and every read of an order goes through the list’s own rule', () => {
    const readsByAssignment: string[] = [];
    for (const file of files) {
      // Comments blanked, not read: a note SAYING «assertOrderAccess»
      // inside a handler that no longer calls it is not a call.
      const src = readFileSync(join(root, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      const marks = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
      for (let i = 0; i < marks.length; i++) {
        if (marks[i][1] !== 'GET') continue;
        const body = src.slice(marks[i].index!, marks[i + 1]?.index ?? src.length);
        if (/assertOrderAccess\s*\(/.test(body)) readsByAssignment.push(file);
      }
    }
    expect(
      readsByAssignment,
      `قراءاتٌ تسأل عن الإسنادِ بدلاً من غلافِ القائمة:\n${readsByAssignment.join('\n')}`
    ).toEqual([]);
  });
});

/**
 * AND THE RULE ITSELF, ASKED ABOUT A REAL CLAIMABLE ORDER.
 */
const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('./db', () => ({ db: { order: { findFirst: (...a: unknown[]) => findFirst(...a) } } }));
vi.mock('./authorization', () => ({
  can: () => true,
  requirePermission: vi.fn(),
  getPermissionScope: (u: SessionUser) =>
    u.role === 'CONFIRMATION_AGENT' ? { scope: 'ASSIGNED' } : { scope: 'ALL_COMPANY' },
}));

const { assertOrderReadable, orderVisibilityWhere } = await import('./rbac');
const { ORDER_WORK_DOOR } = await import('./order-work-door');

const agent = { id: 'a1', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' } as unknown as SessionUser;
const manager = { id: 'm1', role: 'MANAGER', status: 'ACTIVE' } as unknown as SessionUser;
const scope = { companyId: 'c1', storeId: 's1' };

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
});

describe('what an agent may read', () => {
  it('asks the database for the id AND the visibility envelope, in one query', async () => {
    findFirst.mockResolvedValue({ id: 'o1' });
    await assertOrderReadable('o1', agent, scope);

    const where = findFirst.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ id: 'o1', companyId: 'c1', storeId: 's1' });
    /*
     * Not a second copy of the rule: the envelope itself. Compared with
     * every Date flattened, because the claimable branch carries
     * `lockExpiresAt: { lte: new Date() }` — two calls a millisecond apart
     * are the same rule and were not the same object, which is a test that
     * passes alone and fails in a full run.
     */
    const shape = (v: unknown) =>
      JSON.stringify(v, (_k, x) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? '<when>' : x));
    expect(shape(where.AND[1])).toBe(shape(orderVisibilityWhere(agent)));
  });

  it('and through the work door: the same id, AND that same envelope — pool and all — OR the order she holds', async () => {
    /*
     * The order window reads through `ORDER_WORK_DOOR` now. It must still be
     * this one query, and still carry the envelope above whole: an agent with
     * «المسندة إليه» opens exactly what she opened before, plus nothing but
     * the order she holds (`the-order-she-holds.test.ts` asks the rest).
     */
    findFirst.mockResolvedValue({ id: 'o1' });
    await assertOrderReadable('o1', agent, scope, ORDER_WORK_DOOR);

    const where = findFirst.mock.calls[0][0].where;
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(where.AND[0]).toEqual({ id: 'o1', companyId: 'c1', storeId: 's1' });
    const shape = (v: unknown) =>
      JSON.stringify(v, (_k, x) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? '<when>' : x));
    const door = where.AND[1] as { OR: unknown[] };
    expect(door.OR).toHaveLength(2);
    expect(shape(door.OR[0])).toBe(shape(orderVisibilityWhere(agent)));
    expect(door.OR[1]).toEqual({ claimedById: 'a1' });
  });

  it('and the envelope it uses still carries the claimable queue', () => {
    const envelope = orderVisibilityWhere(agent) as { OR: Record<string, unknown>[] };
    const claimable = envelope.OR.find((branch) => branch.confirmationStatus === 'NEW');
    expect(claimable, 'غلافُ القائمة لم يعد يرى الطابورَ القابلَ للسحب').toBeTruthy();
    expect(claimable).toMatchObject({ claimedById: null, signatureStatus: 'UNSIGNED' });
  });

  it('opens what the queue listed', async () => {
    findFirst.mockResolvedValue({ id: 'o1', claimedById: null, confirmationStatus: 'NEW' });
    const access = await assertOrderReadable('o1', agent, scope);
    expect(access.allowed, 'صفٌّ معروضٌ في الطابور لا يُفتح').toBe(true);
  });

  it('and answers «not found» — not «forbidden» — for a colleague’s order', async () => {
    // The query itself excluded it, so the row never comes back.
    findFirst.mockResolvedValue(null);
    const access = await assertOrderReadable('o9', agent, scope);
    expect(access.allowed).toBe(false);
    if (!access.allowed) expect(access.reason).toBe('NOT_FOUND');
  });

  it('and a company-wide role is narrowed by nothing but its tenant', async () => {
    findFirst.mockResolvedValue({ id: 'o1' });
    await assertOrderReadable('o1', manager, scope);
    expect(findFirst.mock.calls[0][0].where.AND[1]).toEqual({});
  });

  it('— through the work door too', async () => {
    findFirst.mockResolvedValue({ id: 'o1' });
    await assertOrderReadable('o1', manager, scope, ORDER_WORK_DOOR);
    expect(findFirst.mock.calls[0][0].where.AND[1]).toEqual({});
  });
});
