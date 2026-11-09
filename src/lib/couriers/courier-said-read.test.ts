import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHAT THE COMPANY SAID, READ BACK — AGAINST LINES THE REAL FEED WROTE.
 *
 * «متابعة الشحن: الشركة بتقول». The poll keeps the company's word as a COURIER_SAID line, and the follow-up list now draws
 * it. What is held here is the reading: the label is the company's name for its CODE and never the free text a driver
 * typed; the free text is kept apart and only when it says more; a line that cannot be trusted says nothing; and the
 * list shows the NEWEST line only while it disagrees with the parcel's own state.
 *
 * ── THE LINES ARE NOT HAND-KEYED ──
 *
 * Every line below is made by the whole chain: a response in the shape the company documents → the real LogesTechs
 * adapter (`fetchEvents`) → the real gate (`applyCourierEvent`) → the row it writes. A free-text `notes` sits next to a
 * status code, two lines of one order sit in one table, an unknown code is let through the gate by hand. Only the
 * database is a fake (it stores what is written and answers what the gate asks).
 */

const { db } = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(),
    orderActivity: { findFirst: vi.fn(), create: vi.fn() },
  },
}));
vi.mock('../db', () => ({ db }));

import { applyCourierEvent } from './apply-event';
import { COURIER_SAID, SAID_STATUSES, isSaidStatus } from './courier-said';
import { courierSaidAgainst, readCourierSaid, type CourierSaidRow } from './courier-said-read';
import { theCompanySends, wordLine } from './courier-said-lines.fixture';
import { LOGESTECHS_STATUS } from './logestechs';
import { SHIPPING_STATUS_AR } from '../shipping-workflow';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const HOUR = 3_600_000;

/** What the database holds: every line the gate wrote, with the moment it was written. */
type Line = { id: string; orderId: string; action: string; newStatus: string | null; metadata: string | null; createdAt: Date };
let store: Line[];
let written: number;

beforeEach(() => {
  vi.clearAllMocks();
  store = [];
  written = NOW.getTime() - 2 * HOUR;
  db.orderActivity.create.mockImplementation(async ({ data }: { data: Omit<Line, 'id' | 'createdAt'> }) => {
    const row: Line = { id: `a${store.length + 1}`, ...data, createdAt: new Date(written) };
    store.push(row);
    return row;
  });
  db.orderActivity.findFirst.mockImplementation(
    async ({ where }: { where: { orderId: string; action: string } }) =>
      [...store].reverse().find((r) => r.orderId === where.orderId && r.action === where.action) ?? null
  );
});

/**
 * The company says `code` about a parcel our state shows as `state`: its response, through the real adapter and the real
 * gate. Returns the line the gate wrote (undefined when it wrote none).
 */
async function companySays(code: string, over: { notes?: string; state?: string; orderId?: string } = {}) {
  const event = await theCompanySends(code, over.notes ?? '');
  const before = store.length;
  const outcome = await applyCourierEvent({
    order: { id: over.orderId ?? 'o1', companyId: 'c1', shippingStatus: over.state ?? 'OUT_FOR_DELIVERY' },
    event,
    courierName: 'الباشا',
    source: 'POLL',
  });
  return { outcome, line: store.length > before ? store.at(-1) : undefined };
}

const SIX: [code: string, status: string, label: string][] = [
  ['DELIVERED_TO_RECIPIENT', 'DELIVERED', 'تم التوصيل'],
  ['PARTIALLY_DELIVERED', 'PARTIALLY_DELIVERED', 'تم توصيلها بشكل جزئي'],
  ['RETURNED_BY_RECIPIENT', 'RETURNED', 'تم ارجاعها'],
  ['DELIVERED_TO_SENDER', 'RETURNED', 'مسلمة الى المرسل'],
  ['CANCELLED', 'CANCELLED', 'ملغاة'],
  ['POSTPONED_DELIVERY', 'FAILED_DELIVERY', 'مؤجلة'],
];

describe('a line the real feed wrote reads back as what the company said', () => {
  it.each(SIX)('— %s: the state %s, and the company’s own name for it, «%s»', async (code, status, label) => {
    const { outcome, line } = await companySays(code);
    expect(outcome).toBe('NOT_AUTO_APPLICABLE');
    expect(line).toBeDefined();
    expect(line!.action).toBe(COURIER_SAID);
    const said = readCourierSaid(line!, NOW);
    expect(said).toMatchObject({ status, label, note: null, ageMinutes: 120 });
    expect(said!.at).toEqual(line!.createdAt);
  });

  it('and the six are every code the feed keeps as a word — a seventh would show up here as a line nobody reads', () => {
    const kept = Object.entries(LOGESTECHS_STATUS)
      .filter(([, s]) => s !== null && isSaidStatus(s))
      .map(([code]) => code)
      .sort();
    expect(kept).toEqual(SIX.map(([code]) => code).sort());
  });
});

