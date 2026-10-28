'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertCircle, ShoppingBag, Search } from 'lucide-react';
import { whatsappHref } from '@/lib/store-contact';
import { ORDER_PLACED } from '@/lib/order-placed-event';
import { leaveFor } from '@/lib/leave-for';
import { RiWhatsappLine } from '@/components/storefront/icons';
import { useTracking } from '@/components/tracking/GlobalTrackingProvider';
// Types only: the values live beside zod, and this form ships on every landing page.
import type { CheckoutField, PageCheckout } from '@/lib/store-theme';
// Plain data, no zod: the door's own «اكتب …» sentences, asked here before anything is sent, and the form's defaults.
import { DEFAULT_SUBMIT, DEFAULT_THANKS, NEW_REQUIRED_FIELD, blankRequired, refusesUndrawn } from '@/lib/checkout-words';

/**
 * Trusted Native Order Form — rendered by Zaki AI itself on the public
 * landing page (BELOW the sandboxed iframe holding the uploaded HTML).
 *
 * Security contract:
 *  - sends ONLY: full_name, phone, address, city, offerId, the campaign code
 *    (+ honeypot and time stamp), and the two the shop's «الدفع» may draw —
 *    alt_phone and notes — only when this form draws them: a field the shop
 *    hid is neither drawn nor sent
 *  - NEVER sends companyId / productId / price / quantity / freeQuantity /
 *    status / userId — the server derives everything from slug + offerId.
 *  - offers & prices arrive as server-rendered props straight from the DB.
 *  - the uploaded landing-page HTML (opaque-origin sandbox) cannot access
 *    or manipulate this form in any way.
 *
 * Theming: every brand colour here reads `var(--store-*, <the old value>)`. On
 * a block-built page those variables carry the seller's derived palette and
 * the form wears the page's colours; anywhere else the fallback is exactly
 * what was hard-coded before, so nothing already published changes. The form
 * is the most important thing on the page — it was the one part that could
 * not follow it.
 */

export interface OfferView {
  id: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  price: number;
  isDefault: boolean;
  isBest?: boolean; // flagged client-side: cheapest per unit
  /** The price already carries the delivery fee — the customer pays nothing more for it. The server sends it; absent = say nothing. */
  deliveryIncluded?: boolean;
}

export interface RecommendationView {
  id: string;
  name: string;
  price: number;
  image: string | null;
  /** One short line: the seller's own, or the start of the product's description. */
  blurb?: string | null;
  /** The product's own page (its landing page, or its page in the shop), opened beside this one. */
  pageUrl?: string | null;
}

/**
 * THE ONE OFFER SHOWN AFTER THE ORDER, exactly as the server sends it.
 *
 * It arrives in the order-creation RESPONSE rather than as a prop, and that
 * is the point: the offer and its price are read from the product's own
 * offers at the moment the order exists, by the same `toOfferView` that
 * priced the bundles on this page. Nothing here is computed — `price` is
 * what the customer will be charged and `listPrice` is the bundle before its
 * own reduction, so «15 بدل 25» is two numbers printed, never a subtraction
 * performed in a browser.
 */
export interface PostOrderOfferView {
  id: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  price: number;
  listPrice: number | null;
}

interface OrderFormProps {
  slug: string;
  productName: string;
  basePrice: number; // unit price (for savings display) — from DB
  currency: string;
  offers: OfferView[];
  recommendations: RecommendationView[];
  /** Region names of the store's country — the only city options offered. */
  regions: string[];
  /** Placeholder for the phone field, in this country's own format. */
  phonePlaceholder?: string;
  /** Phase 2: offer selected from custom-HTML placeholder (pre-validated by the bridge) */
  externalSelectedOfferId?: string | null;
  /**
   * Whether this form draws the offer list itself.
   *
   * A block-built page can carry its own `offers` block higher up. When it
   * does, the form must NOT draw a second list: the visitor was choosing
   * between three tiers and suddenly had six to look at. One picker per
   * page, wherever the seller put it — the form then only states which one
   * is selected.
   */
  showOfferPicker?: boolean;
  /** The form's look and how it lists the bundles — the `form` block's choices. Default: as it always was. */
  formStyle?: 'card' | 'compact';
  offerStyle?: 'cards' | 'radio' | 'select';
  /**
   * WHICH WAY THIS FORM READS.
   *
   * It defaults to `rtl` because a landing page is written in Arabic and
   * every one that exists today relies on that. A STOREFRONT does not: its
   * direction is `directionOf(store.language)`, the seller's own choice,
   * and a shop selling in English had the whole page mirror around a form
   * that stayed put — the one block on the page still reading the other
   * way. The shop passes its own direction; nobody else has to know.
   */
  dir?: 'rtl' | 'ltr';
  /**
   * THE SHOP'S OWN NUMBER, FOR THE CONFIRMATION BUTTON.
   *
   * «زر تأكيد اختياري عبر واتساب برسالة معبّاة». Optional in both senses:
   * a shop that has entered no number gets no button — one that opens
   * WhatsApp with nothing behind it is worse than none — and a customer
   * who ignores it has still ordered. The order is placed either way; this
   * is a customer reaching a person, which is what shortens a confirmation
   * call to nothing.
   */
  whatsapp?: string | null;



/**
   * Where the order is posted.
   *
   * A landing page and a storefront are two doors into one shop, and the
   * form is the same at both. Defaulting to the landing page's endpoint
   * keeps every existing page working without being told about this.
   */
  endpoint?: string;
  /**
   * What the customer reads once the order is in — the page's thank-you
   * block, when it has one. The order number and the post-order offers are
   * shown under it either way: they are the system's, not copy.
   */
  thankYou?: { title: string; message: string };
  /**
   * The WhatsApp button after the order, as the form block sets it: on/off, its words, the message (`{رقم_الطلب}`
   * becomes the number) and whether WhatsApp opens by itself. Absent = the button as it always was.
   */
  afterOrderWhatsapp?: {
    enabled?: boolean;
    label?: string;
    message?: string;
    autoOpen?: boolean;
    /** When it appears and what it looks like — `landing-sections.ts` `whatsappWhen` and the rest. */
    when?: 'now' | 'end' | 'delay';
    delaySeconds?: number;
    look?: 'outline' | 'solid' | 'green' | 'floating';
    shape?: 'curved' | 'pill' | 'square';
    wide?: boolean;
    color?: string;
    icon?: boolean;
    pulse?: boolean;
  };
  /** The words on the submit button, as the form block sets them; the price follows. Absent = «تأكيد الطلب». */
  submitLabel?: string;
  /**
   * The thank-you screen's offers, as the form block's «بعد الطلب» shapes them (`landing-sections.ts`). Absent, the
   * screen is the one it always was: both at once, no strip, the card and the list.
   */
  afterOrderLook?: {
    flow?: 'together' | 'sequence';
    banner?: 'none' | 'congrats' | 'countdown';
    bannerText?: string;
    upsellLook?: 'card' | 'banner' | 'compact';
    crossSellLook?: 'list' | 'cards';
  };
  /**
   * THE STORE'S «الدفع» — worked out on the server by `checkoutForPage` from the store's LIVE theme and handed in as
   * plain data, by every public door that draws this form: a landing page, a store's front, a product page inside
   * the shop. With it: the fields the shop shows, in its order, «هاتف بديل» among them unless hidden, the «*» it
   * asked for (and «اكتب …» before sending when one is left blank), its words and its colour on the confirm button,
   * and its line on the thank-you screen. Without it the form is exactly the one it always was.
   */
  checkout?: PageCheckout;
}

/**
 * The form as it always was, for a door that hands in no checkout: no second number, the note folded, the four a
 * parcel needs marked.
 */
