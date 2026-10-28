import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «بيانات الطلب» SAVES AGAIN — AND ITS LINES WAIT FOR A CONTACT ATTEMPT.
 *
 * Since 8a490c06 (21/10) every press of «حفظ» on the lines card answered
 * «حدث خطأ داخلي. أعد المحاولة، وإن تكرّر أبلغ مدير النظام» — for the agent,
 * the supervisor and the owner alike. The gift that commit carries over was
 * read from `existing.items`, and `existing` is the row `assertOrderAccess`
 * loads: the order's own columns and no relations. So `existing.items` was
 * undefined, `.map` threw inside the transaction, and the save rolled back.
 *
 * NOTHING CAUGHT IT, because no test ever saved a set of lines through this
 * door. The two that send `items` stop before the lines are written — one
 * at the schema, one at a crash it reads as a pass — and the rest hand the
 * route an order they built themselves, with the access check mocked away.
 *
 * So here the access check is the REAL one, reading a bare row from a fake
 * that refuses to pretend it holds a relation; the permission engine is the
 * real one, over grants attached the way a session attaches them; and
 * `computeCod`, `needsContactFirst` and `apiError` are the real ones. The
 * body is exactly what `OrderLinesCard` sends: every line on the screen,
 * the LINE total as the characters in its box, the discount, the note.
 *
 * AND THE SECOND HALF. The contact-first rule counted the single fields and
 * not `items`, so a PATCH carrying only the lines replaced them before the
 * holder had tried to reach the customer. The crash in the lines write was
 * all that stood in the way; mending the crash alone would have opened it.
 * ═══════════════════════════════════════════════════════════════════════
 */

// A row as Prisma hands it over; the fake reads and writes its columns by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface Call {
  /** `db` outside the transaction, `tx` inside it. */
  client: 'db' | 'tx';
  model: string;
  method: string;
  args: Row;
}

