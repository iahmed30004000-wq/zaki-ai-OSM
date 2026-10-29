import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BULK_VIEW_RECORDS, forgetCustomerAccess, noteCustomerAccess, type AccessWindow } from './pii-access';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * READING THE SAME LIST AGAIN IS NOT READING MORE PEOPLE.
 *
 * The shipment-creation screen takes 300 rows and reloads after every
 * action — postponing a parcel, pressing back, typing in the search box.
 * The harvest alarm added each load to a plain counter, so the second
 * reload of one list crossed the line for 500 «customers» of whom there
 * were 300. An alarm that fires on ordinary work is one people learn to
 * ignore, and then it is silent for the real thing.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { logAudit, createNotification } = vi.hoisted(() => ({ logAudit: vi.fn(), createNotification: vi.fn() }));
vi.mock('./audit', () => ({ logAudit }));
vi.mock('./notification', () => ({ createNotification }));

import { noteCustomersHandedOut, type ContactBearingRow } from './pii-alert';

const NOW = 1_800_000_000_000;
let store: Map<string, AccessWindow>;
const note = (anonymous: number, ids: string[] | undefined, at = NOW, key = 'pii:u1') =>
  noteCustomerAccess(key, anonymous, { store, now: at, threshold: 10, windowMs: 1000, ids });

beforeEach(() => {
  store = new Map();
  forgetCustomerAccess();
  vi.clearAllMocks();
});

describe('noteCustomerAccess with names', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('counts each person once in a window, however often the list is read', () => {
    expect(note(0, six).records).toBe(6);
    expect(note(0, six, NOW + 10).records).toBe(6);
    expect(note(0, six, NOW + 20).records).toBe(6);
  });

  it('the repeat never crosses the line by itself', () => {
    for (let i = 0; i < 20; i += 1) expect(note(0, six, NOW + i).crossed).toBe(false);
  });

  it('but new people are added, and do cross it', () => {
    note(0, six);
    expect(note(0, ['g', 'h', 'i'], NOW + 10).records).toBe(9);
    expect(note(0, ['j', 'k'], NOW + 20).crossed).toBe(true);
  });

  it('rows that name nobody still count every time — they cannot be recognised', () => {
    expect(note(3, undefined).records).toBe(3);
    expect(note(3, undefined, NOW + 10).records).toBe(6);
  });

  it('a mix keeps the two tallies apart', () => {
    expect(note(2, ['a', 'b']).records).toBe(4);
    // `a` and `b` again: only the two nameless rows are new.
    expect(note(2, ['a', 'b'], NOW + 10).records).toBe(6);
    expect(note(0, ['c'], NOW + 20).records).toBe(7);
  });

  it('forgets the names when the window rolls over, so the next window starts clean', () => {
    note(0, six);
    expect(note(0, six, NOW + 2000).records).toBe(6);
  });

  it('keeps one set of names per person', () => {
    note(0, six);
    expect(note(0, six, NOW, 'pii:u2').records).toBe(6);
  });

  it('is still not blocked, only counted: a plain number with no names behaves as before', () => {
    expect(note(9, undefined).crossed).toBe(false);
    expect(note(1, undefined, NOW + 1).crossed).toBe(true);
  });
});

describe('noteCustomersHandedOut, the door every list goes through', () => {
  const user = { id: 'u1', name: 'موظف', email: 'e@example.com' } as never;
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ customerId: `c${from + i}`, phone: `07${from + i}` }));
  const hand = (r: ReadonlyArray<ContactBearingRow>) => noteCustomersHandedOut({ companyId: 'co', storeId: null, user, where: 'اختبار', rows: r });

  it('reloading the same 300-row list ten times raises no alarm', async () => {
    const list = rows(300);
    for (let i = 0; i < 10; i += 1) await hand(list);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('five hundred DIFFERENT people still raise it, exactly once', async () => {
    await hand(rows(300));
    await hand(rows(300, 300));
    await hand(rows(300, 600));
    expect(BULK_VIEW_RECORDS).toBe(500);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('a list that names nobody is counted row by row, as before', async () => {
    const nameless = Array.from({ length: 300 }, () => ({}));
    await hand(nameless);
    await hand(nameless);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });
});
