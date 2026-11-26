/**
 * WHAT THE BOT'S TOOLS GO THROUGH — one shape, two doors.
 *
 * `order-door.ts` is the real one: the customer's own orders (matched by the WhatsApp number), changed only through the
 * OMS's own services, every change in the bot's name on the order's history and in the audit log.
 * `sandbox-door.ts` is the owner's «جرّبه»: a made-up customer and order on a real product of the company, kept in the
 * request, so the same engine runs and nothing is written anywhere and nothing goes to WhatsApp.
 */
import { CONFIRMATION_STATUS_AR } from '../../confirmation-workflow';

/** One order as the model reads it. Every figure is the OMS's own; the model never computes money. */
export interface BotOrderView {
  orderNumber: string;
  createdAt: string;
  /** confirmationStatus: NEW, IN_PROGRESS, NO_ANSWER, FOLLOW_UP_REQUIRED, POSTPONED, CONFIRMED, REJECTED, CANCELLED. */
  status: string;
  shippingStatus: string;
  /** Name, address, city and notes may still change. */
  editable: boolean;
  /** The offer may still be swapped: NEW, editable, and the line is still the one the order was taken with. */
  offerChangeAllowed: boolean;
  product: { id: string; name: string } | null;
  offer: { id: string; name: string } | null;
  items: Array<{ name: string; quantity: number; freeQuantity: number }>;
  currency: string;
  /** The goods (the order's stored total). */
  total: number;
  /** What the customer pays on delivery. */
  cod: number;
  deliveryFee: number;
  deliveryIncluded: boolean;
  feeKnown: boolean;
  feeExact: boolean;
  customer: { name: string; city: string | null; address: string | null; notes: string };
  /** The same product's live catalogue offers — the only ones the order may switch to. Details only. */
  offers?: Array<{ id: string; name: string; quantity: number; freeQuantity: number; price: number }>;
  /** The delivery cities of the order's country. Details only. */
  cities?: string[];
  /** The product has sizes/colours chosen per piece: the bot leaves offer changes to a person. */
  hasVariants?: boolean;
}

export interface BotProductInfo {
  name: string;
  description: string;
  currency: string;
  offers: Array<{ id: string; name: string; quantity: number; freeQuantity: number; price: number; deliveryIncluded: boolean }>;
  /** The owner's short facts about this product (bot settings), approved to tell customers. */
  fromStoreOwner: string | null;
}

export interface CustomerChange {
  name?: string;
  city?: string;
  address?: string;
  notes?: string;
}

export type DoorAnswer = { ok: true; order: BotOrderView; already?: boolean } | { ok: false; error: string };

export interface BotDoor {
  /** The customer's orders, newest first (at most ten). */
  orders(): Promise<BotOrderView[]>;
  /** One of them in full — offers and cities included — or null when it is not this customer's. */
  order(orderNumber: string): Promise<BotOrderView | null>;
  product(orderNumber: string): Promise<BotProductInfo | null>;
  amend(orderNumber: string, change: CustomerChange): Promise<DoorAnswer>;
  changeOffer(orderNumber: string, offerId: string): Promise<DoorAnswer>;
  confirm(orderNumber: string): Promise<DoorAnswer>;
}

/** The words of a status, for the model to say: the confirmation axis's one vocabulary. */
export const STATUS_AR: Record<string, string> = CONFIRMATION_STATUS_AR;
