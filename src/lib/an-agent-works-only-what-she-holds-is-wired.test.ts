import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN AGENT WORKS ONLY WHAT SHE HOLDS — WHERE IT IS ASKED (the owner, 1/11)
 *
 * The behaviour is held by the door tests (`confirmation/an-agent-works-only-what-she-holds.test.ts`, `contact-attempts/an-agent-logs-
 * a-call-only-on-what-she-holds.test.ts`). This reads the SOURCE for the part a behaviour test cannot see: that the check stands in the
 * right place — before the body is read and before any action is decided — and that the screen asks the same helper the doors do,
 * so a later edit that moves it below the first write, or draws the panel again for an agent, turns this red.
 * ═══════════════════════════════════════════════════════════════════════
 */

const src = (file: string) => stripComments(readFileSync(join(process.cwd(), file), 'utf8'));

describe('the confirmation door', () => {
  const door = src('src/app/api/orders/[id]/confirmation/route.ts');

  it('asks the rule, with the permission test of the person, and answers NOT_HELD with the one sentence', () => {
    expect(door).toContain('mustHoldToWork((permission) => can(user, permission)) && order.claimedById !== user.id');
    expect(door).toMatch(/code: 'NOT_HELD' \}, \{ status: 403 \}/);
    expect(door).toContain('error: NOT_HELD_MESSAGE, errorAr: NOT_HELD_MESSAGE');
  });

  it('asks it BEFORE the body is read and before any action is decided — for every action, not one of them', () => {
    const asked = door.indexOf('mustHoldToWork(');
    expect(asked).toBeGreaterThan(-1);
    expect(asked, 'the rule moved below the body').toBeLessThan(door.indexOf('await req.json()'));
    expect(asked, 'the rule moved below the action switch').toBeLessThan(door.indexOf('switch (action)'));
    expect(asked, 'the rule moved below the first write').toBeLessThan(door.indexOf('updateMany'));
  });

  it('keeps its own old refusal first: no confirm key, no answer about holding', () => {
    expect(door.indexOf("authorize(user, 'orders.confirm', order)")).toBeLessThan(door.indexOf('mustHoldToWork('));
  });
});

describe('the call door', () => {
  const door = src('src/app/api/orders/[id]/contact-attempts/route.ts');
  const post = door.slice(door.indexOf('export async function POST'));

  it('asks the same rule, before the body is read and before a row is written', () => {
    expect(post).toContain('mustHoldToWork((permission) => can(user, permission)) && order.claimedById !== user.id');
    expect(post.indexOf('mustHoldToWork(')).toBeLessThan(post.indexOf('await req.json()'));
    expect(post.indexOf('mustHoldToWork(')).toBeLessThan(post.indexOf('orderContactAttempt.create'));
  });

  it('keeps the call key first (CONTACT_LOG_NOT_ALLOWED is still what a person without it is told)', () => {
    expect(post.indexOf("can(user, 'orders.contact_log')")).toBeLessThan(post.indexOf('mustHoldToWork('));
  });

  it('only the POST asks it — reading the history of a call is not working the order', () => {
    const get = door.slice(door.indexOf('export async function GET'), door.indexOf('export async function POST'));
    expect(get.length, 'the GET was not found').toBeGreaterThan(100);
    expect(get).not.toContain('mustHoldToWork');
  });
});

