import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from './guard-source';

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: () => true,
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));

import { GET as lossReport } from '@/app/api/analytics/loss/route';
import { customerRisk } from './customer-risk';
import {
  ACTIVITY_ROLE,
  SUPERSEDING_ACTIONS,
  endsTheSale,
  isSuperseded,
  notSuperseded,
  supersededWhere,
  type ActivityLike,
} from './superseded';

/**
 * ONE SALE, TWO ORDERS — WHICH ONE IS THE SALE?
 *
 * A replaced order is read as superseded when it was replaced AND the reason
 * is one of three. NEVER the link alone: the win-back writes the same link on
 * a LOSS, and that loss has to keep counting.
 *
 * The database spelling (`supersededWhere`) and the in-memory one
 * (`isSuperseded`) are run against the same orders by a small evaluator that
 * reads a Prisma `where` the way SQL does — including NULL, where
 * `NOT (x LIKE …)` is not true. Without that, a `NOT` on a missing
 * metadata would have passed here and dropped the row in Postgres.
 */

/* ───────────────────────── a small SQL-faithful evaluator ───────────────────────── */

type Tri = boolean | null;
const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const not = (x: Tri): Tri => (x === null ? null : !x);
const OPS = new Set(['not', 'in', 'gte', 'lte', 'gt', 'lt', 'contains', 'isNot', 'is', 'some', 'equals']);
const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
const num = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function test(row: Row, where: Row | undefined): Tri {
  if (!where) return true;
  return and(
    Object.entries(where).map(([k, v]): Tri => {
      if (k === 'AND') return and(([] as Row[]).concat(v).map((w) => test(row, w)));
      if (k === 'OR') return or((v as Row[]).map((w) => test(row, w)));
      if (k === 'NOT') return not(or(([] as Row[]).concat(v).map((w) => test(row, w))));
      return field(row[k], v);
    })
  );
}

function field(val: unknown, cond: unknown): Tri {
  if (cond === null) return val === null || val === undefined;
  if (cond === undefined) return true;
  if (typeof cond !== 'object' || cond instanceof Date) {
    return val === null || val === undefined ? null : same(val, cond);
  }
  const c = cond as Row;
  if (!Object.keys(c).every((k) => OPS.has(k))) {
    // A filter on a to-one relation: `customer: { phone }`.
    return val == null ? false : test(val as Row, c);
  }
  return and(
    Object.entries(c).map(([op, arg]): Tri => {
      switch (op) {
        case 'equals':
          return val == null ? null : same(val, arg);
        case 'not':
          return arg === null ? val != null : val == null ? null : !same(val, arg);
        case 'in':
          return val == null ? null : (arg as unknown[]).includes(val);
        case 'gte':
          return val == null ? null : num(val) >= num(arg);
        case 'lte':
          return val == null ? null : num(val) <= num(arg);
        case 'gt':
          return val == null ? null : num(val) > num(arg);
        case 'lt':
          return val == null ? null : num(val) < num(arg);
        case 'contains':
          return typeof val === 'string' ? val.includes(arg as string) : null;
        case 'isNot':
          return arg === null ? val != null : val == null ? true : not(test(val as Row, arg as Row));
        case 'is':
          return arg === null ? val == null : val == null ? false : test(val as Row, arg as Row);
        case 'some':
          return or(((val as Row[]) ?? []).map((x) => test(x, arg as Row)));
        default:
          return null;
      }
    })
  );
}

const matches = (row: Row, where: Row) => test(row, where) === true;

/* ───────────────────────── the orders ───────────────────────── */

const act = (action: string, meta: Row | null): ActivityLike => ({
  action,
  metadata: meta === null ? null : JSON.stringify(meta),
});