const { fake, requireContext, logAudit, notify } = vi.hoisted(() => {
  const fake = {
    order: {} as Row,
    lines: [] as Row[],
    products: [] as Row[],
    /** How many contact attempts the order carries — all the rule asks. */
    attempts: 0,
    activities: [] as Row[],
    /** Every call, named by the client it reached. */
    calls: [] as Call[],
    transactions: 0,
    db: null as unknown,
  };

  /** A `where` read the way Prisma reads it, for the few shapes this door sends. */
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
      if (want !== null && typeof want === 'object') {
        for (const op of Object.keys(want)) {
          if (op !== 'in' && op !== 'gt') throw new Error(`fake db: «${op}» on ${key} is not modelled`);
        }
        if ('in' in want && !(want.in as unknown[]).includes(row[key])) return false;
        if ('gt' in want && !(typeof row[key] === 'number' && row[key] > want.gt)) return false;
        return true;
      }
      return row[key] === want;
    });

  const pick = (row: Row, select?: Row): Row => {
    if (!select) return { ...row };
    for (const [key, on] of Object.entries(select)) {
      if (on !== true) throw new Error(`fake db: a nested select on ${key} is not modelled`);
    }
    return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
  };

  type Answer = (args: Row) => unknown;

  const answers = (who: 'db' | 'tx'): Record<string, Record<string, Answer>> => ({
    order: {
      findUnique: (args) => {
        // The access check asks for the bare row and nothing else. A fake that
        // answered an include would hand the route exactly the relation the
        // real one never had.
        if (args.include || args.select) {
          throw new Error(`fake db: ${who}.order.findUnique asked for relations — only the bare row is held`);
        }
        return args.where?.id === fake.order.id ? { ...fake.order } : null;
      },
      updateMany: ({ where, data }) => {
        if (where.id !== fake.order.id || where.version !== fake.order.version) return { count: 0 };
        const { version, ...columns } = data;
        if (version?.increment !== 1) throw new Error('fake db: an order write that does not move the version');
        Object.assign(fake.order, columns, { version: fake.order.version + 1 });
        return { count: 1 };
      },
    },
    orderItem: {
      findFirst: ({ where, select }) => {
        const hit = fake.lines.find((l) => matches(l, where));
        return hit ? pick(hit, select) : null;
      },
      findMany: ({ where, select }) => fake.lines.filter((l) => matches(l, where)).map((l) => pick(l, select)),
      deleteMany: ({ where }) => {
        const kept = fake.lines.filter((l) => !matches(l, where));
        const count = fake.lines.length - kept.length;
        fake.lines = kept;
        return { count };
      },
      createMany: ({ data }) => {
        for (const row of data as Row[]) {
          fake.lines.push({ id: `line-new-${fake.lines.length + 1}`, reservedQty: 0, deliveredQty: null, returnedQty: null, ...row });
        }
        return { count: (data as Row[]).length };
      },
    },
    product: {
      findMany: ({ where, select }) => fake.products.filter((p) => matches(p, where)).map((p) => pick(p, select)),
    },
    // No upsell was accepted on this order. The route reads them so a line
    // edit cannot drop one from what is collected.
    orderAddOn: {
      findMany: ({ where }) => {
        if (where.orderId !== fake.order.id) throw new Error('fake db: add-ons of another order');
        return [];
      },
    },
    // The order is in no shipping batch, so nothing on it is sealed.
    shippingBatch: { findFirst: () => null },
    orderContactAttempt: {
      count: ({ where }) => (where.orderId === fake.order.id ? fake.attempts : 0),
    },
    orderActivity: {
      create: ({ data }) => {
        fake.activities.push(data);
        return { id: `activity-${fake.activities.length}`, ...data };
      },
    },
  });

  /** A client that answers what it holds and names everything else it is asked. */
  const client = (name: 'db' | 'tx') => {
    const held: Row = {};
    const model = (key: string, methods: Record<string, Answer>) =>
      new Proxy(
        {},
        {
          get: (_t, method) => {
            if (typeof method === 'symbol' || method === 'then') return undefined;
            return async (args: Row = {}) => {
              fake.calls.push({ client: name, model: key, method, args });
              const answer = methods[method];
              if (!answer) throw new Error(`fake db: no answer for ${name}.${key}.${method}`);
              return answer(args);
            };
          },
        }
      );
    for (const [key, methods] of Object.entries(answers(name))) held[key] = model(key, methods);
    return new Proxy(held, {
      get: (target, key) => {
        if (typeof key === 'symbol' || key === 'then') return undefined;
        if (key in target) return target[key];
        if (key.startsWith('$')) {
          return () => {
            throw new Error(`fake db: ${name}.${key} is not modelled`);
          };
        }
        return model(key, {});
      },
    });
  };

  const db = client('db');
  const tx = client('tx');
  /*
   * One interactive transaction, and what the database does when it throws:
   * nothing written inside it survives. Without this a crash half-way would
   * leave the fake holding a write the real save never kept.
   */
  (db as Row).$transaction = async (fn: (t: unknown) => Promise<unknown>) => {
    fake.transactions += 1;
    const before = {
      order: { ...fake.order },
      lines: fake.lines.map((l) => ({ ...l })),
      activities: [...fake.activities],
    };
    try {
      return await fn(tx);
    } catch (e) {
      fake.order = before.order;
      fake.lines = before.lines;
      fake.activities = before.activities;
      throw e;
    }
  };
  fake.db = db;

  return { fake, requireContext: vi.fn(), logAudit: vi.fn(), notify: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db: fake.db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
// `authorization.ts` imports this one name; the engine itself is the real one.
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { PATCH } from './route';
import { CONTACT_FIRST_MESSAGE } from '@/lib/confirmation-queue';

const COMPANY = 'company-0001';
const STORE = 'store-0001';
const ORDER_ID = 'id-ord-2026-0044';
const CREAM = 'prod-cream-01';
const SOAP = 'prod-soap-02';
const DROPS = 'prod-drops-03';

/** A session user whose grants are attached the way `getCurrentUser` attaches them. */
const person = (id: string, name: string, role: string, scope: 'ASSIGNED' | 'ALL_COMPANY') => ({
  id,
  name,
  role,
  email: `${id}@osm.local`,
  status: 'ACTIVE',
  companyId: COMPANY,
  permissions: [] as string[],
  effectiveGrants: { fullAccess: false, grants: { 'orders.view': { scope }, 'orders.edit': { scope } } },
});
/** Works the orders the queue handed her. */
const AGENT = person('agent-reem-01', 'ريم', 'CONFIRMATION_AGENT', 'ASSIGNED');
/** Reaches every order in the company, and holds none of them. */
const SUPERVISOR = person('super-samer-02', 'سامر', 'CONFIRMATION_SUPERVISOR', 'ALL_COMPANY');

/**
 * ORD-2026-0044 AS THE ACCESS CHECK HANDS IT OVER: its own columns, and NO
 * `items` key — that absence is the whole bug. Held by the agent, still
 * being worked, nothing printed, nothing shipped, no lock on it.
 */
const storedOrder = (): Row => ({
  id: ORDER_ID,
  orderNumber: 'ORD-2026-0044',
  companyId: COMPANY,
  storeId: STORE,
  countryId: 'country-jo',
  customerId: 'customer-0044',
  productId: CREAM,
  productNameSnapshot: 'كريم',
  // 3 + 2 pieces paid for, 1 + 2 given, 36 + 10 = 46.000, and 2.500 to deliver.
  quantity: 5,
  freeQuantity: 3,
  sellingPrice: 46,
  discountAmount: 0,
  shippingCost: 2.5,
  deliveryFee: null,
  totalAmount: 48.5,
  priceIncludesDelivery: false,
  version: 7,
  status: 'CONTACTING',
  confirmationStatus: 'IN_PROGRESS',
  shippingStatus: 'NOT_READY',
  settlementStatus: 'PENDING_COLLECTION',
  signatureStatus: 'UNSIGNED',
  shippedAt: null,
  labelPrintedAt: null,
  deliveredAt: null,
  confirmedAt: null,
  moderatorId: null,
  createdById: null,
  assignedToId: null,
  claimedById: AGENT.id,
  currentOwnerId: AGENT.id,
  lockedById: null,
  lockExpiresAt: null,
  deliveryProviderId: null,
  regionId: null,
  customerNotes: null,
  internalNotes: null,
});

const line = (over: Row): Row => ({
  companyId: COMPANY,
  orderId: ORDER_ID,
  discountShare: 0,
  reservedQty: 0,
  deliveredQty: null,
  returnedQty: null,
  addedById: null,
  addedStage: 'INTAKE',
  ...over,
});

/** Two lines, each with a gift of its own: كريم one, صابون two. */
const storedLines = (): Row[] => [
  line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 12, lineTotal: 36 }),
  line({ id: 'line-soap-02', productId: SOAP, productName: 'صابون', quantity: 2, freeQuantity: 2, unitPrice: 5, lineTotal: 10 }),
];

