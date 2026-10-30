import { beforeEach, describe, expect, it, vi } from 'vitest';

const { can } = vi.hoisted(() => ({ can: vi.fn() }));
vi.mock('./authorization', () => ({ can: (...a: unknown[]) => can(...a) }));

import { deciderFor, mayDecide } from './change-request-routing';
import type { SessionUser } from '@/types/auth';

/**
 * Who answers "can this still be changed?".
 *
 * Only the person currently holding the order can, and that person moves as
 * the order travels. Route it to the wrong one and you either add a wait
 * for an answer the waiter cannot give, or you let somebody promise a
 * change to a customer whose parcel is already on a van.
 */

const SARA = 'user-sara';
const user = (id: string, role: string) => ({ id, role, permissions: [] }) as unknown as SessionUser;

const onHerDesk = { confirmationStatus: 'IN_PROGRESS', claimedById: SARA };
const inOperations = { confirmationStatus: 'CONFIRMED', claimedById: SARA };
const unclaimed = { confirmationStatus: 'NEW', claimedById: null };
/**
 * Confirmed, and the courier has NOT taken it. The waybill may well be
 * printed — that commits the goods, not the box — so this is still the
 * warehouse's to answer, and its approval is what the reprint shows.
 */
const onOurFloor = { confirmationStatus: 'CONFIRMED', claimedById: SARA, handedToCourier: false };
/** Confirmed, and «زر سلّمت الشركة» has been pressed: it is gone. */
const goneOut = { confirmationStatus: 'CONFIRMED', claimedById: SARA, handedToCourier: true };

beforeEach(() => {
  vi.clearAllMocks();
  can.mockReturnValue(false);
});

describe('who the decider is', () => {
  it('is the agent holding an order that is not confirmed yet', () => {
    expect(deciderFor(onHerDesk)).toEqual({ kind: 'HOLDING_AGENT', userId: SARA });
  });

  it('is the supervisor once the order is confirmed and into operations', () => {
    expect(deciderFor(inOperations)).toEqual({ kind: 'SUPERVISOR' });
  });

  it('is the supervisor when nobody is holding it', () => {
    // An unclaimed order has no informed opinion to ask.
    expect(deciderFor(unclaimed)).toEqual({ kind: 'SUPERVISOR' });
  });

  it('stays with the supervisor for every stage past confirmation', () => {
    for (const status of ['CONFIRMED', 'REJECTED', 'CANCELLED']) {
      expect(deciderFor({ confirmationStatus: status, claimedById: SARA }).kind).toBe('SUPERVISOR');
    }
  });

  it('keeps it with the agent through every stage of her own work', () => {
    for (const status of ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED']) {
      expect(deciderFor({ confirmationStatus: status, claimedById: SARA }).kind).toBe('HOLDING_AGENT');
    }
  });
});

describe('who may decide', () => {
  it('lets the holding agent decide her own order', () => {
    expect(mayDecide(user(SARA, 'CONFIRMATION_AGENT'), onHerDesk).allowed).toBe(true);
  });

  it('refuses another agent who happens to be logged in', () => {
    const verdict = mayDecide(user('someone-else', 'CONFIRMATION_AGENT'), onHerDesk);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('موظف التأكيد');
  });

  it('refuses the agent once the order has moved into operations', () => {
    // Whether the courier can still be reached was never her authority.
    const verdict = mayDecide(user(SARA, 'CONFIRMATION_AGENT'), inOperations);
    expect(verdict.allowed).toBe(false);
    // The refusal now names WHERE the parcel is rather than the stage it
    // is in, because the stage no longer decides on its own: a confirmed
    // order still on our floor is the warehouse's to answer.
    expect(verdict.reason).toContain('شركة الشحن');
  });

  it('lets whoever HOLDS the permission decide at either stage', () => {
    /*
     * An escalation path that stops working because one person went home
     * is not a path — so this is still true at both stages. What changed
     * is WHY: it used to be true because `CONFIRMATION_SUPERVISOR` is in
     * `SUPERVISOR_ROLES`, a list that `can()` could not switch off. The
     * owner unticking «طلبات التعديل» for a role did nothing, which is
     * the one screen built for keeping the final say.
     *
     * Now the name decides nothing and the permission decides everything.
     * The migration grants it to exactly those roles, so the day after
     * the deploy the same people decide — and from then on it holds.
     */
    can.mockImplementation((_u: unknown, key: string) => key === 'control.change_requests');
    const sup = user('sup', 'CONFIRMATION_SUPERVISOR');
    expect(mayDecide(sup, onHerDesk).allowed).toBe(true);
    expect(mayDecide(sup, inOperations).allowed).toBe(true);
  });

  it('and a supervisor the owner has unticked no longer decides', () => {
    // The whole point: the name used to be authority, and could not be
    // withdrawn. `can` returns false for everything here.
    const sup = user('sup', 'CONFIRMATION_SUPERVISOR');
    expect(mayDecide(sup, inOperations).allowed, 'الاسم لسّا بيعطي سلطة').toBe(false);
  });

  it('treats the permission as the authority, not the job title', () => {
    can.mockReturnValue(true);
    expect(mayDecide(user('whoever', 'SETTLEMENT_OFFICER'), inOperations).allowed).toBe(true);
    expect(can).toHaveBeenCalledWith(expect.anything(), 'control.change_requests');
  });

  it('lets the owner decide anything, because he holds every permission', () => {
    // Not special-cased by name: `SUPER_ADMIN` holds every key in this
    // system, so it holds this one — which is why dropping the name list
    // takes nothing away from him.
    can.mockImplementation((_u: unknown, key: string) => key === 'control.change_requests');
    expect(mayDecide(user('owner', 'SUPER_ADMIN'), inOperations).allowed).toBe(true);
  });

  it('reports the decider even when refusing, so the UI can name them', () => {
    const verdict = mayDecide(user('other', 'MODERATOR'), onHerDesk);
    expect(verdict.allowed).toBe(false);
    expect(verdict.decider).toEqual({ kind: 'HOLDING_AGENT', userId: SARA });
  });
});

