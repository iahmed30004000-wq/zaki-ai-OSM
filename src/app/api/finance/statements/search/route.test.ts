import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «بحث بكل الكشوف» — THE DOOR.
 *
 * What the search finds, and the rules of WHICH lines, are in `lib/statement-search.test.ts` (against a database that really
 * answers). This pins what the route adds: the key, asked FIRST; a scope that comes from the session and never from the
 * request; the three-character minimum and its one exception; the address-book key handed down to the search; and an
 * answer that is the search's, untouched.
 */

const { db, requireContext, requirePermission, can, searchAllStatements } = vi.hoisted(() => ({
  db: { marker: 'the-shared-client' },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  searchAllStatements: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/statement-search', () => ({ searchAllStatements: (...a: unknown[]) => searchAllStatements(...a) }));

import * as route from './route';
import { MAX_HITS, TOO_SHORT_AR } from '@/lib/statement-search-rules';

const get = (query: string) => route.GET(new Request(`http://x/api/finance/statements/search?${query}`));

const USER = { id: 'u1', status: 'ACTIVE' };
const ANSWER = { q: 'ORD-1', hits: [{ matchId: 'm1' }], total: 1, limit: MAX_HITS };

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: USER, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
  requirePermission.mockResolvedValue(USER);
  can.mockReturnValue(false);
  searchAllStatements.mockResolvedValue(ANSWER);
});

describe('the key is asked first', () => {
  it('asks for settlement.view — the key every read of the matching screen asks — and answers the search’s own answer', async () => {
    const res = await get('q=ORD-1');
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('settlement.view');
    expect(requirePermission).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual(ANSWER);
  });

  it('refused without it: 403, and nothing is read — not even to say the question was too short', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission settlement.view'));
    for (const q of ['q=ORD-1', 'q=ab', 'q=']) {
      const res = await get(q);
      expect(res.status, q).toBe(403);
    }
    expect(searchAllStatements).not.toHaveBeenCalled();
    expect(can).not.toHaveBeenCalled();
  });

  it('a person with no session gets the session’s refusal and nothing else', async () => {
    requireContext.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
    const res = await get('q=ORD-1');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(searchAllStatements).not.toHaveBeenCalled();
    expect(requirePermission).not.toHaveBeenCalled();
  });
});

describe('whose', () => {
  it('the company and the store are the session’s — the request cannot name another', async () => {
    await get('q=ORD-1&companyId=evil&storeId=evil&company=evil&store=evil');
    expect(searchAllStatements).toHaveBeenCalledTimes(1);
    expect(searchAllStatements).toHaveBeenCalledWith(db, { scope: { companyId: 'c1', storeId: 's1' }, q: 'ORD-1', maySeeContact: false });
  });
});

describe('how much is typed', () => {
  it('fewer than three characters: 400 in Arabic, and the search is not run', async () => {
    for (const q of ['q=', 'q=a', 'q=ab', 'q=%20ab%20', '']) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: TOO_SHORT_AR });
    }
    expect(searchAllStatements).not.toHaveBeenCalled();
  });

  it('exactly three is searched', async () => {
    expect((await get('q=abc')).status).toBe(200);
    expect(searchAllStatements).toHaveBeenCalledWith(db, expect.objectContaining({ q: 'abc' }));
  });

  it('a whole barcode the camera read (scan=1) is searched at any length — a scan is not a way round anything else', async () => {
    expect((await get('q=A1&scan=1')).status).toBe(200);
    expect(searchAllStatements).toHaveBeenCalledWith(db, { scope: { companyId: 'c1', storeId: 's1' }, q: 'A1', maySeeContact: false });
    // The waiver is the length and nothing else: an empty scan is still nothing, and only «1» is a scan.
    expect((await get('q=&scan=1')).status).toBe(400);
    expect((await get('q=A1&scan=true')).status).toBe(400);
    expect(searchAllStatements).toHaveBeenCalledTimes(1);
  });

  it('what is searched is what was typed, cleaned: Latin digits, no invisible marks, one space, at most a hundred characters', async () => {
    await get(`q=${encodeURIComponent('  ORD-٢٠٢٦ ‎ 1234 ')}`);
    expect(searchAllStatements).toHaveBeenLastCalledWith(db, expect.objectContaining({ q: 'ORD-2026 1234' }));
    await get(`q=${'x'.repeat(300)}`);
    expect((searchAllStatements.mock.calls.at(-1)![1] as { q: string }).q).toHaveLength(100);
  });
});

describe('a customer’s name and phone', () => {
  it('the address-book key (customers.view) is asked of the SESSION’S user and handed to the search as it is answered', async () => {
    can.mockReturnValue(true);
    await get('q=ORD-1');
    expect(can).toHaveBeenCalledWith(USER, 'customers.view');
    expect(searchAllStatements).toHaveBeenLastCalledWith(db, expect.objectContaining({ maySeeContact: true }));
    can.mockReturnValue(false);
    await get('q=ORD-1');
    expect(searchAllStatements).toHaveBeenLastCalledWith(db, expect.objectContaining({ maySeeContact: false }));
  });

  it('the request cannot grant it: a parameter that says so changes nothing', async () => {
    await get('q=ORD-1&maySeeContact=true&contact=1&customers=true');
    expect(searchAllStatements).toHaveBeenLastCalledWith(db, expect.objectContaining({ maySeeContact: false }));
  });
});

describe('what comes back, and what does not', () => {
  it('the search’s answer is sent as it is — the lines, the true count and the limit', async () => {
    const full = { q: 'BC-1', hits: Array.from({ length: 50 }, (_, i) => ({ matchId: `m${i}` })), total: 137, limit: 50 };
    searchAllStatements.mockResolvedValue(full);
    const body = await (await get('q=BC-1')).json();
    expect(body).toEqual(full);
    expect(body.hits).toHaveLength(50);
    expect(body.total).toBe(137);
  });

  it('a failure inside the search goes through the shared error mapper: a 500 with a sentence in Arabic, and no half answer', async () => {
    searchAllStatements.mockRejectedValue(new Error('the database did not answer'));
    const res = await get('q=ORD-1');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
    expect(body.hits).toBeUndefined();
  });

  it('it is a read: the route has a GET and nothing else', () => {
    expect(Object.keys(route).sort()).toEqual(['GET']);
  });
});
