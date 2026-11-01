import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { can, attachGrants } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { agentMustPullFirst, NOT_HELD_MESSAGE, OPEN_CONFIRMATION, pullFirstNotice } from './confirmation-queue';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE SHEET'S «اسحبه أولاً» IS TRUE FOR THE ORDER IT IS ABOUT
 * (the independent review of #154, 2/11 — BACKLOG RV568)
 *
 * One sentence said «اسحبه من اسحب التالي» to every bound agent. It was wrong twice:
 *
 *  1. when a COLLEAGUE holds the order: the pull never gives it to her. The sheet says WHO — «الطلب مع <الاسم>» — and gives no
 *     instruction to pull;
 *  2. when she holds no `confirmation.pull`: there is no button. The sheet says the order is not hers, and gives no instruction to pull;
 *  3. when NOBODY holds it and she may pull: today's sentence, word for word.
 *
 * `agentMustPullFirst` (who is owed a sentence at all) is untouched and still decides it: the notice is `null` exactly when it is false.
 * The person's keys come from the REAL engine (`computeEffectiveGrants` + `attachGrants` + `can`), never from a hand-written predicate.
 *
 * Blockers: no money, no order creation.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** CONFIRMATION_AGENT, live, 1/11 (`GET /api/roles`): all 22 keys at the whole company. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
const LIVE_MANAGER = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.assign', 'orders.unlock', 'confirmation.supervise'];
const LIVE_MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.claim'];

async function holdsOf(id: string, role: string, keys: string[]): Promise<(permission: string) => boolean> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  const user = attachGrants(base, grants);
  return (permission) => can(user, permission);
}

/** The sentence the sheet said to everyone before this change — kept byte for byte for the case that did not change. */
const TODAYS_SENTENCE = `${NOT_HELD_MESSAGE}. اسحبه من «اسحب التالي» أو افتحه من «طلباتي»، وبعدها اتصل وأكّد.`;

const waiting = { claimedById: null, confirmationStatus: 'NEW' };
const heldByColleague = (name?: string | null) => ({
  claimedById: 'a2', confirmationStatus: 'IN_PROGRESS', ...(name === undefined ? {} : { claimer: { name } }),
});

describe('a COLLEAGUE holds the order ⇒ «الطلب مع <الاسم>», and no instruction to pull', () => {
  it('the live agent (she HAS the pull) is not sent to a button that will never give it to her', async () => {
    const abeer = await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const n = pullFirstNotice({ holds: abeer, userId: 'a1', order: heldByColleague('ليلى') })!;
    expect(n.kind).toBe('HELD_BY_COLLEAGUE');
    expect(n.text).toContain('الطلب مع ليلى');
    expect(n.text, 'تعليمة سحب لطلب مع زميلتها').not.toMatch(/اسحب/);
    expect(n.text).not.toContain('طلباتي');
  });

  it('the name is the holder’s, trimmed; a row that did not carry it says «موظف تاني»', async () => {
    const abeer = await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT);
    expect(pullFirstNotice({ holds: abeer, userId: 'a1', order: heldByColleague('  ريم ') })!.text).toContain('الطلب مع ريم —');
    for (const order of [heldByColleague(undefined), heldByColleague(null), heldByColleague('   '), { ...heldByColleague(), claimer: null }]) {
      expect(pullFirstNotice({ holds: abeer, userId: 'a1', order })!.text).toContain('الطلب مع موظف تاني');
    }
  });

  it('every open state says the same — the colleague holds it whichever step she is on', async () => {
    const abeer = await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT);
    for (const confirmationStatus of OPEN_CONFIRMATION) {
      const n = pullFirstNotice({ holds: abeer, userId: 'a1', order: { claimedById: 'a2', confirmationStatus, claimer: { name: 'ليلى' } } });
      expect(n?.kind, confirmationStatus).toBe('HELD_BY_COLLEAGUE');
    }
  });

  it('and an agent with NO pull is told who holds it, not that she cannot pull', async () => {
    const dina = await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT.filter((k) => k !== 'confirmation.pull'));
    const n = pullFirstNotice({ holds: dina, userId: 'a1', order: heldByColleague('ليلى') })!;
    expect(n.kind).toBe('HELD_BY_COLLEAGUE');
    expect(n.text).toContain('الطلب مع ليلى');
  });
});

