import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «حركة الطلبات» (`?part=flow`) OPENS WITH THE SAME KEY AS THE REST OF THE TAB, SAYS THE SAME REFUSAL, AND READS NOTHING BEFORE IT.
 *
 * `team.monitor`, the team table's own words — no new key. The window is looked at only AFTER the key: a person without it is
 * refused whatever she typed in `window`. The company and the store are the session's, never the query string's. And the new part
 * is its own question: it never reads the board or the report, and neither of them ever reads it.
 */

const { requireContext, board, report, flow, held } = vi.hoisted(() => ({
  requireContext: vi.fn(),
  board: vi.fn(),
  report: vi.fn(),
  flow: vi.fn(),
  held: { keys: [] as string[] },
}));

vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, k: string) => held.keys.includes(k) }));
vi.mock('@/lib/no-answer-watch', () => ({
  FRESH_NEW_HOURS: 2,
  REPORT_DEFAULT_DAYS: 14,
  STUCK_BUSINESS_DAYS: 2,
  noAnswerBoard: (...a: unknown[]) => board(...a),
  answerRateReport: (...a: unknown[]) => report(...a),
}));
vi.mock('@/lib/held-flow-read', () => ({ heldFlow: (...a: unknown[]) => flow(...a) }));

import { GET } from './route';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const as = (role: string, ...keys: string[]) => {
  held.keys = keys;
  requireContext.mockResolvedValue({ user: { id: 'me', role }, companyId: 'c1', storeId: 's1', country: COUNTRY });
};
const get = (q = '') => GET(new Request(`http://x/api/orders/confirmation/no-answer${q}`));
const ARABIC = /[؀-ۿ]/;

beforeEach(() => {
  vi.clearAllMocks();
  board.mockResolvedValue({ agents: [], totals: {}, team: {}, truncated: false });
  report.mockResolvedValue({ byHour: [], byAttempt: [], total: {}, truncated: false });
  flow.mockResolvedValue({ window: { key: '24h' }, reading: { tone: 'CALM', label: 'ماشية', sentences: ['x'] } });
});

describe('who opens it', () => {
  it('team.monitor opens it, whatever the role is called', async () => {
    as('SOME_CUSTOM_ROLE', 'team.monitor');
    const res = await get('?part=flow');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flow: { window: { key: '24h' }, reading: { tone: 'CALM', label: 'ماشية', sentences: ['x'] } } });
  });

  it('NEGATIVE: without the key — the team table’s refusal, and not one question asked, whatever the window says', async () => {
    for (const [role, keys] of [
      ['CONFIRMATION_AGENT', ['confirmation.supervise', 'confirmation.work']],
      ['MANAGER', ['users.view']],
      ['SUPER_ADMIN', []],
    ] as const) {
      for (const q of ['?part=flow', '?part=flow&window=6h', '?part=flow&window=bogus', '?part=flow&window=']) {
        as(role, ...keys);
        const res = await get(q);
        expect(res.status, `${role} ${q}`).toBe(403);
        expect((await res.json()).errorAr).toBe('أداء الفريق للمشرف وحده.');
      }
    }
    expect(flow).not.toHaveBeenCalled();
    expect(board).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
});

describe('the window', () => {
  it('no window: a day', async () => {
    as('MANAGER', 'team.monitor');
    await get('?part=flow');
    expect(flow.mock.calls[0][0].windowKey).toBe('24h');
  });

  it.each(['6h', '24h', '7d'])('%s reaches the question as it was typed', async (w) => {
    as('MANAGER', 'team.monitor');
    await get(`?part=flow&window=${w}`);
    expect(flow).toHaveBeenCalledTimes(1);
    expect(flow.mock.calls[0][0].windowKey).toBe(w);
  });

  it.each(['1h', '12h', '24H', '30d', '7d%20', '%2024h', 'all', '0', '', 'null'])(
    'an unknown window («%s») is a 400 in Arabic that names the three, and nothing is read',
    async (w) => {
      as('MANAGER', 'team.monitor');
      const res = await get(`?part=flow&window=${w}`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorAr).toMatch(ARABIC);
      expect(body.errorAr).not.toMatch(/[A-Za-z]/);
      expect(body.errorAr).toContain('آخر 6 ساعات');
      expect(body.errorAr).toContain('آخر 24 ساعة');
      expect(body.errorAr).toContain('آخر 7 أيام');
      expect(body.error).toBe(body.errorAr);
      expect(body.code).toBe('UNKNOWN_WINDOW');
      expect(flow).not.toHaveBeenCalled();
      expect(board).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    }
  );
});

describe('what it is asked about', () => {
  it('the session’s company and store and the store country’s calendar — never the query string’s', async () => {
    as('MANAGER', 'team.monitor');
    await get('?part=flow&window=7d&storeId=s9&companyId=c9');
    expect(flow.mock.calls[0][0]).toMatchObject({ companyId: 'c1', storeId: 's1', calendar: COUNTRY, windowKey: '7d' });
    expect(flow.mock.calls[0][0].now).toBeInstanceOf(Date);
  });

  it('answers {flow} and nothing else — the board and the report are not read for it, and the dates are ignored', async () => {
    as('MANAGER', 'team.monitor');
    const body = await (await get('?part=flow&startDate=2026-09-01&endDate=2026-09-03')).json();
    expect(Object.keys(body)).toEqual(['flow']);
    expect(board).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('the other parts never ask the flow — moving the dates or reading the board never recomputes it', async () => {
    as('MANAGER', 'team.monitor');
    for (const q of ['?part=board', '?part=report&startDate=2026-09-01&endDate=2026-09-03', '', '?window=6h', '?part=flows']) {
      const res = await get(q);
      expect(res.status, q).toBe(200);
    }
    expect(flow).not.toHaveBeenCalled();
  });

  it('and they answer exactly what they did before: the board with its rules and its window', async () => {
    as('MANAGER', 'team.monitor');
    const body = await (await get('?part=board')).json();
    expect(Object.keys(body).sort()).toEqual(['board', 'rules', 'window']);
    expect(body.rules).toEqual({ stuckBusinessDays: 2, freshNewHours: 2 });
    const both = await (await get('')).json();
    expect(Object.keys(both).sort()).toEqual(['board', 'report', 'rules', 'window']);
  });
});

describe('when the question fails', () => {
  it('a thrown error is the door’s generic answer in Arabic — and in production nothing of it leaks', async () => {
    as('MANAGER', 'team.monitor');
    flow.mockRejectedValue(new Error('connection to 10.0.0.7 refused'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const res = await get('?part=flow');
      expect(res.status).toBeGreaterThanOrEqual(500);
      const body = await res.json();
      expect(body.errorAr).toMatch(ARABIC);
      expect(JSON.stringify(body)).not.toContain('10.0.0.7');
    } finally {
      vi.unstubAllEnvs();
      spy.mockRestore();
    }
  });
});
