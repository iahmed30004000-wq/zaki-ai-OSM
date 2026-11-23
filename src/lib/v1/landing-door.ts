import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { activeOffersFor, activeOffersForProducts, type OfferView } from '../offers';
import { availableStock } from '../reservation';
import { realStoresOnly } from '../test-store';
import { publicizeMedia } from '../public-media';
import { computeCod, roundMinor } from '../money';
import { matchRegion } from '../regions';
import { priceIncludesDeliveryFor } from '../delivery-fees';
import { offersSayDeliveryIncluded } from '../offer-delivery';
import {
  basketDiscount,
  createPublicOrder,
  resolvePublicLines,
  type IntakeResult,
  type SellingSurface,
} from '../public-order';
import { ADDON_TOKEN_MINUTES, LANDING_PAGE_SOURCE, verifyAddonToken } from '../landing-pages';
import { ORDER_VALIDATION_ERROR_BODY, buildPublicOrderSchema } from '../landing-order-schema';
import { CART_ORDER_SOURCE } from '../abandoned-cart-rules';
import { cartsRecoveredBy, replaceableCartOrders, standDownCartOrders, type CartOrder } from '../cart-order-stand-down';
import { resolveCampaign } from '../campaigns-server';
import { checkoutRules, parseStoreTheme } from '../store-theme';
import { POST_ORDER_REFUSAL_AR, postOrderGate, postOrderOfferSettings, type PostOrderRefusal } from '../post-order-offer';
import { unitCostsOf } from '../product-fixed-cost';
import { V1_CODE, V1Fault } from './door';
import { productsInCountry, type LandingScopeArg } from './landing-country';
import { stampAdTags } from './ad-tags';
import {
  PAGES_CC_SENDER,
  attributionColumns,
  mergedAttribution,
  pagesColumns,
  readLandingAttribution,
  readPagesFields,
  type PagesFields,
} from './landing-attribution';
import { PAGES_SENDS_AR } from '../conversions/types';
import { parseVariantOptions, readVariantsView, unitsSentence, writeLineVariants, type VariantsView } from '../product-variants';

/** `units: [{ variantId }]` — one per piece; read by the order door, the offer after the order and the chat's swap. */
export const unitsSchema = z
  .array(z.object({ variantId: z.string().trim().min(1).max(64) }))
  .max(200)
  .optional()
  .nullable();

/**
 * THE STANDALONE LANDING SYSTEM, AT THE SYSTEMS DOOR.
 *
 * Pages live in another system now; products, offers, money, orders and
 * customers stay here. That system's SERVER calls these (a browser never
 * does, so a page on any domain can sell without an origin exception), with
 * a `SystemToken` holding `products.read` and `orders.create`.
 *
 * ── ORDER CREATION IS NOT CHANGED ──
 *
 * «Order creation changed» and «money arithmetic changed» are fixed blockers
 * in AGENTS.md. So an order placed here goes through `createPublicOrder`
 * untouched, with its own validation, blacklist, phone slot, pricing and
 * events: this file only names the `SellingSurface`, exactly as the two
 * existing public routes do. `Order.totalAmount` is what it has always been
 * at creation, and the courier's fee still lands when the order is put on a
 * shipment.
 *
 * ── THE FEE IS SHOWN, NOT WRITTEN ──
 *
 * The report's first gap: a visitor is never shown delivery, then pays it at
 * the door. But a fee in this product belongs to (courier × region), and no
 * courier has been chosen when somebody orders — so there is no single true
 * figure yet. What the customer can honestly be told is the HIGHEST active
 * fee for their region at this store's couriers: the amount collected can
 * then be that or less, never more. `feeExact` says whether the couriers
 * agree, and `feeKnown` is false when the table has no row at all, because a
 * missing row and a free delivery are different facts.
 *
 * This is a read through the one `computeCod`; nothing it computes is stored.
 *
 * ── THE ONE WRITE TO AN ORDER'S MONEY: THE OFFER AFTER THE ORDER ──
 *
 * The owner, 10/11: the upsell here REPLACES the order's offer with a larger
 * one from the catalogue («عبوة ← 3 بـ40»). No second line, and no price that
 * exists only after an order. See `swapLandingOffer`.
 */

/** Everything the landing system may read about a product, and no cost. */
const PRODUCT_SELECT = {
  id: true,
  sku: true,
  name: true,
  description: true,
  image: true,
  basePrice: true,
  status: true,
  storeId: true,
  // The option types of a product with variants (null for every product without) — `product-variants.ts`.
  variantOptions: true,
  store: {
    select: {
      id: true,
      name: true,
      status: true,
      countryId: true,
      theme: true,
      country: { select: { code: true, currencyCode: true, orderPrefix: true, minorUnit: true } },
    },
  },
} as const;

/** What the page's urgency block may print: «بقي N فقط», and only when N is small. */
const SHOWN_AT_OR_BELOW = 20;

/**
 * A stored image is a session-only `/api/media/…` path; a page on another
 * domain needs the public route, as an absolute address.
 */
function imageAddress(image: string | null): string[] {
  if (!image) return [];
  const pub = publicizeMedia(image);
  if (!pub.startsWith('/')) return [pub];
  const origin = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return [`${origin}${pub}`];
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  image: string | null;
  basePrice: number;
  status: string;
  variantOptions?: string | null;
  storeId?: string | null;
  store: { name: string; status: string; country: { code: string; currencyCode: string; minorUnit: number } } | null;
}