describe('NOBODY holds it and she may pull ⇒ today’s sentence, word for word', () => {
  it('the live agent', async () => {
    const abeer = await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const n = pullFirstNotice({ holds: abeer, userId: 'a1', order: waiting })!;
    expect(n.kind).toBe('PULL');
    expect(n.text).toBe(TODAYS_SENTENCE);
  });

  it('every open state', async () => {
    const abeer = await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT);
    for (const confirmationStatus of OPEN_CONFIRMATION) {
      expect(pullFirstNotice({ holds: abeer, userId: 'a1', order: { claimedById: null, confirmationStatus } })?.text, confirmationStatus).toBe(TODAYS_SENTENCE);
    }
  });
});

describe('NOBODY holds it and she may NOT pull ⇒ the order is not hers, and there is no button to press', () => {
  it('an agent who works orders without `confirmation.pull`', async () => {
    const dina = await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT.filter((k) => k !== 'confirmation.pull'));
    const n = pullFirstNotice({ holds: dina, userId: 'a1', order: waiting })!;
    expect(n.kind).toBe('NOT_YOURS');
    expect(n.text).toContain('الطلب مو إلك');
    expect(n.text, 'تعليمة سحب لمن لا تملك السحب').not.toMatch(/اسحب|اسحبه|طلباتي/);
  });
});

describe('the sheet owes nothing — null — exactly when `agentMustPullFirst` says so', () => {
  it('the order is hers', async () => {
    const abeer = await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT);
    expect(pullFirstNotice({ holds: abeer, userId: 'a1', order: { claimedById: 'a1', confirmationStatus: 'IN_PROGRESS' } })).toBeNull();
  });

  it('the order is already decided: confirmed, rejected, cancelled — held or not', async () => {
    const abeer = await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT);
    for (const confirmationStatus of ['CONFIRMED', 'REJECTED', 'CANCELLED']) {
      for (const claimedById of [null, 'a2']) {
        expect(pullFirstNotice({ holds: abeer, userId: 'a1', order: { claimedById, confirmationStatus } }), `${confirmationStatus}/${claimedById}`).toBeNull();
      }
    }
  });

  it('the owner, a manager and a moderator are owed no sentence — on any order', async () => {
    const owner = await holdsOf('o', 'SUPER_ADMIN', []);
    const manager = await holdsOf('m', 'MANAGER', LIVE_MANAGER);
    const moderator = await holdsOf('x', 'MODERATOR', LIVE_MODERATOR);
    for (const holds of [owner, manager, moderator]) {
      for (const order of [waiting, heldByColleague('ليلى')]) {
        expect(pullFirstNotice({ holds, userId: 'z', order })).toBeNull();
      }
    }
  });

  it('an agent whose role was given `orders.unlock` or `orders.assign` is owed none — the rule is off for her', async () => {
    for (const key of ['orders.unlock', 'orders.assign']) {
      const holds = await holdsOf('a1', 'CONFIRMATION_AGENT', [...LIVE_AGENT, key]);
      expect(pullFirstNotice({ holds, userId: 'a1', order: waiting }), key).toBeNull();
    }
  });

  it('the notice and `agentMustPullFirst` never disagree, over every person and order there is', async () => {
    const persons = {
      live: await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT),
      noPull: await holdsOf('a1', 'CONFIRMATION_AGENT', LIVE_AGENT.filter((k) => k !== 'confirmation.pull')),
      manager: await holdsOf('a1', 'MANAGER', LIVE_MANAGER),
      moderator: await holdsOf('a1', 'MODERATOR', LIVE_MODERATOR),
    };
    const statuses = [...OPEN_CONFIRMATION, 'CONFIRMED', 'REJECTED', 'CANCELLED'];
    let compared = 0;
    for (const [who, holds] of Object.entries(persons)) {
      for (const confirmationStatus of statuses) {
        for (const claimedById of [null, 'a1', 'a2']) {
          const args = { holds, userId: 'a1', order: { claimedById, confirmationStatus } };
          expect(pullFirstNotice(args) !== null, `${who}/${confirmationStatus}/${claimedById}`).toBe(agentMustPullFirst(args));
          compared++;
        }
      }
    }
    expect(compared).toBe(4 * 8 * 3);
  });
});
