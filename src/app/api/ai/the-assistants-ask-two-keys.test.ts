import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EVERY HELPER INSIDE A SCREEN ASKS TWO KEYS: THE WORK'S AND «المساعدون الأذكياء» (perm-plan PR-5).
 *
 * The five routes (confirmation · picking · landing-copy · landing-build · landing-match) answered to the key of the work
 * alone. Now each asks that key AND `ai.assist`, so the owner can leave a person on the desk and take the model away.
 *
 * Every person here is built by the REAL engine (`computeEffectiveGrants`) from role rows and exceptions, and the routes
 * ask the real `can()`. Each door is driven three ways: both keys → past the gate; the work key alone → 403 (the new
 * refusal); `ai.assist` alone → 403 (the box opens nothing by itself). And a «منع» on the box beats a role that has it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { current, db, preparationGroups, aiChat } = vi.hoisted(() => ({
  current: { user: null as unknown as SessionUser },
  db: { product: { findMany: vi.fn(), findFirst: vi.fn() }, order: { findFirst: vi.fn() } },
  preparationGroups: vi.fn(),
  aiChat: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/ai-rate', () => ({ tooManyAiCalls: () => null }));
vi.mock('@/lib/geo-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/geo-context')>()),
  requireContext: async () => ({
    user: current.user, companyId: 'c1', storeId: 's1', countryId: 'co1',
    country: { currencyCode: 'JOD', allowNegativeStock: false },
  }),
}));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});
vi.mock('@/lib/operations', () => ({ preparationGroups: (...a: unknown[]) => preparationGroups(...a) }));
vi.mock('@/lib/ai-provider', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai-provider')>()),
  aiChat: (...a: unknown[]) => aiChat(...a),
}));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { AI_ASSIST_KEY, ASSISTANTS, assistantByKey } from '@/lib/ai-assistants';
import { requireAssistant } from '@/lib/require-assistant';
import { POST as confirmation } from './confirmation/route';
import { POST as picking } from './picking/route';
import { POST as landingCopy } from './landing-copy/route';
import { POST as landingBuild } from './landing-build/route';
import { POST as landingMatch } from './landing-match/route';

async function employee(roleKeys: string[], ex: { deny?: string[]; allow?: string[] } = {}): Promise<SessionUser> {
  const base = { id: 'e1', email: 'e@x', name: 'هبة', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [
      ...(ex.allow ?? []).map((k) => ({ permission: k, effect: 'ALLOW', scope: 'ALL_COMPANY', scopeIds: null })),
      ...(ex.deny ?? []).map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
    ],
  });
  return attachGrants(base, grants);
}

const post = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });

/** Each door, the work key it already asked, and a request that gets PAST the gate (and stops at a harmless 400 / 200). */
const DOORS: Array<{ name: string; work: string; call: () => Promise<Response>; pastGate: (r: Response) => boolean }> = [
  { name: 'confirmation', work: 'confirmation.work', call: () => confirmation(post({ orderId: 'not-an-id' })), pastGate: (r) => r.status === 400 },
  { name: 'picking', work: 'ops.prepare', call: () => picking(), pastGate: (r) => r.status === 200 },
  { name: 'landing-copy', work: 'landing_pages.edit', call: () => landingCopy(post({})), pastGate: (r) => r.status === 400 },
  { name: 'landing-build', work: 'landing_pages.edit', call: () => landingBuild(post({})), pastGate: (r) => r.status === 400 },
  { name: 'landing-match', work: 'landing_pages.edit', call: () => landingMatch(post({})), pastGate: (r) => r.status === 400 },
];

beforeEach(() => {
  vi.clearAllMocks();
  preparationGroups.mockResolvedValue([]);
});

describe.each(DOORS)('$name', ({ work, call, pastGate }) => {
  it('lets in who holds the work key AND the assistants’ box', async () => {
    current.user = await employee([work, AI_ASSIST_KEY]);
    const res = await call();
    expect(res.status, 'رُدّ من لديه المفتاحان').not.toBe(403);
    expect(pastGate(res), `status ${res.status}`).toBe(true);
  });

  it('NEGATIVE: refuses who holds the work key and NOT the box — the owner took the model away, the work stays', async () => {
    current.user = await employee([work]);
    const res = await call();
    expect(res.status).toBe(403);
    expect(aiChat).not.toHaveBeenCalled();
  });

  it('NEGATIVE: refuses who holds the box and NOT the work key — the box opens nothing alone', async () => {
    current.user = await employee([AI_ASSIST_KEY]);
    expect((await call()).status).toBe(403);
  });

  it('NEGATIVE: a «منع» on the box beats a role that carries it', async () => {
    current.user = await employee([work, AI_ASSIST_KEY], { deny: [AI_ASSIST_KEY] });
    expect((await call()).status).toBe(403);
  });

  it('and a personal «سماح» on the box is enough with the role’s work key', async () => {
    current.user = await employee([work], { allow: [AI_ASSIST_KEY] });
    expect((await call()).status).not.toBe(403);
  });
});

describe('the definitions and the guard that reads them', () => {
  it('four assistants carry the gate and name the box; the intelligence centre has none (it answers to ai.use)', () => {
    expect(ASSISTANTS.filter((a) => a.gate).map((a) => a.key).sort()).toEqual(['confirmation', 'landing_copy', 'order_intake', 'picking']);
    for (const a of ASSISTANTS.filter((x) => x.gate)) expect(a.gate).toBe(AI_ASSIST_KEY);
    expect(assistantByKey('intelligence')!.gate).toBeUndefined();
  });

  it('NEGATIVE: an assistant without a gate cannot be waved through the helper door by mistake', async () => {
    current.user = await employee(['growth.intelligence', AI_ASSIST_KEY]);
    await expect(requireAssistant(assistantByKey('intelligence')!)).rejects.toThrow(/no gate/);
  });

  it('NEGATIVE (the test of the test): the old single-key line, if it came back, would let the work key alone through', async () => {
    // The route before PR-5 was `requirePermission(assistant.needs)`; replayed here to prove the three-way test can tell.
    current.user = await employee(['ops.prepare']);
    const { requirePermission } = await import('@/lib/authorization');
    await expect(requirePermission(assistantByKey('picking')!.needs)).resolves.toBeTruthy();
    await expect(requireAssistant(assistantByKey('picking')!)).rejects.toThrow(/ai\.assist/);
  });

  it('no route under src/app/api asks an assistant’s `needs` alone any more', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name) && /requirePermission\(\s*assistant\.needs\s*\)/.test(readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    walk(path.join(process.cwd(), 'src', 'app', 'api'));
    expect(offenders, 'بابٌ يسأل مفتاح الشغل وحده').toEqual([]);
  });

  it('and every route that reads one of the four assistants goes through requireAssistant', () => {
    const dir = path.join(process.cwd(), 'src', 'app', 'api', 'ai');
    for (const sub of ['confirmation', 'picking', 'landing-copy', 'landing-build', 'landing-match']) {
      const src = readFileSync(path.join(dir, sub, 'route.ts'), 'utf8');
      expect(src, sub).toMatch(/await requireAssistant\(assistant\)/);
    }
  });
});
