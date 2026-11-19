import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/types/auth';
import { attachGrants, can, hasFullAccess } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { mustHoldToWork } from './confirmation-queue';
import { ALL_CATALOG_KEYS } from './permission-catalog';
import { DESK_KEYS, DESK_TOOLS, EXEMPTS_FROM_HOLD, deskReadiness, labelledReadiness, type DeskToolId } from './desk-readiness';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (Q1a, 19/11) — `deskReadiness`, asked of persons built the way a session builds them.
 *
 *  1. Table: the live agent · the supervisor template · a moderator · the owner · a follow-up agent · a warehouse person — each
 *     through `computeEffectiveGrants` → `attachGrants` → the real `can`, never a key list read directly.
 *  2. `confirmation.supervise` frees nobody (the 1/11 mistake): the live agent holds it and is BOUND.
 *  3. The owner is the owner — never «exempt», never missing a tool.
 *  4. A personal «منع» on `confirmation.work` and a personal «سماح» of `orders.assign` change her answer and nobody else's.
 *  5. PIN: every key `DESK_TOOLS` lists is asked by the door it names, in that door's own source.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** CONFIRMATION_AGENT, read on the live site 1/11 (the same list as the-live-agent-is-refused-by-the-real-engine.test.ts). */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** The CONFIRMATION_SUPERVISOR template: works a queue to watch it — no pull, no decision, no call log. */
const SUPERVISOR = ['confirmation.work', 'confirmation.supervise', 'confirmation.issues', 'orders.view', 'customers.view_basic', 'reports.view', 'dashboard.view'];
/** A moderator: decides and logs calls on the orders he brings, without «العمل على طلباتي». */
const MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.claim', 'orders.release', 'confirmation.raise_issue'];
/** A follow-up agent: works and pulls like an agent, with no supervise. */
const FOLLOW_UP = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.view', 'orders.release'];
/** A warehouse person: no key of the desk at all. */
const WAREHOUSE = ['orders.view', 'dashboard.view'];
/** A manager: takes and gives any order. */
const MANAGER = ['confirmation.work', 'orders.view', 'orders.confirm', 'orders.unlock', 'orders.assign', 'orders.contact_log', 'orders.edit'];

async function person(
  role: string,
  keys: string[],
  over: { allow?: string[]; deny?: string[] } = {}
): Promise<SessionUser> {
  const base = { id: `u-${role}`, email: 'x@x', name: role, role, roleId: role === 'SUPER_ADMIN' ? null : `r-${role}`, status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [
      ...(over.deny ?? []).map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
      ...(over.allow ?? []).map((k) => ({ permission: k, effect: 'ALLOW', scope: 'ALL_COMPANY', scopeIds: null })),
    ],
  });
  return attachGrants(base, grants);
}

const readinessOf = (u: SessionUser) => deskReadiness((k) => can(u, k), { fullAccess: hasFullAccess(u) });
const toolsHad = (r: ReturnType<typeof deskReadiness>) =>
  Object.fromEntries(r.tools.map((t) => [t.id, t.has])) as Record<DeskToolId, boolean>;

