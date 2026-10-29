/**
 * GLOBAL TRACKING â€” platform adapters (browser only).
 *
 * Each adapter owns ONE hard-coded platform loader. The only dynamic value
 * is a pre-validated Pixel ID. Event names are mapped from the central
 * allowlist to each platform's official browser event names â€” a client can
 * never introduce arbitrary events or arbitrary tracking code.
 *
 * TikTok: official browser pixel (ttq) â€” Pageview/ViewContent/
 *         InitiateCheckout/CompletePayment.
 * Snapchat: official Snap Pixel (snaptr) â€” PAGE_VIEW/VIEW_CONTENT/
 *         START_CHECKOUT/PURCHASE.
 * Meta: standard fbevents.js base code (unchanged behavior from Phase 3).
 * Google: the Google tag (gtag.js) — page_view/view_item/begin_checkout/
 *         purchase, sent to one tag id each (GA4 G-… or Google Ads AW-…).
 */

import {
  sanitizeTrackingPayload,
  TrackingEventName,
  TrackingPayload,
  TrackingPlatform,
} from './tracking-types';
import { googleTagOf } from './tracking-validation';

/* eslint-disable @typescript-eslint/no-explicit-any */

type QueueFn = any;

declare global {
  interface Window {
    fbq?: QueueFn;
    ttq?: any;
    snaptr?: QueueFn;
    TiktokAnalyticsObject?: string;
    gtag?: QueueFn;
    dataLayer?: unknown[];
  }
}

export interface TrackingAdapter {
  platform: TrackingPlatform;
  /** Load the platform script + register this pixel. Once per pixelId. */
  init(pixelId: string): void;
  /** Fire an allowlisted event for this pixel (payload pre-sanitized). */
  track(event: TrackingEventName, payload: TrackingPayload, pixelId: string): void;
}