const PRODUCTS: Row[] = [
  { id: CREAM, companyId: COMPANY, name: 'كريم' },
  { id: SOAP, companyId: COMPANY, name: 'صابون' },
  { id: DROPS, companyId: COMPANY, name: 'قطرة' },
];

/**
 * EXACTLY WHAT THE CARD SENDS (`OrderLinesCard.tsx`, `save()`): every line
 * on the screen with the characters of its LINE-total box, the discount as
 * a number, and the note — empty here, so null. صابون is not on it: the
 * person took it off and put قطرة on.
 */
const CARD_BODY = {
  items: [
    { productId: CREAM, quantity: 5, unitPrice: '60' },
    { productId: DROPS, quantity: 1, unitPrice: '8.5' },
  ],
  discountAmount: 6.8,
  customerNotes: null,
};
const LINES_ONLY = { items: CARD_BODY.items };

const as = (user: Row) =>
  requireContext.mockResolvedValue({
    user,
    companyId: COMPANY,
    storeId: STORE,
    countryId: 'country-jo',
    // JOD: three decimals, which is why 5.956 below is a figure and not a rounding accident.
    country: { id: 'country-jo', code: 'JO', currencyCode: 'JOD', minorUnit: 3, allowNegativeStock: false },
  });

const save = async (body: Row) => {
  const res = await PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 7, ...body }),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );
  return { status: res.status, body: (await res.json()) as Row };
};

const lineOf = (productId: string) => fake.lines.find((l) => l.productId === productId);
const WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
const writes = () => fake.calls.filter((c) => WRITES.has(c.method)).map((c) => `${c.client}.${c.model}.${c.method}`);