const AS_IT_ALWAYS_WAS: { fields: readonly CheckoutField[]; required: readonly CheckoutField[] } = {
  fields: ['name', 'phone', 'address', 'region', 'note'],
  required: ['name', 'phone', 'address', 'region'],
};

/**
 * THE CONFIRM BUTTON'S WORDS: the page's own, unless the page kept the default and the shop wrote its own in «الدفع».
 *
 * Every block page stores «تأكيد الطلب» — it is the form block's default — so «this page chose nothing» can only be
 * read as that string or a blank. A seller who typed other words on the page keeps them. Never blank.
 */
export function submitWords(pageLabel: string | undefined, shopText: string | undefined): string {
  const page = pageLabel?.trim() ?? '';
  const shop = shopText?.trim() ?? '';
  if (shop && (page === '' || page === DEFAULT_SUBMIT)) return shop;
  return page || DEFAULT_SUBMIT;
}

/**
 * The line under the thank-you title: the page's «صفحة الشكر» block, then the shop's «رسالة ما بعد الطلب», then ours.
 *
 * The same rule as `submitWords`: every «صفحة الشكر» block is born holding the default message, so «this page wrote
 * nothing» reads as that sentence or a blank — and then the shop's line shows. Words the seller typed on the page win.
 */
export function thanksLine(pageMessage: string | undefined, shopMessage: string | undefined): string {
  const page = pageMessage?.trim() ?? '';
  const shop = shopMessage?.trim() ?? '';
  if (shop && (page === '' || page === DEFAULT_THANKS)) return shop;
  return page || DEFAULT_THANKS;
}

const WHATSAPP_GREEN = '#25D366';

/**
 * The WhatsApp button's look, as inline style — the seller's colour is a value, not a class, and the page's sheet has
 * no room left under its budget for four more looks. The default (`outline`) is the button as it always was.
 */
export function whatsappButtonStyle(
  w: NonNullable<OrderFormProps['afterOrderWhatsapp']>,
  reduceMotion: boolean
): React.CSSProperties {
  const look = w.look ?? 'outline';
  const color = /^#[0-9a-fA-F]{6}$/.test(w.color ?? '') ? w.color! : '';
  const radius = w.shape === 'pill' ? 999 : w.shape === 'square' ? 4 : 12;
  const motion = w.pulse && !reduceMotion ? { animation: 'lp-bounce 1.8s ease-in-out infinite' } : {};
  if (look === 'floating') {
    return {
      position: 'fixed', bottom: 18, insetInlineEnd: 18, zIndex: 60, width: 58, height: 58, borderRadius: 999,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: color || WHATSAPP_GREEN, color: '#fff', boxShadow: '0 6px 20px rgba(0,0,0,.22)', ...motion,
    };
  }
  const fill =
    look === 'solid' ? { background: color || 'var(--store-accent,#b8256e)', color: '#fff', border: '1px solid transparent' }
    : look === 'green' ? { background: color || WHATSAPP_GREEN, color: '#fff', border: '1px solid transparent' }
    : { background: '#fff', color: color || '#121926', border: `1px solid ${color || '#e3e8ef'}` };
  return {
    marginTop: 20, display: w.wide ? 'flex' : 'inline-flex', width: w.wide ? '100%' : undefined,
    alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 20px', borderRadius: radius,
    fontSize: 14, fontWeight: 700, textDecoration: 'none', ...fill, ...motion,
  };
}

/** The message the customer sends, with the order number put in. */
export function afterOrderMessage(template: string | undefined, orderNumber: string): string {
  const t = template?.trim() || 'مرحباً، بدّي أأكّد طلبي رقم {رقم_الطلب}';
  return t.includes('{رقم_الطلب}') ? t.split('{رقم_الطلب}').join(orderNumber) : `${t} — ${orderNumber}`;
}

/**
 * The campaign code this visitor arrived with.
 *
 * From the URL if it is still there, otherwise from where it was put the
 * first time it was seen. A visitor reads the page, opens WhatsApp to ask
 * their husband, comes back — and by then the query string is often gone.
 * Session storage, not local: the code belongs to this visit, and a sale
 * next month did not come from last month's ad.
 */
const CAMPAIGN_KEY = 'zaki_campaign';