function loadScript(src: string) {
  if (document.querySelector(`script[src="${src}"]`)) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Meta / Facebook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const FB_SCRIPT_SRC = 'https://connect.facebook.net/en_US/fbevents.js';
const META_EVENTS: Record<TrackingEventName, string | null> = {
  PageView: 'PageView',
  ViewContent: 'ViewContent',
  InitiateCheckout: 'InitiateCheckout',
  Purchase: 'Purchase',
  Lead: 'Lead',
};

function metaParams(payload: TrackingPayload): Record<string, unknown> {
  const p = sanitizeTrackingPayload(payload);
  const out: Record<string, unknown> = { content_type: 'product' };
  if (p.content_ids) out.content_ids = p.content_ids;
  if (p.content_name) out.content_name = p.content_name;
  if (p.value != null) {
    out.value = p.value;
    out.currency = p.currency || 'USD';
  }
  return out;
}

const metaAdapter: TrackingAdapter = {
  platform: 'META',
  init(pixelId) {
    const w = window as any;
    if (!w.fbq) {
      const n: QueueFn = (w.fbq = function (...args: any[]) {
        // Called as a method on `n`, so `this` is still `n` — the same
        // binding `.apply(n, args)` spelled out by hand, minus the array.
        n.callMethod ? n.callMethod(...args) : n.queue!.push(args);
      }) as QueueFn;
      if (!w._fbq) w._fbq = n;
      n.push = n;
      n.loaded = true;
      n.version = '2.0';
      n.queue = [];
      loadScript(FB_SCRIPT_SRC);
    }
    w.fbq('init', pixelId);
  },
  track(event, payload, pixelId) {
    const name = META_EVENTS[event];
    if (!name) return; // allowlist guard (unreachable by typing)
    const w = window as any;
    if (!w.fbq) return; // pixel not initialized â†’ fail closed
    try {
      w.fbq('trackSingle', pixelId, name, metaParams(payload));
    } catch {
      /* tracking is non-fatal */
    }
  },
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ TikTok â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TIKTOK_SCRIPT_SRC = 'https://analytics.tiktok.com/i18n/pixel/events.js';
const TIKTOK_EVENTS: Record<TrackingEventName, string | null> = {
  PageView: 'Pageview',
  ViewContent: 'ViewContent',
  InitiateCheckout: 'InitiateCheckout',
  Purchase: 'CompletePayment',
  Lead: 'SubmitForm',
};

function tiktokParams(payload: TrackingPayload): Record<string, unknown> {
  const p = sanitizeTrackingPayload(payload);
  const ids = p.content_ids as string[] | undefined;
  const out: Record<string, unknown> = {};
  if (ids?.length) {
    out.content_id = ids[0];
    out.content_type = 'product';
  }
  if (p.content_name) out.content_name = p.content_name;
  if (p.value != null) {
    out.value = p.value;
    out.currency = p.currency || 'USD';
  }
  return out;
}

const tiktokAdapter: TrackingAdapter = {
  platform: 'TIKTOK',
  init(pixelId) {
    const w = window as any;
    if (!w.ttq) {
      w.TiktokAnalyticsObject = 'ttq';
      const ttq: any = (w.ttq = []);
      ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie'];
      ttq.setAndDefer = function (obj: any, method: string) {
        obj[method] = function (...args: any[]) {
          obj.push([method].concat(args));
        };
      };
      for (const m of ttq.methods) ttq.setAndDefer(ttq, m);
      /*
       * THE OFFICIAL REGISTRY, which this stub used to leave out.
       *
       * TikTok's own snippet keeps one queue PER PIXEL (`ttq._i[id]`) and hands it back through `ttq.instance(id)`;
       * without them every `ttq.track` went to one shared queue, so with two pixels on a page each one received
       * every event of the other (a purchase counted twice on each). `load` registers the pixel's queue, and
       * `instance` wraps it with the deferred methods until the real SDK takes over.
       */
      ttq.instance = function (id: string) {
        const queue = (ttq._i && ttq._i[id]) || [];
        for (const m of ttq.methods) ttq.setAndDefer(queue, m);
        return queue;
      };
      ttq.load = function (id: string, options?: unknown) {
        ttq._i = ttq._i || {};
        ttq._i[id] = [];
        ttq._i[id]._u = TIKTOK_SCRIPT_SRC;
        ttq._t = ttq._t || {};
        ttq._t[id] = +new Date();
        ttq._o = ttq._o || {};
        ttq._o[id] = options || {};
        loadScript(`${TIKTOK_SCRIPT_SRC}?sdkid=${encodeURIComponent(id)}&lib=ttq`);
      };
    }
    // No `ttq.page()` here: the engine sends the page view itself, once, through `track` below. Calling it as well
    // counted every visit twice.
    w.ttq.load(pixelId);
  },
  track(event, payload, pixelId) {
    const name = TIKTOK_EVENTS[event];
    if (!name) return;
    const w = window as any;
    if (!w.ttq?.instance) return;
    try {
      // This pixel's own queue: an event for one pixel never reaches another on the page.
      const pixel = w.ttq.instance(pixelId);
      if (event === 'PageView') pixel.page();
      else pixel.track(name, tiktokParams(payload));
    } catch {
      /* tracking is non-fatal */
    }
  },
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Snapchat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SNAP_SCRIPT_SRC = 'https://sc-static.net/scevent.min.js';
const SNAP_EVENTS: Record<TrackingEventName, string | null> = {
  PageView: 'PAGE_VIEW',
  ViewContent: 'VIEW_CONTENT',
  InitiateCheckout: 'START_CHECKOUT',
  Purchase: 'PURCHASE',
  Lead: 'SIGN_UP',
};

function snapParams(payload: TrackingPayload): Record<string, unknown> {
  const p = sanitizeTrackingPayload(payload);
  const ids = p.content_ids as string[] | undefined;
  const out: Record<string, unknown> = {};
  if (ids?.length) out.item_ids = ids;
  if (p.content_name) out.item_names = [p.content_name];
  if (p.value != null) {
    out.price = p.value;
    out.currency = p.currency || 'USD';
  }
  if (p.order_id) out.transaction_id = p.order_id;
  return out;
}

const snapAdapter: TrackingAdapter = {
  platform: 'SNAPCHAT',
  init(pixelId) {
    const w = window as any;
    if (!w.snaptr) {
      const n: QueueFn = (w.snaptr = function (...args: any[]) {
        // As with fbq above: a method call on `n` binds `this` to `n`, so
        // dropping `.apply` changes nothing the Snap script can observe.
        n.handleRequest ? n.handleRequest(...args) : n.queue!.push(args);
      }) as QueueFn;
      n.queue = [];
      loadScript(SNAP_SCRIPT_SRC);
    }
    try {
      w.snaptr('init', pixelId);
    } catch {
      /* non-fatal */
    }
  },
  track(event, payload) {
    const name = SNAP_EVENTS[event];
    if (!name) return;
    const w = window as any;
    if (!w.snaptr) return;
    try {
      w.snaptr('track', name, snapParams(payload));
    } catch {
      /* non-fatal */
    }
  },
};

// ─────────────────────────────── Google ───────────────────────────────
const GTAG_SCRIPT_SRC = 'https://www.googletagmanager.com/gtag/js';
const GOOGLE_EVENTS: Record<TrackingEventName, string | null> = {
  PageView: 'page_view',
  ViewContent: 'view_item',
  InitiateCheckout: 'begin_checkout',
  Purchase: 'purchase',
  Lead: 'generate_lead',
};

export function googleParams(payload: TrackingPayload, tagId: string): Record<string, unknown> {
  const p = sanitizeTrackingPayload(payload);
  const ids = p.content_ids as string[] | undefined;
  // send_to pins the event to THIS tag: with two tags on a page, an event
  // without it goes to both and every conversion is counted twice.
  const out: Record<string, unknown> = { send_to: googleTagOf(tagId) };
  if (ids?.length) {
    out.items = ids.map((id) => ({ item_id: id, ...(p.content_name ? { item_name: p.content_name } : {}) }));
  }
  if (p.value != null) {
    out.value = p.value;
    out.currency = p.currency || 'USD';
  }
  if (p.order_id) out.transaction_id = p.order_id;
  return out;
}

const googleAdapter: TrackingAdapter = {
  platform: 'GOOGLE',
  init(tagId) {
    const w = window as any;
    const tag = googleTagOf(tagId);
    if (!w.gtag) {
      w.dataLayer = w.dataLayer || [];
      // The official stub: gtag pushes its `arguments` object, which is what
      // gtag.js expects to find in the queue.
      w.gtag = function () {
        // eslint-disable-next-line prefer-rest-params
        w.dataLayer.push(arguments);
      };
      w.gtag('js', new Date());
      loadScript(`${GTAG_SCRIPT_SRC}?id=${encodeURIComponent(tag)}`);
    }
    // The engine fires PageView itself, once per page load — letting the tag
    // send its own as well would count every visit twice.
    w.gtag('config', tag, { send_page_view: false });
  },
  track(event, payload, tagId) {
    const name = GOOGLE_EVENTS[event];
    if (!name) return;
    const w = window as any;
    if (!w.gtag) return;
    try {
      w.gtag('event', name, googleParams(payload, tagId));
      // An Ads tag with a conversion label records the purchase as the
      // conversion itself — the one event Google Ads optimises on.
      if (event === 'Purchase' && tagId.includes('/')) {
        w.gtag('event', 'conversion', { ...googleParams(payload, tagId), send_to: tagId });
      }
    } catch {
      /* tracking is non-fatal */
    }
  },
};

export const TRACKING_ADAPTERS: Record<TrackingPlatform, TrackingAdapter> = {
  META: metaAdapter,
  TIKTOK: tiktokAdapter,
  SNAPCHAT: snapAdapter,
  GOOGLE: googleAdapter,
};
