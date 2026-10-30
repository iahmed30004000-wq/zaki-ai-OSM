import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EVERY CAMPAIGN DOOR ASKS THE CAMPAIGNS’ OWN KEY (perm-plan PR-11) — AND THE OLD KEY OPENS NONE OF THEM.
 *
 * Nine doors: the list, and the eight that write — typing a campaign in, editing, deleting, the dragged order, the bulk
 * delete, the merge of duplicates, «اسحب الإنفاق» (sync) and «اسحب الحملات» (import). Until now all nine asked `reports.view`.
 *
 * These run the REAL engine (can / requirePermission over grants attached to the session user), the real error mapping, and
 * a database that records the first touch and throws: a refused caller must read and write NOTHING. A door’s key is read off
 * the refusal itself («missing required permission …»), so a door that asked the wrong key says so.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { touched, session, reached } = vi.hoisted(() => ({
  touched: [] as string[],
  session: { user: null as unknown },
  reached: [] as string[],
}));

vi.mock('@/lib/db', () => ({
  db: new Proxy({}, { get: (_t, prop) => { touched.push(String(prop)); throw new Error(`db touched: ${String(prop)}`); } }),
}));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(async () => session.user) }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: vi.fn(async () => ({ user: session.user, companyId: `co-${Math.random()}`, storeId: 'st1', country: 'JO' })),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/ads/sync', () => ({ syncAdSpend: vi.fn(async () => { reached.push('sync'); return { updated: 0, accounts: [], message: '' }; }) }));
vi.mock('@/lib/ads/import', () => ({ importRemoteCampaigns: vi.fn(async () => { reached.push('import'); return { created: 0, accounts: [] }; }) }));

import { GET, POST } from './route';
import { PATCH, DELETE } from './[id]/route';
import { POST as bulk } from './bulk/route';
import { POST as duplicates } from './duplicates/route';
import { POST as order } from './order/route';
import { POST as sync } from './sync/route';
import { POST as importCampaigns } from './import/route';

const grantsOf = (...keys: string[]) => ({
  fullAccess: false,
  grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])),
});
const person = (...keys: string[]) => ({ id: 'u1', role: 'MODERATOR', status: 'ACTIVE', companyId: 'co', effectiveGrants: grantsOf(...keys) });

const json = (body: unknown = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: 'camp-1' }) };

interface Door { name: string; needs: 'campaigns.view' | 'campaigns.manage'; call: () => Promise<Response> }
const DOORS: Door[] = [
  { name: 'the list', needs: 'campaigns.view', call: () => GET(new Request('http://x/api/growth/campaigns?period=month')) },
  { name: 'typing one in', needs: 'campaigns.manage', call: () => POST(new Request('http://x/api/growth/campaigns', json())) },
  { name: 'editing', needs: 'campaigns.manage', call: () => PATCH(new Request('http://x/api/growth/campaigns/camp-1', { ...json(), method: 'PATCH' }), ctx) },
  { name: 'deleting', needs: 'campaigns.manage', call: () => DELETE(new Request('http://x/api/growth/campaigns/camp-1', { method: 'DELETE' }), ctx) },
  { name: 'the dragged order', needs: 'campaigns.manage', call: () => order(new Request('http://x/api/growth/campaigns/order', json({ ids: [] }))) },
  { name: 'the bulk delete', needs: 'campaigns.manage', call: () => bulk(new Request('http://x/api/growth/campaigns/bulk', json({ action: 'delete', ids: [] }))) },
  { name: 'the merge of duplicates', needs: 'campaigns.manage', call: () => duplicates(new Request('http://x/api/growth/campaigns/duplicates', json({}))) },
  { name: '«اسحب الإنفاق» (sync)', needs: 'campaigns.manage', call: () => sync() },
  { name: '«اسحب الحملات» (import)', needs: 'campaigns.manage', call: () => importCampaigns() },
];

beforeEach(() => {
  touched.length = 0;
  reached.length = 0;
});

/** A refused caller gets a 403 that NAMES the key the door asked, and has read and written nothing. */
async function refusedFor(door: Door, who: unknown): Promise<string | null> {
  session.user = who;
  touched.length = 0;
  const res = await door.call();
  if (res.status !== 403) return null;
  expect(touched, `${door.name}: a refused caller must not touch the database`).toEqual([]);
  const body = (await res.json()) as { error: string; errorAr?: string };
  return body.error;
}

describe('there are nine doors, and the table is the whole of them', () => {
  it('lists exactly the routes of the campaigns folder that have a handler', () => {
    expect(DOORS).toHaveLength(9);
    expect(DOORS.filter((d) => d.needs === 'campaigns.view')).toHaveLength(1);
    expect(DOORS.filter((d) => d.needs === 'campaigns.manage')).toHaveLength(8);
  });
});

describe('the old key opens none of them', () => {
  for (const door of DOORS) {
    it(`${door.name}: reports.view (with the product edit besides) is refused, and the refusal names ${door.needs}`, async () => {
      const said = await refusedFor(door, person('reports.view', 'products.edit', 'reports.export'));
      expect(said, `${door.name}: should be a 403`).toBe(`Forbidden: missing required permission ${door.needs}`);
    });

    it(`${door.name}: a person with no grants at all is refused too`, async () => {
      expect(await refusedFor(door, person())).toBe(`Forbidden: missing required permission ${door.needs}`);
    });
  }
});

describe('the view opens the list and none of the writes', () => {
  for (const door of DOORS) {
    it(`${door.name}: with campaigns.view alone ${door.needs === 'campaigns.view' ? 'it is let in' : 'it is refused'}`, async () => {
      const said = await refusedFor(door, person('campaigns.view'));
      if (door.needs === 'campaigns.view') expect(said, 'the list is the view’s').toBeNull();
      else expect(said).toBe('Forbidden: missing required permission campaigns.manage');
    });
  }
});

describe('the manage key opens the writes and not the list', () => {
  for (const door of DOORS) {
    it(`${door.name}: with campaigns.manage alone ${door.needs === 'campaigns.manage' ? 'it is let in' : 'it is refused'}`, async () => {
      const said = await refusedFor(door, person('campaigns.manage'));
      if (door.needs === 'campaigns.manage') expect(said, 'a write is the manage key’s').toBeNull();
      else expect(said).toBe('Forbidden: missing required permission campaigns.view');
    });
  }

  it('and the two pulls from the platforms really reach their work for a manager — the gate was all that stood in the way', async () => {
    session.user = person('campaigns.view', 'campaigns.manage');
    expect((await sync()).status).toBe(200);
    expect((await importCampaigns()).status).toBe(200);
    expect(reached).toEqual(['sync', 'import']);
  });

  it('NEGATIVE: and they do NOT reach it for a holder of the old key — the platforms are never called', async () => {
    session.user = person('reports.view');
    expect((await sync()).status).toBe(403);
    expect((await importCampaigns()).status).toBe(403);
    expect(reached).toEqual([]);
  });
});

describe('a suspended account is refused all the same, whatever it holds', () => {
  for (const door of DOORS) {
    it(door.name, async () => {
      expect(await refusedFor(door, { ...person('campaigns.view', 'campaigns.manage'), status: 'SUSPENDED' })).toBe(`Forbidden: missing required permission ${door.needs}`);
    });
  }
});

describe('SUPER_ADMIN passes every door (the engine’s own rule — no route adds a bypass)', () => {
  for (const door of DOORS) {
    it(door.name, async () => {
      expect(await refusedFor(door, { id: 'root', role: 'SUPER_ADMIN', status: 'ACTIVE', effectiveGrants: { fullAccess: true, grants: {} } })).toBeNull();
    });
  }
});