describe('the label is the company’s name for its code — never the free text a driver typed', () => {
  it('— a note beside the code is kept apart: «تم التوصيل» stays the label, the note is the note', async () => {
    const { line } = await companySays('DELIVERED_TO_RECIPIENT', { notes: 'العميل طلب يوصّلوها عند الجارة' });
    expect(JSON.parse(line!.metadata!).courierSaid).toBe('العميل طلب يوصّلوها عند الجارة');
    const said = readCourierSaid(line!, NOW)!;
    expect(said.label).toBe('تم التوصيل');
    expect(said.note).toBe('العميل طلب يوصّلوها عند الجارة');
    expect(said.status).toBe('DELIVERED');
  });

  it('and a note that is itself ANOTHER code’s name does not become the label either', async () => {
    const { line } = await companySays('DELIVERED_TO_RECIPIENT', { notes: 'مؤجلة' });
    const said = readCourierSaid(line!, NOW)!;
    expect(said.label).toBe('تم التوصيل');
    expect(said.note).toBe('مؤجلة');
    expect(said.status).toBe('DELIVERED');
  });

  it('and a note that only repeats the label in another spelling is no note at all', async () => {
    const { line } = await companySays('RETURNED_BY_RECIPIENT', { notes: 'تم إرجاعها' });
    expect(readCourierSaid(line!, NOW)).toMatchObject({ label: 'تم ارجاعها', note: null });
  });

  it('and with no note the company’s name for the code is what was stored, and no note is shown', async () => {
    const { line } = await companySays('POSTPONED_DELIVERY', { notes: '' });
    expect(JSON.parse(line!.metadata!).courierSaid).toBe('مؤجلة');
    expect(readCourierSaid(line!, NOW)!.note).toBeNull();
  });

  it('and a long note is cut where the feed cut it, with its line breaks and runs of spaces closed up', async () => {
    const long = `${'مرحبا   بالعميل\n'.repeat(20)}`;
    const { line } = await companySays('CANCELLED', { notes: long });
    const said = readCourierSaid(line!, NOW)!;
    expect(said.label).toBe('ملغاة');
    expect(said.note!.length).toBeLessThanOrEqual(80);
    expect(said.note).not.toMatch(/\s{2}|\n/);
  });
});

describe('what the reading will not guess', () => {
  const line = async () => (await companySays('DELIVERED_TO_RECIPIENT')).line!;
  const withMeta = (row: CourierSaidRow, meta: unknown): CourierSaidRow => ({ ...row, metadata: typeof meta === 'string' ? meta : JSON.stringify(meta) });

  it('— a code the company’s table does not hold is named by OUR name for the state', async () => {
    const row = await line();
    const meta = JSON.parse(row.metadata!);
    expect(readCourierSaid(withMeta(row, { ...meta, rawStatus: 'A_CODE_THEY_ADD_NEXT_YEAR' }), NOW)).toMatchObject({
      status: 'DELIVERED',
      label: SHIPPING_STATUS_AR.DELIVERED,
    });
  });

  it('and a known code whose meaning is NOT the state the line carries does not name it: the label would say the opposite of the tone', async () => {
    const row = await line();
    const meta = JSON.parse(row.metadata!);
    // «مؤجلة» is the company’s name for POSTPONED_DELIVERY — a line carrying DELIVERED must not wear it.
    expect(readCourierSaid(withMeta(row, { ...meta, rawStatus: 'POSTPONED_DELIVERY' }), NOW)!.label).toBe(SHIPPING_STATUS_AR.DELIVERED);
  });

  it('and the code is read the way the adapter’s own map reads it: trimmed and upper-cased', async () => {
    const row = await line();
    const meta = JSON.parse(row.metadata!);
    expect(readCourierSaid(withMeta(row, { ...meta, rawStatus: '  delivered_to_recipient ' }), NOW)!.label).toBe('تم التوصيل');
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['nothing', null],
    ['an empty string', ''],
    ['an array', '[]'],
    ['a number', '42'],
    ['null', 'null'],
    ['a JSON string cut short', '{"rawStatus": "DELIVERED_TO_RECIPIENT", '],
  ])('— metadata that is %s says nothing: null, not a guess from the state alone', async (_what, metadata) => {
    const row = await line();
    expect(readCourierSaid({ ...row, metadata: metadata as string | null }, NOW)).toBeNull();
  });

  it('but metadata that is a valid, empty object still says what the state says — and nothing more', async () => {
    const row = await line();
    expect(readCourierSaid(withMeta(row, {}), NOW)).toMatchObject({ status: 'DELIVERED', label: SHIPPING_STATUS_AR.DELIVERED, note: null });
  });

  it.each([null, '', 'SHIPPED', 'OUT_FOR_DELIVERY', 'delivered', 'IN_TRANSIT'])('— a line whose state is %j is not one of the five: null', async (newStatus) => {
    const row = await line();
    expect(readCourierSaid({ ...row, newStatus }, NOW)).toBeNull();
  });

  it('— a line with no usable date cannot be aged: null', async () => {
    const row = await line();
    expect(readCourierSaid({ ...row, createdAt: new Date('nonsense') }, NOW)).toBeNull();
  });

  it('— and the reading changes nothing it was handed', async () => {
    const row = await line();
    const frozen = JSON.stringify(row);
    readCourierSaid(row, NOW);
    courierSaidAgainst('SHIPPED', row, NOW);
    expect(JSON.stringify(row)).toBe(frozen);
  });
});

