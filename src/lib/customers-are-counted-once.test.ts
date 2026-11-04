import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * THE HARVEST ALARM COUNTED ONE DOOR OUT OF SIXTEEN.
 *
 * `pii-access.ts` exists to catch the quiet path out of the customer
 * table: somebody entitled to read customers reading all of them. It was
 * wired to the customer list and the customer profile, and to nothing
 * else — while `GET /api/orders` hands out the same name, phone, city and
 * address, up to five hundred rows in one request, plus what the person
 * bought. So did the labels list, its CSV, the returns desk, the tracking
 * screen, the shipment list, the four confirmation queues, the blacklist,
 * the change requests, the WhatsApp inbox and a shipping batch.
 *
 * AND THE KEY WAS THE SCREEN'S, NOT THE PERSON'S — `customers:<id>`. Even
 * had every list been wired that way, four hundred and ninety-nine from
 * one and four hundred and ninety-nine from another would cross nothing.
 *
 * Two things are checked here. First, that no route hands out contact
 * details without adding them to the tally — read off the filesystem, so
 * the seventeenth door cannot be forgotten. Second, that the tally is one
 * person's, across screens, and announces exactly once.
 */

const root = process.cwd();

/** A `phone`, `rawPhone` or `address` asked for by name in a Prisma select. */
const CONTACT = /\b(phone|rawPhone|altPhone|address)\s*:\s*true/;

/**
 * HANDS OUT CONTACT DETAILS AND DOES NOT COUNT THEM — each with why.
 *
 * Being on this list is a statement somebody made, not a check somebody
 * skipped. Every entry must name a real file and give a reason.
 */
const NOT_THE_CUSTOMER_TABLE: [string, string][] = [
  ['src/app/api/users/route.ts', 'staff phone numbers — colleagues, not the customer asset this counter protects'],
  ['src/app/api/users/[id]/profile/route.ts', 'one colleague reading or editing their own profile'],
  ['src/app/api/delivery-providers/route.ts', 'the courier company’s own contact details, which are on their invoices'],
  ['src/app/api/delivery-providers/[id]/route.ts', 'the courier company’s own contact details, one provider at a time'],
  ['src/app/api/orders/import/migrate/route.ts', 'reads the phones of existing orders only to match the upload; the answer is file, line and reason — no contact detail leaves'],
  ['src/app/api/orders/import/route.ts', 'reads existing customers to match duplicates while importing; nothing is handed to a screen'],
  ['src/app/api/ai/confirmation/route.ts', 'one order’s context for the assistant — egress to a model provider, a different question from harvesting'],
  ['src/app/api/orders/[id]/confirmation/route.ts', 'a tab of an order whose detail route already counted that customer'],
  ['src/app/api/orders/[id]/change-requests/route.ts', 'a tab of an order whose detail route already counted that customer'],
  ['src/app/api/orders/[id]/shipping/route.ts', 'a tab of an order whose detail route already counted that customer'],
  ['src/app/api/whatsapp/conversations/[id]/route.ts', 'one thread, reached from the inbox list, which is counted'],
  ['src/app/api/confirmation/whatsapp-template/route.ts', 'reads the phone of the one order she holds only to send the company template to it; the answer is ok and logged — no contact detail leaves to the screen'],
  ['src/app/api/call-helper/reading/route.ts', 'reads the phone of the one order she holds only to compare it with the number her paired phone dialled; the answer is ok or a refusal — no contact detail leaves, and none is stored'],
];

/**
 * …AND ONE CALL DEEP, BECAUSE THAT IS WHERE SOME SELECTS LIVE.
 *
 * A first version of this sweep read each route's own text and passed a
 * mutation that stripped the label printer's tally — because the printer
 * asks `loadWaybillOrders` from `@/lib/waybill` for its orders, and the
 * `address: true` is in there. A sweep that cannot see the biggest file
 * of addresses in the product is not a sweep.
 *
 * Only the named export the route actually imports, and only if ITS body
 * selects contact details: «the module contains one somewhere» would drag
 * in every route that imports anything from a busy file.
 */
const DECL = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let)\s+(\w+)\s*=/g;