function productView(p: ProductRow, offers: OfferView[], availableStockShown: number | null, variants: VariantsView | null = null) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description ?? '',
    images: imageAddress(p.image),
    basePrice: p.basePrice,
    currency: p.store?.country.currencyCode ?? 'USD',
    minorUnit: p.store?.country.minorUnit ?? 2,
    country: p.store?.country.code ?? 'ZZ',
    storeName: p.store?.name ?? '',
    // The store this product is sold under (2026-11-23): Zaki Pages keeps each of its stores to one OMS store.
    storeId: p.storeId ?? null,
    status: p.status,
    storeActive: p.store?.status === 'ACTIVE',
    availableStock: availableStockShown,
    offers: offers.map((o, sortOrder) => ({
      id: o.id,
      name: o.name,
      quantity: o.quantity,
      freeQuantity: o.freeQuantity,
      price: o.price,
      listPrice: o.listPrice,
      compareAtPrice: o.compareAtPrice,
      isDefault: o.isDefault,
      deliveryIncluded: o.deliveryIncluded,
      endsAt: o.endsAt ? o.endsAt.toISOString() : null,
      sortOrder,
    })),
    /*
     * THE OPTIONS AND EVERY ACTIVE COMBINATION (oms-lp.v1 §10, the owner 2026-11-18) — null for a product without
     * variants. `available` per combination; a count only from 1 to 20 and only on the one-product read.
     */
    variants,
  };
}

/**
 * EVERY PRODUCT THE COMPANY HAS, across all its stores and countries.
 *
 * Not only the ACTIVE ones: a seller looking for a product must find it and
 * be told why it cannot sell, rather than conclude the two systems are out
 * of step. `status` says which; the order door refuses anything not ACTIVE.
 * A test bench stays out, as at every door here.
 *
 * Offers are read per currency in one query each, and without the delivered-
 * orders evidence behind `compareAtPrice`: this list is a picker, and the
 * page itself reads one product through `readLandingProduct`.
 */
export async function listLandingProducts(companyId: string, countryId: LandingScopeArg = null) {
  // A key bound to one country lists that country's stores only (`landing-country.ts`); null is every country, as before.
  const rows = await db.product.findMany({
    where: { companyId, ...realStoresOnly(), ...productsInCountry(countryId) },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: PRODUCT_SELECT,
  });
  const byMinor = new Map<number, string[]>();
  for (const p of rows) {
    const minor = p.store?.country.minorUnit ?? 2;
    byMinor.set(minor, [...(byMinor.get(minor) ?? []), p.id]);
  }
  const offers = new Map<string, OfferView[]>();
  for (const [minor, ids] of byMinor) {
    const found = await activeOffersForProducts(db, companyId, ids, minor, new Date(), { withEvidence: false });
    for (const [id, list] of found) offers.set(id, list);
  }
  const out = [];
  for (const p of rows) {
    // Only a product with options is asked about its combinations; every other one costs no query.
    const variants = await readVariantsView(db, companyId, p, false);
    out.push(productView(p, offers.get(p.id) ?? [], null, variants));
  }
  return out;
}

export async function readLandingProduct(companyId: string, productId: string, countryId: LandingScopeArg = null) {
  // Another country's product, for a key bound to one, is a product that does not exist: the same 404.
  const p = await db.product.findFirst({
    where: { companyId, id: productId, ...realStoresOnly(), ...productsInCountry(countryId) },
    select: PRODUCT_SELECT,
  });
  if (!p) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such product');
  const minor = p.store?.country.minorUnit ?? 2;
  const offers = await activeOffersFor(db, companyId, p.id, minor);
  const free = await availableStock(db, companyId, p.id, undefined, p.storeId);
  const variants = await readVariantsView(db, companyId, p, true);
  return productView(p, offers, free >= 1 && free <= SHOWN_AT_OR_BELOW ? free : null, variants);
}

export async function readLandingRegions(companyId: string, code: string) {
  const country = await db.country.findFirst({ where: { companyId, code }, select: { id: true, code: true } });
  if (!country) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such country');
  const regions = await db.region.findMany({
    where: { countryId: country.id, isActive: true },
    select: { id: true, name: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return { country: country.code, regions };
}

export type Refusal = { ok: false; status: number; body: Record<string, unknown> };

export const CITY_REFUSED: Refusal = {
  ok: false,
  status: 400,
  body: {
    ...ORDER_VALIDATION_ERROR_BODY,
    fieldErrors: { city: 'يرجى اختيار المدينة من القائمة.' },
  },
};

export async function deliveryQuote(params: {
  companyId: string;
  productRow: {
    id: string;
    name: string;
    image: string | null;
    basePrice: number;
    variantOptions?: string | null;
    store: { id: string; countryId: string; country: { minorUnit: number; currencyCode: string } };
  };
  offerId: string;
  city: string;
  /** One combination id per piece, for a product with variants (oms-lp.v1 §10). Absent: the base offer's price. */
  units?: string[];
}) {
  const { companyId, productRow: p, offerId, city } = params;
  const { minorUnit, currencyCode } = p.store.country;

  const resolved = await resolvePublicLines(
    companyId,
    [{ id: p.id, name: p.name, image: p.image, basePrice: p.basePrice, variantOptions: p.variantOptions ?? null }],
    [{ productId: p.id, offerId, count: 1, ...(params.units?.length ? { units: params.units } : {}) }],
    minorUnit
  );
  if (!resolved.ok) {
    return { ok: false, status: 400, body: { ...ORDER_VALIDATION_ERROR_BODY, fieldErrors: resolved.fieldErrors } } as Refusal;
  }

  const regions = await db.region.findMany({
    where: { countryId: p.store.countryId, isActive: true },
    select: { id: true, name: true },
  });
  const region = matchRegion(regions, city);
  // A blank city is not a wrong one (the owner, 15/11: a page may ask for «العنوان» only). It has no region, so no
  // fee row: `feeKnown` is false, exactly as for a region the table has no row for. A city that IS written and is
  // not this country's is still refused.
  if (city.trim() !== '' && regions.length > 0 && !region) return CITY_REFUSED;

  const included = await priceIncludesDeliveryFor(
    p.store.id,
    offersSayDeliveryIncluded(resolved.lines.map((l) => l.offer?.deliveryIncluded)),
    { offerMaySayNo: true }
  );

  const rows = region
    ? await db.deliveryFee.findMany({
        where: {
          companyId,
          regionId: region.id,
          isActive: true,
          provider: { isActive: true, OR: [{ storeId: null }, { storeId: p.store.id }] },
        },
        select: { fee: true },
      })
    : [];
  const fees = rows.map((r) => Number(r.fee));
  const highest = fees.length ? Math.max(...fees) : 0;

  const money = computeCod({
    lines: resolved.lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, freeQuantity: l.freeQuantity })),
    discount: basketDiscount(resolved.lines),
    deliveryFee: highest,
    priceIncludesDelivery: included,
    minorUnit,
  });

  return {
    ok: true as const,
    quote: {
      subtotal: money.subtotal,
      discount: money.discount,
      net: included ? money.cod : money.revenue,
      deliveryFee: included ? 0 : money.deliveryFee,
      deliveryIncluded: included,
      feeKnown: included || fees.length > 0,
      feeExact: included || new Set(fees).size === 1,
      cod: money.cod,
      currency: currencyCode,
      minorUnit,
      region: region ? { id: region.id, name: region.name } : null,
      /*
       * A PRODUCT WITH VARIANTS (oms-lp.v1 §10): the pieces' deltas, already inside `subtotal` / `net` / `cod`, and how
       * many pieces this offer needs a choice for. 0 and 0 for a product without variants.
       */
      variantsDelta: resolved.lines.reduce((n, l) => n + (l.variantDelta ?? 0), 0),
      unitsRequired: parseVariantOptions(p.variantOptions).length > 0 ? resolved.lines.reduce((n, l) => n + l.quantity + l.freeQuantity, 0) : 0,
    },
  };
}