const TRANSFER_ORIGINAL = act('COURIER_TRANSFERRED', { mode: 'REPLACE', role: ACTIVITY_ROLE.original, from: 'أ', to: 'ب' });
const TRANSFER_REPLACEMENT = act('COURIER_TRANSFERRED', { mode: 'REPLACE', role: ACTIVITY_ROLE.replacement, from: 'أ', to: 'ب' });
const TRANSFER_DIRECT = act('COURIER_TRANSFERRED', { mode: 'DIRECT', role: undefined, from: 'أ', to: 'ب' });
const REORDER_ORIGINAL = act('CHANGE_REQUEST_REORDERED', { role: ACTIVITY_ROLE.original, requestId: 'r1' });
const REORDER_REPLACEMENT = act('CHANGE_REQUEST_REORDERED', { role: ACTIVITY_ROLE.replacement, requestId: 'r1' });
const SWAP = act('SWAP_RECORDED', { role: ACTIVITY_ROLE.original });
const SWAP_REPLACEMENT = act('SWAP_RECORDED', { role: ACTIVITY_ROLE.replacement });
// Rows written before the role existed: no role at all, or no metadata.
const TRANSFER_LEGACY = act('COURIER_TRANSFERRED', { mode: 'REPLACE', from: 'أ', to: 'ب' });
const REORDER_LEGACY = act('CHANGE_REQUEST_REORDERED', { requestId: 'r1' });
const REORDER_NO_METADATA = act('CHANGE_REQUEST_REORDERED', null);
const UNRELATED = act('STATUS_CHANGED', { to: 'X' });

const REPLACED = { id: 'replacement-1' };

const CASES: { name: string; order: Row; superseded: boolean }[] = [
  { name: 'taken back from a company (REPLACE)', order: { replacedBy: REPLACED, activities: [TRANSFER_ORIGINAL] }, superseded: true },
  { name: 'cancelled at the courier for a change to the goods', order: { replacedBy: REPLACED, activities: [REORDER_ORIGINAL] }, superseded: true },
  { name: 'a swap recorded on the statement', order: { replacedBy: REPLACED, activities: [SWAP] }, superseded: true },
  { name: 'a REPLACE written before the role existed', order: { replacedBy: REPLACED, activities: [TRANSFER_LEGACY] }, superseded: true },
  { name: 'a reorder written before the role existed', order: { replacedBy: REPLACED, activities: [REORDER_LEGACY] }, superseded: true },
  { name: 'a reorder whose activity has no metadata at all', order: { replacedBy: REPLACED, activities: [REORDER_NO_METADATA] }, superseded: true },
  { name: 'one reason among other history', order: { replacedBy: REPLACED, activities: [UNRELATED, REORDER_ORIGINAL] }, superseded: true },

  // THE WIN-BACK: the link, and no reason.
  { name: 'a LOSS won back (the link alone)', order: { replacedBy: REPLACED, activities: [] }, superseded: false },
  { name: 'a loss won back, with unrelated history', order: { replacedBy: REPLACED, activities: [UNRELATED] }, superseded: false },
  { name: 'a parcel moved between agents, later won back', order: { replacedBy: REPLACED, activities: [TRANSFER_DIRECT] }, superseded: false },
  { name: 'a REPLACEMENT that was itself won back', order: { replacedBy: REPLACED, activities: [TRANSFER_REPLACEMENT] }, superseded: false },
  { name: 'a reorder replacement that was itself won back', order: { replacedBy: REPLACED, activities: [REORDER_REPLACEMENT] }, superseded: false },
  { name: 'a swap replacement that was itself won back', order: { replacedBy: REPLACED, activities: [SWAP_REPLACEMENT] }, superseded: false },

  // THE REASON WITHOUT THE LINK.
  { name: 'the reason but no replacement', order: { replacedBy: null, activities: [TRANSFER_ORIGINAL] }, superseded: false },
  { name: 'a reorder reason but no replacement', order: { replacedBy: null, activities: [REORDER_ORIGINAL] }, superseded: false },
  { name: 'a swap reason but no replacement', order: { replacedBy: null, activities: [SWAP] }, superseded: false },
  { name: 'an ordinary order', order: { replacedBy: null, activities: [] }, superseded: false },
];

