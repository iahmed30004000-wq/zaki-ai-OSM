import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import {
  entryOwnership,
  keepsOwnEntry,
  CLAIM_CAPS,
  MANUAL_ENTRY_REASON,
  ENTRY_CAP_FULL_MESSAGE,
} from './confirmation-queue';
import { repoFile, stripComments } from './guard-source';

/*
 * THE SCOPE COMES FROM THE PERMISSION ENGINE, AND THESE TESTS ARE NOT
 * ABOUT THE ENGINE.
 *
 * `getPermissionScope` reads a user's grants through machinery of its own;
 * building a user that satisfies it would make every case here depend on a
 * second subject. The fixture carries the scope and the double hands it
 * back — the same arrangement `a-queue-row-opens.test.ts` uses.
 */
vi.mock('./authorization', () => ({
  can: () => true,
  requirePermission: vi.fn(),
  getPermissionScope: (u: SessionUser & { __scope?: string }) =>
    u.__scope ? { scope: u.__scope } : null,
}));

const { orderVisibilityWhere, orderListWhere, orderWorkWhere } = await import('./rbac');

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHO SEES WHICH ORDERS, AND WHOSE ORDER IT IS THE MOMENT IT IS TYPED.
 *
 * Three things the owner asked for, and one discovery that decided how.
 *
 * ── THE DISCOVERY ──
 *
 * `orderVisibilityWhere` answers TWO questions with one object: it is the
 * WHERE of the orders list, and it is the permission envelope
 * `assertOrderReadable` puts inside its own query. So the ASSIGNED scope's
 * claimable branch — unclaimed, unsigned, NEW orders — is not there to give
 * an agent a list of the pool. It is there so she can OPEN an order she is
 * about to pull. The claim route once carried a hand-written patch saying
 * exactly that («Without this the agent sees the order in their queue but
 * gets 403 when actually claiming it»).
 *
 * So «her list never shows the pool» could not be done by narrowing that
 * function — narrowing it would 404 every order she tries to pull. Two
 * envelopes instead, and these hold the difference down.
 * ═══════════════════════════════════════════════════════════════════════
 */

const user = (scope: 'ALL_COMPANY' | 'ASSIGNED' | 'OWN', id = 'u1'): SessionUser =>
  ({ id, status: 'ACTIVE', role: 'CUSTOM', __scope: scope }) as unknown as SessionUser;

/** The branch that lists work nobody has taken. */
const poolBranch = (envelope: Record<string, unknown>) =>
  (envelope.OR as Record<string, unknown>[] | undefined)?.find(
    (b) => b.confirmationStatus === 'NEW' && b.claimedById === null
  );

describe('the read envelope still carries the pool — the pull depends on it', () => {
  it('an agent may OPEN an unclaimed order', () => {
    const branch = poolBranch(orderVisibilityWhere(user('ASSIGNED')));
    expect(
      branch,
      'غلافُ القراءةِ فقدَ الطابور — كلُّ طلبٍ تُحاوِلُ سحبَه سيَرُدُّ «غير موجود»'
    ).toBeTruthy();
    expect(branch).toMatchObject({ claimedById: null, signatureStatus: 'UNSIGNED' });
  });
});

describe('the list envelope does not', () => {
  it('an agent’s list is what she took and what she typed — never the pool', () => {
    const envelope = orderListWhere(user('ASSIGNED')) as { OR: Record<string, unknown>[] };
    expect(poolBranch(envelope), 'الطابورُ ما زالَ في قائمتِها').toBeUndefined();
    // And it is not empty either: she must still see her own work.
    const keys = envelope.OR.map((b) => Object.keys(b)[0]).sort();
    expect(keys).toEqual(
      ['assignedToId', 'claimedById', 'createdById', 'currentOwnerId', 'moderatorId'].sort()
    );
    for (const branch of envelope.OR) expect(Object.values(branch)[0]).toBe('u1');
  });

  it('and a moderator’s list is the orders he entered, by either record of it', () => {
    /*
     * `createdById` is written on every staff creation path from now on;
     * `moderatorId` is the only record orders from before the column have,
     * and nothing was backfilled. Dropping either one hides real work.
     */
    const envelope = orderListWhere(user('OWN', 'm1')) as { OR: Record<string, unknown>[] };
    expect(envelope.OR).toEqual([{ createdById: 'm1' }, { moderatorId: 'm1' }]);
    // And a single-order read answers the same for him — there is no pool
    // in his job to be hidden from.
    expect(orderVisibilityWhere(user('OWN', 'm1'))).toEqual(envelope);
  });

  it('and company-wide stays company-wide', () => {
    expect(orderListWhere(user('ALL_COMPANY'))).toEqual({});
  });

  it('and a user with no orders.view gets nothing from either', () => {
    const none = { id: 'u9', status: 'ACTIVE' } as unknown as SessionUser;
    expect(orderListWhere(none)).toEqual({ id: '__no_access__' });
    expect(orderVisibilityWhere(none)).toEqual({ id: '__no_access__' });
  });
});

