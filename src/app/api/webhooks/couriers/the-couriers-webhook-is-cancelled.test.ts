import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «الغي الويب هوك»: the couriers' status webhook is cancelled
 *
 * The owner, 2/11. Statuses come from the courier's own API (the polling job); the link a courier was given to post to is
 * dead, and so is the screen that minted it.
 *
 *  1. `/api/webhooks/couriers/<anything>` answers 410, in Arabic words, to EVERY method — and touches no database, no audit
 *     trail and no rate limiter (it imports nothing but `next/server`).
 *  2. The card that minted and stopped the link is gone from the couriers screen, and so is its route and its token helper.
 *  3. Nothing in the app reads or writes the three `DeliveryProvider.webhook*` columns any more (they stay in the schema:
 *     no migration with this change).
 *  4. The statuses still arrive — the polling job and `applyCourierEvent` are untouched (their own tests stay).
 *
 * This file REPLACES `courier-webhook.test.ts` and `the-link-can-be-stopped.test.ts`, which tested the endpoint that took a
 * token and the routes that minted and revoked it. Rewriting them is the owner's cancellation, not a weakening.
 *
 * Blockers: no migration, no schema edit, no money arithmetic, no customer data.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, logAudit, rateLimit, getClientIp, applyCourierEvent } = vi.hoisted(() => ({
  // A proxy that fails the moment anything is read from it: "no database call" must not depend on which table.
  db: new Proxy({}, { get: (_t, key) => { throw new Error(`the cancelled webhook touched db.${String(key)}`); } }),
  logAudit: vi.fn(),
  rateLimit: vi.fn(() => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  applyCourierEvent: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit, getClientIp }));
vi.mock('@/lib/couriers/apply-event', () => ({ applyCourierEvent }));

import * as route from './[token]/route';

const ROUTE = 'src/app/api/webhooks/couriers/[token]/route.ts';
const params = (token: string) => ({ params: Promise.resolve({ token }) });
const request = (method: string, body?: unknown) =>
  new Request('https://app.example/api/webhooks/couriers/x', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const call = (method: (typeof METHODS)[number], token = 'a'.repeat(43), body?: unknown) =>
  (route as unknown as Record<string, (req: Request, ctx: unknown) => Promise<Response>>)[method](request(method, body), params(token));

beforeEach(() => vi.clearAllMocks());

describe('the address answers 410 to every method', () => {
  it.each(METHODS)('%s → 410', async (method) => {
    expect((await call(method)).status).toBe(410);
  });

  it('says in Arabic that it was cancelled and that the statuses come from the courier’s API', async () => {
    const body = await (await call('POST', 'a'.repeat(43), { barcode: 'BC-1', status: 'OUT_FOR_DELIVERY' })).json();
    expect(body).toMatchObject({ ok: false, gone: true });
    expect(body.errorAr).toBe(body.error);
    expect(body.errorAr).toContain('تم إلغاء');
    expect(body.errorAr).toContain('API');
    expect(body.errorAr).not.toMatch(/[A-Za-z]{4,}/);
  });

  it('answers the same to a token that was good, a wrong one and none — it looks at none of them', async () => {
    const answers = await Promise.all(['a'.repeat(43), 'short', '', 'x'.repeat(200)].map(async (t) => [(await call('POST', t)).status, await (await call('POST', t)).text()]));
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0][0]).toBe(410);
  });

  it('says nothing about whether the token in the link was valid', async () => {
    expect(JSON.stringify(await (await call('GET')).json())).not.toMatch(/token|صالح|invalid|forbidden/i);
  });

  it('HEAD and OPTIONS are 410 as well, with no body (Next would otherwise answer them itself)', async () => {
    for (const method of ['HEAD', 'OPTIONS'] as const) {
      const res = await call(method);
      expect(res.status).toBe(410);
      expect(await res.text()).toBe('');
    }
  });
});

describe('and does nothing else', () => {
  it('touches no database, no audit trail, no rate limiter, no status gate — for any method, body or token', async () => {
    for (const method of METHODS) {
      await call(method, 'a'.repeat(43), method === 'POST' ? { barcode: 'BC-1', status: 'DELIVERED_TO_RECIPIENT' } : undefined);
    }
    // `db` is a proxy that throws on any property read: reaching here already means no table was touched.
    expect(logAudit).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(getClientIp).not.toHaveBeenCalled();
    expect(applyCourierEvent).not.toHaveBeenCalled();
  });

  it('imports nothing but next/server — it cannot reach a table, the audit trail or the limiter', () => {
    const src = stripComments(repoFile(ROUTE));
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports).toEqual(['next/server']);
  });

  it('exports only the seven HTTP methods and the dynamic switch — no helper in a route file', () => {
    expect(Object.keys(route).sort()).toEqual([...METHODS, 'dynamic'].sort());
  });
});

describe('the card that minted the link is gone, with its route and its token helper', () => {
  it('the files are deleted, not hidden', () => {
    for (const gone of [
      'src/components/settings/CourierWebhook.tsx',
      'src/app/api/settings/couriers/[id]/webhook/route.ts',
      'src/lib/couriers/webhook-token.ts',
    ]) expect(existsSync(join(process.cwd(), gone)), `${gone} ما زال موجوداً`).toBe(false);
  });

  it('the couriers screen neither imports nor draws it', () => {
    const src = stripComments(repoFile('src/components/screens/CouriersScreen.tsx'));
    expect(src).not.toMatch(/CourierWebhook/);
    // …while the account card beside it is still there.
    expect(src).toMatch(/<CourierCredentials\s+providerId=/);
  });

  it('no screen calls the route that minted or stopped the link', () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && /couriers\/\$\{[^}]*\}\/webhook|couriers\/[^'"`/]+\/webhook/.test(stripComments(readFileSync(p, 'utf8')))) {
          callers.push(relative(process.cwd(), p).split('\\').join('/'));
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(callers).toEqual([]);
  });
});

describe('nothing reads or writes the webhook columns any more', () => {
  it('src has no mention of webhookSecretHash, webhookSecretSetAt or webhookLastSeenAt (the columns stay in the schema)', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        // This very file names them to say so; every other file, test or not, must not.
        else if (/\.tsx?$/.test(p) && !p.endsWith('the-couriers-webhook-is-cancelled.test.ts') && /webhookSecretHash|webhookSecretSetAt|webhookLastSeenAt/.test(readFileSync(p, 'utf8'))) {
          hits.push(relative(process.cwd(), p).split('\\').join('/'));
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(hits).toEqual([]);
  });
});

describe('the statuses still come, from the courier’s API', () => {
  it('the polling job is still registered and still passes its word through the one gate', () => {
    const job = stripComments(repoFile('src/lib/jobs/definitions/sync-courier-status.ts'));
    expect(job).toMatch(/applyCourierEvent\(/);
    expect(job).toMatch(/source:\s*'POLL'/);
  });
});