describe('the order sheet', () => {
  const modal = src('src/components/orders/OrderDetailModal.tsx');

  // RV568: the sheet asks `pullFirstNotice` (who is owed a sentence — `agentMustPullFirst` — AND which sentence is true for this order)
  // where it asked `agentMustPullFirst` and printed one sentence for everybody. Same person's keys and id, same panel swap.
  it('asks the helper the doors build on, with the person’s own keys and id, and the order as the server sent it (its holder’s name)', () => {
    expect(modal).toContain('pullFirstNotice({');
    expect(modal).toContain('holds: (permission) => userCan(currentUser, permission)');
    expect(modal).toContain('userId: currentUser?.id');
    expect(modal).toMatch(/pullFirstNotice\(\{[^}]*order,\s*\}\)/);
  });

  it('draws the sentence INSTEAD of the call and confirm panel for an agent — never both, never neither', () => {
    expect(modal).toMatch(/mayRecordCalls && pullNotice && \(/);
    expect(modal).toMatch(/mayRecordCalls && !pullNotice && \(\s*<ConfirmationActions/);
    expect(modal).toContain('{pullNotice.text}');
  });

  it('prints no sentence of its own about pulling — the words come from the helper, so they are true for the order', () => {
    expect(modal).not.toContain('NOT_HELD_MESSAGE');
    expect(modal).not.toContain('اسحبه من');
  });
});

describe('the transfer door', () => {
  const door = src('src/app/api/orders/[id]/transfer/route.ts');

  it('exports only its handlers — a route file may not export a helper (the build refuses it)', () => {
    const exported = [...door.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);
    expect(exported.sort()).toEqual(['GET', 'POST']);
  });

  it('judges a target by «can work» for whoever assigns, and by role for anybody else — never one rule for both', () => {
    expect(door).toContain("audience: { permission: 'confirmation.work' }");
    expect(door).toContain('if (isReassigner) {');
    expect(door).toContain('} else if (holder && !sameRank(holder, target)) {');
    expect(door).toContain("authorize(user, 'orders.assign', order).allowed");
  });

  // RV567: «can work» is `confirmation.work` AND `confirmation.pull` AND `orders.confirm` (`mayBeHandedAnOrder`), asked of the sessions the
  // audience resolver already built — and by ONE function, so the list the screen is offered and the acceptance of the door cannot differ.
  it('asks the three keys of the sessions the resolver returned, inside the one function both halves read', () => {
    const fn = door.slice(door.indexOf('async function whoMayWorkTheOrder'), door.indexOf('async function currentHolder'));
    expect(fn).toContain("audience: { permission: 'confirmation.work' }");
    expect(fn).toContain('.filter((u) => mayBeHandedAnOrder((permission) => can(u, permission)))');
    expect(fn.indexOf('.filter(')).toBeLessThan(fn.indexOf('.map('));
  });

  it('has exactly one resolver call and exactly two readers of the function: the door (POST) and the list (GET)', () => {
    expect(door.match(/resolveAudience\(/g)?.length).toBe(1);
    expect(door.match(/whoMayWorkTheOrder\(/g)?.length, 'definition + POST + GET').toBe(3);
    const post = door.slice(door.indexOf('export async function POST'), door.indexOf('export async function GET'));
    const get = door.slice(door.indexOf('export async function GET'));
    expect(post.match(/whoMayWorkTheOrder\(/g)?.length).toBe(1);
    expect(get.match(/whoMayWorkTheOrder\(/g)?.length).toBe(1);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE DOORS THE INDEPENDENT REVIEW OF #154 FOUND BESIDE THE TWO IT FIXED (2/11) — WHERE EACH IS ASKED
 * The behaviour is held by the real-engine tests next to each door; this reads the SOURCE for what a behaviour test cannot see: that the
 * check stands BEFORE the body is read and before the first write, and that the door kept its older refusals first.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('the call log door (RV566)', () => {
  const door = src('src/app/api/orders/[id]/call-logs/route.ts');

  it('asks the rule with the person’s own permission test, answers NOT_HELD in the one sentence', () => {
    expect(door).toContain('mustHoldToWork((permission) => can(user, permission)) && order.claimedById !== user.id');
    expect(door).toMatch(/code: 'NOT_HELD' \}, \{ status: 403 \}/);
    expect(door).toContain('error: NOT_HELD_MESSAGE, errorAr: NOT_HELD_MESSAGE');
  });

  it('asks it BEFORE the body is read and before the transaction that writes the log and CALL_MADE', () => {
    const asked = door.indexOf('mustHoldToWork(');
    expect(asked).toBeGreaterThan(-1);
    expect(asked, 'the rule moved below the body').toBeLessThan(door.indexOf('await req.json()'));
    expect(asked, 'the rule moved below the transaction').toBeLessThan(door.indexOf('$transaction'));
    expect(asked, 'the rule moved below the log').toBeLessThan(door.indexOf('callLog.create'));
  });

  it('keeps its own older refusals first: the call key, then the edit authority', () => {
    expect(door.indexOf("can(user, 'orders.contact_log')")).toBeLessThan(door.indexOf('mustHoldToWork('));
    expect(door.indexOf("authorize(user, 'orders.edit', order)")).toBeLessThan(door.indexOf('mustHoldToWork('));
  });

  it('stays on `orders.view` and OFF the work door — the holder check is an extra refusal, not a wider entrance', () => {
    expect(door).not.toContain('ORDER_WORK_DOOR');
    expect(door).toContain("'orders.view'");
  });
});

describe('the entry-issue door (RV564)', () => {
  const door = src('src/app/api/confirmation/issues/route.ts');
  const post = door.slice(door.indexOf('export async function POST'));

  it('asks the rule with the person’s own permission test, answers NOT_HELD in the one sentence', () => {
    expect(post).toContain('mustHoldToWork((permission) => can(user, permission)) && order.claimedById !== user.id');
    expect(post).toMatch(/code: 'NOT_HELD' \}, \{ status: 403 \}/);
    expect(post).toContain('error: NOT_HELD_MESSAGE, errorAr: NOT_HELD_MESSAGE');
  });

  it('asks it before anything about the order is judged and before the transaction — after the access check that found the order', () => {
    const asked = post.indexOf('mustHoldToWork(');
    expect(asked).toBeGreaterThan(post.indexOf('assertOrderAccess('));
    expect(asked, 'the rule moved below the moderator check').toBeLessThan(post.indexOf('order.moderatorId'));
    expect(asked, 'the rule moved below the open-issue read').toBeLessThan(post.indexOf('orderIssue.findFirst'));
    expect(asked, 'the rule moved below the transaction').toBeLessThan(post.indexOf('$transaction'));
  });

  it('refuses an order past the confirmation desk from the DERIVED state, for everybody, before the transaction', () => {
    expect(post).toContain('const state = deriveCoreState(order as StateSource);');
    expect(post).toMatch(/if \(zone !== 'INTAKE' && zone !== 'CONFIRMATION'\) \{/);
    expect(post).toContain("code: 'PAST_CONFIRMATION' }, { status: 409 }");
    const past = post.indexOf("zone !== 'INTAKE'");
    expect(past, 'the state rule moved below the transaction').toBeLessThan(post.indexOf('$transaction'));
    expect(past, 'the state rule moved below the open-issue read').toBeLessThan(post.indexOf('orderIssue.findFirst'));
    // not about the person: no key is asked between the state and its refusal
    const block = post.slice(past, post.indexOf("code: 'PAST_CONFIRMATION'"));
    expect(block).not.toMatch(/\bcan\(|mustHoldToWork|authorize\(/);
  });

  it('keeps its own work door and its raising key first', () => {
    expect(post).toContain('ORDER_WORK_DOOR');
    expect(post.indexOf("requirePermission('confirmation.raise_issue')")).toBeLessThan(post.indexOf('mustHoldToWork('));
  });

  it('only the POST asks — reading the list of issues is not working an order', () => {
    const get = door.slice(door.indexOf('export async function GET'), door.indexOf('export async function POST'));
    expect(get.length, 'the GET was not found').toBeGreaterThan(100);
    expect(get).not.toContain('mustHoldToWork');
  });
});

describe('the claim-by-number door (RV565)', () => {
  const door = src('src/app/api/orders/[id]/claim/route.ts');
  const post = door.slice(door.indexOf('export async function POST'), door.indexOf('export async function DELETE'));
  const del = door.slice(door.indexOf('export async function DELETE'));

  it('refuses a bound account with a code of its own — not NOT_HELD — and the sentence that points to the pull', () => {
    expect(post).toContain('mustHoldToWork((permission) => can(user, permission))');
    expect(post).toContain('claimByNumberMessage((permission) => can(user, permission))');
    expect(post).toContain('code: USE_THE_PULL_CODE }, { status: 403 }');
    expect(post).not.toContain("'NOT_HELD'");
  });

  it('asks it in the NORMAL branch only — after the claim key, before the hold is written, before the order is read, before the claim', () => {
    const asked = post.indexOf('mustHoldToWork(');
    expect(asked).toBeGreaterThan(post.indexOf("can(user, 'orders.claim')"));
    expect(asked, 'the rule moved below the best-effort hold').toBeLessThan(post.indexOf('reserveReturningCustomers('));
    expect(asked, 'the rule moved below the order read').toBeLessThan(post.indexOf('assertOrderAccess(id, user, { companyId, storeId })'));
    expect(asked, 'the rule moved below the claim').toBeLessThan(post.indexOf('atomicClaim('));
  });

  it('the owner’s override branch is above it and is not asked; neither is the release door', () => {
    const override = post.slice(post.indexOf("mode === 'override'"), post.indexOf("can(user, 'orders.claim')"));
    expect(override.length, 'the override branch was not found').toBeGreaterThan(200);
    expect(override).not.toContain('mustHoldToWork');
    expect(del).not.toContain('mustHoldToWork');
  });

  it('the claim stays off the work door: it is the pull that takes (the-order-she-holds.test.ts lists only the DELETE)', () => {
    expect(post).not.toContain('ORDER_WORK_DOOR');
  });
});

describe('the library says what is true about the claim door', () => {
  const raw = readFileSync(join(process.cwd(), 'src/lib/confirmation-queue.ts'), 'utf8');

  it('no longer claims the agent has a claim-by-number door — it names the refusal instead', () => {
    expect(raw, 'the old sentence is back').not.toContain('which the live agent holds); no screen calls it');
    expect(raw).toContain('USE_THE_PULL');
    expect(raw).toContain('the ONLY way an order reaches an agent');
  });
});

describe('the pre-deploy report lists who the rule does not bind (RV570)', () => {
  const sql = readFileSync(join(process.cwd(), 'scripts', 'permission-predeploy-report.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const section = code.slice(code.indexOf('WITH people AS ('));

  it('has the section, after everything else', () => {
    expect(code.indexOf('WITH people AS (')).toBeGreaterThan(code.indexOf("'team.monitor'"));
    expect(section.length).toBeGreaterThan(500);
  });

  it('asks the three keys of the rule, from the same tables the engine reads: the role’s rows and the person’s own allow / deny', () => {
    for (const key of ["'confirmation.work'", "'orders.unlock'", "'orders.assign'"]) expect(section, key).toContain(key);
    // The keys are asked ONCE, as one list: a key dropped from it leaves its join empty and the report silent about everybody.
    expect(section).toContain("(VALUES ('confirmation.work'), ('orders.unlock'), ('orders.assign')) AS k(\"key\")");
    expect(section).toContain("JOIN how ul ON ul.\"id\" = w.\"id\" AND ul.\"key\" = 'orders.unlock'");
    expect(section).toContain("JOIN how asg ON asg.\"id\" = w.\"id\" AND asg.\"key\" = 'orders.assign'");
    expect(section).toContain('"role_permissions"');
    expect(section).toContain('"user_permissions"');
    expect(section).toContain("d.\"effect\" = 'DENY'");
  });

  it('keeps to people who can act: ACTIVE only, and SUPER_ADMIN (full access) named as such', () => {
    expect(section).toContain("u.\"status\" = 'ACTIVE'");
    expect(section).toContain("'SUPER_ADMIN'");
    expect(section).toContain("'full access'");
  });

  it('lists the person who holds the desk key AND one of the two keys — not either alone', () => {
    expect(section).toMatch(/w\."key" = 'confirmation\.work' AND w\."via" IS NOT NULL\s+AND \(ul\."via" IS NOT NULL OR asg\."via" IS NOT NULL\)/);
  });

  it('writes nothing — and its tuples are not mistaken for a catalog pair by the pairs guard', () => {
    const stripped = section.replace(/'[^']*'/g, "''");
    expect(stripped).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i);
    expect([...section.matchAll(/\('([a-z_.]+)','([a-z_.]+)'\)/g)]).toEqual([]);
  });
});