const UNAVAILABLE: Refusal = { ok: false, status: 409, body: { error: 'هذا العرض لم يعد متاحًا' } };

/** The sellable product, or why not. Company first: it comes from the token — and so does the country, when it has one. */
async function sellableProduct(companyId: string, productId: string, countryId: LandingScopeArg = null) {
  const p = await db.product.findFirst({
    where: { companyId, id: productId, ...realStoresOnly(), ...productsInCountry(countryId) },
    select: PRODUCT_SELECT,
  });
  if (!p?.store || p.status !== 'ACTIVE' || p.store.status !== 'ACTIVE') return null;
  return { ...p, store: p.store };
}

export async function quoteLandingOrder(
  companyId: string,
  q: { productId: string; offerId: string; city: string; units?: string[] },
  countryId: LandingScopeArg = null
) {
  const productRow = await sellableProduct(companyId, q.productId, countryId);
  if (!productRow) return UNAVAILABLE;
  return deliveryQuote({ companyId, productRow, offerId: q.offerId, city: q.city, units: q.units });
}

/** The pieces a body names — `units: [{ variantId }]` — as ids; absent is none. */
function unitIds(units: { variantId: string }[] | null | undefined): string[] {
  return (units ?? []).map((u) => u.variantId);
}

/** Identifiers and the customer's words. Every figure is derived here. */
export const landingOrderSchema = z.object({
  productId: z.string().trim().min(1).max(64),
  offerId: z.string().trim().max(64).optional().default(''),
  landingPageId: z.string().trim().min(1).max(64),
  full_name: z.string().max(200),
  phone: z.string().max(60),
  alt_phone: z.string().max(60).optional().nullable(),
  address: z.string().max(500),
  // Blank or absent: a page that asks for «العنوان» only. The order is taken with no region (`cityOptional` below).
  city: z.string().max(120).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  campaign: z.string().max(40).optional().nullable(),
  deviceClass: z.enum(['mobile', 'tablet', 'desktop']).optional().nullable(),
  /*
   * WHICH AD THE VISITOR CAME FROM (contract oms-lp.v1 §4) — all optional, and read as `unknown` ON PURPOSE: an ad's
   * tracking value is never a reason to refuse a customer's order. `readLandingAttribution` cleans each one and drops
   * what does not fit; a page that sends none of them is taken exactly as before.
   */
  attribution: z.unknown().optional(),
  event_id: z.unknown().optional(),
  client_user_agent: z.unknown().optional(),
  /*
   * WHAT ZAKI PAGES ADDS (2026-11-21) — the same rule: optional, read as `unknown`, cleaned or dropped by
   * `landing-attribution.ts`, never a refusal. `client_ip` is accepted and stored nowhere (see that file).
   */
  fbp: z.unknown().optional(),
  fbc: z.unknown().optional(),
  client_ip: z.unknown().optional(),
  event_source_url: z.unknown().optional(),
  browser_event_id: z.unknown().optional(),
  pixel_id: z.unknown().optional(),
  utm_source: z.unknown().optional(),
  utm_medium: z.unknown().optional(),
  utm_campaign: z.unknown().optional(),
  utm_content: z.unknown().optional(),
  utm_term: z.unknown().optional(),
  ad_id: z.unknown().optional(),
  ad_name: z.unknown().optional(),
  page_id: z.unknown().optional(),
  page_slug: z.unknown().optional(),
  cc_sender: z.unknown().optional(),
  /*
   * ONE CHOICE PER PIECE, for a product with variants (oms-lp.v1 §10, the owner 2026-11-18): paid pieces first, then
   * the free ones. Optional: a page from before this sends none and the order is taken, flagged for the call.
   */
  units: unitsSchema,
});
export type LandingOrderInput = z.infer<typeof landingOrderSchema>;

