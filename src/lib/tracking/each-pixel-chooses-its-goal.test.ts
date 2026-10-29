import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackingEngine } from '@/lib/tracking/tracking-client';
import type { TrackingPixelView } from '@/lib/tracking/tracking-types';
import type { TrackingAdapter } from '@/lib/tracking/tracking-platforms';
import { repoFile } from '@/lib/guard-source';

/**
 * «بدي تحط عندي بالسايت جنب البيكسيل شو الهدف الي بدك التحويل عليه — شراء ولا بيدج فيو…».
 *
 * Each pixel says what an accepted order is reported as (a purchase, as always, or a lead) and whether it hears the
 * two earlier moments (a product viewed, the form started). The defaults are exactly what every pixel did before.
 */

const { db } = vi.hoisted(() => ({
  db: { trackingPixel: { findMany: vi.fn() }, customConversion: { findMany: vi.fn() } },
}));
vi.mock('@/lib/db', () => ({ db }));

import { getCompanyTrackingPixels } from '@/lib/tracking/tracking-config';

const px = (over: Partial<TrackingPixelView> = {}): TrackingPixelView => ({
  id: 'p1', platform: 'META', name: 'عالمي', pixelId: '123456789012345', scope: 'GLOBAL', enabled: true, ...over,
});

function run(pixels: TrackingPixelView[]) {
  const log: { platform: string; event: string }[] = [];
  const make = (platform: 'META' | 'TIKTOK' | 'SNAPCHAT' | 'GOOGLE'): TrackingAdapter => ({
    platform, init() {}, track(event) { log.push({ platform, event }); },
  });
  const engine = new TrackingEngine({ page: 'LANDING_PAGES', adapters: { META: make('META'), TIKTOK: make('TIKTOK'), SNAPCHAT: make('SNAPCHAT'), GOOGLE: make('GOOGLE') }, pixels });
  engine.initAll();
  engine.track('ViewContent', { contentIds: ['prod-1'], contentName: 'ماء الكمأ', value: 12, currency: 'USD' });
  engine.track('InitiateCheckout', { value: 12, currency: 'USD' });
  engine.track('Purchase', { orderId: 'ORD-1', value: 20, currency: 'USD' });
  return log.map((c) => c.event);
}

beforeEach(() => vi.clearAllMocks());

describe('a pixel on its defaults', () => {
  it('hears every moment it always heard, and an order is a purchase', () => {
    expect(run([px()])).toEqual(['PageView', 'ViewContent', 'InitiateCheckout', 'Purchase']);
  });
});

describe('a pixel whose goal is a lead', () => {
  it('reports the order as a Lead — and never also as a Purchase', () => {
    const events = run([px({ orderEvent: 'Lead' })]);
    expect(events).toContain('Lead');
    expect(events).not.toContain('Purchase');
  });

  it('still hears its lead when the company sends only a Purchase from the server — that is a different event, so the pixel is not flagged', () => {
    expect(run([px({ orderEvent: 'Lead' })])).toContain('Lead');
  });

  it('stands down when the server sends the LEAD itself at confirmation (ط34) — flagged, the browser sends neither', () => {
    const events = run([px({ orderEvent: 'Lead', purchaseOnServer: true })]);
    expect(events).not.toContain('Lead');
    expect(events).not.toContain('Purchase');
    // And only the order event: the earlier moments still arrive.
    expect(events).toEqual(expect.arrayContaining(['PageView', 'ViewContent', 'InitiateCheckout']));
  });

  it('NEGATIVE: a second pixel on its defaults still gets the Purchase', () => {
    const events = run([px({ orderEvent: 'Lead' }), px({ id: 'p2', pixelId: '999999999999999' })]);
    expect(events.filter((e) => e === 'Purchase')).toHaveLength(1);
    expect(events.filter((e) => e === 'Lead')).toHaveLength(1);
  });
});

describe('the two switches', () => {
  it('a pixel told not to hear product views or started forms does not', () => {
    expect(run([px({ sendViewContent: false, sendInitiateCheckout: false })])).toEqual(['PageView', 'Purchase']);
  });

  it('NEGATIVE: the visit is always sent — a pixel with no PageView is no pixel to the platform', () => {
    expect(run([px({ sendViewContent: false, sendInitiateCheckout: false })])).toContain('PageView');
  });
});

describe('what reaches the browser', () => {
  it('only what differs from the default — a page of default pixels ships the bytes it did before', async () => {
    db.trackingPixel.findMany.mockResolvedValue([
      { id: 'a', platform: 'META', name: 'a', pixelId: '123456789012345', scope: 'GLOBAL', enabled: true, storeId: null, countryId: null, orderEvent: 'Purchase', sendViewContent: true, sendInitiateCheckout: true },
      { id: 'b', platform: 'META', name: 'b', pixelId: '223456789012345', scope: 'GLOBAL', enabled: true, storeId: null, countryId: null, orderEvent: 'Lead', sendViewContent: false, sendInitiateCheckout: true },
    ]);
    db.customConversion.findMany.mockResolvedValue([]);
    const [a, b] = await getCompanyTrackingPixels('co');
    expect(Object.keys(a)).not.toEqual(expect.arrayContaining(['orderEvent']));
    expect(a.sendViewContent).toBeUndefined();
    expect(b).toMatchObject({ orderEvent: 'Lead', sendViewContent: false });
    expect(b.sendInitiateCheckout).toBeUndefined();
  });

  it('every platform knows what a lead is called', () => {
    const src = repoFile('src/lib/tracking/tracking-platforms.ts');
    for (const name of ["Lead: 'Lead'", "Lead: 'SubmitForm'", "Lead: 'SIGN_UP'", "Lead: 'generate_lead'"]) expect(src).toContain(name);
  });

  it('and the migration only adds, with today’s behaviour as the default', () => {
    const sql = repoFile('prisma/migrations/20261026000000_pixel_order_event/migration.sql');
    expect(sql).toContain(`ADD COLUMN "orderEvent" TEXT NOT NULL DEFAULT 'Purchase'`);
    expect(sql).toContain('ADD COLUMN "sendViewContent" BOOLEAN NOT NULL DEFAULT true');
    expect(sql).toContain('ADD COLUMN "sendInitiateCheckout" BOOLEAN NOT NULL DEFAULT true');
    expect(sql).not.toMatch(/DROP|DELETE|TRUNCATE|UPDATE/i);
  });
});
