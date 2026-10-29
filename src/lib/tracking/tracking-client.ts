/**
 * GLOBAL TRACKING — central dispatch engine (testable, framework-free).
 *
 *   TrackingEngine
 *     -> getActivePixels()   (enabled + scope-matching, re-validated)
 *     -> dedupe              (platform + pixelId + event [+ order])
 *     -> dispatch            -> MetaAdapter | TikTokAdapter | SnapchatAdapter
 *
 * Guarantees:
 *  - PageView: once per page load per pixel.
 *  - InitiateCheckout: callers gate on interaction; engine dedupes too.
 *  - Purchase: deduped by platform+pixelId+orderNumber — React re-renders
 *    or repeat submissions can never double-fire.
 *  - A disabled pixel, an out-of-scope pixel, or an unconsented pixel is
 *    never contacted. An invalid pixelId never loads a script.
 *  - No pixels configured → everything is a no-op (zero network/script).
 */

import {
  allowAllConsent,
  filterPixelsForPage,
  sanitizeTrackingPayload,
  TrackingConsentGate,
  TrackingEventName,
  TrackingPageContext,
  TrackingPayload,
  TrackingPixelView,
  trackingEventKey,
} from './tracking-types';
import { validateTrackingPixelId } from './tracking-validation';
import { TRACKING_ADAPTERS, TrackingAdapter } from './tracking-platforms';

export interface EngineAdapters {
  META: TrackingAdapter;
  TIKTOK: TrackingAdapter;
  SNAPCHAT: TrackingAdapter;
  GOOGLE: TrackingAdapter;
}

export interface TrackingEngineOptions {
  pixels: TrackingPixelView[];
  page: TrackingPageContext;
  adapters?: EngineAdapters;
  consent?: TrackingConsentGate;
}

export class TrackingEngine {
  private pixels: TrackingPixelView[];
  private page: TrackingPageContext;
  private readonly adapters: EngineAdapters;
  private readonly consent: TrackingConsentGate;
  private readonly fired = new Set<string>();
  private readonly initializedPixels = new Set<string>();
  /**
   * Events asked for before the page's PageView went out.
   *
   * A page announces what it is showing (ViewContent) from an effect that
   * runs BEFORE the one that starts the engine — so every ViewContent used
   * to reach a platform whose script was not initialised yet, was dropped
   * by the adapter, and was marked as fired so it never came back. They
   * wait here and go out right after PageView, in the order a platform
   * expects them.
   */
  private started = false;
  private readonly pending: { event: TrackingEventName; payload: TrackingPayload }[] = [];

  constructor({ pixels, page, adapters, consent }: TrackingEngineOptions) {
    this.pixels = pixels;
    this.page = page;
    this.adapters = adapters ?? TRACKING_ADAPTERS;
    this.consent = consent ?? allowAllConsent;
  }

  /** Enabled, scope-matching, re-validated pixels — the only active set. */
  getActivePixels(): TrackingPixelView[] {
    return filterPixelsForPage(this.pixels, this.page).filter(
      (p) => validateTrackingPixelId(p.platform, p.pixelId) !== null
    );
  }

  registerPixels(pixels: TrackingPixelView[]): void {
    const known = new Set(this.pixels.map((p) => p.id));
    for (const p of pixels) {
      if (p && typeof p.id === 'string' && !known.has(p.id)) {
        this.pixels.push(p);
        known.add(p.id);
      }
    }
  }

  /** Narrow/widen the page context (e.g. landing page mounts). */
  setPage(page: TrackingPageContext): void {
    this.page = page;
  }

  /** Load a pixel's platform script, once. */
  private ensureInit(pixel: TrackingPixelView): void {
    if (this.initializedPixels.has(pixel.id)) return;
    this.initializedPixels.add(pixel.id);
    try {
      this.adapters[pixel.platform].init(pixel.pixelId);
    } catch {
      /* script loading is non-fatal */
    }
  }

  /** Load each platform script once per pixel, fire PageView once, then what was waiting. */
  initAll(): void {
    for (const pixel of this.getActivePixels()) {
      if (!this.consent(pixel.platform, pixel.scope)) continue;
      this.ensureInit(pixel);
      this.dispatch('PageView', {}, pixel);
    }
    this.started = true;
    for (const { event, payload } of this.pending.splice(0)) this.track(event, payload);
  }

  /** Dispatch an event to every active pixel, with per-pixel dedupe. */
  track(event: TrackingEventName, payload: TrackingPayload, target?: TrackingPixelView): void {
    if (!this.started) {
      this.pending.push({ event, payload });
      return;
    }
    this.dispatch(event, payload, target);
  }

  private dispatch(event: TrackingEventName, payload: TrackingPayload, target?: TrackingPixelView): void {
    const pixels = target ? this.getActivePixels().filter((p) => p.id === target.id) : this.getActivePixels();
    if (pixels.length === 0) return;
    const safe = sanitizeTrackingPayload(payload);
    // ViewContent fires ONLY when there is a trusted DB product attached.
    if (event === 'ViewContent' && !Array.isArray(safe.content_ids)) return;
    for (const pixel of pixels) {
      if (!this.consent(pixel.platform, pixel.scope)) continue;
      // The seller's own switches for this pixel: a view or a started form it was told not to report.
      if (event === 'ViewContent' && pixel.sendViewContent === false) continue;
      if (event === 'InitiateCheckout' && pixel.sendInitiateCheckout === false) continue;
      // The server sends this pixel's ORDER event when the order is CONFIRMED — Purchase, or Lead for a pixel set to
      // report orders as leads (`pixelsWithServerPurchase` flags a pixel only when the conversion's name IS that
      // pixel's own order event). The browser must not send a second one. Only the order event: a server Purchase
      // does not stand in for the lead a Lead pixel sends, so that pixel is not flagged and still hears it.
      const reported: TrackingEventName = event === 'Purchase' && pixel.orderEvent === 'Lead' ? 'Lead' : event;
      if (event === 'Purchase' && pixel.purchaseOnServer) continue;
      // Purchase is once per order; ViewContent once per PRODUCT, so moving
      // from one product page to the next is a second view, not a repeat.
      const scope = event === 'ViewContent'
        ? (safe.content_ids as string[])[0]
        : (safe.order_id as string | undefined);
      /*
       * SNAPCHAT HAS NO PER-PIXEL CALL. `snaptr('track', …)` goes to every Snap pixel on the page, so an event
       * dispatched once per pixel reached each of them once per pixel: two Snap pixels counted every purchase twice.
       * The key for Snap carries no pixel number, so the event goes out ONCE per page. The limit is real and is said
       * here: two Snap pixels cannot be told apart, so a per-pixel switch (a view the seller turned off on one of
       * them) cannot be honoured between them — the other pixel's event still reaches both.
       */
      const key = trackingEventKey(pixel.platform, pixel.platform === 'SNAPCHAT' ? '*' : pixel.pixelId, reported, scope);
      if (this.fired.has(key)) continue; // dedupe — never double-fire
      this.fired.add(key);
      // A pixel registered after the page started (a later navigation) is
      // loaded on its first event rather than never.
      this.ensureInit(pixel);
      try {
        // Adapters receive the SANITIZED payload — PII/tampered fields can
        // never reach a platform even if an adapter forgets to sanitize.
        this.adapters[pixel.platform].track(reported, safe, pixel.pixelId);
      } catch {
        /* tracking is non-fatal */
      }
    }
  }
}