describe('1 · superseded means replaced AND one of three reasons', () => {
  it.each(CASES)('$name → $superseded', ({ order, superseded }) => {
    expect(isSuperseded(order)).toBe(superseded);
  });

  it('names exactly the three reasons', () => {
    expect([...SUPERSEDING_ACTIONS]).toEqual(['COURIER_TRANSFERRED', 'CHANGE_REQUEST_REORDERED', 'SWAP_RECORDED']);
  });

  it('a transfer is a replacement only when the parcel was taken back', () => {
    expect(endsTheSale(TRANSFER_ORIGINAL)).toBe(true);
    expect(endsTheSale(TRANSFER_DIRECT)).toBe(false);
  });

  it('the replacement’s own copy of the word is never a reason', () => {
    expect(endsTheSale(TRANSFER_REPLACEMENT)).toBe(false);
    expect(endsTheSale(REORDER_REPLACEMENT)).toBe(false);
    expect(endsTheSale(SWAP_REPLACEMENT)).toBe(false);
  });
});

describe('2 · the database’s spelling says what the in-memory one says', () => {
  it.each(CASES)('$name', ({ order, superseded }) => {
    expect(matches(order, supersededWhere as Row)).toBe(superseded);
    expect(matches(order, notSuperseded as Row)).toBe(!superseded);
  });

  it('and a won-back loss is IN the set a report reads, not out of it', () => {
    const wonBack = { replacedBy: REPLACED, activities: [] };
    expect(matches(wonBack, notSuperseded as Row)).toBe(true);
  });
});

/* ───────────────────────── readers, run against the fake ───────────────────────── */

