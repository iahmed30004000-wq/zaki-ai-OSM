// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { TrackingEngine } from './tracking-client';
import { TRACKING_ADAPTERS, type TrackingAdapter } from './tracking-platforms';
import type { TrackingPixelView } from './tracking-types';

/**
 * ط35 — TWO PIXELS OF ONE PLATFORM ARE TWO PIXELS.
 *
 * TikTok's adapter used one shared queue, so with two TikTok pixels each received every event of the other (a purchase
 * counted twice on each), and its `init` sent a page view of its own on top of the engine's (one pixel counted every
 * visit twice). It now keeps the official per-pixel registry (`ttq.instance(id)`) and sends the page view once.
 * Snapchat has no per-pixel call at all — `snaptr('track')` goes to every Snap pixel — so the engine sends a Snap event
 * ONCE per page, whatever the number of Snap pixels, and the limit (a per-pixel switch cannot be honoured between two
 * Snap pixels) is written in the engine.
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: Snapchat is deduplicated per page, not split per pixel (it
 * cannot be split); TikTok is split per pixel with its own SDK's registry.
 */

type Entry = [string, ...unknown[]];
const win = () => window as unknown as { ttq: Entry[] & { _i: Record<string, Entry[]> }; snaptr?: unknown };

const tiktok = (id: string, pixelId: string): TrackingPixelView => ({ id, platform: 'TIKTOK', name: id, pixelId, scope: 'GLOBAL', enabled: true });
const A = 'CABCDEFGHIJ1234567';
const B = 'CBBCDEFGHIJ7654321';

beforeEach(() => {
  document.head.innerHTML = '';
  delete (window as { ttq?: unknown }).ttq;
  delete (window as { snaptr?: unknown }).snaptr;
});

describe('TikTok', () => {
  it('one pixel: the visit is ONE page view — the adapter\'s own init sends none', () => {
    const engine = new TrackingEngine({ page: 'PUBLIC', pixels: [tiktok('a', A)] });
    engine.initAll();
    const queue = win().ttq._i[A].filter((e) => e[0] === 'page');
    expect(queue).toHaveLength(1);
    // And nothing was put on the shared queue by init.
    expect(win().ttq.filter((e) => e[0] === 'page')).toHaveLength(0);
  });

  it('two pixels: an event for one is in ITS queue and not in the other\'s', () => {
    const engine = new TrackingEngine({ page: 'PUBLIC', pixels: [tiktok('a', A), tiktok('b', B)] });
    engine.initAll();
    engine.track('Purchase', { orderId: 'ORD-1', value: 20, currency: 'USD' }, tiktok('a', A));
    const bought = (id: string) => win().ttq._i[id].filter((e) => e[0] === 'track' && e[1] === 'CompletePayment');
    expect(bought(A)).toHaveLength(1);
    expect(bought(B)).toHaveLength(0);
  });

  it('two pixels, one purchase for both: each gets exactly one — not two', () => {
    const engine = new TrackingEngine({ page: 'PUBLIC', pixels: [tiktok('a', A), tiktok('b', B)] });
    engine.initAll();
    engine.track('Purchase', { orderId: 'ORD-1', value: 20, currency: 'USD' });
    const bought = (id: string) => win().ttq._i[id].filter((e) => e[0] === 'track' && e[1] === 'CompletePayment');
    expect([bought(A).length, bought(B).length]).toEqual([1, 1]);
  });

  it('loads a script per pixel, each with its own id, and registers a queue for each', () => {
    TRACKING_ADAPTERS.TIKTOK.init(A);
    TRACKING_ADAPTERS.TIKTOK.init(B);
    expect(Object.keys(win().ttq._i).sort()).toEqual([A, B].sort());
    expect(document.head.querySelectorAll('script[src^="https://analytics.tiktok.com/i18n/pixel/events.js"]')).toHaveLength(2);
  });

  it('NEGATIVE: an event before the stub exists is dropped without an error', () => {
    expect(() => TRACKING_ADAPTERS.TIKTOK.track('Purchase', {}, A)).not.toThrow();
  });
});

describe('Snapchat', () => {
  const recorder = (log: { platform: string; pixelId: string; event: string }[]) => {
    const make = (platform: 'META' | 'TIKTOK' | 'SNAPCHAT' | 'GOOGLE'): TrackingAdapter => ({
      platform, init() {}, track(event, _p, pixelId) { log.push({ platform, pixelId, event }); },
    });
    return { META: make('META'), TIKTOK: make('TIKTOK'), SNAPCHAT: make('SNAPCHAT'), GOOGLE: make('GOOGLE') };
  };
  const snap = (id: string, pixelId: string): TrackingPixelView => ({ id, platform: 'SNAPCHAT', name: id, pixelId, scope: 'GLOBAL', enabled: true });
  const meta = (id: string, pixelId: string): TrackingPixelView => ({ id, platform: 'META', name: id, pixelId, scope: 'GLOBAL', enabled: true });
  const run = (pixels: TrackingPixelView[]) => {
    const log: { platform: string; pixelId: string; event: string }[] = [];
    const engine = new TrackingEngine({ page: 'PUBLIC', adapters: recorder(log), pixels });
    engine.initAll();
    engine.track('Purchase', { orderId: 'ORD-1', value: 20, currency: 'USD' });
    return log;
  };

  it('two Snap pixels: the page view and the purchase each go out ONCE', () => {
    const log = run([snap('s1', 'aaaaaaaa-1111-2222-3333-444444444444'), snap('s2', 'bbbbbbbb-1111-2222-3333-444444444444')]);
    const snaps = log.filter((c) => c.platform === 'SNAPCHAT');
    expect(snaps.filter((c) => c.event === 'Purchase')).toHaveLength(1);
    expect(snaps.filter((c) => c.event === 'PageView')).toHaveLength(1);
  });

  it('NEGATIVE: one Snap pixel is unchanged — its page view once, its purchase once', () => {
    const log = run([snap('s1', 'aaaaaaaa-1111-2222-3333-444444444444')]);
    expect(log.filter((c) => c.event === 'PageView')).toHaveLength(1);
    expect(log.filter((c) => c.event === 'Purchase')).toHaveLength(1);
  });

  it('NEGATIVE: Meta can address its pixels one by one, so two Meta pixels still each get theirs', () => {
    const log = run([meta('m1', '111111111111111'), meta('m2', '222222222222222')]);
    expect(log.filter((c) => c.event === 'Purchase')).toHaveLength(2);
  });
});
