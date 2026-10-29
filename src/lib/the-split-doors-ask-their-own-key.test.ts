import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EVERY SPLIT DOOR ASKS ITS OWN KEY — AND NOT THE ONE IT ASKED BEFORE (perm-plan PR-4).
 *
 * Each handler below is CALLED, with a person who holds a given set of keys:
 *   · the key it asks NOW  → the gate lets the call through (whatever happens after it is not the question: the
 *     database is a sink that refuses everything, so a pass shows up as anything BUT a 403);
 *   · only the key it asked BEFORE  → 403;
 *   · every OTHER new box together with the old keys, but not its own  → 403  (no box opens a neighbour's door).
 *
 * A door that moved from settings.edit to settings.manage (the ad-account sign-in, the AI connection test) is in
 * the same table: it is the opposite direction of the same rule, and it is written down so it cannot slide back.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({ held: new Set<string>() }));

const sink: unknown = vi.hoisted(() => {
  const s: unknown = new Proxy(function () {}, {
    get: (_t, p) => (p === 'then' ? undefined : s),
    apply: () => Promise.reject(new Error('db touched')),
  });
  return s;
});

vi.mock('@/lib/db', () => ({ db: sink }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));

const USER = { id: 'u1', name: 'x', email: 'x@x', role: 'MANAGER', status: 'ACTIVE', companyId: 'c1', permissions: [] };
const CTX = {
  user: USER, companyId: 'c1', storeId: 's1',
  country: { id: 'sy', code: 'SY', orderPrefix: 'SY', currencyCode: 'USD', minorUnit: 2, allowNegativeStock: false },
};

vi.mock('@/lib/geo-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/geo-context')>()),
  requireContext: async () => CTX,
}));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  requireAuth: async () => USER,
  requireCompanyTenant: async () => ({ user: USER, companyId: 'c1' }),
  getCurrentUser: async () => USER,
}));
vi.mock('@/lib/authorization', async (orig) => ({
  ...(await orig<typeof import('@/lib/authorization')>()),
  requirePermission: async (k: string) => {
    if (!h.held.has(k)) throw new Error(`Forbidden: missing required permission ${k}`);
    return USER;
  },
  can: (_u: unknown, k: string) => h.held.has(k),
}));

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Door {
  /** The route file, from src/app/api. */
  file: string;
  method: Method;
  /** Every key the door asks for NOW (all of them are needed). */
  need: string[];
  /** The keys it asked for BEFORE (any ONE opened it). */
  was: string[];
  /** What the request looks like. */
  query?: string;
  form?: boolean;
}

const NEW_BOXES = [
  'settings.jobs', 'settings.messages', 'penalties.rules', 'team.settings', 'offers.rules',
  'commission.view', 'commission.manage', 'settings.delivery_fees', 'settings.tracking', 'orders.migrate',
];

const DOORS: Door[] = [
  { file: 'admin/jobs/route', method: 'POST', need: ['settings.jobs'], was: ['settings.manage'] },
  { file: 'settings/messages/route', method: 'PUT', need: ['settings.messages'], was: ['settings.manage'] },
  { file: 'settings/messages/route', method: 'GET', query: '?sample=1', need: ['settings.messages'], was: ['settings.manage'] },
  { file: 'settings/penalty-rules/route', method: 'POST', need: ['penalties.rules'], was: ['settings.manage'] },
  { file: 'settings/penalty-rules/route', method: 'PATCH', need: ['penalties.rules'], was: ['settings.manage'] },
  { file: 'settings/performance/route', method: 'PUT', need: ['team.settings'], was: ['settings.manage'] },
  { file: 'settings/post-order-offer/route', method: 'PUT', need: ['offers.rules'], was: ['settings.manage'] },
  { file: 'confirmation/winback/rule/route', method: 'PUT', need: ['offers.rules'], was: ['settings.manage'] },
  { file: 'orders/import/migrate/route', method: 'POST', form: true, need: ['orders.import', 'orders.migrate'], was: ['settings.manage'] },
  { file: 'settings/commission/route', method: 'GET', need: ['commission.view'], was: ['settings.view'] },
  { file: 'settings/commission/route', method: 'POST', need: ['commission.manage'], was: ['settings.edit'] },
  { file: 'settings/commission/route', method: 'PATCH', need: ['commission.manage'], was: ['settings.edit'] },
  { file: 'settings/delivery-fees/route', method: 'PUT', need: ['settings.delivery_fees'], was: ['settings.edit'] },
  { file: 'settings/tracking-pixels/route', method: 'POST', need: ['settings.tracking'], was: ['settings.edit'] },
  { file: 'settings/tracking-pixels/[id]/route', method: 'PATCH', need: ['settings.tracking'], was: ['settings.edit'] },
  { file: 'settings/tracking-pixels/[id]/route', method: 'DELETE', need: ['settings.tracking'], was: ['settings.edit'] },
  { file: 'settings/tracking-pixels/[id]/capi/route', method: 'PUT', need: ['settings.tracking'], was: ['settings.edit'] },
  { file: 'settings/conversions/route', method: 'POST', need: ['settings.tracking'], was: ['settings.edit'] },
  { file: 'settings/conversions/[id]/route', method: 'PATCH', need: ['settings.tracking'], was: ['settings.edit'] },
  { file: 'settings/conversions/[id]/route', method: 'DELETE', need: ['settings.tracking'], was: ['settings.edit'] },
  // The other direction: the same secret was behind two keys (RV169). Now one.
  { file: 'settings/ad-accounts/oauth/[platform]/start/route', method: 'GET', need: ['settings.manage'], was: ['settings.edit'] },
  { file: 'settings/ad-accounts/oauth/[platform]/callback/route', method: 'GET', need: ['settings.manage'], was: ['settings.edit'] },
  { file: 'settings/ai/test/route', method: 'POST', need: ['settings.manage'], was: ['settings.edit'] },
];