export async function takeLandingOrder(companyId: string, order: LandingOrderInput, countryId: LandingScopeArg = null): Promise<IntakeResult> {
  // Another country's product, for a key bound to one, is refused as a product that is no longer sold — nothing is written.
  const productRow = await sellableProduct(companyId, order.productId, countryId);
  if (!productRow) return UNAVAILABLE;
  const { store } = productRow;

  const raw = {
    full_name: order.full_name,
    phone: order.phone,
    alt_phone: order.alt_phone ?? '',
    address: order.address,
    city: order.city ?? '',
    notes: order.notes ?? '',
    offerId: order.offerId,
    website: '',
  };

  /*
   * THE CUSTOMER'S OWN ORDER WINS OVER THE ONE HIS CART BECAME (the owner, 17/11; `cart-order-stand-down.ts`). An
   * automatic order for this phone and this product that nobody has confirmed is ended first — only when this order
   * passes the door's own form, so a typo the visitor is about to fix does not cost the queue its order — and the engine
   * then takes this one as any other. Never in the way: a failure here is logged and the order goes on.
   */
  let stoodDown: CartOrder[] = [];
  try {
    const replaced = await replaceableCartOrders(companyId, {
      storeId: store.id,
      countryCode: store.country.code,
      phone: order.phone,
      productId: productRow.id,
    });
    if (replaced.length > 0 && (await passesTheForm(store, raw))) stoodDown = await standDownCartOrders(companyId, replaced);
  } catch (e) {
    console.error('landing door: could not stand down a cart order (non-fatal):', (e as Error)?.name || 'unknown');
  }

  const surface: SellingSurface = {
    companyId,
    store: { id: store.id, countryId: store.countryId, country: store.country },
    checkout: checkoutRules(parseStoreTheme(store.theme)),
    campaignId: await resolveCampaign(companyId, store.id, order.campaign),
    products: [
      { id: productRow.id, name: productRow.name, image: productRow.image, basePrice: productRow.basePrice, variantOptions: productRow.variantOptions },
    ],
    // The piece-by-piece choice of a product with variants (oms-lp.v1 §10); none for a product without.
    ...(order.units?.length ? { units: unitIds(order.units) } : {}),
    // That page lives in the other system, so there is no row here to link.
    landingPage: null,
    source: LANDING_PAGE_SOURCE,
    dedupeScope: `lpx:${order.landingPageId}`,
    deviceClass: order.deviceClass ?? null,
    // This door only (the owner, 15/11): a blank city is taken, with no region, for the team to pick on the call.
    cityOptional: true,
    notice: {
      title: 'طلب جديد من صفحة هبوط',
      message: (n) => `طلب جديد #${n} من صفحات الهبوط — ${productRow.name}.`,
    },
  };

  const result = await createPublicOrder(surface, raw);
  if (!result.ok) return result;

  // After the commit, and unable to fail what is already saved.
  await markLandingChannel(companyId, String(result.body.orderNumber));
  await recordLandingAttribution(companyId, String(result.body.orderNumber), order);
  // The ad this order came from, for the media buyer — once, after the commit, never able to fail the order (`ad-tags.ts`).
  // With what Zaki Pages sent at the top level filling only what `attribution` lacks (`mergedAttribution`).
  await stampAdTags(companyId, String(result.body.orderNumber), mergedAttribution(order));
  if (stoodDown.length > 0) {
    await cartsRecoveredBy(companyId, stoodDown, String(result.body.orderNumber)).catch((e) =>
      console.error('landing door: could not mark the cart recovered (non-fatal):', (e as Error)?.name || 'unknown')
    );
  }
  const upgrade = await upgradeOffered(companyId, productRow.id, store.country.minorUnit, String(result.body.orderNumber));
  // Priced with the pieces as ordered — read before this order held anything, since a NEW order holds no stock.
  const figures = await deliveryQuote({ companyId, productRow, offerId: order.offerId, city: order.city ?? '', units: unitIds(order.units) }).catch(
    () => null
  );
  const delivery =
    figures && figures.ok
      ? {
          cod: figures.quote.cod,
          deliveryFee: figures.quote.deliveryFee,
          deliveryIncluded: figures.quote.deliveryIncluded,
          feeKnown: figures.quote.feeKnown,
          feeExact: figures.quote.feeExact,
        }
      : {};
  // Replaces the after-order bundle `createPublicOrder` looked up: at this door the upsell is a swap, or nothing.
  return { ok: true, body: { ...result.body, ...delivery, ...upgrade } };
}

/** Whether this body passes the door's own form, read the way `createPublicOrder` reads it — nothing written. */
async function passesTheForm(store: { countryId: string; country: { code: string } }, raw: Record<string, unknown>): Promise<boolean> {
  const regions = await db.region.findMany({ where: { countryId: store.countryId, isActive: true }, select: { name: true } });
  return buildPublicOrderSchema({ countryCode: store.country.code, regions: regions.map((r) => r.name), cityOptional: true }).safeParse(raw)
    .success;
}

/** What an abandoned cart hands the order engine: what the visitor typed, and nothing the team decided. */
export interface CartForOrder {
  id: string;
  productId: string;
  customerName: string;
  /** The number in the national form the country's rule reads (`cartPhoneShown`). */
  phone: string;
  /** The governorate the cart's city matched, or '' — never a city the country does not have. */
  city: string;
  /** The city as the visitor wrote it, when it matched no governorate: kept on the order's note for the call. */
  typedCity: string | null;
}

