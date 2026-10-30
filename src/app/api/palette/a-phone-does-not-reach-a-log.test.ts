import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PALETTE'S DOOR, AND THE THREE THINGS IT MUST NOT BECOME.
 *
 * ── 1. A QUERY STRING WITH A CUSTOMER'S PHONE IN IT ──
 *
 * One of the things a person types into Ctrl+K is a phone number, and the
 * query string is the one part of a request that is written down
 * everywhere by default: the reverse proxy's access log, the server's
 * request log, the browser's own history, any error report that carries a
 * URL. «الهاتف لا يخرج من الخادم» cannot be true of a value that was in
 * the URL on the way in — it is already in three files by then.
 *
 * So the counter is a POST with the term in the BODY. This is asked both
 * ways: the route is driven with a body, and the component's source is
 * read to make sure it is not ALSO building a URL out of the term.
 *
 * ── 2. A WAY TO ASK FOR SOMEBODY ELSE'S NUMBERS ──
 *
 * There is no `scope`, no `wide`, no `storeId` parameter. A client that
 * sends them anyway must be counted exactly as if it had not — which is
 * asked here by sending them.
 *
 * ── 3. A STAFF DIRECTORY FOR PEOPLE WHO MAY NOT READ ONE ──
 *
 * «a staff member's name → his page» is for owner roles. Not «fetch the
 * names and let the browser hide them»: an account without `users.view`
 * must cause no query at all, because a name that reached the bundle has
 * been disclosed whether or not it was drawn.
 *
 * Asked of the ROUTE and of the `where` it builds, never of the wording.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext } = vi.hoisted(() => ({
  db: {
    order: { count: vi.fn() },
    product: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (u: { __perms?: string[] }, p: string) => (u.__perms ?? []).includes(p),
  requirePermission: vi.fn(),
  getPermissionScope: (u: { __scope?: string }) => (u.__scope ? { scope: u.__scope } : null),
}));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));

import { GET, POST } from './route';

const OWNER = {
  id: 'owner1',
  status: 'ACTIVE',
  role: 'COMPANY_ADMIN',
  companyId: 'c1',
  __scope: 'ALL_COMPANY',
  __perms: ['users.view', 'confirmation.pull', 'insights.view'],
};

const AGENT = {
  id: 'agent1',
  status: 'ACTIVE',
  role: 'CONFIRMATION_AGENT',
  companyId: 'c1',
  __scope: 'ASSIGNED',
  __perms: ['confirmation.pull', 'insights.view'],
};

const PHONE = '0791234567';

const asUser = (user: unknown) =>
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });

const ask = (q: string, extra: Record<string, unknown> = {}) =>
  POST(
    new Request('http://localhost/api/palette', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, ...extra }),
    })
  );

/** Everything the route put to the orders table, as JSON. */
const everyWhere = () =>
  db.order.count.mock.calls.map((call: unknown[]) =>
    JSON.stringify((call[0] as { where: unknown }).where)
  );

beforeEach(() => {
  vi.clearAllMocks();
  db.order.count.mockResolvedValue(4);
  db.product.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
  asUser(OWNER);
});

describe('the counter takes its term in the body', () => {
  it('and the URL it was asked on carries nothing but the path', async () => {
    const res = await ask(PHONE);
    expect(res.status).toBe(200);
    // Nothing to assert about the query string except that there is none:
    // the term went in the body, so this is the whole surface a log sees.
    expect(db.order.count).toHaveBeenCalled();
  });

  it('and the answer is a count with no customer in it', async () => {
    const body = await (await ask(PHONE)).json();
    const printed = JSON.stringify(body);
    expect(body.facts[0].count).toBe(4);
    expect(printed, 'رقم الهاتف رجع في الجواب').not.toContain(PHONE);
    expect(printed, 'ولا جزءٌ منه').not.toContain('079');
  });

  it('and the box that asks it does not also build a URL out of the term', () => {
    /*
     * The one way this rule dies quietly: somebody adds
     * `/api/palette?q=${term}` beside the POST for a quick fix, and the
     * phone is back in the access log while every behavioural test above
     * still passes.
     *
     * `stripComments` first — this very file's prose contains the pattern
     * it is looking for, and so does the component's. A guard that reads
     * its own explanation is a guard that fails on the day it is written.
     */
    const src = stripComments(
      readFileSync(join(process.cwd(), 'src/components/shell/CommandPalette.tsx'), 'utf8')
    );
    const palette = src.slice(src.indexOf("'/api/palette'"));
    expect(src, 'الباب لم يُستعمل أصلاً').toContain("'/api/palette'");
    expect(palette, 'المصطلح صار في عنوان الطلب').not.toMatch(/\/api\/palette\?/);
    expect(src, 'المصطلح لم يُرسل في الجسم').toMatch(/body: JSON\.stringify\(\{ q: term \}\)/);
  });
});

/**
 * THE LIVE COUNTS ARE SMART CARDS (perm-plan PR-10). Without `insights.view` the box still finds products and people and still
 * navigates; only the counters («جديدة»، «مؤجّلة»…) are an empty list — the same shape it already draws for an account with
 * no orders grant — and not one count query is made.
 */
