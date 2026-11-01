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

  it('asks the helper the doors build on, with the person’s own keys and id', () => {
    expect(modal).toContain('agentMustPullFirst({');
    expect(modal).toContain('holds: (permission) => userCan(currentUser, permission)');
    expect(modal).toContain('userId: currentUser?.id');
  });

  it('draws the sentence INSTEAD of the call and confirm panel for an agent — never both, never neither', () => {
    expect(modal).toMatch(/mayRecordCalls && mustPullFirst && \(/);
    expect(modal).toMatch(/mayRecordCalls && !mustPullFirst && \(\s*<ConfirmationActions/);
    expect(modal).toContain('{NOT_HELD_MESSAGE}');
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
});