/**
 * AN ABANDONED CART BECOMES AN ORDER BY ITSELF (the owner, 17/11) — through the SAME engine the landing orders use.
 *
 * `createPublicOrder` with this file's surface, exactly as `takeLandingOrder` names one, so the order gets the same
 * validation against the country, the same blacklist, the same pricing, the same customer find-or-create, history, event
 * and notice. What differs, and why:
 *
 *   · the product at its DEFAULT offer — the live bundle marked default, else the first live one, which is what «حوّل
 *     لطلب» opens with (`adoptedOffer`); the product's base price when it has none;
 *   · the address may be blank (`addressOptional` — set here ONLY, a guard pins it) and so may the city
 *     (`cityOptional`): the visitor never reached «اطلب». The order's history tells the team to ask for both
 *     (`FROM_ABANDONED_CART_ACTION`, written in the order's own transaction via `abandonedCartId`);
 *   · its own one-order-per-phone slot, `cart:<id>`, so it never stands in the way of the order the customer may still
 *     place on the page (`cart-order-stand-down.ts`);
 *   · no «إلزامي» fields of the shop's form (`checkout: null`): nobody filled the form, and the call asks;
 *   · its source is «سلة مهجورة» (`CART_ORDER_SOURCE`) and its channel the landing pages', like every order from there.
 *
 * Status NEW, in the confirmation queue like any new order. The caller is `abandoned-cart-orders.ts`, which decides
 * WHICH carts and makes sure one cart makes one order.
 */
export async function takeCartOrder(companyId: string, cart: CartForOrder): Promise<IntakeResult> {
  const productRow = await sellableProduct(companyId, cart.productId);
  if (!productRow) return UNAVAILABLE;
  const { store } = productRow;
  const offers = await activeOffersFor(db, companyId, productRow.id, store.country.minorUnit);
  const offer = offers.find((o) => o.isDefault) ?? offers[0] ?? null;

  const surface: SellingSurface = {
    companyId,
    store: { id: store.id, countryId: store.countryId, country: store.country },
    checkout: null,
    campaignId: null,
    // With its option types: a cart of a product with variants becomes an order flagged «اسأل عن المقاس واللون».
    products: [
      { id: productRow.id, name: productRow.name, image: productRow.image, basePrice: productRow.basePrice, variantOptions: productRow.variantOptions },
    ],
    landingPage: null,
    source: CART_ORDER_SOURCE,
    dedupeScope: `cart:${cart.id}`,
    deviceClass: null,
    cityOptional: true,
    addressOptional: true,
    abandonedCartId: cart.id,
    notice: {
      title: 'طلب جديد من سلة مهجورة',
      message: (n) => `طلب جديد #${n} من سلة مهجورة — ${productRow.name}. الزبون ما كمّل الطلب: أكّد معه العنوان والمحافظة.`,
    },
  };

  const result = await createPublicOrder(surface, {
    full_name: cart.customerName.trim().slice(0, 80),
    phone: cart.phone,
    alt_phone: '',
    address: '',
    city: cart.city,
    notes: cart.typedCity ? `المدينة كما كتبها الزائر: ${cart.typedCity}`.slice(0, 500) : '',
    offerId: offer?.id ?? '',
    website: '',
  });
  if (!result.ok) return result;
  await markLandingChannel(companyId, String(result.body.orderNumber));
  return result;
}

/**
 * THE CATALOGUE OFFER THIS ORDER CAN GROW INTO: the smallest one holding more units and costing more.
 *
 * Only offers a visitor could have picked at the door, so nothing is invented for the upsell.
 */
export function pickUpgrade(offers: readonly OfferView[], current: { units: number; price: number }): OfferView | null {
  const units = (o: OfferView) => o.quantity + o.freeQuantity;
  return [...offers].filter((o) => units(o) > current.units && o.price > current.price).sort((a, b) => units(a) - units(b) || a.price - b.price)[0] ?? null;
}

/** Never fatal: the order is saved, and a thank-you screen with no upsell is still a thank-you screen. */
async function upgradeOffered(companyId: string, productId: string, minorUnit: number, orderNumber: string) {
  const none = { postOrderOffer: null };
  try {
    const order = await db.order.findFirst({ where: { companyId, orderNumber }, select: { quantity: true, freeQuantity: true, totalAmount: true } });
    if (!order) return none;
    const offer = pickUpgrade(await activeOffersFor(db, companyId, productId, minorUnit), {
      units: order.quantity + order.freeQuantity,
      price: Number(order.totalAmount),
    });
    if (!offer) return none;
    const { windowMinutes } = await postOrderOfferSettings(companyId);
    return { postOrderOffer: offer, postOrderWindowMinutes: Math.min(windowMinutes, ADDON_TOKEN_MINUTES) };
  } catch (e) {
    console.error('landing door: could not read the upgrade offer (non-fatal):', e);
    return none;
  }
}

/**
 * `createPublicOrder` picks the channel from `landingPage`, which is null
 * here, so without this these orders would be counted as the website's.
 */
