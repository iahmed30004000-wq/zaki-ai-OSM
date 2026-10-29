import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackingEngine } from '@/lib/tracking/tracking-client';
import type { TrackingPixelView } from '@/lib/tracking/tracking-types';
import type { TrackingAdapter } from '@/lib/tracking/tracking-platforms';
import { collidesWithBrowserPixel, replacesBrowserPurchase } from '@/lib/conversions/types';

/**
 * «الشراء بيتحقق لما يتم تأكيد الطلب وهو الأولوية».
 *
 * The server already sends a conversion when an order is confirmed (Conversions API). What was missing was the
 * browser standing down: it sent Purchase at the form's submit, so a seller who also sent Purchase on the
 * confirmation had it counted twice. A pixel the server covers is flagged `purchaseOnServer`, and the page stops
 * sending Purchase to THAT pixel only — every other pixel, and every other event, goes on as before.
 */

const { db } = vi.hoisted(() => ({
  db: { trackingPixel: { findMany: vi.fn() }, customConversion: { findMany: vi.fn() } },
}));
vi.mock('@/lib/db', () => ({ db }));

import { getCompanyTrackingPixels, pixelsWithServerPurchase } from '@/lib/tracking/tracking-config';

function px(over: Partial<TrackingPixelView> = {}): TrackingPixelView {
  return { id: 'p1', platform: 'META', name: 'm', pixelId: '123456789012345', scope: 'GLOBAL', enabled: true, ...over };
}

interface Call { platform: string; pixelId: string; event: string }
function adapters(log: Call[]) {
  const make = (platform: 'META' | 'TIKTOK' | 'SNAPCHAT' | 'GOOGLE'): TrackingAdapter => ({
    platform,
    init() {},
    track(event, _payload, pixelId) {
      log.push({ platform, pixelId, event });
    },
  });
  return { META: make('META'), TIKTOK: make('TIKTOK'), SNAPCHAT: make('SNAPCHAT'), GOOGLE: make('GOOGLE') };
}

describe('the browser engine', () => {
  const run = (pixels: TrackingPixelView[]) => {
    const log: Call[] = [];
    const engine = new TrackingEngine({ page: 'PUBLIC', adapters: adapters(log), pixels });
    engine.initAll();
    engine.track('Purchase', { orderId: 'ORD-1', value: 100, currency: 'USD' });
    return log.filter((c) => c.event === 'Purchase');
  };

  it('still sends Purchase to a pixel the server does not cover — exactly as before', () => {
    expect(run([px()])).toHaveLength(1);
  });

  it('does NOT send Purchase to a pixel whose Purchase the server sends at confirmation', () => {
    expect(run([px({ purchaseOnServer: true })])).toEqual([]);
  });

  it('stands down for that pixel only: another Meta pixel and a TikTok pixel still get it', () => {
    const sent = run([
      px({ id: 'm1', pixelId: '111111111111111', purchaseOnServer: true }),
      px({ id: 'm2', pixelId: '222222222222222' }),
      px({ id: 't1', platform: 'TIKTOK', pixelId: 'TIKTOK123456' }),
    ]);
    expect(sent.map((c) => c.pixelId).sort()).toEqual(['222222222222222', 'TIKTOK123456']);
  });

  it('and only Purchase: PageView, ViewContent and InitiateCheckout still reach the covered pixel', () => {
    const log: Call[] = [];
    const engine = new TrackingEngine({ page: 'PUBLIC', adapters: adapters(log), pixels: [px({ purchaseOnServer: true })] });
    engine.initAll();
    engine.track('InitiateCheckout', {});
    engine.track('ViewContent', { contentIds: ['prod-1'] });
    expect(log.map((c) => c.event)).toEqual(expect.arrayContaining(['PageView', 'InitiateCheckout', 'ViewContent']));
  });
});