/** What `apiError` logged on the way to a 500 — the failure message carries it. */
let logged: string[] = [];
let restoreConsole = () => {};
const why = (body: unknown) => [JSON.stringify(body), ...logged].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  fake.order = storedOrder();
  fake.lines = storedLines();
  fake.products = PRODUCTS.map((p) => ({ ...p }));
  fake.attempts = 0;
  fake.activities = [];
  fake.calls = [];
  fake.transactions = 0;
  logAudit.mockResolvedValue(undefined);
  notify.mockResolvedValue(undefined);
  logged = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(
      args.map((a) => (a instanceof Error ? (a.stack ?? String(a)).split('\n').slice(0, 3).join(' | ') : String(a))).join(' ')
    );
  });
  restoreConsole = () => spy.mockRestore();
});

afterEach(() => restoreConsole());

describe('Ⅰ · the card saves again', () => {
  beforeEach(() => {
    // She has called: one attempt on the order, so the rule of Ⅱ is not what is tested here.
    fake.attempts = 1;
    as(AGENT);
  });

  it('answers 200 where it answered «حدث خطأ داخلي»', async () => {
    const res = await save(CARD_BODY);
    expect(res.status, why(res.body)).toBe(200);
    expect(res.body.success).toBe(true);
    // And the save took: the version moved once.
    expect(fake.order.version).toBe(8);
  });

  it('and replaces the lines in the one transaction — reading them before it deletes them', async () => {
    const res = await save(CARD_BODY);
    expect(res.status, why(res.body)).toBe(200);
    expect(fake.transactions, 'لا معاملة، أو أكتر من وحدة').toBe(1);
    // The committed-goods check runs before the transaction and is not part of the replacement.
    const replacing = fake.calls.filter((c) => c.model === 'orderItem' && !(c.client === 'db' && c.method === 'findFirst'));
    expect(
      replacing.map((c) => `${c.client}.${c.method}`),
      'الأسطر ما انقرت قبل ما تنمسح، أو انقرت برّا المعاملة'
    ).toEqual(['tx.findMany', 'tx.deleteMany', 'tx.createMany']);
    expect(replacing[0].args.where.orderId, 'قرا أسطر طلب تاني').toBe(ORDER_ID);
  });

  it('and كريم keeps the gift of ITS line — one; not the order’s three, not صابون’s two', async () => {
    const res = await save(CARD_BODY);
    expect(res.status, why(res.body)).toBe(200);
    /*
     * The row this save wrote, not the stored one. A save that rolled back
     * leaves the old كريم line standing with its gift of one, and the claim
     * below would pass over a door that saved nothing — it did, on the first
     * run of this file against the unmended route.
     */
    expect(lineOf(CREAM)?.addedStage, 'سطر كريم مش السطر الجديد').toBe('EDIT');
    expect(lineOf(CREAM)?.freeQuantity, 'هديّة كريم ما رجعت من سطره').toBe(1);
  });

  it('and قطرة, new on the order, starts with no gift', async () => {
    // This door binds no offer, so a gift for a product the order never had would be invented.
    const res = await save(CARD_BODY);
    expect(res.status, why(res.body)).toBe(200);
    expect(lineOf(DROPS)?.freeQuantity, 'قطرة أخدت هديّة ما إلها').toBe(0);
  });

  it('and صابون, taken off, is gone — and its gift with it', async () => {
    const res = await save(CARD_BODY);
    expect(res.status, why(res.body)).toBe(200);
    expect(fake.lines.map((l) => l.productId)).toEqual([CREAM, DROPS]);
    expect(lineOf(SOAP), 'صابون لسّا على الطلب').toBeUndefined();
  });

  it('and the money is the figure worked by hand — on the order and on both lines', async () => {
    /*
     * The card sends LINE totals: كريم five pieces for 60.000, قطرة one for 8.500.
     *
     *   per piece      60 ÷ 5 = 12.000             8.5 ÷ 1 = 8.500
     *   subtotal       60 + 8.5 = 68.500
     *   discount       6.800, shared by value:
     *                    60 ÷ 68.5 × 6.8 = 5.9562…  → 5.956
     *                    8.5 ÷ 68.5 × 6.8 = 0.8437… → 0.844
     *                  5.956 + 0.844 = 6.800, nothing left over
     *   line totals    60 − 5.956 = 54.044         8.5 − 0.844 = 7.656
     *   delivery       2.500 on top — this order's prices do not include it
     *   to collect     68.5 − 6.8 + 2.5 = 64.200
     *   pieces paid    5 + 1 = 6 (a gift is never part of the money)
     */
    const res = await save(CARD_BODY);
    expect(res.status, why(res.body)).toBe(200);
    const o = fake.order;
    expect({
      sellingPrice: o.sellingPrice,
      quantity: o.quantity,
      discountAmount: o.discountAmount,
      shippingCost: o.shippingCost,
      totalAmount: o.totalAmount,
      productId: o.productId,
      productNameSnapshot: o.productNameSnapshot,
    }).toEqual({
      sellingPrice: 68.5,
      quantity: 6,
      discountAmount: 6.8,
      shippingCost: 2.5,
      totalAmount: 64.2,
      productId: CREAM,
      productNameSnapshot: 'كريم',
    });
    expect(lineOf(CREAM)).toMatchObject({
      quantity: 5, unitPrice: 12, discountShare: 5.956, lineTotal: 54.044,
      companyId: COMPANY, orderId: ORDER_ID, productName: 'كريم', addedById: AGENT.id, addedStage: 'EDIT',
    });
    expect(lineOf(DROPS)).toMatchObject({
      quantity: 1, unitPrice: 8.5, discountShare: 0.844, lineTotal: 7.656,
      companyId: COMPANY, orderId: ORDER_ID, productName: 'قطرة', addedById: AGENT.id, addedStage: 'EDIT',
    });
  });
});