describe('deskReadiness — six real shapes, through the real engine', () => {
  it.each([
    {
      who: 'the live agent (holds confirmation.supervise)', role: 'CONFIRMATION_AGENT', keys: LIVE_AGENT,
      atDesk: true, hold: 'BOUND', bound: true, exemptBy: [], decidesWithoutWork: false, handed: true, owner: false,
      tools: { pull: true, log_call: true, decide: true, on_the_line: true, hand_over: true, raise_issue: true },
    },
    {
      who: 'the supervisor template', role: 'CONFIRMATION_SUPERVISOR', keys: SUPERVISOR,
      atDesk: true, hold: 'BOUND', bound: true, exemptBy: [], decidesWithoutWork: false, handed: false, owner: false,
      tools: { pull: false, log_call: false, decide: false, on_the_line: false, hand_over: false, raise_issue: false },
    },
    {
      who: 'a moderator', role: 'MODERATOR', keys: MODERATOR,
      atDesk: true, hold: 'DOES_NOT_WORK', bound: false, exemptBy: [], decidesWithoutWork: true, handed: false, owner: false,
      tools: { pull: false, log_call: true, decide: true, on_the_line: false, hand_over: true, raise_issue: true },
    },
    {
      who: 'the owner', role: 'SUPER_ADMIN', keys: [],
      atDesk: true, hold: 'OWNER', bound: false, exemptBy: ['orders.unlock', 'orders.assign'], decidesWithoutWork: false, handed: true, owner: true,
      tools: { pull: true, log_call: true, decide: true, on_the_line: true, hand_over: true, raise_issue: true },
    },
    {
      who: 'a follow-up agent', role: 'FOLLOW_UP_AGENT', keys: FOLLOW_UP,
      atDesk: true, hold: 'BOUND', bound: true, exemptBy: [], decidesWithoutWork: false, handed: true, owner: false,
      tools: { pull: true, log_call: true, decide: true, on_the_line: true, hand_over: true, raise_issue: false },
    },
    {
      who: 'a warehouse person', role: 'WAREHOUSE', keys: WAREHOUSE,
      atDesk: false, hold: 'DOES_NOT_WORK', bound: false, exemptBy: [], decidesWithoutWork: false, handed: false, owner: false,
      tools: { pull: false, log_call: false, decide: false, on_the_line: false, hand_over: false, raise_issue: false },
    },
    {
      who: 'a manager (takes and gives any order)', role: 'MANAGER', keys: MANAGER,
      atDesk: true, hold: 'EXEMPT', bound: false, exemptBy: ['orders.unlock', 'orders.assign'], decidesWithoutWork: false, handed: false, owner: false,
      tools: { pull: false, log_call: true, decide: true, on_the_line: false, hand_over: true, raise_issue: false },
    },
  ])('$who', async (c) => {
    const u = await person(c.role, c.keys);
    const r = readinessOf(u);
    expect(DESK_KEYS.some((k) => can(u, k))).toBe(c.atDesk);
    expect(r.owner).toBe(c.owner);
    expect(r.hold).toBe(c.hold);
    expect(r.boundToHold).toBe(c.bound);
    expect(r.exemptBy).toEqual(c.exemptBy);
    expect(r.decidesWithoutWork).toBe(c.decidesWithoutWork);
    expect(r.mayBeHanded).toBe(c.handed);
    expect(toolsHad(r)).toEqual(c.tools);
  });

  it('confirmation.supervise is not an exemption — the agent holding it is bound, and nothing frees her', async () => {
    const r = readinessOf(await person('CONFIRMATION_AGENT', LIVE_AGENT));
    expect(r.boundToHold).toBe(true);
    expect(r.exemptBy).toEqual([]);
    expect(EXEMPTS_FROM_HOLD).not.toContain('confirmation.supervise');
  });

  it('the owner is never missing a key, and is said to be the owner, not exempt', async () => {
    const r = readinessOf(await person('SUPER_ADMIN', []));
    expect(r.tools.every((t) => t.has && t.missing.length === 0)).toBe(true);
    expect(r.hold).toBe('OWNER');
  });

  it('a holder of every key who is NOT full access is exempt by name, not «the owner»', async () => {
    const r = readinessOf(await person('COMPANY_ADMIN', [...ALL_CATALOG_KEYS]));
    expect(r.owner).toBe(false);
    expect(r.hold).toBe('EXEMPT');
  });
});

describe('a personal exception is her truth', () => {
  it('a «منع» on confirmation.work: she is no longer bound, and she decides without working', async () => {
    const r = readinessOf(await person('CONFIRMATION_AGENT', LIVE_AGENT, { deny: ['confirmation.work'] }));
    expect(r.worksDesk).toBe(false);
    expect(r.boundToHold).toBe(false);
    expect(r.hold).toBe('DOES_NOT_WORK');
    expect(r.decidesWithoutWork).toBe(true);
    expect(r.tools.find((t) => t.id === 'on_the_line')!.missing).toEqual([['confirmation.work']]);
  });

  it('a «سماح» of orders.assign frees her by that key, and says so', async () => {
    const r = readinessOf(await person('CONFIRMATION_AGENT', LIVE_AGENT, { allow: ['orders.assign'] }));
    expect(r.boundToHold).toBe(false);
    expect(r.hold).toBe('EXEMPT');
    expect(r.exemptBy).toEqual(['orders.assign']);
  });

  it('a «منع» on orders.view takes «الزبون على الخط» and the hand-over, each naming what is missing', async () => {
    const r = readinessOf(await person('CONFIRMATION_AGENT', LIVE_AGENT, { deny: ['orders.view'] }));
    expect(r.tools.find((t) => t.id === 'on_the_line')!.missing).toEqual([['orders.view']]);
    expect(r.tools.find((t) => t.id === 'hand_over')!.missing).toEqual([['orders.view']]);
    expect(r.tools.find((t) => t.id === 'pull')!.has).toBe(true);
  });

  it('a group of which any key is enough is missing as the whole group', async () => {
    const r = readinessOf(await person('CONFIRMATION_AGENT', LIVE_AGENT, { deny: ['orders.edit', 'orders.claim'] }));
    expect(r.tools.find((t) => t.id === 'log_call')!.missing).toEqual([['orders.edit', 'orders.claim']]);
  });
});