async function markLandingChannel(companyId: string, orderNumber: string) {
  try {
    const channel = await db.orderChannel.findFirst({
      where: { companyId, kind: 'LANDING_PAGE', isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    });
    if (!channel) return;
    await db.order.updateMany({ where: { companyId, orderNumber }, data: { channelId: channel.id } });
  } catch (e) {
    console.error('landing door: could not mark the channel (non-fatal):', e);
  }
}

/**
 * THE AD THIS ORDER CAME FROM, written beside it — see `landing-attribution.ts` for the mapping and the rules.
 *
 * Here and not in `createPublicOrder`: order creation is not changed («order creation changed» is a fixed blocker),
 * and like the channel above this is a reported fact written after the commit, unable to fail the order. The row is
 * the one just created, so nothing that was there is overwritten. A failure logs its error code only: a database
 * error can quote the values it was given, and none of them belongs in a log.
 */
async function recordLandingAttribution(companyId: string, orderNumber: string, order: LandingOrderInput) {
  let pages: PagesFields | null = null;
  try {
    pages = readPagesFields(order);
    const data = {
      ...attributionColumns(readLandingAttribution({ ...order, attribution: mergedAttribution(order) })),
      ...pagesColumns(pages),
    };
    if (Object.keys(data).length === 0) return;
    await db.order.updateMany({ where: { companyId, orderNumber }, data });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    console.error('landing door: could not record the ad attribution (non-fatal):', typeof code === 'string' ? code : 'error');
    return;
  }
  if (pages.ccSender === PAGES_CC_SENDER) await standDownOmsConversions(companyId, orderNumber);
}

/**
 * ZAKI PAGES SENDS THIS ORDER'S CUSTOM CONVERSIONS ITSELF (`cc_sender: "pages"`, 2026-11-21) — so the conversion this
 * system queued at creation (`createPublicOrder` queues «عبّأ النموذج» before this door can write `ccSender`, and order
 * creation is not changed) is stood down here, marked «تُرسَل من صفحات ذكي» rather than sent: one sale counted once.
 * The later moments never queue for it (`queueConversions`), and the sender checks again (`deliverConversion`).
 * Never fatal, and logs a code only.
 */
async function standDownOmsConversions(companyId: string, orderNumber: string) {
  try {
    const row = await db.order.findFirst({ where: { companyId, orderNumber }, select: { id: true } });
    if (!row) return;
    await db.conversionDelivery.updateMany({
      where: { companyId, orderId: row.id, status: 'PENDING' },
      data: { status: 'SKIPPED', nextAttemptAt: null, lastError: PAGES_SENDS_AR },
    });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    console.error('landing door: could not stand down the conversions (non-fatal):', typeof code === 'string' ? code : 'error');
  }
}

export const landingAddOnSchema = z.object({
  token: z.string().min(20).max(2048),
  offerId: z.string().min(1).max(64),
  // The pieces of the larger offer, for a product with variants (oms-lp.v1 §10).
  units: unitsSchema,
});

/** A refusal about the pieces is the visitor's to fix: 400 with the field errors, the shape the order door answers with. */
export function unitsRefusal(r: { reason: string; fieldErrors?: Record<string, string> }): Refusal | null {
  if (r.reason !== UNITS_REQUIRED && r.reason !== UNITS_INVALID) return null;
  return { ok: false, status: 400, body: { ...ORDER_VALIDATION_ERROR_BODY, reason: r.reason, fieldErrors: r.fieldErrors ?? {} } };
}

/** Names the swap on the order's history, and is how «once» is a fact on the row. */
export const OFFER_SWAP_ACTION = 'LANDING_OFFER_SWAPPED';

/** What a rewrite of the order's offer reads about the order, first and again under the row's lock. */
const SWAP_SELECT = {
  id: true,
  status: true,
  confirmationStatus: true,
  createdAt: true,
  currency: true,
  productId: true,
  offerId: true,
  totalAmount: true,
  discountAmount: true,
  shippingCost: true,
  deliveryFee: true,
  shippingStatus: true,
  shippingBatchId: true,
  trackingNumber: true,
  labelPrintedAt: true,
  region: { select: { name: true } },
  items: { select: { id: true, productId: true, quantity: true, freeQuantity: true, reservedQty: true, deliveredQty: true, variantSummary: true } },
  _count: { select: { contactAttempts: true } },
} as const;

export type SwapRow = Prisma.OrderGetPayload<{ select: typeof SWAP_SELECT }>;
type SwapClient = Pick<typeof db, 'orderAddOn' | 'orderActivity'>;

/**
 * THE LINE IS STILL THE ONE THE DOOR WROTE: one line, carrying the order's offer, nothing reserved or delivered, no
 * discount, no shipping cost and no fee written. Only such a line can be rewritten from the catalogue without
 * overwriting something a person or the warehouse did to it.
 */
export function lineUntouched(o: SwapRow): boolean {
  const [line, ...more] = o.items;
  return (
    !!line && more.length === 0 && !!o.offerId && line.productId === o.productId && line.reservedQty === 0 && line.deliveredQty === null &&
    Number(o.discountAmount) === 0 && Number(o.shippingCost) === 0 && o.deliveryFee === null
  );
}

/** What differs between the two doors that rewrite an order's offer. The money does not. */
export interface OfferRewriteRule {
  /** Null when the order may move; the reason otherwise. Asked first, and again under the row's lock. */
  blocked: (o: SwapRow, client: SwapClient) => Promise<string | null>;
  /** The catalogue offer this door may write for the one the caller named, or null. */
  pick: (offers: OfferView[], current: { units: number; price: number }, offerId: string) => OfferView | null;
  /** The history line's action, and who it says did it. */
  action: string;
  by: string;
  /** Shown on the order's history as «المصدر» when given. */
  source?: string;
}

export type OfferRewrite =
  | { ok: true; offer: OfferView; before: number; total: number; currency: string; productRow: NonNullable<Awaited<ReturnType<typeof sellableProduct>>>; regionName: string | null }
  | { ok: false; reason: string; fieldErrors?: Record<string, string> };

/**
 * The pieces of a product with variants, when an offer is rewritten (oms-lp.v1 §10): a line that already carries a
 * choice per piece needs one for every piece of the new offer; a line without may name them or not.
 */
export const UNITS_REQUIRED = 'UNITS_REQUIRED';
export const UNITS_INVALID = 'UNITS_INVALID';

/**
 * THE ORDER'S LINE TAKES ANOTHER CATALOGUE OFFER — the one write both offer doors share (the offer after the order,
 * and the confirmation chat's «بدّل العرض»).
 *
 * The figures are the door's own. `resolvePublicLines`, `basketDiscount` and `computeCod` are called the way
 * `createPublicOrder` calls them, so the order ends up exactly as if the customer had picked this offer in the first
 * place. Which offer is allowed, and when, is the caller's rule; nothing else is.
 */
export async function rewriteLandingOffer(
  companyId: string,
  orderId: string,
  offerId: string,
  rule: OfferRewriteRule,
  now: Date = new Date(),
  /** One combination id per piece of the NEW offer, for a product with variants. */
  units?: string[]
): Promise<OfferRewrite> {
  // The signature proves the customer; the company comes from the calling system's key.
  const order = await db.order.findFirst({ where: { companyId, id: orderId }, select: SWAP_SELECT });
  if (!order) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such order');

  const first = await rule.blocked(order, db);
  if (first) return { ok: false, reason: first };

  const product = await sellableProduct(companyId, order.productId);
  if (!product) return { ok: false, reason: 'OFFER_GONE' };
  const { minorUnit } = product.store.country;
  const line = order.items[0];

  const allowed = rule.pick(
    await activeOffersFor(db, companyId, product.id, minorUnit, now),
    { units: line.quantity + line.freeQuantity, price: Number(order.totalAmount) },
    offerId
  );
  if (!allowed) return { ok: false, reason: 'OFFER_GONE' };

  // A line whose pieces were chosen keeps a choice for EVERY piece: the new offer's pieces must be named.
  const options = parseVariantOptions(product.variantOptions);
  const withUnits = options.length > 0 && !!units?.length;
  if (options.length > 0 && !withUnits && line.variantSummary) {
    return { ok: false, reason: UNITS_REQUIRED, fieldErrors: { units: unitsSentence(options) } };
  }

  const resolved = await resolvePublicLines(
    companyId,
    [{ id: product.id, name: product.name, image: product.image, basePrice: product.basePrice, variantOptions: product.variantOptions }],
    [{ productId: product.id, offerId: allowed.id, count: 1, ...(withUnits ? { units } : {}) }],
    minorUnit
  );
  if (!resolved.ok) {
    return withUnits && (resolved.fieldErrors.units || Object.keys(resolved.fieldErrors).some((k) => k.startsWith('units')))
      ? { ok: false, reason: UNITS_INVALID, fieldErrors: resolved.fieldErrors }
      : { ok: false, reason: 'OFFER_GONE' };
  }
  const [next] = resolved.lines;

  // An add-on already on the order (a later door may write one) stays in the sum, as every reader counts it.
  const addOns = await db.orderAddOn.findMany({ where: { orderId: order.id }, select: { quantity: true, price: true } });
  const money = computeCod({
    lines: [{ quantity: next.quantity, unitPrice: next.unitPrice, freeQuantity: next.freeQuantity }],
    discount: basketDiscount(resolved.lines),
    addOns: addOns.map((a) => ({ quantity: a.quantity, unitPrice: a.price })),
    minorUnit,
  });
  const unitCosts = await unitCostsOf(db, companyId, [product.id]);
  const included = await priceIncludesDeliveryFor(product.store.id, offersSayDeliveryIncluded([next.offer?.deliveryIncluded]), { offerMaySayNo: true });

  const before = Number(order.totalAmount);
  const refused = await db.$transaction(async (tx) => {
    // The row is locked first: two presses at the same moment swap once, and a staff save from an older copy is told.
    await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } }, select: { id: true } });
    const latest = await tx.order.findFirst({ where: { id: order.id }, select: SWAP_SELECT });
    if (!latest || latest.offerId !== order.offerId) return 'ALREADY_ADDED';
    const again = await rule.blocked(latest, tx);
    if (again) return again;

    await tx.orderItem.update({
      where: { id: line.id },
      data: {
        quantity: next.quantity,
        freeQuantity: next.freeQuantity,
        unitPrice: next.unitPrice,
        discountShare: money.discountShares[0] ?? 0,
        lineTotal: money.lineTotals[0] ?? 0,
      },
    });
    // The pieces of the new offer replace the old ones, in the same commit as the line they describe.
    if (next.units?.length) {
      await writeLineVariants(tx, { companyId, orderId: order.id, orderItemId: line.id, productId: product.id, groups: next.units });
    }
    await tx.order.update({
      where: { id: order.id },
      data: {
        offerId: allowed.id,
        quantity: next.quantity,
        freeQuantity: next.freeQuantity,
        sellingPrice: money.lineTotals[0] ?? money.subtotal,
        totalAmount: money.cod,
        priceIncludesDelivery: included,
        estimatedCostOfGoods: roundMinor((unitCosts.get(product.id) ?? 0) * (next.quantity + next.freeQuantity), minorUnit),
      },
    });
    await tx.orderActivity.create({
      data: {
        companyId,
        orderId: order.id,
        userId: null,
        action: rule.action,
        metadata: JSON.stringify({
          from: { offerId: order.offerId, quantity: line.quantity, freeQuantity: line.freeQuantity, total: before },
          to: { offerId: allowed.id, offer: allowed.name, quantity: next.quantity, freeQuantity: next.freeQuantity, total: money.cod },
          by: rule.by,
          ...(rule.source ? { source: rule.source, offerName: allowed.name, total: money.cod } : {}),
        }),
      },
    });
    return null;
  });
  if (refused) return { ok: false, reason: refused };

  return { ok: true, offer: allowed, before, total: money.cod, currency: order.currency, productRow: product, regionName: order.region?.name ?? null };
}