describe('every list goes through the one filter', () => {
  it('and that filter reads the LIST envelope, not the read one', () => {
    /*
     * `applyQueueFilter` is the single point `GET /api/orders` — with its
     * search and its scan — and `/api/reports/export` both pass through.
     * One line there is what takes the pool out of all of them at once;
     * one line missed is a door that still hands out the pool.
     */
    const src = stripComments(repoFile('src/lib/rbac.ts'));
    expect(src).toMatch(/const visibility = orderListWhere\(user\);/);
  });

  it('and the two doors that return many orders both call it', () => {
    for (const f of ['src/app/api/orders/route.ts', 'src/app/api/reports/export/route.ts']) {
      expect(stripComments(repoFile(f)), f).toMatch(/applyQueueFilter\(/);
    }
  });

  it('and the single-order read still uses the envelope that has the pool', () => {
    const src = stripComments(repoFile('src/lib/rbac.ts'));
    expect(src).toMatch(/AND: \[\{ id: orderId, companyId: scope\.companyId, storeId: scope\.storeId \}, orderVisibilityWhere\(user\)\]/);
  });

  it('and so does the work door the order window reads through — the order she holds joins it, the pool does not leave', () => {
    /*
     * The second door (`order-work-door.ts`) asks the same id in the same
     * company and store, AND `orderWorkWhere` — which is this very envelope
     * OR the order she holds. Narrowing it would 404 the pull exactly as
     * narrowing `orderVisibilityWhere` would.
     */
    const src = stripComments(repoFile('src/lib/rbac.ts'));
    expect(src).toMatch(/AND: \[\{ id: orderId, companyId: scope\.companyId, storeId: scope\.storeId \}, orderWorkWhere\(user\)\]/);
    const envelope = orderWorkWhere(user('ASSIGNED')) as { OR: Record<string, unknown>[] };
    // Dates flattened: the pool branch carries `lte: new Date()`, a millisecond apart on each call.
    const shape = (v: unknown) =>
      JSON.stringify(v, (_k, x) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? '<when>' : x));
    expect(shape(envelope.OR[0]), 'بابُ العمل لم يعد يحمل غلافَ القراءة كاملاً').toBe(shape(orderVisibilityWhere(user('ASSIGNED'))));
    expect(poolBranch(envelope.OR[0]), 'بابُ العمل فقدَ الطابور').toBeTruthy();
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────
 * AN ORDER AN AGENT TYPES IS HERS.
 * ───────────────────────────────────────────────────────────────────────
 */

const holder = (...perms: string[]) => (p: string) => perms.includes(p);
const NOW = new Date('2026-10-14T12:00:00.000Z');

describe('whose order it is the moment it is entered', () => {
  it('an agent keeps her own entry: claimed, owned, out of the queue', () => {
    const got = entryOwnership({
      userId: 'a1',
      holds: holder('confirmation.work'),
      heldTotal: 3,
      now: NOW,
    });
    expect(got).toEqual({
      claimedById: 'a1',
      claimedAt: NOW,
      currentOwnerId: 'a1',
      capFull: false,
    });
  });

  it('a supervisor’s entry goes to the queue, as every entry used to', () => {
    // Her entries belong to whoever is free. She is not working a queue.
    const got = entryOwnership({
      userId: 's1',
      holds: holder('confirmation.work', 'confirmation.supervise'),
      heldTotal: 0,
      now: NOW,
    });
    expect(got).toMatchObject({ claimedById: null, currentOwnerId: null, capFull: false });
  });

  it('and so does a moderator’s, and anyone else who works no queue', () => {
    const got = entryOwnership({ userId: 'm1', holds: holder('orders.create'), heldTotal: 0, now: NOW });
    expect(got).toMatchObject({ claimedById: null, capFull: false });
  });

  it('and the cap still binds — the 121st goes to the queue, and she is told', () => {
    const got = entryOwnership({
      userId: 'a1',
      holds: holder('confirmation.work'),
      heldTotal: CLAIM_CAPS.total,
      now: NOW,
    });
    expect(got.claimedById, 'سلّمَها الطلبَ ١٢١ بصمت').toBeNull();
    expect(got.capFull, 'أُخِذَ منها الطلبُ ولم تُخبَر').toBe(true);
    expect(ENTRY_CAP_FULL_MESSAGE).toContain(String(CLAIM_CAPS.total));
  });

  it('and one short of the cap is still hers', () => {
    const got = entryOwnership({
      userId: 'a1',
      holds: holder('confirmation.work'),
      heldTotal: CLAIM_CAPS.total - 1,
      now: NOW,
    });
    expect(got.claimedById).toBe('a1');
  });

  it('and the rule is read from permissions, never from a role name', () => {
    /*
     * A company that builds its own «موظف تأكيد» under another name gets
     * this too — which is the whole point of the permission engine.
     */
    expect(keepsOwnEntry(holder('confirmation.work'))).toBe(true);
    expect(keepsOwnEntry(holder('confirmation.work', 'confirmation.supervise'))).toBe(false);
    expect(keepsOwnEntry(holder('confirmation.supervise'))).toBe(false);
    expect(keepsOwnEntry(holder())).toBe(false);
    const src = stripComments(repoFile('src/lib/confirmation-queue.ts'));
    expect(src, 'القاعدةُ تَقرأُ اسمَ الدور').not.toMatch(/keepsOwnEntry[\s\S]{0,300}role ===/);
  });
});

describe('both creation doors ask the same rule and record the same fact', () => {
  const quick = () => stripComments(repoFile('src/app/api/orders/route.ts'));
  const intake = () => stripComments(repoFile('src/app/api/orders/ai-intake/route.ts'));

  it('both write who entered the order', () => {
    for (const [name, src] of [['quick entry', quick()], ['AI intake', intake()]] as const) {
      expect(src, name).toMatch(/createdById: user\.id/);
    }
  });

  it('and both ask `entryOwnership`, rather than deciding it themselves', () => {
    for (const [name, src] of [['quick entry', quick()], ['AI intake', intake()]] as const) {
      expect(src, name).toMatch(/const entry = entryOwnership\(\{/);
      expect(src, name).toMatch(/claimedById: entry\.claimedById/);
      expect(src, name).toMatch(/currentOwnerId: entry\.currentOwnerId/);
    }
  });

  it('and both record the claim through the one writer', () => {
    /*
     * THIS USED TO GREP THE QUICK-ENTRY FILE FOR `reason:
     * MANUAL_ENTRY_REASON`, AND PASSED WHILE THE AI INTAKE WROTE NO
     * HISTORY AT ALL. A text match on one of two places is a test about
     * that place, not about the rule.
     *
     * What it holds now is that neither door writes the row itself — the
     * shared `recordEntryClaim` does, and `entry-claim-reaches-both-doors`
     * asks that function what it writes.
     */
    for (const [name, src] of [['quick entry', quick()], ['AI intake', intake()]] as const) {
      expect(src, name).toMatch(/recordEntryClaim\(tx, \{/);
      expect(src, `${name}: يَكتبُ سجلَّ الحجزِ بنفسِه`).not.toMatch(/orderClaimHistory\.create/);
    }
    expect(MANUAL_ENTRY_REASON).toBe('MANUAL_ENTRY');
  });

  it('and both return the cap notice', () => {
    for (const [name, src] of [['quick entry', quick()], ['AI intake', intake()]] as const) {
      expect(src, name).toMatch(/entry\.capFull \? \{ notice: ENTRY_CAP_FULL_MESSAGE \}/);
    }
  });

  it('and the public storefront door writes no creator at all', () => {
    /*
     * A shopper is not staff. `public-order.ts` must never gain a
     * `createdById`, or every storefront order would be «entered by»
     * somebody and land in a person's list.
     */
    const pub = stripComments(repoFile('src/lib/public-order.ts'));
    expect(pub, 'طلبُ المتجرِ العامِّ صارَ له مُدخِل').not.toMatch(/createdById/);
  });


});

describe('the column is additive and nothing was invented for old orders', () => {
  const sql = () =>
    repoFile('prisma/migrations/20261014140000_order_created_by/migration.sql');

  it('adds a nullable column and never backfills it', () => {
    const src = sql();
    expect(src).toMatch(/ALTER TABLE "orders" ADD COLUMN "createdById" TEXT;/);
    expect(src, 'الترحيلُ يَملأُ العمودَ بأثرٍ رجعيّ').not.toMatch(/UPDATE "orders"/);
  });

  it('and an employee leaving never takes an order row with them', () => {
    expect(sql()).toMatch(/ON DELETE SET NULL/);
  });

  it('and it moves only the moderator rows still holding the template value', () => {
    /*
     * A company that widened or narrowed its own moderator role made a
     * decision. Overwriting it would be taking that decision back.
     */
    const src = sql();
    expect(src).toMatch(/r\."name" = 'MODERATOR'/);
    expect(src).toMatch(/rp\."permission" = 'orders\.view'/);
    expect(src, 'يَدهَسُ الصفوفَ المعدّلة').toMatch(/rp\."scope" = 'ALL_COMPANY'/);
  });
});