const NOW = new Date('2026-10-28T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

/** One order as the risk query reads it. */
const riskRow = (o: Row) => ({
  companyId: 'c1',
  customer: { phone: '0790000000' },
  createdAt: daysAgo(10),
  returnedAt: null,
  replacedBy: null,
  activities: [] as ActivityLike[],
  ...o,
});

function riskTx(rows: Row[]) {
  return {
    customer: { findFirst: vi.fn(async () => ({ phone: '0790000000' })) },
    order: {
      findMany: vi.fn(async (args: { where: Row; take?: number }) => {
        const hit = rows.filter((r) => matches(r, args.where));
        return args.take ? hit.slice(0, args.take) : hit;
      }),
    },
  };
}

describe('3 · the risk score does not blame the customer for our re-routing', () => {
  // Six of ten orders "returned" is HIGH. Here five were REPLACED — taken
  // back from a company or reordered — and each has a delivered replacement.
  const replaced = (activities: ActivityLike[]) =>
    riskRow({ shippingStatus: 'RETURN_REQUESTED', returnedAt: daysAgo(5), replacedBy: REPLACED, activities });
  const delivered = () => riskRow({ shippingStatus: 'DELIVERED' });

  it('a customer whose parcels were only moved is SAFE', async () => {
    const rows = [
      replaced([TRANSFER_ORIGINAL]),
      replaced([REORDER_ORIGINAL]),
      replaced([TRANSFER_LEGACY]),
      replaced([SWAP]),
      replaced([REORDER_ORIGINAL]),
      ...Array.from({ length: 5 }, delivered),
    ];
    const r = await customerRisk(riskTx(rows) as never, 'c1', 'cust1', NOW);
    expect(r.returns).toBe(0);
    expect(r.orders).toBe(5);
    expect(r.tier).toBe('SAFE');
    expect(r.requiresPrepaymentOrApproval).toBe(false);
  });

  it('a replacement that is itself refused still counts against him', async () => {
    const rows = [
      replaced([REORDER_ORIGINAL]),
      riskRow({ shippingStatus: 'RETURNED', returnedAt: daysAgo(3), replacedBy: null, activities: [REORDER_REPLACEMENT] }),
      delivered(),
      delivered(),
    ];
    const r = await customerRisk(riskTx(rows) as never, 'c1', 'cust1', NOW);
    expect(r.orders).toBe(3);
    expect(r.returns).toBe(1);
  });

  it('and a refusal won back by the win-back keeps counting', async () => {
    // Shipped, refused, then offered again at a discount: the link is there,
    // the reason is not. It is still a return of his.
    const rows = [
      riskRow({ shippingStatus: 'RETURNED', returnedAt: daysAgo(20), replacedBy: REPLACED, activities: [] }),
      riskRow({ shippingStatus: 'RETURNED', returnedAt: daysAgo(15), replacedBy: REPLACED, activities: [TRANSFER_DIRECT] }),
      delivered(),
    ];
    const r = await customerRisk(riskTx(rows) as never, 'c1', 'cust1', NOW);
    expect(r.returns).toBe(2);
    expect(r.orders).toBe(3);
  });
});

describe('4 · the loss report', () => {
  const lossRow = (o: Row) => ({
    companyId: 'c1',
    storeId: 's1',
    createdAt: NOW,
    rejectionReason: null,
    deliveryFailureReason: null,
    returnReason: null,
    deliveryFee: 2.5,
    productCost: null,
    estimatedCostOfGoods: 0,
    quantity: 1,
    regionId: null,
    deliveryProviderId: null,
    replacedBy: null,
    activities: [] as ActivityLike[],
    ...o,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    requireContext.mockResolvedValue({ user: {}, companyId: 'c1', storeId: 's1' });
    requirePermission.mockResolvedValue({});
    db.deliveryFee.findMany.mockResolvedValue([]);
  });

  async function report(rows: Row[]) {
    db.order.findMany.mockImplementation(async (a: { where: Row }) => rows.filter((r) => matches(r, a.where)));
    db.order.count.mockImplementation(async (a: { where: Row }) => rows.filter((r) => matches(r, a.where)).length);
    const res = await lossReport(new Request('http://localhost/api/analytics/loss?period=all'));
    expect(res.status).toBe(200);
    return res.json();
  }

  it('a reordered order is not "the customer’s decision"', async () => {
    // The reorder door writes CUSTOMER_REQUEST on the old order. The customer
    // asked for nothing: the sale went on in the replacement.
    const body = await report([
      lossRow({ returnReason: 'CUSTOMER_REQUEST', replacedBy: REPLACED, activities: [REORDER_ORIGINAL] }),
      lossRow({ returnReason: 'OTHER', replacedBy: REPLACED, activities: [TRANSFER_ORIGINAL] }),
    ]);
    expect(body.after.count).toBe(0);
    expect(body.total).toBe(0);
    const customer = body.after.byFault.find((f: { fault: string }) => f.fault === 'CUSTOMER');
    expect(customer).toBeUndefined();
  });

  it('a loss won back by the win-back is still a loss', async () => {
    const body = await report([
      // Lost before shipping, then offered again: the link, no reason.
      lossRow({ rejectionReason: 'PRICE_TOO_HIGH', replacedBy: REPLACED, activities: [] }),
      // Shipped, refused, then offered again.
      lossRow({ returnReason: 'CUSTOMER_REFUSED', replacedBy: REPLACED, activities: [TRANSFER_DIRECT] }),
    ]);
    expect(body.before.count).toBe(1);
    expect(body.after.count).toBe(1);
    expect(body.total).toBe(2);
  });

  it('a replacement that fails on its own is counted', async () => {
    const body = await report([
      lossRow({ returnReason: 'CUSTOMER_REFUSED', replacedBy: null, activities: [REORDER_REPLACEMENT] }),
      lossRow({ returnReason: 'CUSTOMER_REQUEST', replacedBy: REPLACED, activities: [REORDER_ORIGINAL] }),
    ]);
    expect(body.after.count).toBe(1);
    expect(body.total).toBe(1);
  });
});

/* ───────────────────────── every reader goes through the one definition ───────────────────────── */

describe('5 · nobody writes the question again in their own words', () => {
  /** The reports that count orders, returns or refusals — each reads the shared clause. */
  const READERS = [
    'src/lib/customer-risk.ts',
    'src/lib/intelligence.ts',
    'src/lib/analytics.ts',
    'src/lib/attribution-performance.ts',
    'src/lib/landing-analytics.ts',
    'src/app/api/analytics/loss/route.ts',
    'src/app/api/moderators/route.ts',
  ];

  it.each(READERS)('%s imports the shared clause and spreads it into a where', (file) => {
    const src = stripComments(repoFile(file));
    expect(src, `${file} لا يستورد notSuperseded`).toMatch(/import \{[^}]*\bnotSuperseded\b[^}]*\} from '(?:@\/lib|\.)\/superseded'/);
    expect(src, `${file} لا يستعمله`).toMatch(/\.\.\.notSuperseded\b|where: notSuperseded\b/);
  });

  it('customer-risk reads it in all three of its queries', () => {
    const src = stripComments(repoFile('src/lib/customer-risk.ts'));
    expect(src.match(/\.\.\.notSuperseded\b/g)).toHaveLength(3);
  });

  it('intelligence reads it in its four order-counting findings', () => {
    const src = stripComments(repoFile('src/lib/intelligence.ts'));
    expect(src.match(/\.\.\.notSuperseded\b/g)).toHaveLength(4);
  });

  it('analytics counts through it but keeps the money on the old filter', () => {
    const src = stripComments(repoFile('src/lib/analytics.ts'));
    expect(src).toMatch(/const countedWhere = \{ \.\.\.baseWhere, \.\.\.notSuperseded \}/);
    // The three money reads. If one of these moves to `countedWhere`, a
    // reading of history is moving a figure on the profit line.
    expect(src).toMatch(/const deliveredWhere = \{ \.\.\.baseWhere, \.\.\.whereDelivered\(\) \}/);
    expect(src).toMatch(/commissionByUserForOrders\(\{ \.\.\.baseWhere, shippingStatus: 'DELIVERED' \}\)/);
    expect(src).not.toMatch(/deliveredWhere = \{ \.\.\.countedWhere/);
  });

  /** Every production file that spells the link or the reasons itself. */
  it('no other file re-implements it', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, sep } = await import('node:path');
    const root = join(process.cwd(), 'src');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const text = stripComments(readFileSync(p, 'utf8'));
          const rel = p.slice(process.cwd().length + 1).split(sep).join('/');
          // The question: «was it replaced» asked as a filter, or the swap word.
          if (/replacedBy:\s*\{\s*(?:isNot|is)\b/.test(text) || /SWAP_RECORDED/.test(text)) found.push(rel);
        }
      }
    };
    walk(root);
    expect(found, `نسخةٌ محلّيةٌ من تعريف «استُبدل»:\n${found.join('\n')}`).toEqual(['src/lib/superseded.ts']);
  });

  /**
   * THE READERS THAT ARE LEFT ALONE ON PURPOSE — each with its reason, so the
   * next reader added has to decide rather than forget.
   */
  it('order-outcome and the media buyer’s feed are not filtered, and say why', () => {
    for (const file of ['src/lib/order-outcome.ts', 'src/lib/v1/attribution.ts']) {
      expect(stripComments(repoFile(file)), file).not.toMatch(/notSuperseded|isSuperseded/);
    }
  });
});