/**
 * «أيوه»: THE ORDER'S OFFER BECOMES THE LARGER ONE. Same order, same line.
 *
 * Under the gates of the add-on it replaces (`postOrderGate`): still NEW, nobody
 * has contacted the customer, inside the window, once. So only an order nobody
 * has worked on can move, which is what makes rewriting its line safe: no stock
 * is reserved yet, no fee is written yet, no person has quoted a figure.
 *
 * The write is `rewriteLandingOffer`'s. The caller names an offer and a token;
 * which offer is allowed is decided here: the next larger one, `pickUpgrade`.
 */
export async function swapLandingOffer(
  companyId: string,
  orderNumber: string,
  swap: z.infer<typeof landingAddOnSchema>,
  now: Date = new Date()
): Promise<{ ok: true; body: Record<string, unknown> } | Refusal> {
  const token = await verifyAddonToken(swap.token);
  if (!token || token.orderNumber !== orderNumber) {
    return { ok: false, status: 401, body: { error: 'رابط الإضافة غير صالح أو منتهي الصلاحية' } };
  }

  const refuse = (reason: PostOrderRefusal): Refusal => ({
    ok: false,
    status: reason === 'OFFER_GONE' || reason === 'NOT_IN_ORDER' ? 404 : 409,
    body: { error: POST_ORDER_REFUSAL_AR[reason], reason },
  });
  const { windowMinutes } = await postOrderOfferSettings(companyId);

  const result = await rewriteLandingOffer(
    companyId,
    token.orderId,
    swap.offerId,
    {
      /** Everything that says the order is still the one the door wrote. */
      blocked: async (o, client) => {
        const [addOns, swaps] = await Promise.all([
          client.orderAddOn.count({ where: { orderId: o.id, offerId: { not: null } } }),
          client.orderActivity.count({ where: { companyId, orderId: o.id, action: OFFER_SWAP_ACTION } }),
        ]);
        const gate = postOrderGate(
          { status: o.status, confirmationStatus: o.confirmationStatus, createdAt: o.createdAt, contactAttempts: o._count.contactAttempts, postOrderAddOns: addOns + swaps },
          windowMinutes,
          now
        );
        if (!gate.allowed) return gate.reason;
        return lineUntouched(o) ? null : 'NOT_NEW';
      },
      pick: (offers, current, offerId) => {
        const up = pickUpgrade(offers, current);
        return up && up.id === offerId ? up : null;
      },
      action: OFFER_SWAP_ACTION,
      by: 'public visitor',
    },
    now,
    unitIds(swap.units)
  );
  if (!result.ok) return unitsRefusal(result) ?? refuse(result.reason as PostOrderRefusal);
  const { offer: allowed } = result;

  // What the customer now pays at the door, by the quote the page already showed for this offer.
  const figures = await deliveryQuote({ companyId, productRow: result.productRow, offerId: allowed.id, city: result.regionName ?? '' }).catch(() => null);
  return {
    ok: true,
    body: {
      total: result.total,
      added: roundMinor(result.total - result.before, result.productRow.store.country.minorUnit),
      currency: result.currency,
      offer: { id: allowed.id, name: allowed.name, quantity: allowed.quantity, freeQuantity: allowed.freeQuantity, price: allowed.price },
      ...(figures && figures.ok
        ? { cod: figures.quote.cod, deliveryFee: figures.quote.deliveryFee, deliveryIncluded: figures.quote.deliveryIncluded, feeKnown: figures.quote.feeKnown, feeExact: figures.quote.feeExact }
        : {}),
    },
  };
}