describe('without insights.view the counters are empty and nothing is counted', () => {
  it('the summary is an empty list, the capabilities still travel, and no order is counted', async () => {
    asUser({ ...AGENT, __perms: ['confirmation.pull'] });
    const body = await (await GET()).json();
    expect(body.facts).toEqual([]);
    expect(body.may).toBeTruthy();
    expect(db.order.count).not.toHaveBeenCalled();
  });

  it('the typed counter likewise — products and people are still searched', async () => {
    asUser({ ...OWNER, __perms: ['users.view', 'confirmation.pull'] });
    db.product.findMany.mockResolvedValue([]);
    const body = await (await ask(PHONE)).json();
    expect(body.facts).toEqual([]);
    expect(body.people).toEqual([]);
    expect(body.products).toEqual([]);
    expect(db.order.count).not.toHaveBeenCalled();
    expect(db.user.findMany).toHaveBeenCalled();
    expect(db.product.findMany).toHaveBeenCalled();
  });

  it('NEGATIVE (the test of the test): the same agent WITH the key is counted', async () => {
    asUser(AGENT);
    const body = await (await ask(PHONE)).json();
    expect(body.facts.length).toBeGreaterThan(0);
    expect(db.order.count).toHaveBeenCalled();
  });
});

describe('a client cannot ask for somebody else’s numbers', () => {
  it('because the agent’s counts carry her id however the request is dressed', async () => {
    asUser(AGENT);
    await ask(PHONE, { wide: true, storeWide: true, scope: 'ALL_COMPANY', storeId: 'other' });
    const asked = everyWhere();
    expect(asked.length).toBeGreaterThan(0);
    for (const where of asked) {
      expect(where, `نطاقُ الموظّفة اتّسع بطلبٍ من المتصفح:\n${where}`).toContain('agent1');
      expect(where, 'متجرٌ آخر تسلّل من الطلب').not.toContain('other');
    }
  });

  it('and the summary likewise — it takes no parameter at all', async () => {
    asUser(AGENT);
    const res = await GET();
    expect(res.status).toBe(200);
    for (const where of everyWhere()) {
      expect(where).toContain('agent1');
    }
  });

  it('and the summary says which of the two it is, so the screen cannot guess', async () => {
    asUser(AGENT);
    expect((await (await GET()).json()).may.wide).toBe(false);
    vi.clearAllMocks();
    db.order.count.mockResolvedValue(4);
    asUser(OWNER);
    expect((await (await GET()).json()).may.wide).toBe(true);
  });
});

describe('a colleague’s name', () => {
  beforeEach(() => {
    db.user.findMany.mockResolvedValue([{ id: 'u9', name: 'سارة', role: 'MODERATOR' }]);
  });

  it('comes back for an account that may read the employees screen', async () => {
    const body = await (await ask('سارة')).json();
    expect(body.people).toEqual([{ id: 'u9', name: 'سارة', roleAr: 'موديريتور' }]);
  });

  it('and is not even looked up for one that may not', async () => {
    asUser(AGENT);
    const body = await (await ask('سارة')).json();
    expect(db.user.findMany, 'أسماءُ الموظّفين استُعلمت لمن لا يملك رؤيتها').not.toHaveBeenCalled();
    expect(body.people).toEqual([]);
  });

  it('and the lookup is fenced to this tenant, not to «any company»', async () => {
    await ask('سارة');
    const where = JSON.stringify(db.user.findMany.mock.calls[0][0].where);
    expect(where, 'بحثُ الموظّفين خرج عن الشركة').toContain('c1');
  });

  it('and no email, no phone and no hash leave with it', async () => {
    db.user.findMany.mockResolvedValue([
      { id: 'u9', name: 'سارة', role: 'MODERATOR' },
    ]);
    await ask('سارة');
    const select = db.user.findMany.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual(['id', 'name', 'role']);
  });
});

describe('the door is a door, not a gate', () => {
  it('so an account with no orders grant gets five honest zeroes, not a 403', async () => {
    /*
     * Ctrl+K is also the only way to reach a screen without the mouse. A
     * 403 here would make the box itself refuse to open for a PENDING_USER
     * who holds nothing but «الملف الشخصي» — and the summary is the part
     * that is empty for them, not the palette.
     */
    asUser({ ...AGENT, __scope: undefined, __perms: [] });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts).toEqual([]);
    expect(db.order.count, 'سُئلت قاعدةُ البيانات عن حسابٍ لا يرى طلباً').not.toHaveBeenCalled();
  });

  it('and «اسحب» is offered only to whoever the pull route itself would serve', async () => {
    const owner = await (await GET()).json();
    expect(owner.may.pull).toBe(true);
    vi.clearAllMocks();
    db.order.count.mockResolvedValue(4);
    asUser({ ...AGENT, __perms: [] });
    expect((await (await GET()).json()).may.pull).toBe(false);
  });

  it('and two letters is the floor here too', async () => {
    const body = await (await ask('ك')).json();
    expect(body).toEqual({ facts: [], people: [], products: [] });
    expect(db.order.count).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
