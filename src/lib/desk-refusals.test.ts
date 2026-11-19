import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «سجل الرفض» — THE HELPER (`desk-refusals.ts`), request Q2a.
 *
 *  1. A listed code writes ONE statement; an unlisted one (an empty queue, a bad body, `CALL_PROOF_REFUSED` which has its audit row)
 *     writes nothing.
 *  2. It never throws: a rejected insert, a client with no `$executeRaw` at all, a throwing getter — all answer `false`.
 *  3. The same (user, code, order) inside a minute is one row — in this process, and in the statement (`WHERE NOT EXISTS`).
 *  4. The row carries ids and codes only: the columns are pinned, and no customer field exists.
 *  5. Only server route files and the prune job import it — never a screen (the desk's bundle is at its ceiling).
 *  6. The prune deletes in bounded passes and stops when a pass comes back short.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('./db', () => ({ db: {} }));

import {
  DESK_REFUSAL_CODES,
  DESK_REFUSAL_FOLD_MS,
  DESK_REFUSAL_KEEP_DAYS,
  forgetDeskRefusalFold,
  isLoggedDeskRefusal,
  logDeskRefusal,
  pruneDeskRefusalsOnce,
} from './desk-refusals';
import { pruneDeskRefusals, PRUNE_DESK_REFUSALS_BATCH, PRUNE_DESK_REFUSALS_PASSES } from './jobs/definitions/prune-desk-refusals';

type Call = [TemplateStringsArray, ...unknown[]];
const T0 = new Date('2026-11-19T10:00:00.000Z');
const BASE = { companyId: 'c1', storeId: 's1', userId: 'u1', door: 'pull' as const };

function client(answer: () => Promise<number> = async () => 1) {
  const calls: Call[] = [];
  return {
    calls,
    $executeRaw: vi.fn((q: TemplateStringsArray, ...v: unknown[]) => {
      calls.push([q, ...v]);
      return answer();
    }),
  };
}

/** The values of the insert, by column — the order the statement names them in. */
function row(call: Call) {
  const [, id, companyId, storeId, userId, orderId, code, door, at] = call;
  return { id, companyId, storeId, userId, orderId, code, door, at };
}

beforeEach(() => forgetDeskRefusalFold());

describe('which refusals are written', () => {
  it('every code the request names is listed, and nothing else', () => {
    const named = [
      'NOT_HELD', 'CONTACT_FIRST', 'POSTPONE_LIMIT', 'NO_ANSWER_NOT_A_POSTPONE', 'PULL_TOO_FAST', 'CAP_TOTAL', 'UNTOUCHED_ORDER',
      'WORK_FIRST', 'USE_THE_PULL', 'CANNOT_WORK_IT', 'DIFFERENT_RANK',
      // the «on the line» refusals
      'HELD_BY_COLLEAGUE', 'RESERVED_FOR_COLLEAGUE', 'CLOSED', 'NEVER_CALLED', 'REACHED_SINCE_RELEASE', 'TAKEN_MEANWHILE',
      // the hand-full twin of CAP_TOTAL
      'CAP_WITHOUT_ATTEMPT',
    ];
    for (const code of named) expect(isLoggedDeskRefusal(code), code).toBe(true);
    expect([...DESK_REFUSAL_CODES].sort()).toEqual([...named].sort());
  });

  it.each(['CALL_PROOF_REFUSED', 'QUEUE_EMPTY', 'QUEUE_BUSY', 'NOT_FOUND', 'ALREADY_YOURS', 'VERSION_CONFLICT', 'NOT_YOUR_DESK', '', null, undefined, 42])(
    'NEGATIVE: %s is not written',
    async (code) => {
      const c = client();
      expect(await logDeskRefusal({ ...BASE, code: code as string }, c, T0)).toBe(false);
      expect(c.$executeRaw).not.toHaveBeenCalled();
    }
  );

  it('a listed code is ONE statement with the entry as values', async () => {
    const c = client();
    expect(await logDeskRefusal({ ...BASE, orderId: 'o1', code: 'NOT_HELD', door: 'confirmation' }, c, T0)).toBe(true);
    expect(c.$executeRaw).toHaveBeenCalledTimes(1);
    expect(row(c.calls[0])).toMatchObject({ companyId: 'c1', storeId: 's1', userId: 'u1', orderId: 'o1', code: 'NOT_HELD', door: 'confirmation', at: T0.toISOString() });
  });

  it('a refusal about no order writes a null order', async () => {
    const c = client();
    await logDeskRefusal({ ...BASE, code: 'PULL_TOO_FAST' }, c, T0);
    expect(row(c.calls[0]).orderId).toBeNull();
  });

  it('NEGATIVE: an entry with no company or no user is not written', async () => {
    const c = client();
    expect(await logDeskRefusal({ ...BASE, companyId: '', code: 'NOT_HELD' }, c, T0)).toBe(false);
    expect(await logDeskRefusal({ ...BASE, userId: '', code: 'NOT_HELD' }, c, T0)).toBe(false);
    expect(c.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('it never throws', () => {
  it('a rejected insert (the table rolled back) answers false', async () => {
    const c = client(async () => {
      throw new Error('relation "desk_refusals" does not exist');
    });
    await expect(logDeskRefusal({ ...BASE, code: 'NOT_HELD' }, c, T0)).resolves.toBe(false);
  });

  it('a client that throws synchronously answers false', async () => {
    const c = {
      $executeRaw: () => {
        throw new Error('boom');
      },
    };
    await expect(logDeskRefusal({ ...BASE, code: 'NOT_HELD' }, c, T0)).resolves.toBe(false);
  });

  it('a client with no $executeRaw at all (a door test that never taught its fake) answers false', async () => {
    await expect(logDeskRefusal({ ...BASE, code: 'NOT_HELD' }, {} as never, T0)).resolves.toBe(false);
    // and the shared client, mocked here as `{}`
    await expect(logDeskRefusal({ ...BASE, code: 'CONTACT_FIRST' })).resolves.toBe(false);
  });

  it('an insert that wrote nothing (the database folded it) answers false', async () => {
    const c = client(async () => 0);
    expect(await logDeskRefusal({ ...BASE, code: 'NOT_HELD' }, c, T0)).toBe(false);
  });
});

describe('one row a minute per press', () => {
  it('ten presses at once are ONE statement', async () => {
    const c = client();
    const out = await Promise.all(Array.from({ length: 10 }, () => logDeskRefusal({ ...BASE, code: 'CAP_TOTAL' }, c, T0)));
    expect(out.filter(Boolean)).toHaveLength(1);
    expect(c.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('the window is one minute, the keep is ninety days', () => {
    expect(DESK_REFUSAL_FOLD_MS).toBe(60_000);
    expect(DESK_REFUSAL_KEEP_DAYS).toBe(90);
  });

  it('the same press 59 seconds later is folded; 60 seconds later is a new row', async () => {
    const c = client();
    await logDeskRefusal({ ...BASE, code: 'PULL_TOO_FAST' }, c, T0);
    await logDeskRefusal({ ...BASE, code: 'PULL_TOO_FAST' }, c, new Date(T0.getTime() + DESK_REFUSAL_FOLD_MS - 1000));
    expect(c.$executeRaw).toHaveBeenCalledTimes(1);
    await logDeskRefusal({ ...BASE, code: 'PULL_TOO_FAST' }, c, new Date(T0.getTime() + DESK_REFUSAL_FOLD_MS));
    expect(c.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('another order, another code, another person or another company is not folded', async () => {
    const c = client();
    await logDeskRefusal({ ...BASE, orderId: 'o1', code: 'NOT_HELD' }, c, T0);
    await logDeskRefusal({ ...BASE, orderId: 'o2', code: 'NOT_HELD' }, c, T0);
    await logDeskRefusal({ ...BASE, orderId: 'o1', code: 'CONTACT_FIRST' }, c, T0);
    await logDeskRefusal({ ...BASE, orderId: 'o1', userId: 'u2', code: 'NOT_HELD' }, c, T0);
    await logDeskRefusal({ ...BASE, orderId: 'o1', companyId: 'c2', code: 'NOT_HELD' }, c, T0);
    expect(c.$executeRaw).toHaveBeenCalledTimes(5);
  });

  it('the statement itself folds too (a second server): NOT EXISTS over the same person, code and order inside the minute', () => {
    const c = client();
    void logDeskRefusal({ ...BASE, orderId: 'o1', code: 'NOT_HELD' }, c, T0);
    const sql = c.calls[0][0].join('?').replace(/\s+/g, ' ');
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).toMatch(/"companyId" = \?::text AND "userId" = \?::text AND "code" = \?::text AND "orderId" IS NOT DISTINCT FROM \?::text AND "createdAt" > \?::timestamp\(3\)/);
    const since = c.calls[0][c.calls[0].length - 1];
    expect(since).toBe(new Date(T0.getTime() - DESK_REFUSAL_FOLD_MS).toISOString());
  });
});

describe('ids and codes only', () => {
  it('the insert names exactly these columns', () => {
    const c = client();
    void logDeskRefusal({ ...BASE, code: 'NOT_HELD' }, c, T0);
    const sql = c.calls[0][0].join('?');
    const cols = sql.match(/INSERT INTO "desk_refusals" \(([^)]*)\)/)![1].split(',').map((s) => s.trim().replace(/"/g, ''));
    expect(cols).toEqual(['id', 'companyId', 'storeId', 'userId', 'orderId', 'code', 'door', 'createdAt']);
  });

  it('the model and the migration carry no customer field', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const model = schema.match(/model DeskRefusal \{[\s\S]*?\n\}/)![0];
    const fields = model.split(/\r?\n/).slice(1, -1).map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('@@')).map((l) => l.split(/\s+/)[0]);
    expect(fields).toEqual(['id', 'companyId', 'storeId', 'userId', 'orderId', 'code', 'door', 'createdAt']);
    const dir = readdirSync(join(process.cwd(), 'prisma/migrations')).find((d) => d.endsWith('_desk_refusals'))!;
    const sql = readFileSync(join(process.cwd(), 'prisma/migrations', dir, 'migration.sql'), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/phone|name|address|customer|message|sentence/i);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
    expect(readFileSync(join(process.cwd(), 'prisma/migrations', dir, 'rollback.sql'), 'utf8')).toMatch(/DROP TABLE IF EXISTS "desk_refusals"/);
  });
});

describe('only server doors import it', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
    }
    return out;
  }
  const importers = walk(join(process.cwd(), 'src'))
    .filter((f) => /(from|import)\s*\(?\s*['"](@\/lib\/desk-refusals|(\.\.?\/)+desk-refusals)['"]/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(process.cwd(), f).replace(/\\/g, '/'))
    .sort();

  it('the importers are the eight refusing doors and the prune job — no screen, no shared lib the desk could reach', () => {
    expect(importers).toEqual([
      'src/app/api/confirmation/callback-take/route.ts',
      'src/app/api/confirmation/issues/route.ts',
      'src/app/api/confirmation/pull/route.ts',
      'src/app/api/orders/[id]/call-logs/route.ts',
      'src/app/api/orders/[id]/claim/route.ts',
      'src/app/api/orders/[id]/confirmation/route.ts',
      'src/app/api/orders/[id]/contact-attempts/route.ts',
      'src/app/api/orders/[id]/transfer/route.ts',
      'src/lib/jobs/definitions/prune-desk-refusals.ts',
    ]);
  });
});

describe('the prune', () => {
  it(`deletes rows older than ${DESK_REFUSAL_KEEP_DAYS} days, a bounded batch per statement`, async () => {
    const c = client(async () => 3);
    expect(await pruneDeskRefusalsOnce(c, T0, 500)).toBe(3);
    const [q, before, batch] = c.calls[0];
    expect(q.join('?').replace(/\s+/g, ' ')).toContain('DELETE FROM "desk_refusals" WHERE "id" IN ( SELECT "id" FROM "desk_refusals" WHERE "createdAt" < ?::timestamp(3) LIMIT ?::int )');
    expect(before).toBe('2026-08-21T10:00:00.000Z');
    expect(batch).toBe(500);
  });

  it('the job stops at the first short pass, and never makes more than its passes', async () => {
    const dbm = (await import('./db')).db as Record<string, unknown>;
    const answers = [PRUNE_DESK_REFUSALS_BATCH, PRUNE_DESK_REFUSALS_BATCH, 7];
    dbm.$executeRaw = vi.fn(async () => answers.shift() ?? 0);
    const r = await pruneDeskRefusals.run({ now: T0 } as never);
    expect(r.processed).toBe(PRUNE_DESK_REFUSALS_BATCH * 2 + 7);
    expect(dbm.$executeRaw).toHaveBeenCalledTimes(3);

    dbm.$executeRaw = vi.fn(async () => PRUNE_DESK_REFUSALS_BATCH);
    await pruneDeskRefusals.run({ now: T0 } as never);
    expect(dbm.$executeRaw).toHaveBeenCalledTimes(PRUNE_DESK_REFUSALS_PASSES);
    delete dbm.$executeRaw;
  });

  it('an empty table: one statement, nothing removed', async () => {
    const dbm = (await import('./db')).db as Record<string, unknown>;
    dbm.$executeRaw = vi.fn(async () => 0);
    const r = await pruneDeskRefusals.run({ now: T0 } as never);
    expect(r.processed).toBe(0);
    expect(dbm.$executeRaw).toHaveBeenCalledTimes(1);
    delete dbm.$executeRaw;
  });
});
