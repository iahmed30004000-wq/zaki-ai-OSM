import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BULK_VIEW_RECORDS,
  BULK_VIEW_WINDOW_MS,
  noteCustomerAccess,
  type AccessWindow,
} from './pii-access';
import { CLAIM_CAPS } from './confirmation-queue';

/**
 * READING EVERY CUSTOMER USED TO LEAVE NO TRACE AT ALL.
 *
 * The permission, the store scope and the hundred-row cap all hold for
 * one request. None of them sees the same allowed person asking a hundred
 * times. These tests pin the one thing that does: the count, and the
 * single moment it is worth telling somebody about.
 */

let store: Map<string, AccessWindow>;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  store = new Map();
});

const note = (records: number, at = NOW, key = 'customers:u1') =>
  noteCustomerAccess(key, records, { store, now: at, threshold: 10, windowMs: 1000 });

describe('counting what a person was handed', () => {
  it('adds up across requests inside the window', () => {
    expect(note(4).records).toBe(4);
    expect(note(3, NOW + 100).records).toBe(7);
  });

  it('starts again once the window rolls over', () => {
    note(9);
    expect(note(1, NOW + 2000).records, 'حُسبت النافذةُ القديمة مع الجديدة').toBe(1);
  });

  it('keeps one tally per person', () => {
    note(9);
    expect(note(2, NOW, 'customers:u2').records).toBe(2);
  });

  it('ignores a read that returned nobody', () => {
    expect(note(0).records).toBe(0);
  });

  it('and cannot be talked downwards', () => {
    note(8);
    // A negative count would let a caller erase what it had already read.
    expect(note(-100).records).toBe(8);
  });
});

describe('the moment it stops looking like work', () => {
  it('says nothing below the threshold', () => {
    expect(note(9).crossed).toBe(false);
  });

  it('says it once, on the request that crosses', () => {
    expect(note(9).crossed).toBe(false);
    expect(note(1, NOW + 10).crossed, 'لم يُعلَن التجاوز').toBe(true);
  });

  it('and does not repeat for the rest of the window', () => {
    note(9);
    note(1, NOW + 10);
    // An alert that fires on every later request is an alert somebody
    // switches off, and then nobody hears the next one either.
    expect(note(100, NOW + 20).crossed).toBe(false);
    expect(note(100, NOW + 30).crossed).toBe(false);
  });

  it('but does speak again in a new window', () => {
    note(10);
    expect(note(10, NOW + 2000).crossed).toBe(true);
  });

  it('fires on a single oversized read too, not only on a slow climb', () => {
    expect(note(500).crossed).toBe(true);
  });
});

