import { describe, expect, it } from 'vitest';
import { DETAIL_VARS, TEMPLATE_VARS, fillTemplate, orderDetailsContext, usesOrderDetails } from './message-templates';

describe('the four order-detail placeholders', () => {
  it('are offered to the person writing a template', () => {
    const keys = TEMPLATE_VARS.map((v) => v.key as string);
    for (const v of DETAIL_VARS) expect(keys).toContain(v);
  });

  it('fill from the context, and an absent one is an empty word, never a literal brace', () => {
    const text = fillTemplate('{المنتجات}|{الكمية}|{العنوان}|{تاريخ_الطلب}', {
      products: 'كريم × 2', quantity: 2, address: 'دمشق', orderDate: '28/10/2026',
    });
    expect(text).toBe('كريم × 2|2|دمشق|28/10/2026');
    expect(fillTemplate('ب{المنتجات}ب', {})).toBe('بب');
  });

  it('usesOrderDetails is true only for a wording that holds one of them', () => {
    expect(usesOrderDetails('طلبك {المنتجات}')).toBe(true);
    expect(usesOrderDetails('مرحبا {اسم_الزبون}')).toBe(false);
  });
});

describe('orderDetailsContext reads the order as the single-order door returns it', () => {
  const order = {
    createdAt: '2026-10-28T09:00:00.000Z',
    deliveryAddress: 'عنوان الطلب',
    customer: { address: 'عنوان الزبون' },
    items: [
      { productName: 'كريم', quantity: 2, freeQuantity: 1 },
      { productName: 'صابون', quantity: 1, freeQuantity: 0 },
    ],
  };

  it('lines with their gifts, the units asked for (gifts not counted), the date', () => {
    expect(orderDetailsContext(order)).toEqual({
      products: 'كريم × 2 (+ 1 هدية)، صابون × 1', quantity: 3, address: 'عنوان الطلب', orderDate: '28/10/2026',
    });
  });

  it('the address falls back to the customer own address; nothing at all gives nulls', () => {
    expect(orderDetailsContext({ ...order, deliveryAddress: null }).address).toBe('عنوان الزبون');
    expect(orderDetailsContext({})).toEqual({ products: null, quantity: null, address: null, orderDate: null });
  });
});
