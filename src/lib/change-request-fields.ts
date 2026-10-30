/**
 * WHAT A CHANGE REQUEST MAY TOUCH, AND WHAT EACH THING IS CALLED.
 *
 * One list, read by the route that accepts a request and by the dialog that
 * decides one. They used to keep a list each, and the lists had drifted:
 * the route accepted the city, the product, the offer and the notes, and
 * the dialog knew none of them — so four of the ten fields reached the
 * person deciding under their English code names, and three names in the
 * dialog belonged to fields no request could ever carry.
 *
 * Pure and client-safe: the dialog runs in the browser.
 */

/**
 * `regionId`, NOT `customerCity`.
 *
 * The city was free text and could not be applied at all: the order ships
 * to a REGION — the governorate the delivery fee is keyed on — and the
 * order route has no city field to write. So every request on it was
 * accepted, approved, and then refused with «عدّلها يدوياً»; it was
 * reported as «طلب تعديل: لا يمكن تعديل المدينة».
 *
 * The governorate is a real list and a real column, so the request can be
 * carried out to the end — which is the whole point of the door.
 *
 * AND `sellingPrice` IS HERE, WHILE `offerId` IS NOT.
 *
 * «كمية كم عدد والسعر الجديد… منتج آخر اختاره وكميته وسعره وينعكس هذا على
 * الفاتورة» — so the price had to become askable. The order route already
 * accepts it, so the request can be carried out to the end.
 *
 * The offer could not, and that was the city's bug wearing another name:
 * the door accepted it, a supervisor approved it, and the apply path then
 * answered «لا يمكن تطبيق العرض من هنا — عدّلها يدوياً». An offer is not one
 * value: it carries quantity, free units, price, discount AND whether the
 * price includes delivery, so applying one by copying an id would move five
 * money inputs at once through a path built for none of them. And the ask
 * behind it is already sayable in three fields that DO apply — the product,
 * the quantity and the price.
 *
 * A field belongs in this list only if `APPLIES_AS` in change-request-apply
 * can carry it out. A guard holds the two lists together, because this is
 * the second time they drifted apart and both times the seller found it
 * before we did.
 */
export const CHANGEABLE_FIELDS = [
  'customerName', 'customerPhone', 'customerAltPhone', 'customerAddress', 'regionId',
  'quantity', 'productId', 'sellingPrice', 'discountAmount', 'customerNotes',
] as const;

export type ChangeableField = (typeof CHANGEABLE_FIELDS)[number];

/**
 * THE FIELDS WHOSE APPROVAL MOVES WHAT THE CUSTOMER PAYS (perm-plan PR-7).
 *
 * The price, the discount, the quantity, the product — and the two names an old row may still carry (`offerId`, `items`),
 * because a row written before they were retired is decided under today's rule, not under a list that forgot it. Approving
 * a request that carries one of them needs `orders.change_price`: who may DECIDE a price change is the same question as who
 * may make one. Rejecting never needs it, and neither does any other field.
 */
export const MONEY_CHANGE_FIELDS: readonly string[] = ['sellingPrice', 'discountAmount', 'quantity', 'productId', 'offerId', 'items'];

/** The sentence a decider without the price key reads on a request that moves a figure. */
export const PRICE_KEY_REQUIRED_AR = 'هذا الطلب يغيّر السعر أو الكمية أو المنتج — البتّ فيه لمن عنده صلاحية تغيير السعر.';

/** Does this request (its `changes` object, as stored or as sent) ask for any money field? */
export function touchesMoney(changes: unknown): boolean {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return false;
  return Object.keys(changes as Record<string, unknown>).some((k) => MONEY_CHANGE_FIELDS.includes(k));
}

export const CHANGE_FIELD_AR: Record<ChangeableField, string> = {
  customerName: 'اسم العميل',
  customerPhone: 'هاتف العميل',
  customerAltPhone: 'الهاتف البديل',
  customerAddress: 'العنوان',
  regionId: 'المحافظة',
  quantity: 'الكمية',
  productId: 'المنتج',
  sellingPrice: 'السعر (إجمالي الكمية)',
  discountAmount: 'الخصم',
  customerNotes: 'ملاحظات العميل',
};

/**
 * Fields no new request may carry, kept only so an OLD row still reads in
 * Arabic. Dropping the name with the field would print `offerId` to a reader
 * of a request raised before it was retired — and the apply path refuses it
 * by its label, so the label is what the refusal says.
 */
const RETIRED_FIELD_AR: Record<string, string> = {
  offerId: 'العرض',
  customerCity: 'المدينة',
};

export function changeFieldLabel(field: string): string {
  return (CHANGE_FIELD_AR as Record<string, string>)[field] ?? RETIRED_FIELD_AR[field] ?? field;
}

export type ChangeValue = string | number | null;
export type Changes = Partial<Record<ChangeableField, { from?: ChangeValue; to: ChangeValue }>>;

/** The order as it stands, in the shape a change request speaks. */
export interface OrderSnapshot {
  quantity: number;
  productId: string;
  /** The line total for the quantity, not the per-unit price — see below. */
  sellingPrice: number;
  discountAmount: number;
  customerNotes: string | null;
  /** The governorate it ships to — what the delivery fee is keyed on. */
  regionId: string | null;
  /** The address this order goes to, when it has its own — the «before» of an address change is THIS one. */
  deliveryAddress?: string | null;
  customer: {
    fullName: string;
    phone: string;
    altPhone: string | null;
    address: string;
    city: string;
  };
}

function current(order: OrderSnapshot, field: ChangeableField): ChangeValue {
  switch (field) {
    case 'customerName': return order.customer.fullName;
    case 'customerPhone': return order.customer.phone;
    case 'customerAltPhone': return order.customer.altPhone;
    case 'customerAddress': return order.deliveryAddress ?? order.customer.address;
    case 'regionId': return order.regionId ?? null;
    case 'quantity': return order.quantity;
    case 'productId': return order.productId;
    /**
     * THE LINE TOTAL, NOT THE PER-UNIT PRICE.
     *
     * `Order.sellingPrice` is the whole line — the order route's own words:
     * «the single-line shorthand: price is the TOTAL for the quantity». A
     * request that showed «50 ← 60» while the person meant sixty EACH would
     * be approved as a discount, so the label says which it is and the
     * decider sees the current figure beside it.
     */
    case 'sellingPrice': return order.sellingPrice;
    case 'discountAmount': return order.discountAmount;
    case 'customerNotes': return order.customerNotes;
  }
}

/**
 * Each requested change, with what it is changing FROM.
 *
 * Taken by the server at the moment of asking, never accepted from the
 * browser. A request that says only "make it 3" is unanswerable — three
 * instead of what? — and a "from" the requester typed could say anything.
 * The dialog was built to show both sides and had only ever been given one.
 */
export function withFrom(order: OrderSnapshot, changes: Changes): Changes {
  const out: Changes = {};
  for (const [field, change] of Object.entries(changes) as [ChangeableField, { to: ChangeValue }][]) {
    if (!change) continue;
    out[field] = { from: current(order, field), to: change.to };
  }
  return out;
}
