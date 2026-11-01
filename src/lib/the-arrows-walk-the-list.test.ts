import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ARROWS WALK THE LIST, NOT THE POOL.
 *
 * C2 took the unclaimed queue out of an agent's «الطلبات». The previous /
 * next arrows in the order window handed it straight back: they were built
 * on `orderVisibilityWhere` — the READ envelope — and the read envelope
 * deliberately carries the pool, because an agent must be able to OPEN the
 * order she is about to pull.
 *
 * So she opened one order and arrowed through every unclaimed order in the
 * store, customer names and phones included. One screen closed, one button
 * beside it open.
 *
 * And the envelope was chosen by role NAME — MODERATOR · CONFIRMATION_AGENT
 * · FOLLOW_UP_AGENT — so a custom role on the same scope under another name
 * fell past the list entirely and walked every order in the company. A
 * guard that is a list is incomplete the day it is written.
 *
 * These ask both halves: what the list envelope matches, and that the two
 * envelopes genuinely differ on the pool — because a test that passes
 * whichever one the route picks is not holding anything.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('./authorization', () => ({
  can: () => true,
  requirePermission: vi.fn(),
  getPermissionScope: (u: SessionUser & { __scope?: string }) =>
    u.__scope ? { scope: u.__scope } : null,
}));

const { orderVisibilityWhere, applyQueueFilter } = await import('./rbac');

/**
 * The envelope the arrows are built on now — composed exactly as the route
 * composes it: the filters first (here, none), the role's envelope ANDed
 * over the top by `applyQueueFilter`, which is the same call `GET
 * /api/orders` makes. Written the same way so the two cannot drift.
 */
const navigationWhere = (user: SessionUser, queue: string | null = null) =>
  applyQueueFilter(user, { companyId: 'c1', storeId: 's1' }, queue);

const user = (scope: string, role = 'CUSTOM', id = 'u1'): SessionUser =>
  ({ id, status: 'ACTIVE', role, __scope: scope }) as unknown as SessionUser;

/**
 * Does this order satisfy a Prisma-shaped envelope?
 *
 * Understands the three shapes these builders produce: a flat object of
 * equalities, an `OR` of such objects, and an `AND` of either — which is
 * what `applyQueueFilter` returns when it lays the role envelope over the
 * filters. Fields the fixtures do not carry (companyId, storeId) are not
 * about ownership and are skipped.
 */
function matches(envelope: Record<string, unknown>, order: Record<string, unknown>): boolean {
  const SKIP = new Set(['companyId', 'storeId']);
  const clause = (c: Record<string, unknown>): boolean => {
    if (Array.isArray(c.AND)) {
      if (!(c.AND as Record<string, unknown>[]).every(clause)) return false;
    }
    if (Array.isArray(c.OR)) {
      if (!(c.OR as Record<string, unknown>[]).some(clause)) return false;
    }
    return Object.entries(c).every(([field, want]) => {
      if (field === 'AND' || field === 'OR' || SKIP.has(field)) return true;
      return order[field] === want;
    });
  };
  return clause(envelope);
}

/**
 * An unclaimed NEW order: nobody's, and in the pool. `lockedById: null`
 * because the read envelope's pool branch also asks that nobody is holding
 * an editing lock on it, and an unclaimed order never is.
 */
const POOL = {
  claimedById: null,
  createdById: null,
  assignedToId: null,
  currentOwnerId: null,
  moderatorId: null,
  confirmationStatus: 'NEW',
  signatureStatus: 'UNSIGNED',
  lockedById: null,
};

/** One she pulled. Hers by every reading. */
const HERS = {
  claimedById: 'u1',
  createdById: null,
  assignedToId: null,
  currentOwnerId: null,
  moderatorId: null,
};

/** A colleague's, and nothing to do with her. */
const THEIRS = {
  claimedById: 'u2',
  createdById: 'u2',
  assignedToId: null,
  currentOwnerId: 'u2',
  moderatorId: null,
};

describe('the envelope the arrows are built on', () => {
  it('does not carry the unclaimed pool, for any scope that has one', () => {
    for (const scope of ['ASSIGNED', 'OWN']) {
      expect(matches(navigationWhere(user(scope)), POOL), `${scope}: الطابور رجع بالأسهم`).toBe(false);
    }
  });

  it('and the READ envelope still does — so the two are genuinely different things', () => {
    // If this ever goes false the test above stops proving anything: it
    // would pass with either envelope wired in.
    expect(
      matches(orderVisibilityWhere(user('ASSIGNED')), POOL),
      'غلاف القراءة فقد الطابور — السحب بينكسر، والاختبار اللي فوق بطّل يحرس إشي'
    ).toBe(true);
  });

  it('and still carries her own orders, so the arrows are not dead', () => {
    expect(matches(navigationWhere(user('ASSIGNED')), HERS)).toBe(true);
  });

  it('and never a colleague’s', () => {
    expect(matches(navigationWhere(user('ASSIGNED')), THEIRS)).toBe(false);
  });

  it('and `available` is the one queue the route refuses to pass through', () => {
    /*
     * The window hands the list's own search params to this builder. Most
     * `queue` values NARROW — `my_orders`, `assigned_to_me`, `processing` —
     * and honouring them keeps the arrows inside what is on screen. Only
     * `available` adds orders the role's envelope excludes, so the route
     * drops that one value before calling the filter.
     *
     * Asserted on the filter itself to show WHY the route drops it: with
     * `available` the envelope really does carry the pool. That is the
     * back door, and it is a query string away.
     */
    expect(
      matches(navigationWhere(user('ASSIGNED'), 'available'), POOL),
      'لو مرّ queue=available، الأسهم بترجع تمشي بالطابور'
    ).toBe(true);

    // And the narrowing ones are safe to honour: still no pool.
    for (const q of ['my_orders', 'assigned_to_me', 'processing']) {
      expect(matches(navigationWhere(user('ASSIGNED'), q), POOL), q).toBe(false);
    }
  });
});

describe('and the scope decides, not the name of the role', () => {
  it('a custom role on ASSIGNED is treated exactly like the three named ones', () => {
    /*
     * This is the defect the name list produced: `SELF_SCOPED` held
     * MODERATOR · CONFIRMATION_AGENT · FOLLOW_UP_AGENT, so a company that
     * made its own role — «موظّف تأكيد — مسائي» — got the unfiltered
     * branch and walked every order in the store.
     */
    // The list envelope carries a time (the hold of a returning customer's order lets go after a day): freeze it, or two
    // envelopes built a millisecond apart are not equal.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
    const named = navigationWhere(user('ASSIGNED', 'CONFIRMATION_AGENT'));
    const custom = navigationWhere(user('ASSIGNED', 'موظّف تأكيد — مسائي'));
    vi.useRealTimers();
    expect(custom).toEqual(named);
    expect(matches(custom, POOL), 'دور مخصّص بنفس النطاق لسّا بيمشي بالطابور').toBe(false);
    expect(matches(custom, THEIRS), 'دور مخصّص بيمشي بطلبات زميل').toBe(false);
  });

  it('and an owner on ALL_COMPANY still walks everything', () => {
    const owner = navigationWhere(user('ALL_COMPANY', 'COMPANY_ADMIN'));
    for (const order of [POOL, HERS, THEIRS]) {
      expect(matches(owner, order)).toBe(true);
    }
  });
});
