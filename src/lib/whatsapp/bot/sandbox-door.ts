/**
 * «جرّبه» — THE OWNER'S PRACTICE CHAT: the same engine and the same tools, against a made-up customer and order.
 *
 * The order is built on a REAL product of the company — its live offers, its country's cities, the real delivery quote —
 * so the owner hears what a customer would hear. Nothing is written: the order lives in the request (the screen sends it
 * back with every turn) and every «change» or «confirmation» only returns a new copy of it. Nothing goes to WhatsApp.
 */
import { db } from '../../db';
import { realStoresOnly } from '../../test-store';
import { matchRegion } from '../../regions';
import { landingOrderFigures, readLandingProduct } from '../../v1/landing-door';
import type { BotDoor, BotOrderView, CustomerChange, DoorAnswer } from './door';
import type { ProductNote } from './settings';

export interface SandboxState {
  productId: string;
  order: BotOrderView;
}

export const SANDBOX_CUSTOMER = 'زبون تجريبي';

class SandboxMissing extends Error {}

async function figures(companyId: string, productId: string, offerId: string, city: string, price: number, included: boolean) {
  return landingOrderFigures(companyId, { productId, offerId, regionName: city, totalAmount: price, priceIncludesDelivery: included });
}

async function citiesOf(companyId: string, productId: string): Promise<string[]> {
  const p = await db.product.findFirst({ where: { companyId, id: productId }, select: { store: { select: { countryId: true } } } });
  if (!p?.store?.countryId) return [];
  const rows = await db.region.findMany({ where: { countryId: p.store.countryId, isActive: true }, select: { name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  return rows.map((r) => r.name);
}

/** The products the practice chat can run on: the company's own, active, in a real store. */
export async function sandboxProducts(companyId: string) {
  return db.product.findMany({
    where: { companyId, status: 'ACTIVE', ...realStoresOnly() },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: 200,
  });
}

/** A new practice order: the product asked for (or the first active one), its default offer, the first city. */
export async function openSandbox(companyId: string, productId?: string | null): Promise<SandboxState> {
  const pick =
    (productId ? await db.product.findFirst({ where: { companyId, id: productId, ...realStoresOnly() }, select: { id: true } }) : null) ??
    (await db.product.findFirst({ where: { companyId, status: 'ACTIVE', ...realStoresOnly() }, select: { id: true }, orderBy: { name: 'asc' } }));
  if (!pick) throw new SandboxMissing('ما في منتج فعّال بالمتجر لنجرّب عليه');
  const p = await readLandingProduct(companyId, pick.id);
  const offer = p.offers.find((o) => o.isDefault) ?? p.offers[0];
  if (!offer) throw new SandboxMissing('المنتج ما عليه عروض فعّالة — أضف عرضًا أو اختر منتجًا آخر');
  const cities = await citiesOf(companyId, p.id);
  const city = cities[0] ?? '';
  const f = await figures(companyId, p.id, offer.id, city, offer.price, offer.deliveryIncluded);
  return {
    productId: p.id,
    order: {
      orderNumber: 'TEST-1001',
      createdAt: new Date().toISOString(),
      status: 'NEW',
      shippingStatus: 'NOT_READY',
      editable: true,
      offerChangeAllowed: true,
      product: { id: p.id, name: p.name },
      offer: { id: offer.id, name: offer.name },
      items: [{ name: p.name, quantity: offer.quantity, freeQuantity: offer.freeQuantity }],
      currency: p.currency,
      total: offer.price,
      cod: f.cod,
      deliveryFee: f.deliveryFee,
      deliveryIncluded: f.deliveryIncluded,
      feeKnown: f.feeKnown,
      feeExact: f.feeExact,
      customer: { name: SANDBOX_CUSTOMER, city, address: 'عنوان تجريبي، شارع رئيسي 1', notes: '' },
      offers: f.offers,
      cities,
      hasVariants: false,
    },
  };
}

export { SandboxMissing };

/** The practice door. `state.order` is replaced in place by every «change», so the caller sends the new copy back. */
export function sandboxDoor(companyId: string, state: SandboxState, productNotes: ProductNote[] = []): BotDoor {
  const same = (n: string) => n.trim().replace(/^#/, '') === state.order.orderNumber;
  const editable = () => !['CONFIRMED', 'REJECTED', 'CANCELLED'].includes(state.order.status);
  const missing: DoorAnswer = { ok: false, error: 'No such order for this customer. Use only order numbers from get_customer_orders.' };

  const reprice = async (offerId: string, city: string) => {
    const p = await readLandingProduct(companyId, state.productId);
    const offer = p.offers.find((o) => o.id === offerId);
    if (!offer) return null;
    const f = await figures(companyId, p.id, offer.id, city, offer.price, offer.deliveryIncluded);
    return { offer, f };
  };

  return {
    async orders() {
      return [state.order];
    },
    async order(n) {
      return same(n) ? state.order : null;
    },
    async product(n) {
      if (!same(n)) return null;
      const p = await readLandingProduct(companyId, state.productId);
      return {
        name: p.name,
        description: p.description,
        currency: p.currency,
        offers: p.offers.map((f) => ({ id: f.id, name: f.name, quantity: f.quantity, freeQuantity: f.freeQuantity, price: f.price, deliveryIncluded: f.deliveryIncluded })),
        fromStoreOwner: productNotes.find((x) => x.productId === state.productId)?.notes ?? null,
      };
    },
    async amend(n, change: CustomerChange) {
      if (!same(n)) return missing;
      if (!editable()) return { ok: false, error: 'This order is confirmed, ended or on its way: the bot cannot change it. Offer transfer_to_human.' };
      const next = { ...state.order, customer: { ...state.order.customer } };
      if (change.city !== undefined) {
        const region = matchRegion((state.order.cities ?? []).map((name, i) => ({ id: String(i), name })), change.city.trim());
        if (!region) return { ok: false, error: 'That city is not in the list of delivery cities. Ask the customer to pick one of the "cities" list of get_order_details.' };
        next.customer.city = region.name;
        const priced = next.offer ? await reprice(next.offer.id, region.name) : null;
        if (priced) Object.assign(next, { cod: priced.f.cod, deliveryFee: priced.f.deliveryFee, deliveryIncluded: priced.f.deliveryIncluded, feeKnown: priced.f.feeKnown, feeExact: priced.f.feeExact });
      }
      if (change.name) next.customer.name = change.name.trim().slice(0, 80);
      if (change.address) next.customer.address = change.address.trim().slice(0, 200);
      if (change.notes !== undefined) next.customer.notes = change.notes.trim().slice(0, 500);
      state.order = next;
      return { ok: true, order: next };
    },
    async changeOffer(n, offerId) {
      if (!same(n)) return missing;
      if (state.order.offer?.id === offerId) return { ok: true, order: state.order, already: true };
      if (!(state.order.status === 'NEW' && editable())) {
        return { ok: false, error: 'The offer of this order can no longer be changed from the chat. Offer transfer_to_human.' };
      }
      const priced = await reprice(offerId, state.order.customer.city ?? '');
      if (!priced) return { ok: false, error: 'That offer is not a live offer of this product. Use an id of the "offers" list of get_order_details.' };
      const next: BotOrderView = {
        ...state.order,
        offer: { id: priced.offer.id, name: priced.offer.name },
        items: [{ name: state.order.product?.name ?? '', quantity: priced.offer.quantity, freeQuantity: priced.offer.freeQuantity }],
        total: priced.offer.price,
        cod: priced.f.cod,
        deliveryFee: priced.f.deliveryFee,
        deliveryIncluded: priced.f.deliveryIncluded,
        feeKnown: priced.f.feeKnown,
        feeExact: priced.f.feeExact,
      };
      state.order = next;
      return { ok: true, order: next };
    },
    async confirm(n) {
      if (!same(n)) return missing;
      if (state.order.status === 'CONFIRMED') return { ok: true, order: state.order, already: true };
      if (!editable()) return { ok: false, error: 'This order is cancelled or cannot be confirmed from the chat. Offer transfer_to_human.' };
      state.order = { ...state.order, status: 'CONFIRMED', editable: false, offerChangeAllowed: false };
      return { ok: true, order: state.order };
    },
  };
}
