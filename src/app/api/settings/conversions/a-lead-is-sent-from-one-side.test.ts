import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collidesWithBrowserPixel, orderEventOf, replacesBrowserPurchase } from '@/lib/conversions/types';

/**
 * ط34 — A PIXEL'S ORDER EVENT IS SENT FROM ONE SIDE ONLY, WHATEVER IT IS CALLED.
 *
 * A pixel set to report orders as leads sends `Lead` from the browser at the submit. A server conversion named «Lead»
 * on the confirmation then counted every order twice (the browser never sends an event id, so Meta cannot join them),
 * and the door said nothing. The warning, the note and the browser's stand-down all follow the PIXEL'S OWN order event
 * now; and the note «الصفحة توقفت» is said only when it is true — conversion on, pixel holding its token.
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: no event id is sent from the browser (a larger change, left
 * out); the double count is prevented by sending from one side.
 */

describe('the rule', () => {
  it('a Lead pixel is replaced by a server Lead at the confirmation, and that is no collision', () => {
    expect(replacesBrowserPurchase('Lead', 'order.confirmed', 'Lead')).toBe(true);
    expect(collidesWithBrowserPixel('Lead', 'order.confirmed', 'Lead')).toBe(false);
  });

  it('a Lead pixel sends Lead at the submit, so a server Lead on the submit or on delivery DOUBLES it and is warned', () => {
    for (const trigger of ['order.created', 'order.delivered']) {
      expect(collidesWithBrowserPixel('Lead', trigger, 'Lead'), trigger).toBe(true);
    }
  });

  it('NEGATIVE: a pixel on the default sends no Lead at all, so a server Lead collides with nothing', () => {
    for (const trigger of ['order.created', 'order.confirmed', 'order.delivered']) {
      expect(collidesWithBrowserPixel('Lead', trigger), trigger).toBe(false);
      expect(collidesWithBrowserPixel('Lead', trigger, 'Purchase'), trigger).toBe(false);
    }
  });

  it('NEGATIVE: a Lead pixel sends no Purchase, so a server Purchase on delivery doubles nothing there', () => {
    expect(collidesWithBrowserPixel('Purchase', 'order.delivered', 'Lead')).toBe(false);
    expect(replacesBrowserPurchase('Purchase', 'order.confirmed', 'Lead')).toBe(false);
  });

  it('NEGATIVE: with no pixel goal the old answers are the old answers', () => {
    expect(collidesWithBrowserPixel('Purchase', 'order.created')).toBe(true);
    expect(replacesBrowserPurchase('Purchase', 'order.confirmed')).toBe(true);
    expect(collidesWithBrowserPixel('PageView', 'order.confirmed', 'Lead')).toBe(true);
  });

  it('the type of a row\'s order event: Lead, or the default', () => {
    expect(orderEventOf({ orderEvent: 'Lead' })).toBe('Lead');
    expect(orderEventOf({ orderEvent: 'Purchase' })).toBe('Purchase');
    expect(orderEventOf({})).toBe('Purchase');
    expect(orderEventOf({ orderEvent: 'garbage' })).toBe('Purchase');
  });
});

const { db, requireCompanyTenant, requirePermission } = vi.hoisted(() => ({
  db: { trackingPixel: { findFirst: vi.fn() }, customConversion: { findFirst: vi.fn(), create: vi.fn() } },
  requireCompanyTenant: vi.fn(),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: (...a: unknown[]) => requireCompanyTenant(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/api-error', () => ({ apiErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }) }));

import { POST } from './route';

const PIXEL = '11111111-1111-4111-8111-111111111111';
const post = (eventName: string, trigger: string, enabled = true) =>
  POST(new Request('http://x/api/settings/conversions', {
    method: 'POST',
    body: JSON.stringify({ pixelId: PIXEL, name: 'تحويل', eventName, trigger, enabled }),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  requireCompanyTenant.mockResolvedValue({ user: { id: 'u1', name: 'احمد' }, companyId: 'co' });
  db.trackingPixel.findFirst.mockResolvedValue({ id: PIXEL, platform: 'META', name: 'm', capiToken: 'enc', orderEvent: 'Lead' });
  db.customConversion.findFirst.mockResolvedValue(null);
  db.customConversion.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'c1', ...data }));
});

describe('the door', () => {
  it('a Lead on the confirmation of a Lead pixel is said, not warned', async () => {
    const body = await (await post('Lead', 'order.confirmed')).json();
    expect(body.warning).toBeNull();
    expect(body.note).toContain('Lead');
  });

  it('a Lead on the submit of a Lead pixel is warned about (the browser sends one too)', async () => {
    const body = await (await post('Lead', 'order.created')).json();
    expect(body.warning).toContain('تضاعف');
    expect(body.note).toBeNull();
  });

  it('NEGATIVE: the note «the page stopped» is NOT said for a conversion saved switched off', async () => {
    const body = await (await post('Lead', 'order.confirmed', false)).json();
    expect(body.note).toBeNull();
  });

  it('NEGATIVE: nor for a pixel that holds no token (it cannot receive the server event)', async () => {
    db.trackingPixel.findFirst.mockResolvedValue({ id: PIXEL, platform: 'META', name: 'm', capiToken: null, orderEvent: 'Lead' });
    const body = await (await post('Lead', 'order.confirmed')).json();
    expect(body.note).toBeNull();
  });

  it('reads the pixel\'s own order event from the row', async () => {
    await post('Lead', 'order.confirmed');
    expect(db.trackingPixel.findFirst.mock.calls[0][0].select.orderEvent).toBe(true);
  });
});