/**
 * WHAT THE CONFIRMATION CHAT SHOWS ABOUT AN ORDER'S MONEY — read, never written.
 *
 * `total` is the order's stored figure, as it is. The fee beside it is the quote's (the highest active fee for the
 * order's region at this store's couriers, `deliveryQuote`), and `cod` adds it to the stored total through the one
 * `computeCod` — unless the order's own snapshot says delivery is included, when the goods are the whole amount.
 * `offers` are the product's live catalogue offers, the ones the chat may switch between.
 */
export async function landingOrderFigures(
  companyId: string,
  o: { productId: string; offerId: string | null; regionName: string | null; totalAmount: number; priceIncludesDelivery: boolean }
) {
  const p = await db.product.findFirst({ where: { companyId, id: o.productId }, select: PRODUCT_SELECT });
  const minorUnit = p?.store?.country.minorUnit ?? 2;
  const offers = p ? await activeOffersFor(db, companyId, p.id, minorUnit) : [];
  const quoted =
    p?.store && o.offerId
      ? await deliveryQuote({ companyId, productRow: { ...p, store: p.store }, offerId: o.offerId, city: o.regionName ?? '' }).catch(() => null)
      : null;
  const q = quoted && quoted.ok ? quoted.quote : null;

  const included = o.priceIncludesDelivery;
  // A quote that counts the fee in while the order does not is not a figure for this order: unknown, never «free».
  const known = !!q && !q.deliveryIncluded && q.feeKnown;
  const fee = included || !known ? 0 : q!.deliveryFee;
  const money = computeCod({
    lines: [{ quantity: 1, unitPrice: o.totalAmount, freeQuantity: 0 }],
    discount: 0,
    deliveryFee: fee,
    priceIncludesDelivery: included,
    minorUnit,
  });

  return {
    storeName: p?.store?.name ?? '',
    minorUnit,
    offers: offers.map((f) => ({ id: f.id, name: f.name, quantity: f.quantity, freeQuantity: f.freeQuantity, price: f.price })),
    cod: money.cod,
    deliveryFee: fee,
    deliveryIncluded: included,
    feeKnown: included || known,
    feeExact: included || (known && q!.feeExact),
  };
}