describe('the numbers it ships with', () => {
  it('are seven hundred customers in a quarter of an hour — more than a full desk', () => {
    expect(BULK_VIEW_RECORDS).toBe(700);
    expect(BULK_VIEW_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  /*
   * A FULL DESK MUST NEVER BE THE CROSSING (review of PR #217).
   *
   * One load of «طلباتي» hands out everything she may hold (the cap) + the fifty closed today + the twenty-five confirmed on the
   * page, one customer each. With the cap at 500 and the alarm at 500 the busiest ordinary request there is crossed the line by
   * itself — an audit row and an alert to every `users.edit` holder each quarter hour for an agent doing her job. The two numbers
   * are tied here so that raising the cap again fails THIS test and not the alarm's audience.
   */
  it('is above everything one load of the desk hands out: the cap + 50 closed today + 25 confirmed', () => {
    expect(BULK_VIEW_RECORDS).toBeGreaterThan(CLAIM_CAPS.total + 50 + 25);
  });

  it('and the desk’s two other pages are the 50 and the 25 that sum counts — read from the route, so growing one fails here', () => {
    const route = readFileSync(join(process.cwd(), 'src', 'app', 'api', 'confirmation', 'mine', 'route.ts'), 'utf8');
    const confirmedPage = Number(/const CONFIRMED_PAGE_SIZE = (\d+);/.exec(route)?.[1]);
    const closedToday = Number(/where: closedScope,[\s\S]*?take: (\d+),/.exec(route)?.[1]);
    expect(confirmedPage, 'ما لقيت حجم صفحة المؤكَّدة بالباب').toBeGreaterThan(0);
    expect(closedToday, 'ما لقيت عدد المسكَّرة اليوم بالباب').toBeGreaterThan(0);
    expect(BULK_VIEW_RECORDS).toBeGreaterThan(CLAIM_CAPS.total + closedToday + confirmedPage);
    // The same sum, as the desk really adds it: 500 + 50 + 25.
    expect(CLAIM_CAPS.total + closedToday + confirmedPage).toBe(575);
  });

  it('a full desk handed out in ONE request does not cross the alarm — through the real counter', () => {
    const fullDesk = Array.from({ length: CLAIM_CAPS.total + 50 + 25 }, (_, i) => `customer-${i}`);
    const out = noteCustomerAccess('pii:agent', 0, { store, now: NOW, ids: fullDesk });
    expect(out.records).toBe(575);
    expect(out.crossed, 'الشاشة الكاملة صارت هي التجاوز').toBe(false);
  });

  it('and reading the customer table is still what crosses it: 700 different people', () => {
    const harvest = Array.from({ length: BULK_VIEW_RECORDS }, (_, i) => `customer-${i}`);
    expect(noteCustomerAccess('pii:other', 0, { store, now: NOW, ids: harvest }).crossed).toBe(true);
  });
});

/**
 * THE COUNTER IS USELESS UNLESS SOMETHING CALLS IT.
 *
 * A pure function with perfect tests, wired to nothing, is the most
 * comfortable kind of dead code. This reads the route.
 */
describe('the route that feeds it', () => {
  const route = readFileSync(join(process.cwd(), 'src', 'app', 'api', 'customers', 'route.ts'), 'utf8');

  /*
   * These three used to pin the FIRST shape of this: a tally keyed
   * `customers:<user id>`, counted and announced by each route itself.
   * Both halves of that were the defect — see
   * `customers-are-counted-once.test.ts`. The key is the person's now,
   * and the counting and the announcing are one call every route makes,
   * so what is checked here is that these two routes still make it.
   */
  it('counts the customers it actually returned', () => {
    expect(route).toMatch(/noteCustomersHandedOut\(\{[^}]*rows: customers/);
  });

  it('and does not keep a second, private tally beside the shared one', () => {
    expect(route, 'عادت الشاشةُ تعدُّ لنفسها').not.toMatch(/noteCustomerAccess\(/);
  });

  it('and the profile page feeds the same tally', () => {
    // Otherwise the hole is the obvious one: open five hundred profiles
    // one at a time and the list endpoint never sees any of it.
    const history = readFileSync(
      join(process.cwd(), 'src', 'app', 'api', 'customers', '[id]', 'history', 'route.ts'),
      'utf8'
    );
    expect(history).toMatch(/noteCustomersHandedOut\(\{/);
    expect(history).toMatch(/rows: \[\{ customerId: id \}\]/);
  });

  it('and blocks nobody', () => {
    // Deliberate: someone may have a real reason to read six hundred
    // customers. The system raises a hand; a person decides.
    expect(route, 'حُوِّل التنبيهُ إلى منع').not.toMatch(/seen\.crossed[\s\S]{0,120}status:\s*4\d\d/);
  });
});

describe('the alert itself', () => {
  const alert = readFileSync(join(process.cwd(), 'src', 'lib', 'pii-alert.ts'), 'utf8');

  it('writes the record and raises the hand as two separate things', () => {
    expect(alert).toMatch(/action: 'CUSTOMER_BULK_VIEW'/);
    expect(alert).toMatch(/createNotification\(/);
  });

  it('tells the people who can act, not everyone who can read', () => {
    // `users.edit` — who can grant and revoke access. It named `users.manage`, a key pruned from the catalog that
    // nobody can be given, so only the SUPER_ADMINs ever heard of a harvest.
    expect(alert).toMatch(/audience: \{ permission: 'users\.edit' \}/);
  });

  it('does not tell the person being watched', () => {
    expect(alert, 'أُعلِم الشخصُ بأنّه مراقَب').toMatch(/actorId: input\.user\.id/);
  });

  it('names no customer in the alert about customer data', () => {
    // The entity id is the reader, not a person read: putting one of the
    // protected rows inside the warning about them would be absurd.
    expect(alert).toMatch(/entityId: input\.user\.id/);
  });

  it('never turns a permitted read into an error', async () => {
    vi.resetModules();
    vi.doMock('./audit', () => ({ logAudit: vi.fn().mockRejectedValue(new Error('db down')) }));
    vi.doMock('./notification', () => ({ createNotification: vi.fn() }));
    const { announceBulkCustomerView } = await import('./pii-alert');
    await expect(
      announceBulkCustomerView({
        companyId: 'c1',
        storeId: 's1',
        user: { id: 'u1', name: 'س', email: 'a@b.c' } as never,
        records: 600,
        where: 'قائمة العملاء',
      })
    ).resolves.toBeUndefined();
    vi.doUnmock('./audit');
    vi.doUnmock('./notification');
  });
});
