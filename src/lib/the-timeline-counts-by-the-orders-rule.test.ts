import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * REQUEST Q4d (21/11) — THE ORDER'S TIMELINE NUMBERS ITS «لا يرد» LINES BY THE ORDER'S OWN RULE: «محاولة 1 من 7» for an order of a product with «منتج غالي»,
 * «من 5» for another product, and — with no ORDER_NUMBERS row — the order is not read again (main's timeline).
 */

vi.mock('./db', () => ({ db: {} }));
vi.mock('./no-answer-cadence-switch', () => ({ cadenceSince: async () => new Date('2026-11-01T00:00:00.000Z') }));

import { orderTimeline } from './order-timeline';
import { forgetConfirmationRules } from './employee-numbers';
import { scheduleOfAttempts } from './confirmation-own-rules';

const AT = (h: number, mi = 0) => new Date(Date.UTC(2026, 10, 15, h - 3, mi)); // Amman, Sunday
const line = (id: string, at: Date, n: number, due: Date | null) => ({
  id, companyId: 'co-q4d-tl', orderId: 'o1', createdAt: at, result: 'NO_ANSWER', contactMethod: 'PHONE', attemptNumber: n, employeeId: 'u1', note: null, nextFollowUpAt: due,
});
const rules: unknown[] = [];
let product = 'pA';
let factReads = 0;

function tx() {
  const none = { findMany: vi.fn(async () => []) };
  return {
    orderStatusLog: none, callLog: none, callHelperReading: none, deliveryAttempt: none, orderNote: none, orderActivity: none, orderChangeRequest: none, orderIssue: none, orderClaimHistory: none,
    orderContactAttempt: { findMany: vi.fn(async () => [line('a', AT(13), 1, AT(13, 30)), line('b', AT(13, 30), 2, AT(15, 30))]) },
    user: { findMany: vi.fn(async () => [{ id: 'u1', name: 'موظفة' }]) },
    order: {
      findUnique: vi.fn(async () => ({ country: { timezone: 'Asia/Amman', weekendDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00' } })),
      findMany: vi.fn(async () => (factReads++, [{ id: 'o1', storeId: 's1', productId: product, channel: null, items: [{ productId: product }] }])),
    },
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    confirmationRule: { findMany: vi.fn(async () => [...rules]) },
  };
}
const titles = async () => (await orderTimeline(tx() as never, 'o1')).filter((e) => e.kind === 'CONTACT').map((e) => e.title.split(' عبر ')[0]);

beforeEach(() => {
  forgetConfirmationRules('co-q4d-tl');
  rules.length = 0;
  product = 'pA';
  factReads = 0;
});

describe('the timeline counts by the order’s rule', () => {
  const seven = {
    id: 'r7', companyId: 'co-q4d-tl', storeId: null, name: 'منتج غالي', kind: 'ORDER_NUMBERS', userIds: null, productId: 'pA', channelKind: null, phase: null, hoursFrom: null, hoursTo: null,
    effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), effectiveTo: null, isActive: true, payload: scheduleOfAttempts(7), createdAt: new Date('2026-11-01T00:00:00.000Z'),
  };

  it('an order of the product with seven: «محاولة 1 من 7», «محاولة 2 من 7»', async () => {
    rules.push(seven);
    expect(await titles()).toEqual(['محاولة 1 من 7', 'محاولة 2 من 7']);
  });

  it('NEGATIVE: an order of another product: the base five', async () => {
    rules.push(seven);
    product = 'pB';
    expect(await titles()).toEqual(['محاولة 1 من 5', 'محاولة 2 من 5']);
  });

  it('no ORDER_NUMBERS row: main’s numbering, and the order is not read again', async () => {
    expect(await titles()).toEqual(['محاولة 1 من 5', 'محاولة 2 من 5']);
    expect(factReads).toBe(0);
  });
});