function handsOutContact(src: string): boolean {
  if (CONTACT.test(src)) return true;

  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(@\/lib\/[^']+)'/g)) {
    const candidate = join(root, 'src/lib', m[2].slice('@/lib/'.length) + '.ts');
    if (!existsSync(candidate)) continue;
    const target = readFileSync(candidate, 'utf8');
    const decls = [...target.matchAll(DECL)];

    const bodies = new Map<string, string>();
    for (let i = 0; i < decls.length; i++) {
      bodies.set(
        decls[i][1] ?? decls[i][2],
        target.slice(decls[i].index!, decls[i + 1]?.index ?? target.length)
      );
    }
    /*
     * The select is usually a const of its own — `WAYBILL_SELECT` sits
     * above `loadWaybillOrders` and is passed into it. So a function also
     * hands out contact details when it names one that does.
     */
    const selects = [...bodies].filter(([, body]) => CONTACT.test(body)).map(([n]) => n);

    for (const raw of m[1].split(',')) {
      const name = raw.split(' as ').pop()!.trim();
      const body = bodies.get(name);
      if (!body) continue;
      if (CONTACT.test(body)) return true;
      if (selects.some((s) => s !== name && new RegExp(`\\b${s}\\b`).test(body))) return true;
    }
  }
  return false;
}

function routeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('route.ts')) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(join(root, 'src', 'app', 'api'));
  return out;
}

describe('no contact details leave without being counted', () => {
  const handing: string[] = [];
  const uncounted: string[] = [];

  for (const file of routeFiles()) {
    const src = readFileSync(join(root, file), 'utf8');
    if (!handsOutContact(src)) continue;
    handing.push(file);
    if (src.includes('noteCustomersHandedOut(')) continue;
    if (NOT_THE_CUSTOMER_TABLE.some(([f]) => f === file)) continue;
    uncounted.push(file);
  }

  it('found the routes that hand them out — a sweep over nothing proves nothing', () => {
    expect(handing.length).toBeGreaterThan(20);
    expect(handing).toContain('src/app/api/orders/route.ts');
    expect(handing).toContain('src/app/api/ops/labels/route.ts');
  });

  it('and every one of them adds to the tally', () => {
    expect(
      uncounted,
      `مساراتٌ تُسلّم هاتفاً أو عنواناً ولا تُحصيه:\n${uncounted.join('\n')}`
    ).toEqual([]);
  });

  it('and what is exempt says why, and still exists', () => {
    for (const [file, why] of NOT_THE_CUSTOMER_TABLE) {
      expect(why.length, `${file}: بلا سبب`).toBeGreaterThan(30);
      expect(handing, `${file}: لم يعد يُسلّم شيئاً`).toContain(file);
    }
  });
});

/**
 * AND THE TALLY ITSELF, EXERCISED.
 */
const { logAudit, createNotification } = vi.hoisted(() => ({
  logAudit: vi.fn(),
  createNotification: vi.fn(),
}));
vi.mock('./audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('./notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));

const { distinctCustomers, noteCustomersHandedOut } = await import('./pii-alert');
const { forgetCustomerAccess, BULK_VIEW_RECORDS } = await import('./pii-access');

const reader = { id: 'u1', name: 'سارة', email: 's@x.com' } as never;

const hand = (where: string, count: number, from = 0) =>
  noteCustomersHandedOut({
    companyId: 'c1',
    storeId: 's1',
    user: reader,
    where,
    rows: Array.from({ length: count }, (_, i) => ({ customerId: `cust-${from + i}` })),
  });

beforeEach(() => {
  vi.clearAllMocks();
  forgetCustomerAccess();
});

describe('people, not rows', () => {
  it('counts one customer once however many of their orders are on the page', () => {
    const oneCustomer = Array.from({ length: 20 }, () => ({ customer: { id: 'c-7', phone: '0790000000' } }));
    expect(distinctCustomers(oneCustomer)).toBe(1);
  });

  it('falls back to the phone when the list did not select an id', () => {
    expect(distinctCustomers([{ customer: { phone: 'a' } }, { customer: { phone: 'b' } }, { customer: { phone: 'a' } }])).toBe(2);
  });

  it('and a row that identifies nobody still counts as somebody', () => {
    expect(distinctCustomers([{}, {}, {}])).toBe(3);
  });
});

describe('one tally per person, across screens', () => {
  it('adds up what two different lists handed the same reader', async () => {
    const half = Math.ceil(BULK_VIEW_RECORDS / 2);
    await hand('قائمة العملاء', half, 0);
    expect(logAudit, 'رُفعت الراية قبل بلوغ الحدّ').not.toHaveBeenCalled();

    await hand('قائمة الطلبات', half, half);
    expect(logAudit, 'شاشتان لا تتجمّعان — الحدُّ يُلتفّ عليه بفتح شاشة أخرى').toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('and raises the hand once, not on every request after it', async () => {
    await hand('قائمة الطلبات', BULK_VIEW_RECORDS);
    await hand('قائمة الطلبات', BULK_VIEW_RECORDS);
    await hand('شاشة التتبّع', BULK_VIEW_RECORDS);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it('and says nothing at all about ordinary work', async () => {
    for (let i = 0; i < 4; i++) await hand('قائمة الطلبات', 25, i * 25);
    expect(logAudit).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('and an empty page is not a reading of anybody', async () => {
    await hand('قائمة الطلبات', 0);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
