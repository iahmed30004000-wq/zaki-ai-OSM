import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A7 — THE VISIT COUNTER HAS A CEILING EVEN WHEN NOBODY KNOWS WHO IS CALLING.
 *
 * Without a trusted proxy every visitor is the address «local», and the per-address limit was
 * skipped for it, so one script could write rows for ever. A page now has a ceiling of its own
 * for that case, far above a busy hour; with a known address the old per-address limit stands.
 */

const { db, recordBrowserView, ip } = vi.hoisted(() => ({
  db: { landingPage: { findFirst: vi.fn(), update: vi.fn() } },
  recordBrowserView: vi.fn(),
  ip: { value: 'local' },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/campaigns-server', () => ({ resolveCampaign: vi.fn(async () => null) }));
vi.mock('@/lib/rate-limit', async (orig) => ({ ...(await orig<typeof import('@/lib/rate-limit')>()), getClientIp: () => ip.value }));
vi.mock('@/lib/landing-views', async (orig) => ({
  ...(await orig<typeof import('@/lib/landing-views')>()),
  recordBrowserView,
  recordLandingView: vi.fn(),
}));

import { POST } from './route';

const PHONE = 'Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 Mobile Safari/537.36';
const visit = (page: string) =>
  POST(new Request('http://x/api/public/lp-view', { method: 'POST', body: JSON.stringify({ p: page }), headers: { 'user-agent': PHONE, 'content-type': 'text/plain' } }));

const PAGE_A = 'aaaaaaaa-2222-4333-8444-555555555555';
const PAGE_B = 'bbbbbbbb-2222-4333-8444-555555555555';
const PAGE_C = 'cccccccc-2222-4333-8444-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  db.landingPage.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, companyId: 'c1', storeId: 's1' }));
});

describe('an unknown address', () => {
  it('a busy hour is counted in full: 1200 visits to one page in a minute are all recorded', async () => {
    ip.value = 'local';
    for (let i = 0; i < 1200; i += 1) expect((await visit(PAGE_A)).status).toBe(204);
    expect(recordBrowserView).toHaveBeenCalledTimes(1200);
  });

  it('the 1201st is dropped — still a quiet 204, nothing recorded — and another page is not affected', async () => {
    ip.value = 'local';
    for (let i = 0; i < 1200; i += 1) await visit(PAGE_B);
    recordBrowserView.mockClear();
    const over = await visit(PAGE_B);
    expect(over.status).toBe(204);
    expect(recordBrowserView).not.toHaveBeenCalled();
    expect((await visit(PAGE_C)).status).toBe(204);
    expect(recordBrowserView).toHaveBeenCalledTimes(1);
  });
});

describe('a known address', () => {
  it('keeps the per-address limit it always had: 60 a minute per page, then dropped', async () => {
    ip.value = '203.0.113.9';
    const PAGE = 'dddddddd-2222-4333-8444-555555555555';
    for (let i = 0; i < 70; i += 1) await visit(PAGE);
    expect(recordBrowserView).toHaveBeenCalledTimes(60);
  });
});