describe('boundToHold IS mustHoldToWork, for every subset of the keys it reads', () => {
  it('agrees on all 2^4 combinations of work / unlock / assign / supervise', () => {
    const keys = ['confirmation.work', 'orders.unlock', 'orders.assign', 'confirmation.supervise'];
    for (let mask = 0; mask < 16; mask++) {
      const held = new Set(keys.filter((_, i) => mask & (1 << i)));
      const holds = (k: string) => held.has(k);
      expect(deskReadiness(holds).boundToHold, [...held].join(',')).toBe(mustHoldToWork(holds));
      // Spelled out independently of the function: work, and neither of the two exempting keys.
      expect(mustHoldToWork(holds)).toBe(held.has('confirmation.work') && !held.has('orders.unlock') && !held.has('orders.assign'));
      // And the list the screens read says the same thing as the rule: bound = works and holds none of EXEMPTS_FROM_HOLD.
      expect(mustHoldToWork(holds)).toBe(held.has('confirmation.work') && !EXEMPTS_FROM_HOLD.some((k) => held.has(k)));
    }
  });

  it('the rule’s own line names exactly the keys of EXEMPTS_FROM_HOLD (it writes them out to keep the desk bundle at its ceiling)', () => {
    const source = readFileSync(join(__dirname, 'confirmation-queue.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function mustHoldToWork'), source.indexOf('export const NOT_HELD_MESSAGE'));
    const excused = [...body.matchAll(/!holds\('([a-z_]+\.[a-z_]+)'\)/g)].map((m) => m[1]).sort();
    expect(excused).toEqual([...EXEMPTS_FROM_HOLD].sort());
  });
});

describe('labels', () => {
  it('every key a tool or an exemption names has an Arabic name in the catalog', () => {
    const named = new Set([...DESK_KEYS, ...EXEMPTS_FROM_HOLD, ...DESK_TOOLS.flatMap((t) => [...t.all, ...(t.anyOf ?? []).flat()])]);
    for (const k of named) expect(ALL_CATALOG_KEYS.has(k), k).toBe(true);
  });

  it('a missing group reads «a» أو «b», and nothing English reaches the label', async () => {
    const r = labelledReadiness(readinessOf(await person('CONFIRMATION_AGENT', LIVE_AGENT, { deny: ['orders.edit', 'orders.claim'] })));
    const label = r.tools.find((t) => t.id === 'log_call')!.missing[0].label;
    expect(label).toContain(' أو ');
    expect(label).not.toMatch(/[A-Za-z]/);
    for (const t of r.tools) expect(t.labelAr).not.toMatch(/[A-Za-z]/);
  });
});

describe('PIN — each key DESK_TOOLS lists is asked by the door it names', () => {
  const ROOT = join(__dirname, '..', '..');
  const ASKED_BY = /(?:can|requirePermission|authorize|assertOrderAccess|assertOrderReadable)\([^;]*?'([a-z_]+\.[a-z_]+)'/g;

  it.each(DESK_TOOLS.map((t) => [t.id, t] as const))('%s', (_id, tool) => {
    const source = readFileSync(join(ROOT, tool.door), 'utf8');
    const asked = new Set([...source.matchAll(ASKED_BY)].map((m) => m[1]));
    for (const key of [...tool.all, ...(tool.anyOf ?? []).flat()]) {
      expect(asked.has(key), `${tool.door} لا يسأل «${key}» — تعديل DESK_TOOLS أو الباب`).toBe(true);
    }
  });

  it('the pin itself goes red for a key the door does not ask', () => {
    const source = readFileSync(join(ROOT, 'src/app/api/confirmation/pull/route.ts'), 'utf8');
    const asked = new Set([...source.matchAll(ASKED_BY)].map((m) => m[1]));
    expect(asked.has('orders.confirm')).toBe(false);
  });
});