describe('5b · the win-back can never make a loss "superseded"', () => {
  it('writes the link and an activity of its own, and none of the three reasons', () => {
    const src = stripComments(repoFile('src/app/api/confirmation/winback/route.ts'));
    expect(src).toMatch(/replacesOrderId: order.id/);
    expect(src).toMatch(/action: 'WINBACK_OFFERED'/);
    for (const word of SUPERSEDING_ACTIONS) expect(src, word).not.toContain(word);
    expect(src).not.toMatch(/ACTIVITY_ROLE/);
  });

  it('and the guide still promises that the old order keeps counting as a loss', () => {
    expect(repoFile('src/lib/route-guide-texts.ts')).toContain('فتبقى الخسارة محسوبة');
  });
});

describe('6 · both doors that make a replacement say which side each copy is on', () => {
  it.each([
    'src/app/api/ops/tracking/transfer/route.ts',
    'src/app/api/orders/[id]/reorder/route.ts',
  ])('%s writes the role into the activity', (file) => {
    const src = stripComments(repoFile(file));
    expect(src).toMatch(/ACTIVITY_ROLE\.original/);
    expect(src).toMatch(/ACTIVITY_ROLE\.replacement/);
    expect(src).toMatch(/metadata: JSON\.stringify\(\{[^}]*\brole\b/);
  });
});