describe('which pixels the server covers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for exactly the conversions that WILL be sent: on, named like a pixel order event, on the confirmation, on a pixel that is on and holds its token', async () => {
    db.customConversion.findMany.mockResolvedValue([{ pixelId: 'p1', eventName: 'Purchase', pixel: { orderEvent: 'Purchase' } }]);
    const set = await pixelsWithServerPurchase('co');
    expect([...set]).toEqual(['p1']);
    expect(db.customConversion.findMany.mock.calls[0][0].where).toEqual({
      companyId: 'co',
      enabled: true,
      trigger: 'order.confirmed',
      // CHANGED (ط34): was `eventName: 'Purchase'`. The name that covers a pixel is ITS order event, so both names are
      // read and the row is kept only when the name equals that pixel's own goal (the next tests).
      eventName: { in: ['Purchase', 'Lead'] },
      pixel: { enabled: true, capiToken: { not: null } },
    });
  });

  it('a pixel that reports orders as leads is covered by a server LEAD at confirmation, and not by a server Purchase', async () => {
    db.customConversion.findMany.mockResolvedValue([
      { pixelId: 'lead-with-lead', eventName: 'Lead', pixel: { orderEvent: 'Lead' } },
      { pixelId: 'lead-with-purchase', eventName: 'Purchase', pixel: { orderEvent: 'Lead' } },
      { pixelId: 'plain-with-lead', eventName: 'Lead', pixel: { orderEvent: 'Purchase' } },
      { pixelId: 'plain-with-purchase', eventName: 'Purchase', pixel: { orderEvent: 'Purchase' } },
    ]);
    expect([...(await pixelsWithServerPurchase('co'))].sort()).toEqual(['lead-with-lead', 'plain-with-purchase']);
  });

  it('NEGATIVE: if it cannot be read, nothing is covered — the browser keeps sending Purchase', async () => {
    db.customConversion.findMany.mockRejectedValue(new Error('db down'));
    expect((await pixelsWithServerPurchase('co')).size).toBe(0);
  });

  it('flags only the pixel the conversion belongs to, and leaves the others unflagged', async () => {
    const row = (id: string) => ({ id, platform: 'META', name: id, pixelId: '123456789012345', scope: 'GLOBAL', enabled: true, storeId: null, countryId: null });
    db.trackingPixel.findMany.mockResolvedValue([row('p1'), row('p2')]);
    db.customConversion.findMany.mockResolvedValue([{ pixelId: 'p2', eventName: 'Purchase', pixel: { orderEvent: 'Purchase' } }]);
    const views = await getCompanyTrackingPixels('co');
    expect(views.find((v) => v.id === 'p1')?.purchaseOnServer).toBeUndefined();
    expect(views.find((v) => v.id === 'p2')?.purchaseOnServer).toBe(true);
  });

  it('NEGATIVE: with no such conversion no pixel is flagged', async () => {
    db.trackingPixel.findMany.mockResolvedValue([
      { id: 'p1', platform: 'META', name: 'm', pixelId: '123456789012345', scope: 'GLOBAL', enabled: true, storeId: null, countryId: null },
    ]);
    db.customConversion.findMany.mockResolvedValue([]);
    expect((await getCompanyTrackingPixels('co'))[0].purchaseOnServer).toBeUndefined();
  });
});

describe('the name Purchase on the confirmation', () => {
  it('is the one combination that is meant — it replaces the browser’s Purchase, so it is no collision', () => {
    expect(replacesBrowserPurchase('Purchase', 'order.confirmed')).toBe(true);
    expect(collidesWithBrowserPixel('Purchase', 'order.confirmed')).toBe(false);
  });

  it('NEGATIVE: Purchase at any other moment still doubles the browser’s, and is still warned about', () => {
    for (const trigger of ['order.created', 'order.delivered', undefined]) {
      expect(replacesBrowserPurchase('Purchase', trigger), String(trigger)).toBe(false);
      expect(collidesWithBrowserPixel('Purchase', trigger), String(trigger)).toBe(true);
    }
  });

  it('NEGATIVE: the other browser events are never replaced, whatever the moment', () => {
    for (const name of ['PageView', 'ViewContent', 'InitiateCheckout']) {
      expect(replacesBrowserPurchase(name, 'order.confirmed')).toBe(false);
      expect(collidesWithBrowserPixel(name, 'order.confirmed')).toBe(true);
    }
  });

  it('and a custom name is no collision at any moment', () => {
    expect(collidesWithBrowserPixel('OrderConfirmed', 'order.confirmed')).toBe(false);
  });
});