const PARAMS = { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001', platform: 'meta' }) };

async function call(d: Door, held: string[]): Promise<number> {
  h.held = new Set(held);
  const mod = (await import(/* @vite-ignore */ `@/app/api/${d.file}`)) as Record<Method, (req: Request, ctx: typeof PARAMS) => Promise<Response>>;
  const url = `http://localhost/api/${d.file}${d.query ?? ''}`;
  let body: BodyInit | undefined;
  if (d.method !== 'GET' && d.method !== 'DELETE') {
    if (d.form) {
      const f = new FormData();
      f.append('files', new File([new Uint8Array([80, 75, 3, 4])], 'a.xlsx'));
      f.append('dates', '2026-10-22');
      body = f;
    } else {
      body = '{}';
    }
  }
  const res = await mod[d.method](new Request(url, { method: d.method, body, headers: d.form ? undefined : { 'content-type': 'application/json' } }), PARAMS);
  return res.status;
}

beforeEach(() => {
  h.held = new Set();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each(DOORS)('$method $file', (door) => {
  it('lets the key it asks NOW through the gate', async () => {
    const status = await call(door, door.need);
    expect(status, `${door.file} ${door.method}: البوابة رفضت صاحب المفتاح الجديد`).not.toBe(403);
  });

  it('NEGATIVE: refuses the person who holds only the key it asked BEFORE', async () => {
    expect(await call(door, door.was)).toBe(403);
  });

  it('NEGATIVE: refuses everybody who holds every OTHER box (and the old keys) but not its own', async () => {
    const others = [...NEW_BOXES, 'settings.view', 'settings.edit', 'settings.manage', 'orders.import']
      // The door's own keys are the ones taken away.
      .filter((k) => !door.need.includes(k));
    expect(await call(door, others)).toBe(403);
  });

  it('NEGATIVE: refuses a person holding nothing at all', async () => {
    expect(await call(door, [])).toBe(403);
  });
});

describe('the migration door needs BOTH halves', () => {
  const door = DOORS.find((d) => d.file.includes('migrate'))!;
  it('the import half alone is refused, and the box alone is refused', async () => {
    expect(await call(door, ['orders.import'])).toBe(403);
    expect(await call(door, ['orders.migrate'])).toBe(403);
    expect(await call(door, ['orders.import', 'settings.manage'])).toBe(403);
    expect(await call(door, ['orders.import', 'orders.migrate'])).not.toBe(403);
  });
});

describe('what stays where it was', () => {
  it('the doors that are NOT split still ask the key they asked (credentials stay on settings.manage)', async () => {
    const stays: Door[] = [
      { file: 'settings/ai/route', method: 'PUT', need: ['settings.manage'], was: [] },
      { file: 'settings/ad-accounts/route', method: 'POST', need: ['settings.manage'], was: [] },
    ];
    for (const d of stays) {
      expect(await call(d, d.need), d.file).not.toBe(403);
      // NEGATIVE: none of the new boxes opens a credential door.
      expect(await call(d, [...NEW_BOXES, 'settings.view', 'settings.edit']), d.file).toBe(403);
    }
  });

  it('the winback screen is told «you may edit the rule» by the same key the rule door asks', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/app/api/confirmation/winback/route.ts'), 'utf8');
    expect(src).toContain(`canEditRule: can(user, 'offers.rules')`);
    expect(src).not.toContain(`canEditRule: can(user, 'settings.manage')`);
  });
});

describe('the table is the whole list — no split door was left out', () => {
  it('every handler that asks one of the new boxes is in the table', () => {
    const root = path.join(process.cwd(), 'src', 'app', 'api');
    const asked = new Map<string, number>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'route.ts') {
          const text = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
          const n = [...text.matchAll(/(?:requirePermission|can)\(\s*(?:user,\s*)?'([a-z_]+\.[a-z_]+)'/g)].filter((m) => NEW_BOXES.includes(m[1])).length;
          if (n) asked.set(path.relative(root, p).split(path.sep).join('/').replace(/\.ts$/, ''), n);
        }
      }
    };
    walk(root);
    const inTable = new Set(DOORS.map((d) => d.file));
    // The winback list route and the progress route read the box without being a write door; both have their own test.
    const own = new Set(['confirmation/winback/route', 'finance/commission/progress/route']);
    const missing = [...asked.keys()].filter((f) => !inTable.has(f) && !own.has(f));
    expect(missing, 'أبواب بمفتاح جديد خارج الجدول').toEqual([]);
    expect(asked.size).toBeGreaterThanOrEqual(15);
  });
});