/**
 * THE WAREHOUSE'S WINDOW.
 *
 * «مين بشوفه؟ المالك، السوبر أدمن، والمسؤول عن المخزن» — and «بس في حالة
 * إنشاء شحنة وما انترحّل للشحن». The question at that stage is «can what
 * goes in the box still change?», and the only person who knows is the one
 * standing at the packing table. Once the waybill is printed the box
 * cannot be opened, and their answer would be about goods they no longer
 * control.
 */
describe('the warehouse, while the goods are on its floor', () => {
  const warehouse = user('user-w', 'WAREHOUSE');
  // PR-7: the packing table is a KEY now (`ops.decide_changes`), given by the migration to every holder of `ops.ship` and
  // every person whose role is WAREHOUSE. The warehouse person of these tests is the person AFTER the deploy.
  const holdsTheDecideKey = () => can.mockImplementation((_u: unknown, p: string) => p === 'ops.decide_changes');

  it('decides a confirmed order that has not left', () => {
    holdsTheDecideKey();
    expect(deciderFor(onOurFloor)).toEqual({ kind: 'WAREHOUSE' });
    expect(mayDecide(warehouse, onOurFloor).allowed).toBe(true);
  });

  it('and does not once the waybill is printed', () => {
    holdsTheDecideKey();
    expect(deciderFor(goneOut)).toEqual({ kind: 'SUPERVISOR' });
    const v = mayDecide(warehouse, goneOut);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('شركة الشحن');
  });

  /**
   * A PRINTED LABEL IS NOT THE LINE.
   *
   * The first version of this used `hasLeftWarehouse`, which starts at the
   * printed waybill — so the warehouse lost its say the moment a label
   * came off the printer, with the parcel still three feet away. The
   * commitment of the GOODS and the openability of the BOX are two
   * questions and they keep two answers.
   */
  it('and a labelled parcel still on our floor is theirs to answer', () => {
    // hasLeftWarehouse would be true here — labelled, not handed over.
    const labelledNotGone = {
      confirmationStatus: 'CONFIRMED',
      claimedById: SARA,
      handedToCourier: false,
    };
    holdsTheDecideKey();
    expect(deciderFor(labelledNotGone)).toEqual({ kind: 'WAREHOUSE' });
    expect(mayDecide(warehouse, labelledNotGone).allowed).toBe(true);
  });

  /**
   * THE SAFE WAY ROUND. A caller that has not been taught to pass the fact
   * must deny the warehouse, never grant it on a parcel already in a van.
   */
  it('and a caller that says nothing about the parcel denies them', () => {
    holdsTheDecideKey();
    const silent = { confirmationStatus: 'CONFIRMED', claimedById: SARA };
    expect(deciderFor(silent)).toEqual({ kind: 'SUPERVISOR' });
    expect(mayDecide(warehouse, silent).allowed).toBe(false);
  });

  it('and the KEY is the authority — the job title and the old packing key no longer open it by themselves (PR-7)', () => {
    // The key, whatever the person's role is called.
    holdsTheDecideKey();
    expect(mayDecide(user('user-x', 'SOMETHING_ELSE'), onOurFloor).allowed).toBe(true);
    // NEGATIVE: the name WAREHOUSE with no key decides nothing — the owner can now untick the warehouse person.
    can.mockReturnValue(false);
    expect(mayDecide(warehouse, onOurFloor).allowed, 'الاسم لسّا بيعطي سلطة').toBe(false);
    // NEGATIVE: `ops.ship` alone no longer opens it either; the migration gave its holders `ops.decide_changes`.
    can.mockImplementation((_u: unknown, p: string) => p === 'ops.ship');
    expect(mayDecide(user('user-y', 'SOMETHING_ELSE'), onOurFloor).allowed, 'ops.ship لسّا بيفتح الباب').toBe(false);
  });

  /**
   * AND NOBODY ELSE. Asserting only who MAY decide leaves the rule open at
   * the other end: a version of `isWarehouse` that returned true for
   * everyone passed every test above it, and the confirmation agent whose
   * order it is would have been deciding her own requests at the packing
   * stage. The mutation run is what found that.
   */
  it('and a passer-by with neither the role nor the permission is refused', () => {
    can.mockReturnValue(false);
    for (const role of ['CONFIRMATION_AGENT', 'MODERATOR', 'ACCOUNTANT', 'DELIVERY_MANAGER']) {
      const v = mayDecide(user('user-' + role, role), onOurFloor);
      expect(v.allowed, role).toBe(false);
      expect(v.reason, role).toContain('المستودع');
    }
  });

  /** Before confirmation nothing changed: it is still the agent's call. */
  it('and it does not take the order off the agent before confirmation', () => {
    expect(deciderFor({ ...onHerDesk, handedToCourier: false })).toEqual({
      kind: 'HOLDING_AGENT',
      userId: SARA,
    });
  });
});