describe('Ⅱ · the lines wait for a contact attempt, like every other field', () => {
  it('the holder, before any attempt, sending only the lines: 409 CONTACT_FIRST naming them — and nothing written', async () => {
    as(AGENT);
    fake.attempts = 0;
    const res = await save(LINES_ONLY);
    expect(res.status, why(res.body)).toBe(409);
    expect(res.body).toEqual({ errorAr: CONTACT_FIRST_MESSAGE, code: 'CONTACT_FIRST', fields: ['items'] });
    expect(writes(), 'انكتب إشي قبل أي محاولة اتصال').toEqual([]);
    expect(fake.transactions).toBe(0);
    expect(fake.lines).toEqual(storedLines());
    expect(fake.order).toEqual(storedOrder());
  });

  it('and the card’s own body is refused the same way, with the lines among the fields it names', async () => {
    as(AGENT);
    fake.attempts = 0;
    const res = await save(CARD_BODY);
    expect(res.status, why(res.body)).toBe(409);
    expect(res.body.code).toBe('CONTACT_FIRST');
    expect([...(res.body.fields as string[])].sort()).toEqual(['customerNotes', 'discountAmount', 'items']);
    expect(writes()).toEqual([]);
    expect(fake.transactions).toBe(0);
  });

  it('and one attempt opens it — the same lines-only save goes through', async () => {
    as(AGENT);
    fake.attempts = 1;
    const res = await save(LINES_ONLY);
    expect(res.status, why(res.body)).toBe(200);
    expect(fake.lines.map((l) => l.productId)).toEqual([CREAM, DROPS]);
    // No discount sent, so the order's own (none) carries on: 60 + 8.5 + 2.5 delivery = 71.000.
    expect(fake.order.totalAmount).toBe(71);
  });

  it('and it binds the holder only — a supervisor correcting the order is not asked to call, and nothing is counted', async () => {
    as(SUPERVISOR);
    fake.attempts = 0;
    // Company-wide authority says why (`order-edit-reason.ts`), the same as the card's second send.
    const res = await save({ ...LINES_ONLY, reason: 'الزبونة بدّلت الصابون بقطرة' });
    expect(res.status, why(res.body)).toBe(200);
    expect(
      fake.calls.filter((c) => c.model === 'orderContactAttempt'),
      'انعدّت محاولات الاتصال لحدا مش حامل الطلب'
    ).toEqual([]);
    expect(fake.lines.map((l) => l.productId)).toEqual([CREAM, DROPS]);
  });
});