describe('how old the word is — by the clock it is handed, never below zero', () => {
  const at = (msAgo: number): CourierSaidRow => ({ ...wordLine({ orderId: 'o', code: 'DELIVERED_TO_RECIPIENT', at: new Date(NOW.getTime() - msAgo) }) });

  it.each([
    [0, 0],
    [59_999, 0],
    [60_000, 1],
    [119_999, 1],
    [2 * HOUR, 120],
    [3 * 24 * HOUR + 5 * 60_000, 3 * 24 * 60 + 5],
  ])('— %i ms ago is %i whole minutes', (ms, minutes) => {
    expect(readCourierSaid(at(ms), NOW)!.ageMinutes).toBe(minutes);
  });

  it('and a line dated after the clock (two machines a few seconds apart) is zero, not a negative age', () => {
    expect(readCourierSaid(at(-45_000), NOW)!.ageMinutes).toBe(0);
    expect(readCourierSaid(at(-5 * HOUR), NOW)!.ageMinutes).toBe(0);
  });
});

describe('the newest line, and only while it disagrees with the parcel’s own state', () => {
  const said = (code: string, state = 'SHIPPED') => courierSaidAgainst(state, wordLine({ orderId: 'o', code, at: new Date(NOW.getTime() - HOUR) }), NOW);

  it('— a word that differs from the state is shown', () => {
    expect(said('DELIVERED_TO_RECIPIENT', 'SHIPPED')).toMatchObject({ status: 'DELIVERED' });
    expect(said('DELIVERED_TO_RECIPIENT', 'RETURNED')).toMatchObject({ status: 'DELIVERED' });
  });

  it('and a word that EQUALS the state says nothing new: null', () => {
    expect(said('DELIVERED_TO_RECIPIENT', 'DELIVERED')).toBeNull();
    expect(said('POSTPONED_DELIVERY', 'FAILED_DELIVERY')).toBeNull();
    expect(said('DELIVERED_TO_SENDER', 'RETURNED')).toBeNull();
    expect(said('RETURNED_BY_RECIPIENT', 'RETURNED')).toBeNull();
  });

  it('and a parcel the company never spoke about has no word', () => {
    expect(courierSaidAgainst('SHIPPED', undefined, NOW)).toBeNull();
  });
});

describe('the fixture the other tests read lines from is the line the real feed writes', () => {
  it.each(SIX)('— %s: same state, same metadata, key for key', async (code) => {
    const { line } = await companySays(code);
    const built = wordLine({ orderId: 'o1', code, at: line!.createdAt });
    expect(built.newStatus).toBe(line!.newStatus);
    expect(built.metadata).toBe(line!.metadata);
  });

  it('— and with the company’s own notes too, long ones cut at the same place', async () => {
    for (const [i, notes] of ['العميل رفض الاستلام لأنه غيّر رأيه', 'س'.repeat(200)].entries()) {
      // One order each: the same word twice in a row on ONE order is, rightly, one line.
      const { line } = await companySays('RETURNED_BY_RECIPIENT', { notes, orderId: `o${i}` });
      const built = wordLine({ orderId: `o${i}`, code: 'RETURNED_BY_RECIPIENT', notes, at: line!.createdAt });
      expect(built.metadata).toBe(line!.metadata);
    }
  });
});

describe('the five words are exactly what the gate keeps as a word', () => {
  it('— for EVERY shipping state, the gate keeps it as a word if and only if it is one of the five', async () => {
    const states = Object.keys(SHIPPING_STATUS_AR);
    expect(states.length).toBeGreaterThanOrEqual(12);
    const kept: string[] = [];
    for (const status of states) {
      // A parcel in some OTHER state hears the company say `status`; a dry run writes nothing and answers what it WOULD do.
      const state = status === 'SHIPPED' ? 'OUT_FOR_DELIVERY' : 'SHIPPED';
      const outcome = await applyCourierEvent({
        order: { id: 'o1', companyId: 'c1', shippingStatus: state },
        event: { trackingNumber: 'K', rawStatus: 'X', occurredAt: NOW, status: status as keyof typeof SHIPPING_STATUS_AR },
        courierName: 'الباشا',
        source: 'POLL',
        dryRun: true,
      });
      if (outcome === 'NOT_AUTO_APPLICABLE') kept.push(status);
    }
    expect(kept.sort()).toEqual([...SAID_STATUSES].sort());
  });

  it('— and the predicate agrees with the list', () => {
    for (const s of SAID_STATUSES) expect(isSaidStatus(s), s).toBe(true);
    for (const s of ['SHIPPED', 'OUT_FOR_DELIVERY', 'RETURN_REQUESTED', 'delivered', '', null, undefined, 3]) expect(isSaidStatus(s), String(s)).toBe(false);
  });
});