function campaignCode(): string {
  if (typeof window === 'undefined') return '';
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('c');
    if (fromUrl) {
      sessionStorage.setItem(CAMPAIGN_KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(CAMPAIGN_KEY) || '';
  } catch {
    // Private mode, blocked storage — attribution is worth nothing next to
    // the order itself.
    try {
      return new URLSearchParams(window.location.search).get('c') || '';
    } catch {
      return '';
    }
  }
}

type FormState = 'idle' | 'loading' | 'success' | 'error';

/** «عبوة» · «عبوتان» · «5 عبوات» · «12 عبوة» — the word a person would say for that many packs. */
const packs = (n: number) => (n === 1 ? 'عبوة' : n === 2 ? 'عبوتان' : n <= 10 ? `${n} عبوات` : `${n} عبوة`);
const fmt = (n: number) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export function OrderForm({ slug, productName, basePrice, currency, offers, recommendations, regions, phonePlaceholder, externalSelectedOfferId, showOfferPicker = true, formStyle = 'card', offerStyle = 'cards', dir = 'rtl', whatsapp, endpoint, thankYou, afterOrderWhatsapp, submitLabel, afterOrderLook, checkout }: OrderFormProps) {
  const orderEndpoint = endpoint || `/api/public/landing-pages/${encodeURIComponent(slug)}/orders`;
  // ─── The fields: the shop's «الدفع» when the page handed it in, the form as it always was when not ───
  // What is drawn is what is sent: a field the shop hid is not in `fields`, so it is neither drawn nor sent.
  const fields: readonly CheckoutField[] = checkout?.fields ?? AS_IT_ALWAYS_WAS.fields;
  const marked = new Set<CheckoutField>(checkout?.required ?? AS_IT_ALWAYS_WAS.required);
  const [state, setState] = useState<FormState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ orderNumber: string | null; addonToken: string | null }>({ orderNumber: null, addonToken: null });
  // The WhatsApp link after the order — only when the block leaves it on, there is a number, and an order exists.
  const waBase = whatsappHref(whatsapp);
  const waAfter =
    afterOrderWhatsapp?.enabled !== false && waBase && result.orderNumber
      ? `${waBase}?text=${encodeURIComponent(afterOrderMessage(afterOrderWhatsapp?.message, result.orderNumber))}`
      : null;
  // «متى اقدر اظهر زر الواتس»: at once, after a few seconds, or last — once the offers are done (see `waShown`).
  const waWhen = afterOrderWhatsapp?.when ?? 'now';
  const waDelay = Math.min(120, Math.max(1, Math.round(afterOrderWhatsapp?.delaySeconds ?? 5)));
  const [waDelayOver, setWaDelayOver] = useState(false);
  useEffect(() => {
    if (state !== 'success' || waWhen !== 'delay') return;
    const t = window.setTimeout(() => setWaDelayOver(true), waDelay * 1000);
    return () => window.clearTimeout(t);
  }, [state, waWhen, waDelay]);
  /**
   * «العرض بعد الطلب», as the server answered it — the offer, and how long
   * it may still be taken.
   *
   * `windowMinutes` is STATED and never enforced here. Every gate is on the
   * server (`postOrderGate`): still NEW, nobody has called yet, inside the
   * window, once. A countdown in a browser would be a second clock, and the
   * lesson this product already learned about countdowns is that a clock
   * with a source of its own reaches zero while the thing carries on.
   */
  const [postOrder, setPostOrder] = useState<{ offer: PostOrderOfferView | null; windowMinutes: number }>(
    { offer: null, windowMinutes: 0 }
  );
  /** idle → adding → added, or `gone` when the server says the door is shut. */
  const [postOrderState, setPostOrderState] = useState<'idle' | 'adding' | 'added' | 'gone'>('idle');
  /**
   * «لا شكرًا» for THIS offer, kept apart from `offerRefused` below.
   *
   * Two different things are being refused — the seller's after-order bundle
   * and the page's recommendation list — and one flag for both would mean
   * saying no to one silently withdrew the other. A customer who declines
   * the bundle has not declined anything else.
   */
  const [postOrderRefused, setPostOrderRefused] = useState(false);
  /** The server's own sentence when it refuses. Never a code read in here. */
  const [postOrderMsg, setPostOrderMsg] = useState<string | null>(null);
  const [selectedOffer, setSelectedOffer] = useState<string>(
    offers.find((o) => o.isDefault)?.id || offers[0]?.id || ''
  );
  const [addons, setAddons] = useState<Record<string, 'added' | 'adding'>>({});
  /**
   * «بيظهر مرة وحدة، وبيختفي إذا رفضه الزائر».
   *
   * A customer who said no once and is shown the same offer again has been
   * told their answer did not count. It is component state and that is the
   * right scope: this screen exists only until they leave it, and there is
   * no second visit to remember.
   */
  const [offerRefused, setOfferRefused] = useState(false);
  /*
   * THE REAL WINDOW, COUNTED DOWN — the form block's «عدّاد». It starts when the order's answer arrives and counts the
   * minutes the server sent, which are the minutes `postOrderGate` will enforce; at zero the offers leave the screen,
   * because the server would refuse them anyway. Never an invented deadline: no window, no countdown.
   */
  const [offersFrom, setOffersFrom] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const look = {
    flow: afterOrderLook?.flow ?? 'together',
    banner: afterOrderLook?.banner ?? 'none',
    bannerText: afterOrderLook?.bannerText?.trim() || 'مبروك! حابين نهديك عرض خاص قبل ما نجهّز طلبك',
    upsell: afterOrderLook?.upsellLook ?? 'card',
    crossSell: afterOrderLook?.crossSellLook ?? 'list',
  };
  // Global tracking: Purchase — ONLY after the server confirms a real order,
  // with the SERVER-AUTHORITATIVE total/currency from the response. Deduped
  // per orderNumber (local ref + central engine) — re-renders never re-fire.
  const { trackEvent } = useTracking();
  const purchaseFiredRef = useRef<Set<string>>(new Set());
  /*
   * «بدء الطلب» (InitiateCheckout) — the moment a visitor starts filling the form, once per visit. It was sent from
   * an HTML page's form only, so a block page (every page built in the editor) never reported it, and the seller's
   * switch for it changed nothing there. The chosen offer's DB price is the value — never anything typed.
   */
  const checkoutStartedRef = useRef(false);
  const startCheckout = (e?: React.FocusEvent<HTMLFormElement>) => {
    if (checkoutStartedRef.current) return;
    checkoutStartedRef.current = true;
    // When the first touch is picking a bundle, focus lands before the change is committed, so the state still holds
    // the old offer. Read the one being picked from the field itself (it can only name one of this page's offers) —
    // measured: picking «عبوتين» first reported 12, not 20.
    const target = e?.target as HTMLInputElement | HTMLSelectElement | undefined;
    const picked = target && (target.type === 'radio' || target.tagName === 'SELECT') ? offers.find((o) => o.id === target.value) : undefined;
    const chosen = picked || offers.find((o) => o.id === selectedOffer) || offers[0];
    try {
      trackEvent('InitiateCheckout', chosen ? { value: chosen.price, currency: currency || 'USD' } : {});
    } catch { /* tracking is non-fatal */ }
  };

  // Phase 2: offer picked from the custom HTML placeholder (bridge already
  // validated the id against this page's DB offers)
  React.useEffect(() => {
    if (externalSelectedOfferId && offers.some((o) => o.id === externalSelectedOfferId)) {
      setSelectedOffer(externalSelectedOfferId);
    }
  }, [externalSelectedOfferId, offers]);

  /**
   * Announce which offer is selected, so anything else on the page that
   * shows a price can follow it — the floating button, above all.
   *
   * Only the ID travels. A listener resolves the price from its own
   * server-provided offers, exactly as the bridge does, so no price on this
   * page ever comes out of a message.
   */
  React.useEffect(() => {
    if (!selectedOffer) return;
    try {
      window.postMessage({ type: 'ZAKI_OFFER_SELECTED', offerId: selectedOffer }, '*');
    } catch { /* never fatal */ }
  }, [selectedOffer]);
  // «شريط اطلب الآن بيغطّي على شاشة الشكر»: once the order is in, the bar that
  // carries people to the form has nothing left to offer — it is told, and leaves.
  React.useEffect(() => {
    if (state !== 'success') return;
    // A DOM event, not a message: only a script of this page can raise it, never a frame inside it.
    window.dispatchEvent(new Event(ORDER_PLACED));
  }, [state]);
  const [totals, setTotals] = useState<{ total: number } | null>(null);

  const offer = useMemo(() => offers.find((o) => o.id === selectedOffer) || offers[0], [offers, selectedOffer]);
  const originalPrice = useMemo(() => (offer ? Number((basePrice * offer.quantity).toFixed(2)) : basePrice), [basePrice, offer]);
  const savings = useMemo(() => (offer ? Math.max(0, Number((originalPrice - offer.price).toFixed(2))) : 0), [originalPrice, offer]);

  // ─── City searchable select ───
  // The options are THIS store's country regions, server-rendered. There is
  // no hard-coded country here: a Jordanian store shows Jordanian regions.
  /**
   * THE SHORTEST CHECKOUT THESE FIELDS ALLOW.
   *
   * «أقصر إتمام ممكن بالحقول الموجودة (الحقول ما تتغيّر)». The note is
   * optional, and it was a three-row textarea with a placeholder reading
   * «(اختياري)» — a whole field's worth of screen, on a phone, between the
   * address and the only button that matters, that almost nobody fills.
   *
   * So it is folded behind one line of text. Nothing is removed: the same
   * `name="notes"` textarea, the same 500-character limit, one tap away for
   * the visitor who has something to say. A collapsed optional field is a
   * shorter form; a deleted one is a different form.
   *
   * WHICH FIELDS, IN WHAT ORDER, WITH WHICH «*», IS THE SHOP'S — «مش مربوط
   * بصفحة الهبوط». Every public door hands in its store's «الدفع», and the
   * order, the marks, «هاتف بديل» and what is left off come from there. The
   * note stays folded unless the shop made it required; then it is open from
   * the start.
   */
  const [notesOpen, setNotesOpen] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [cityQuery, setCityQuery] = useState('');
  const [cityValue, setCityValue] = useState('');
  const cityOptions = useMemo(() => {
    const q = cityQuery.trim();
    if (!q) return regions;
    return regions.filter((r) => r.includes(q));
  }, [cityQuery, regions]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    const drawn = new Set(fields);
    const data = {
      full_name: String(fd.get('full_name') || '').trim(),
      phone: String(fd.get('phone') || '').trim(),
      // The second number and the note, only from a form that draws them: a field the shop hid is not sent at all.
      ...(drawn.has('altPhone') ? { alt_phone: String(fd.get('alt_phone') || '').trim() } : {}),
      address: String(fd.get('address') || '').trim(),
      city: cityValue,
      offerId: selectedOffer,
      ...(drawn.has('note') ? { notes: String(fd.get('notes') || '').trim() } : {}),
      // honeypot (hidden from humans — bots may fill it)

      website: String(fd.get('website') || ''),

      ts: String(Date.now()),

      // The campaign code from the link this visitor arrived on.

      //

      // Read at submit and not at load: a visitor who lands on the ad's

      // link, wanders to another page and comes back would otherwise lose

      // the attribution, and the ad would look like it sold nothing. The

      // server checks the code against this store's campaigns — a wrong or

      // invented one resolves to nothing and the order is still created,

      // because a mistyped link in an ad must never cost a sale.

      campaign: campaignCode(),
    };

    /*
     * «إلزامي» ASKED BEFORE ANYTHING IS SENT — the door's own sentence, under the field, and no request at all.
     *
     * The door refuses the same blank (`createPublicOrder`), so this is the visitor hearing it a round trip sooner,
     * not a second rule. Nothing is reported to the ad accounts for it: «بدء الطلب» already went out on the first
     * focus, as it does for any visitor, and no refusal sends anything — the door's refusals never did either. The
     * field is brought into view, never focused: a focus is an event, and this must not invent one.
     */
    const blank = checkout ? blankRequired(checkout.required, data) : null;
    if (blank) {
      setErrorMsg(null);
      setFieldErrors(blank);
      setState('error');
      try {
        // The first of them as the visitor meets them, top to bottom.
        const first = Array.from(form.querySelectorAll<HTMLElement>('[name]')).find((el) => blank[el.getAttribute('name') ?? '']);
        first?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      } catch { /* bringing it into view is a courtesy */ }
      return;
    }

    setState('loading');
    setErrorMsg(null);
    setFieldErrors({});
    try {
      const res = await fetch(orderEndpoint, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        setResult({ orderNumber: json?.orderNumber || null, addonToken: json?.addonToken || null });
        // The server decided whether there is an offer and what it costs.
        // `null` is a real answer — the seller set none — and draws nothing.
        setPostOrder({
          offer: (json?.postOrderOffer as PostOrderOfferView | null) ?? null,
          windowMinutes:
            typeof json?.postOrderWindowMinutes === 'number' ? json.postOrderWindowMinutes : 0,
        });
        setPostOrderState('idle');
        setPostOrderRefused(false);
        setPostOrderMsg(null);
        setOffersFrom(Date.now());
          // Purchase — ONLY after the server confirms a real order, with the
          // SERVER-AUTHORITATIVE total/currency from the response.
          if (json?.orderNumber && typeof window !== 'undefined') {
            const ordNum = String(json.orderNumber);
            if (!purchaseFiredRef.current.has(ordNum)) {
              purchaseFiredRef.current.add(ordNum);
              try {
                trackEvent('Purchase', {
                  orderId: ordNum,
                  value: typeof json.total === 'number' ? json.total : null,
                  currency: typeof json.currency === 'string' ? json.currency : currency,
                });
              } catch { /* tracking is non-fatal */ }
            }
          }
        setTotals(null);
        setState('success');
      } else {
        setErrorMsg(json?.error || 'تعذر إرسال الطلب، حاول مرة أخرى');
        if (json?.fieldErrors && typeof json.fieldErrors === 'object') {
          setFieldErrors(json.fieldErrors);
        }
        setState('error');
      }
    } catch {
      setErrorMsg('تعذر الاتصال بالسيرفر، تحقق من الإنترنت وأعد المحاولة');
      setState('error');
    }
  }

  /**
   * «آه، زيدها لطلبي» — one press, one request, and no figure on the wire.
   *
   * The body is the signed add-on token and the offer's id. The server
   * re-reads the offer through `postOrderOfferWhere`, prices it with the
   * same function that priced this page, checks the four gates and adds ONE
   * add-on to the SAME order. What comes back is the new total, which is the
   * only number this screen is allowed to print as one.
   *
   * A refusal is not an error here — it is the rule answering. The server
   * sends the Arabic sentence and a `reason`, and the one decision this
   * screen makes with it is whether the offer is still worth showing:
   * `ALREADY_ADDED`, `NOT_NEW`, `WINDOW_PASSED`, `OFFER_GONE` and
   * `NOT_IN_ORDER` all mean «stop offering it», so the card closes and the
   * sentence stays. Nothing about the order is undone, because nothing about
   * the order was done.
   */
  async function addPostOrderOffer() {
    const offer = postOrder.offer;
    if (!offer || !result.addonToken || !result.orderNumber) return;
    setPostOrderState('adding');
    setPostOrderMsg(null);
    try {
      const res = await fetch(
        `/api/public/orders/${encodeURIComponent(result.orderNumber)}/post-order-offer`,
        {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: result.addonToken, offerId: offer.id }),
        }
      );
      const json = await res.json().catch(() => null);
      if (res.ok) {
        setPostOrderState('added');
        // The server's total, never a sum worked out in here.
        if (typeof json?.newTotal === 'number') setTotals({ total: json.newTotal });
        /*
         * The added amount, not the new total. Purchase already fired with
         * the opening figure and the ad platforms SUM the events they
         * receive, so re-sending the whole total would count the first
         * order twice — the same rule the recommendation add-on follows
         * below, and for the same measured reason.
         */
        const added = json?.addOn;
        if (added && typeof added.total === 'number') {
          try {
            trackEvent('Purchase', {
              orderId: `${result.orderNumber}:${offer.id}`,
              value: added.total,
              currency: typeof json.currency === 'string' ? json.currency : currency,
              contentName: typeof added.productName === 'string' ? added.productName : undefined,
            });
          } catch { /* tracking is non-fatal */ }
        }
      } else {
        setPostOrderState('gone');
        setPostOrderMsg(json?.error || 'تعذر إضافة العرض');
      }
    } catch {
      // A connection that failed is not the rule saying no: the offer stays
      // on the screen so the customer can try again.
      setPostOrderState('idle');
      setPostOrderMsg('تعذر الاتصال، حاول مرة أخرى');
    }
  }

  async function addRecommendation(recId: string) {
    if (!result.addonToken || !result.orderNumber) return;
    setAddons((a) => ({ ...a, [recId]: 'adding' }));
    try {
      const res = await fetch(
        `${orderEndpoint}/${encodeURIComponent(result.orderNumber!)}/add-product`,
        {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: result.addonToken, recommendationId: recId }),
        }
      );
      const json = await res.json().catch(() => null);
      if (res.ok) {
        setAddons((a) => ({ ...a, [recId]: 'added' }));
        if (typeof json?.newTotal === 'number') setTotals({ total: json.newTotal });
        // The add-on is revenue, and it was not reaching the ad platforms.
        // Purchase had already fired with the opening total, so an order
        // that grew from 20 to 32 was reported as 20 — every upsell on the
        // page invisible to the campaign paying for it, and the ROAS the
        // seller optimises against quietly wrong.
        //
        // A second Purchase for the ADDED amount, not the new total: the
        // platforms sum the events they receive, so re-sending the whole
        // total would count the original twice. The button becomes "added"
        // and cannot be pressed again, so this fires once per add-on.
        const added = json?.addOn;
        if (added && typeof added.price === 'number') {
          const value = added.price * (typeof added.quantity === 'number' ? added.quantity : 1);
          try {
            trackEvent('Purchase', {
              orderId: `${result.orderNumber}:${recId}`,
              value,
              currency: typeof json.currency === 'string' ? json.currency : currency,
              contentName: typeof added.productName === 'string' ? added.productName : undefined,
            });
          } catch { /* tracking is non-fatal */ }
        }
      } else {
        setAddons((a) => {
          const n = { ...a };
          delete n[recId];
          return n;
        });
        setErrorMsg(json?.error || 'تعذر إضافة المنتج');
        setTimeout(() => setErrorMsg(null), 4000);
      }
    } catch {
      setAddons((a) => {
        const n = { ...a };
        delete n[recId];
        return n;
      });
      setErrorMsg('تعذر الاتصال، حاول مرة أخرى');
      setTimeout(() => setErrorMsg(null), 4000);
    }
  }

  // One tick a second, only while a countdown is on the screen — nothing runs on a page that shows none.
  const counting = look.banner === 'countdown' && offersFrom !== null && postOrder.windowMinutes > 0;
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [counting]);
  const secondsLeft = counting ? Math.max(0, Math.ceil((offersFrom! + postOrder.windowMinutes * 60_000 - now) / 1000)) : null;
  const windowOver = secondsLeft === 0;
  const clock = secondsLeft === null ? '' : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
  // «ورا بعض»: the suggestions wait until the offer is answered — added, refused, or gone.
  const upsellOpen = !!postOrder.offer && !postOrderRefused && (postOrderState === 'idle' || postOrderState === 'adding');
  const showCrossSell = !offerRefused && !windowOver && recommendations.length > 0 && (look.flow === 'together' || !upsellOpen);
  const showUpsell = !!postOrder.offer && !postOrderRefused && !windowOver;
  // «آخر شي»: the bundle answered (or none), and the suggestions answered — refused, or one of them added.
  const offersDone = !upsellOpen && (!showCrossSell || Object.values(addons).includes('added'));
  const waShown =
    !!waAfter && (waWhen === 'now' || (waWhen === 'delay' && waDelayOver) || (waWhen === 'end' && (offersDone || windowOver)));
  const waFloating = afterOrderWhatsapp?.look === 'floating';
  // «يحولو ع الواتس» — only when the seller chose it: three seconds after the button is on the screen, so the
  // customer has read «تم تسجيل طلبك» and seen where they are going.
  useEffect(() => {
    if (!waShown || !waAfter || !afterOrderWhatsapp?.autoOpen) return;
    const t = window.setTimeout(() => leaveFor(waAfter), 3000);
    return () => window.clearTimeout(t);
  }, [waShown, waAfter, afterOrderWhatsapp?.autoOpen]);
  const reduceMotion = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    []
  );
  const waLabel = afterOrderWhatsapp?.label?.trim() || 'أكّد طلبك على واتساب';
  const waButton = waShown && waAfter ? (
    <a
      href={waAfter}
      target="_blank"
      rel="noopener noreferrer"
      className="lp-wa-after"
      data-look={afterOrderWhatsapp?.look ?? 'outline'}
      // The round corner button shows the icon alone; its words are still what a screen reader says.
      aria-label={waFloating ? waLabel : undefined}
      style={whatsappButtonStyle(afterOrderWhatsapp ?? {}, reduceMotion)}
    >
      {(afterOrderWhatsapp?.icon || waFloating) && <RiWhatsappLine size={waFloating ? 30 : 20} aria-hidden />}
      {!waFloating && <span>{waLabel}</span>}
    </a>
  ) : null;

  const inputCls =
    'w-full rounded-xl border border-[#e3e8ef] bg-white px-4 py-3 text-base text-[#121926] placeholder:text-[#9aa4b2] focus:outline-none focus:ring-2 focus:ring-[var(--store-accent-border,#e8b9d0)] focus:border-[var(--store-accent,#b8256e)] transition-colors';
  const labelCls = 'block text-sm font-semibold text-[#364152] mb-1.5';
  const fieldErr = (key: string) => fieldErrors[key];
  const FieldError = ({ k }: { k: string }) =>
    fieldErr(k) ? (
      <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-rose-600">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {fieldErr(k)}
      </p>
    ) : null;
  const hasOffers = offers.length > 0;

  const star = (f: CheckoutField) =>
    marked.has(f) ? <> <span className="text-[var(--store-accent,#b8256e)]">*</span></> : null;
  // A refusal about a field this form does not draw — see the error line by the button.
  const undrawnRefusal = refusesUndrawn(fieldErrors, fields);
  /*
   * THE FIRST FIELD, FOR «اطلب الآن».
   *
   * The page's buttons carried the visitor to the NAME field, which was the first field until the shop could order
   * them. Whatever is first now carries the mark, on the control a visitor would type in or tap — the input, the
   * note's box, the city's button, or the line that opens a folded note — and `OrderCta` focuses that.
   */
  const firstMark = (f: CheckoutField) => (fields[0] === f ? '' : undefined);
  // «الاسم والهاتف جنب بعض» in the compact look — while they ARE next to each other. A shop that put another field
  // between them gets two full rows rather than two half fields each standing alone.
  const half =
    formStyle === 'compact' && Math.abs(fields.indexOf('name') - fields.indexOf('phone')) === 1 ? 'lp-half' : undefined;
  const words = submitWords(submitLabel, checkout?.submitText);

  const fieldBlock = (f: CheckoutField): React.ReactNode => {
    switch (f) {
      case 'name':
        return (
          <div className={half}>
            <label htmlFor="zf-full_name" className={labelCls}>
              الاسم الكامل{star('name')}
            </label>
            <input
              id="zf-full_name"
              name="full_name"
              data-zf-first={firstMark('name')}
              type="text"
              required
              minLength={2}
              maxLength={80}
              autoComplete="name"
              placeholder="اكتب اسمك الكامل"
              className={inputCls}
              disabled={state === 'loading'}
            />
            <FieldError k='full_name' />
          </div>
        );
      case 'phone':
        return (
          <div className={half}>
            <label htmlFor="zf-phone" className={labelCls}>
              رقم الهاتف{star('phone')}
            </label>
            <input
              id="zf-phone"
              name="phone"
              data-zf-first={firstMark('phone')}
              type="tel"
              required
              minLength={7}
              maxLength={20}
              inputMode="tel"
              autoComplete="tel"
              placeholder={phonePlaceholder || '07xxxxxxxx'}
              dir="ltr"
              className={`${inputCls} text-start`}
              disabled={state === 'loading'}
            />
            <FieldError k='phone' />
          </div>
        );
      case 'altPhone':
        /*
         * «هاتف بديل» — a second number for the confirmation call to try. Marked when the shop marked it, and then
         * asked for: a blank one is refused before sending with the door's own «اكتب …», and by the door itself.
         * `aria-required` says it to a screen reader the way «*» says it on the screen. Not `autoComplete="tel"`, or
         * the browser fills the customer's own number in twice.
         */
        return (
          <div>
            <label htmlFor="zf-alt_phone" className={labelCls}>
              رقم هاتف بديل{marked.has('altPhone') ? star('altPhone') : ' (اختياري)'}
            </label>
            <input
              id="zf-alt_phone"
              name="alt_phone"
              data-zf-first={firstMark('altPhone')}
              type="tel"
              maxLength={25}
              inputMode="tel"
              autoComplete="off"
              aria-required={marked.has('altPhone') || undefined}
              placeholder={phonePlaceholder || '07xxxxxxxx'}
              dir="ltr"
              className={`${inputCls} text-start`}
              disabled={state === 'loading'}
            />
            <FieldError k="alt_phone" />
          </div>
        );
      case 'address':
        return (
          <div>
            <label htmlFor="zf-address" className={labelCls}>
              العنوان{star('address')}
            </label>
            <input
              id="zf-address"
              name="address"
              data-zf-first={firstMark('address')}
              type="text"
              required
              minLength={5}
              maxLength={200}
              autoComplete="street-address"
              placeholder="المنطقة، الشارع، أقرب علامة مميزة"
              className={inputCls}
              disabled={state === 'loading'}
            />
            <FieldError k="address" />
          </div>
        );
      case 'region':
        // المدينة / الولاية — the country's own regions, searchable. Moved as one block: the list hangs off it.
        return (
          <div className="relative">
            <label htmlFor="zf-city" className={labelCls}>
              المدينة / الولاية{star('region')}
            </label>
            <button
              type="button"
              id="zf-city"
              data-zf-first={firstMark('region')}
              onClick={() => { setCityOpen((o) => !o); }}
              className={`${inputCls} flex items-center justify-between text-start ${cityValue ? '' : 'text-[#9aa4b2]'}`}
              disabled={state === 'loading'}
              aria-haspopup="listbox"
              aria-expanded={cityOpen}
            >
              <span className="truncate">{cityValue || 'اختر المدينة أو الولاية'}</span>
              <svg className="h-4 w-4 shrink-0 text-[#697586]" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.72-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" /></svg>
            </button>
            <FieldError k="city" />
            {cityOpen && (
              <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-hidden rounded-xl border border-[#e3e8ef] bg-white shadow-lg">
                <div className="relative border-b border-[#e3e8ef]">
                  {/* LOGICAL, NOT PHYSICAL. `right-3` put this icon at the
                      start of a right-to-left page and on top of the typed
                      text in a left-to-right one — and the shop's language
                      is the seller's to choose. The sibling list below has
                      always used `text-start`; this was the line it was
                      never applied to. */}
                  <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9aa4b2]" />
                  <input
                    type="text"
                    autoFocus
                    value={cityQuery}
                    onChange={(e) => setCityQuery(e.target.value)}
                    placeholder="ابحث عن المحافظة أو المدينة…"
                    className="w-full border-0 px-4 py-3 ps-9 text-sm focus:outline-none"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {cityOptions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => { setCityValue(name); setCityOpen(false); setCityQuery(''); setFieldErrors((fe) => { const n = { ...fe }; delete n.city; return n; }); }}
                      className={`block w-full px-4 py-2 text-start text-sm hover:bg-[#f8fafc] ${cityValue === name ? 'bg-[#fdf2f7] font-semibold text-[var(--store-accent,#b8256e)]' : 'text-[#364152]'}`}
                    >
                      {name}
                    </button>
                  ))}
                  {cityOptions.length === 0 && (
                    <p className="px-4 py-6 text-center text-xs text-[#9aa4b2]">لا توجد نتائج مطابقة</p>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      case 'note': {
        /*
         * ملاحظات — folded until it is wanted, unless the shop made it required: then it is open from the start,
         * marked, and NOT focused. Focus on arrival would scroll every visitor down to the form, open the phone's
         * keyboard and report «بدء الطلب» to the ad accounts before anybody touched anything. A note the visitor
         * opened with a tap is still focused: they asked for it.
         */
        const noteRequired = marked.has('note');
        return noteRequired || notesOpen ? (
          <div>
            <label htmlFor="zf-notes" className={labelCls}>
              ملاحظات{star('note')}
            </label>
            <textarea
              id="zf-notes"
              name="notes"
              data-zf-first={firstMark('note')}
              rows={3}
              maxLength={500}
              autoFocus={!noteRequired}
              aria-required={noteRequired || undefined}
              placeholder="أي تفاصيل إضافية"
              className={`${inputCls} resize-none`}
              disabled={state === 'loading'}
            />
            {checkout && <FieldError k="notes" />}
          </div>
        ) : (
          <>
            <button
              type="button"
              data-zf-first={firstMark('note')}
              onClick={() => setNotesOpen(true)}
              /* A plain underline and nothing finer.
                 A dotted decoration style and an offset step were tried
                 here, and each would have been the product's ONLY use of
                 that utility — while the first-load stylesheet has eleven
                 bytes of headroom under its ratchet. A dotted rule under
                 one link is not worth a step of that budget.
                 THE TWO NAMES ARE NOT WRITTEN OUT ON PURPOSE: Tailwind's
                 scanner reads prose as well as markup, so a comment
                 naming a utility puts that utility back in the sheet.
                 This exact comment, with the names in it, is what pushed
                 the build 50 bytes over the cap after they were removed
                 from the className. */
              className="text-start text-sm font-semibold text-[var(--store-accent,#b8256e)] underline"
            >
              + إضافة ملاحظة (اختياري)
            </button>
            {/* A refusal about a folded field is still said, under the line that opens it. */}
            {checkout && <FieldError k="notes" />}
          </>
        );
      }
      default:
        return null;
    }
  };

  return (
    <section
      id="zaki-order-form"
      // The form card keeps its own ink: a block colour chosen for the form block reaches its title, not the white
      // card, the fields or the red errors.
      data-ink=""
      dir={dir}
      className="w-full bg-[var(--store-page,#f7f7f8)] px-4 py-10 sm:px-6"
      aria-label="نموذج الطلب"
    >
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-2xl border border-[#e3e8ef] bg-white shadow-sm overflow-hidden">
          {/* Header. On a themed page this band IS the accent colour, so
              everything in it takes the readable ink the theme derived —
              accent text on an accent band would be invisible. On a page
              with no theme the old navy and its old colours stand. */}
          {/* After the order is placed this band must stop saying "order
              now" over the price the customer paid BEFORE their add-ons.
              Standing there advertising the opening price of an order that
              is already placed reads as though nothing happened — it was
              the one part of the screen still describing the previous step.
              It becomes the receipt: what was ordered, and what it costs
              now, add-ons included. */}
          <div className="bg-[var(--store-accent,#121926)] px-5 py-5 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--store-accent-text,#697586)] opacity-75">
              {state === 'success' ? 'طلبك' : 'اطلب الآن'}
            </p>
            {/* Inline, because the page's heading rule (html .lp-root h2 → the block's heading colour) outranks a class
                and repainted the name on its accent band. */}
            <h2 className="mt-1 text-xl font-bold" style={{ color: 'var(--store-accent-text, #ffffff)' }}>{productName}</h2>
            <p className="mt-1 text-2xl font-extrabold text-[var(--store-accent-text,#b8256e)]" dir="ltr">
              {fmt(state === 'success' && totals ? totals.total : offer ? offer.price : basePrice)} {currency}
            </p>
            {/*
              «المبلغ المتوقع عند الاستلام». The figure was already here and
              said nothing about itself — a customer looking at a number
              after ordering wants to know whether it is what they pay, and
              when. A receipt that states the amount and not the moment is
              half a receipt.
            */}
            {state === 'success' && (
              <p className="mt-1 text-xs font-semibold text-[var(--store-accent-text,#ffffff)] opacity-80">
                تدفعه عند الاستلام
              </p>
            )}
          </div>

          {state === 'success' ? (
            <div className="px-5 py-8 text-center">
              <p className="text-4xl">✅</p>
              <p className="mt-3 text-lg font-bold text-[#121926]">{thankYou?.title?.trim() || 'تم تسجيل طلبك بنجاح'}</p>
              <p className="mt-2 text-sm text-[#364152]" dir="ltr">
                رقم الطلب: <span className="font-bold">{result.orderNumber}</span>
              </p>
              {totals && (
                // The header already carries the number. This says why it
                // moved, which is the part the customer needs to trust.
                <p className="mt-1 text-xs font-semibold text-[var(--store-accent,#b8256e)]">
                  تم تحديث الإجمالي بعد الإضافة
                </p>
              )}
              <p className="mt-2 whitespace-pre-line text-xs text-[#697586]">
                {thanksLine(thankYou?.message, checkout?.thanksMessage)}
              </p>

              {/*
                A CONFIRMATION THE CUSTOMER CHOOSES, NOT ONE THEY WAIT FOR.

                The order is already placed; nothing here is required. What
                it buys is a confirmation call that is already half done —
                the message carries the order number, so the person on the
                other end is not asking «شو رقم طلبك؟» first.
              */}
              {waAfter && (waWhen !== 'end' || waFloating) && waButton}

              {/*
                ═══════════════════════════════════════════════════════════
                «وصلنا طلبك!» → «زيد علبة كمان؟ 15 بدل 25»

                ONE offer, the one the seller flagged on this product, at
                the price the server computed. Every number drawn below
                came off the response: `price` is what the customer will be
                charged and `listPrice` is the bundle before its own
                reduction, so «بدل 25» is a figure printed and never a
                subtraction done in a browser.

                HONEST COPY, which the brief asks for by name. There is no
                invented scarcity here: the only urgency stated is the real
                window the server will enforce, in the minutes the
                company's own setting holds, and it is stated only when the
                server sent one. No «آخر قطعة», no fabricated countdown.
                ═══════════════════════════════════════════════════════════
              */}
              {/* «شريط: مبروك، حابين نهديك عرض — أو عدّاد». Only while there is something to offer. */}
              {look.banner !== 'none' && (showUpsell || showCrossSell) && (look.banner === 'congrats' || clock) && (
                <p className="lp-after-banner" role="status">
                  {look.banner === 'countdown' ? (
                    <>⏳ العرض متاح لمدة <b dir="ltr">{clock}</b></>
                  ) : (
                    look.bannerText
                  )}
                </p>
              )}
              {windowOver && (postOrder.offer || recommendations.length > 0) && (
                <p className="lp-after-banner">انتهت مهلة الإضافة على هذا الطلب — حكي معنا وبنزيدها لك.</p>
              )}
              {showUpsell && postOrder.offer && (
                <div className="lp-upsell mt-6 rounded-xl border border-[var(--store-accent,#b8256e)] bg-white p-4 text-center" data-look={look.upsell}>
                  <p className="lp-upsell-title text-sm font-bold text-[#121926]">
                    {postOrderState === 'added' ? 'تمت الإضافة إلى طلبك ✅' : `${postOrder.offer.name} — زيدها لطلبك؟`}
                  </p>
                  <p className="lp-upsell-price mt-2 text-lg font-bold text-[var(--store-accent,#b8256e)]" dir="ltr">
                    {fmt(postOrder.offer.price)} {currency}
                    {postOrder.offer.listPrice !== null && (
                      <span className="ms-2 text-sm font-semibold text-[#9aa4b2] line-through">
                        {fmt(postOrder.offer.listPrice)} {currency}
                      </span>
                    )}
                  </p>
                  <p className="lp-upsell-note mt-1 text-xs text-[#697586]">
                    {postOrder.offer.quantity} قطعة
                    {postOrder.offer.freeQuantity > 0 && ` + ${postOrder.offer.freeQuantity} مجاناً`}
                    {' — تدفعها عند الاستلام مع طلبك، بدون توصيل إضافي.'}
                  </p>

                  {postOrderState === 'added' ? (
                    <p className="mt-3 text-xs font-semibold text-[#00c853]">
                      صار على نفس الطلب — ما في طلب ثاني ولا توصيل ثاني.
                    </p>
                  ) : postOrderState === 'gone' ? null : (
                    <div className="lp-upsell-actions mt-4 flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={addPostOrderOffer}
                        disabled={postOrderState === 'adding'}
                        className="lp-upsell-yes inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--store-accent,#b8256e)] px-5 py-3 text-sm font-bold text-white transition hover:bg-[var(--store-accent-dark,#a01f5f)] disabled:opacity-60 active:scale-95"
                      >
                        {postOrderState === 'adding' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'آه، زيدها لطلبي'}
                      </button>
                      {/*
                        A WAY TO SAY NO, AND TO BE BELIEVED.

                        It hides the offer and touches nothing else: the
                        order was placed before this card appeared, so
                        refusing has nothing to undo. The server agrees —
                        there is no «decline» endpoint, because there is no
                        state a refusal would have to write.
                      */}
                      <button
                        type="button"
                        onClick={() => setPostOrderRefused(true)}
                        className="text-xs font-semibold text-[#697586] underline hover:text-[#364152]"
                      >
                        لا شكراً
                      </button>
                    </div>
                  )}

                  {postOrderMsg && (
                    <p className="mt-3 text-xs text-rose-600">{postOrderMsg}</p>
                  )}

                  {postOrderState === 'idle' && postOrder.windowMinutes > 0 && look.banner !== 'countdown' && (
                    // The real rule, in the server's own number. It is the
                    // window `postOrderGate` will measure, not a decoration.
                    <p className="mt-3 text-[11px] text-[#9aa4b2]">
                      تقدر تزيدها خلال {postOrder.windowMinutes} دقيقة من وقت الطلب، وقبل ما نتواصل معك.
                    </p>
                  )}
                </div>
              )}

              {/* Post-order upsells */}
              {showCrossSell && (
                <div className="mt-6 rounded-xl border border-[#e3e8ef] bg-[#f8fafc] p-4 text-start">
                  <p className="mb-3 text-center text-sm font-bold text-[#121926]">
                    🔥 عرض خاص لك — أضفها إلى طلبك الآن
                  </p>
                  <div className="lp-xsell-items space-y-2" data-look={look.crossSell}>
                    {recommendations.map((rec) => {
                      const st = addons[rec.id];
                      return (
                        <div key={rec.id} className="flex items-center gap-3 rounded-xl border border-[#e3e8ef] bg-white p-3">
                          <div className="lp-xsell-thumb h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-[#f1f3f6]">
                            {rec.image ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={rec.image} alt={rec.name} className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-lg">🛍️</div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-sm font-semibold leading-snug text-[#121926]">{rec.name}</p>
                            {rec.blurb && <p className="lp-xsell-blurb line-clamp-2 text-xs leading-snug text-[#697586]">{rec.blurb}</p>}
                            <p className="text-sm font-bold text-[var(--store-accent,#b8256e)]" dir="ltr">
                              {fmt(rec.price)} {currency}
                            </p>
                            {rec.pageUrl && (
                              // A new tab: this screen holds the order and the add-to-order button.
                              <a href={rec.pageUrl} target="_blank" rel="noopener" className="text-xs font-semibold text-[var(--store-accent,#b8256e)] underline">
                                شوف المنتج ←
                              </a>
                            )}
                          </div>
                          {st === 'added' ? (
                            <span className="flex shrink-0 items-center gap-1 rounded-lg bg-[#e6f9ee] px-3 py-2 text-xs font-bold text-[#00c853]">
                              تمت الإضافة ✅
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => addRecommendation(rec.id)}
                              disabled={st === 'adding'}
                              className="shrink-0 rounded-lg bg-[var(--store-accent,#b8256e)] px-3 py-2 text-xs font-bold text-white transition hover:bg-[var(--store-accent-dark,#a01f5f)] disabled:opacity-60 active:scale-95"
                            >
                              {st === 'adding' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'أضف إلى طلبي'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {errorMsg && (
                    <p className="mt-2 text-center text-xs text-rose-600">{errorMsg}</p>
                  )}
                  {/*
                    A WAY TO SAY NO, AND TO BE BELIEVED.

                    «بيظهر مرة وحدة، وبيختفي إذا رفضه الزائر». An offer with
                    no way out is not an offer, and a customer who has
                    already ordered does not owe this screen another
                    decision. It is placed AFTER the items, not beside them:
                    the first thing to read is what is offered.

                    It hides nothing they added — an add-on already put on
                    the order stays on it.
                  */}
                  <button
                    type="button"
                    onClick={() => setOfferRefused(true)}
                    className="mt-3 w-full text-center text-xs text-[#697586] underline"
                  >
                    لا شكراً، أكمل بطلبي
                  </button>
                </div>
              )}

              {/* «آخر شي»: the button under the offers, once the customer is done with them. */}
              {waAfter && waWhen === 'end' && !waFloating && <div>{waButton}</div>}
            </div>
          ) : (
            <form onSubmit={onSubmit} onFocusCapture={startCheckout} noValidate className={formStyle === 'compact' ? 'px-5 py-6 lp-form-compact' : 'space-y-4 px-5 py-6'}>
              {/* ─── Offers (server-provided — replaces the quantity stepper) ─── */}
              {/* The page's own offers block is the picker; here it is a
                  dropdown, so the choice can still be changed at the last
                  moment without scrolling back up the page. */}
              {/* …and when the seller chose «قائمة منسدلة» for the form itself. */}
              {hasOffers && (!showOfferPicker || offerStyle === 'select') && offer && (
                <div>
                  <label htmlFor="zf-offer" className={labelCls}>العرض المختار</label>
                  <select
                    id="zf-offer"
                    value={selectedOffer}
                    onChange={(e) => setSelectedOffer(e.target.value)}
                    disabled={state === 'loading'}
                    className={inputCls}
                  >
                    {offers.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} — {o.quantity} قطعة
                        {o.freeQuantity > 0 ? ` + ${o.freeQuantity} هدية` : ''} — {fmt(o.price)} {currency}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {hasOffers && showOfferPicker && offerStyle === 'radio' && (
                <fieldset className="lp-radios">
                  <legend className="lp-radios-title">👇 اختر الكمية</legend>
                  {offers.map((o) => (
                    <label key={o.id} className="lp-radio">
                      <input
                        type="radio"
                        name="zf-offer-radio"
                        value={o.id}
                        checked={o.id === selectedOffer}
                        onChange={() => { setSelectedOffer(o.id); setFieldErrors((fe) => { const n = { ...fe }; delete n.offerId; return n; }); }}
                        disabled={state === 'loading'}
                      />
                      <span>
                        {o.name} = <b dir="ltr">{fmt(o.price)} {currency}</b>
                        {o.freeQuantity > 0 ? ` + هدية ${packs(o.freeQuantity)}` : ''}
                        {o.deliveryIncluded === true ? ' توصيل مجاني' : ''}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              {hasOffers && showOfferPicker && offerStyle !== 'radio' && offerStyle !== 'select' && (
                <div>
                  <span className={labelCls}>اختر العرض</span>
                  <div className="space-y-2">
                    {offers.map((o) => {
                      const sel = o.id === selectedOffer;
                      const oOriginal = Number((basePrice * o.quantity).toFixed(2));
                      const oSave = Math.max(0, Number((oOriginal - o.price).toFixed(2)));
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => { setSelectedOffer(o.id); setFieldErrors((fe) => { const n = { ...fe }; delete n.offerId; return n; }); }}
                          className={`w-full rounded-xl border-2 p-3.5 text-start transition ${
                            sel ? 'border-[var(--store-accent,#b8256e)] bg-[#fdf2f7]' : 'border-[#e3e8ef] bg-white hover:border-[var(--store-accent-border,#e8b9d0)]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              {o.isDefault && (
                                <span className="mb-1 inline-block rounded-full bg-[#ffab00] px-2 py-0.5 text-[10px] font-bold text-white">
                                  ⭐ الأكثر طلبًا
                                </span>
                              )}
                              <p className="truncate text-sm font-bold text-[#121926]">{o.name}</p>
                              <p className="mt-0.5 text-[11px] text-[#697586]">
                                {o.quantity} قطعة{o.freeQuantity > 0 ? ` + ${o.freeQuantity} هدية 🎁` : ''}
                              </p>
                              {oOriginal > o.price && (
                                <p className="mt-0.5 text-[11px] font-medium text-[#00a344]">
                                  وفرت {fmt(oOriginal - o.price)} {currency}
                                </p>
                              )}
                            </div>
                            <div className="shrink-0 text-end">
                              <p className="text-lg font-extrabold text-[var(--store-accent,#b8256e)]" dir="ltr">
                                {fmt(o.price)} {currency}
                              </p>
                              {oOriginal > o.price && (
                                <p className="text-xs text-[#9aa4b2] line-through" dir="ltr">
                                  {fmt(oOriginal)} {currency}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="mt-2 flex items-center justify-end">
                            <span
                              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold transition ${
                                sel ? 'bg-[var(--store-accent,#b8256e)] text-white' : 'bg-[#f8fafc] text-[#697586]'
                              }`}
                            >
                              {sel ? '✓ العرض المختار' : 'اختر هذا العرض'}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {offer && offer.freeQuantity > 0 && (
                    <p className="mt-2 text-center text-xs font-semibold text-[#00a344]">
                      🎁 مع {offer.freeQuantity} قطعة هدية مجانًا
                    </p>
                  )}
                </div>
              )}

              {/* The fields, in the shop's order (or the form's own, for a door that hands in no checkout). A fragment
                  each, never a wrapper: the compact look is a grid over the form's own children. */}
              {fields.map((f) => (
                <React.Fragment key={f}>{fieldBlock(f)}</React.Fragment>
              ))}

              {/* Honeypot — hidden from humans */}
              {/* Bot honeypot. It used to hide at `left: -9999px`, which in
                  an RTL page is not off-canvas at all — it is 9999px of real
                  horizontal scroll, and the page slid side to side on every
                  phone. Hidden by size and opacity instead: still in the DOM
                  for a bot to fill, invisible and unscrollable for a person. */}
              <div
                className="absolute h-px w-px overflow-hidden opacity-0"
                style={{ pointerEvents: 'none' }}
                aria-hidden="true"
              >
                <label htmlFor="zf-website">Website</label>
                <input id="zf-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
              </div>

              {/* Error — and when the door refused a field this page does not draw (the page is older than the shop's
                  «الدفع»), the one thing the visitor can do about it: reload. */}
              {state === 'error' && (undrawnRefusal || errorMsg) && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{undrawnRefusal ? NEW_REQUIRED_FIELD : errorMsg}</span>
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={state === 'loading' || (!hasOffers && false) || (hasOffers && !selectedOffer)}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--store-accent,#b8256e)] px-5 py-4 text-base font-bold text-[var(--store-accent-text,#ffffff)] shadow-sm transition hover:bg-[var(--store-accent-dark,#a01f5f)] disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.99]"
                // The shop's «لون زر التأكيد» — on THIS button alone, as the three variables its classes already read
                // (colour, measured ink, pressed shade). The band above and the offer cards keep the page's accent.
                // No colour set: no style at all, and the button is the page's as before.
                style={checkout?.buttonVars ? (checkout.buttonVars as React.CSSProperties) : undefined}
              >
                {state === 'loading' ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    جارٍ تسجيل الطلب...
                  </>
                ) : (
                  <>
                    <ShoppingBag className="h-5 w-5" />
                    {words}{offer ? ` — ${fmt(offer.price)} ${currency}` : ''}
                  </>
                )}
              </button>

              {offer && savings > 0 && (
                <p className="text-center text-xs font-medium text-[#00a344]">
                  بدل {fmt(originalPrice)} — {fmt(offer.price)} {currency} • وفرت {fmt(savings)}
                  {offer.freeQuantity > 0 ? ` • 🎁 +${offer.freeQuantity} هدية` : ''}
                </p>
              )}
              <p className="text-center text-[11px] text-[#697586]">
                بالضغط على «{words}»، سيتواصل معك فريقنا لتأكيد الطلب والتوصيل. الدفع عند الاستلام.
              </p>
            </form>
          )}
        </div>

        {/*
          THE BADGES THAT SAID SOMETHING NOBODY MEASURED.

          «توصيل لجميع المحافظات» was written here as a fact about every shop
          on this system, and it is a fact about none of them: a shop's
          regions are its country's `Region` rows and its courier's reach,
          and a new shop delivering to two governorates said this to every
          visitor. «دفع عند الاستلام» was the third telling of `COD_LINE` on
          one page — the hero carries it as part of the locked core, and the
          line above this one has just said «الدفع عند الاستلام» again.

          Both are now the trust row's, where the delivery claim is a
          measured window or is absent. Nothing is lost that was true.
        */}
      </div>
    </section>
  );
}

export default OrderForm;