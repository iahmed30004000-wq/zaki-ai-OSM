// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CANCELLED ROW AND THE CHANGED ROW, ON THE SCREEN ITSELF.
 *
 * «تمييزُ الصفوف: أحمر للملغى، برتقاليّ لمن فيه تعديل».
 *
 * The rule is guarded in two halves already: `Rows` draws two tones
 * (`ui/a-cancelled-row-is-not-a-changed-row`), and `rowToneFor` picks the
 * right one for each alert. Both passed while the screen handed `Rows`
 * nothing at all — FOUND BY MUTATION: replacing the whole prop with
 * `alert={() => null}` broke no test. A rule proved in two pieces with no
 * test over the join is a rule that can ship unwired.
 *
 * So this renders the real screen with two real parcels and reads the
 * ROWS — which is the only place the owner's sentence is actually true or
 * false.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson, apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => async () => null,
  useConfirm: () => async () => false,
  useTell: () => async () => undefined,
}));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { TrackingScreen } from './TrackingScreen';

/** One parcel on its way, carrying whatever alert the test needs. */
function parcel(id: string, tracking: string, alert: unknown) {
  return {
    id,
    orderNumber: `ORD-${id}`,
    merchantRef: null,
    trackingNumber: tracking,
    shippingStatus: 'SHIPPED',
    collectionStatus: 'PENDING_COLLECTION',
    settlementStatus: 'PENDING_COLLECTION',
    daysInTransit: 1,
    lateThresholdDays: 3,
    late: false,
    totalAmount: 40,
    currency: 'JOD',
    deliveryFailureReason: null,
    customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
    region: { name: 'عمّان' },
    deliveryProvider: { id: 'dp1', name: 'Basha Delivery', kind: 'COMPANY' },
    deliveryFee: 2.5,
    priceIncludesDelivery: false,
    collectedAmount: null,
    expectedCollection: 37.5,
    _count: { deliveryAttempts: 0, notes: 0 },
    alert,
  };
}

const AT = '2026-10-01T00:00:00.000Z';

/** The door's whole answer — the page, its numbers, what was applied. */
const answer = (orders: unknown[]) => ({
  count: orders.length,
  orders,
  lateCount: 0,
  dialCode: '+962',
  pagination: { total: orders.length, page: 1, limit: 25, totalPages: 1 },
  facts: {
    total: orders.length,
    tasks: { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 },
    lateCount: 0,
    couriers: [],
    regions: [],
    ages: { fresh: 0, few: 0, week: 0, old: 0 },
  },
  applied: { status: 'default', task: null, courier: null, region: null, age: null, q: null },
  capped: false,
});

async function show(parcels: unknown[]) {
  apiJson.mockResolvedValue(answer(parcels));
  render(<TrackingScreen />);
  await waitFor(() => expect(screen.getAllByText('TRK-A').length).toBeGreaterThan(0));
}

/** The table row carrying this waybill number. */
const rowOf = (tracking: string) =>
  screen.getAllByText(tracking).map((el) => el.closest('tr')).find(Boolean) as HTMLElement;

/**
 * And its phone card — found by the REFERENCE, not the waybill.
 *
 * The waybill column is a labelled line on the card and the reference is
 * the card's heading; looking the card up by the waybill found nothing,
 * which is how this helper was written wrong the first time.
 */
const cardOf = (id: string) =>
  screen.getAllByText(`ORD-${id}`).map((el) => el.closest('li')).find(Boolean) as HTMLElement;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the screen hands the row its colour', () => {
  it('a cancelled parcel and a changed parcel are two different rows', async () => {
    await show([
      parcel('a', 'TRK-A', { kind: 'CANCELLED', at: AT, acknowledged: false }),
      parcel('b', 'TRK-B', { kind: 'CHANGED', at: AT, acknowledged: false }),
      parcel('c', 'TRK-C', null),
    ]);

    const cancelled = rowOf('TRK-A').className;
    const changed = rowOf('TRK-B').className;
    const quiet = rowOf('TRK-C').className;

    expect(cancelled, 'صفُّ الملغى بلا لون — الشاشةُ لا تُمرِّرُ النبرة').not.toBe(quiet);
    expect(changed, 'صفُّ المعدَّل بلا لون').not.toBe(quiet);
    expect(changed, 'الملغى والمعدَّلُ بنفسِ اللونِ على الشاشة').not.toBe(cancelled);
  });

  it('and the red one is the cancelled one, not the changed one', async () => {
    await show([
      parcel('a', 'TRK-A', { kind: 'CANCELLED', at: AT, acknowledged: false }),
      parcel('b', 'TRK-B', { kind: 'CHANGED', at: AT, acknowledged: false }),
    ]);
    expect(rowOf('TRK-A').className).toMatch(/destructive/);
    expect(rowOf('TRK-B').className).toMatch(/warning/);
  });

  it('and the phone cards say the same two things', async () => {
    await show([
      parcel('a', 'TRK-A', { kind: 'CANCELLED', at: AT, acknowledged: false }),
      parcel('b', 'TRK-B', { kind: 'CHANGED', at: AT, acknowledged: false }),
      parcel('c', 'TRK-C', null),
    ]);
    const cancelled = cardOf('a').className;
    const changed = cardOf('b').className;
    expect(changed, 'البطاقاتُ لم تَفرِّقْ بينَ الحالتين').not.toBe(cancelled);
    expect(cancelled).not.toBe(cardOf('c').className);
  });

  it('and a parcel whose alert was dealt with stops tinting its row', async () => {
    await show([
      parcel('a', 'TRK-A', { kind: 'CANCELLED', at: AT, acknowledged: true }),
      parcel('c', 'TRK-C', null),
    ]);
    expect(rowOf('TRK-A').className, 'ما زالَ يَصرخُ بعدَ أن رآه أحد').toBe(rowOf('TRK-C').className);
    // And it still SAYS what happened — the chip stays, greyed.
    expect(screen.getAllByText(/رآه/).length, 'الشارةُ اختفت مع اللون').toBeGreaterThan(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE SEARCH BOX IS THE SYSTEM'S FIELD, NOT A HAND-ROLLED ONE.
 *
 * «نسخةُ الموبايل لمتابعة الشحن — تنظيمٌ أعمق». The two fields at the top
 * of this screen were written by hand, and what they were missing is
 * stated here as MEASURED and not as assumed:
 *
 *   NO BACKGROUND. Read in the browser on the dark palette: the
 *   hand-rolled field computed `rgba(0, 0, 0, 0)` — transparent — while
 *   every other field in the product computes `rgb(10, 26, 46)`, the card
 *   colour, against a page of `rgb(5, 15, 31)`. So it read as a flat
 *   outline drawn on the page where the rest of the product reads as a
 *   raised box. NOT a white box: `color-scheme` is declared per palette at
 *   the root already, and `ReturnsScreen` records that half being fixed.
 *
 *   NO LABEL. A `<span>` above a field is not a label. It is not clickable,
 *   it is not announced with the field, and it does not extend the field's
 *   hit area — which on a phone is the difference between a tap that lands
 *   and a tap that does nothing. `Input` and `Select` render a real
 *   `<label htmlFor>`, which is what is asserted below.
 *
 * WHAT IS NOT CLAIMED: that a TAPPED field now shows a focus ring.
 * `system.css` styles `:focus-visible` only, deliberately, and whether a
 * browser grants that to a text field focused by touch is the browser's
 * own heuristic. Tried to measure it; a synthetic click does not trigger
 * the heuristic, so it is not provable here and is not asserted.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('the search box at the top of the screen', () => {
  /**
   * A REAL `<label htmlFor>`, CHECKED AS ONE.
   *
   * `getByLabelText` is satisfied by an `aria-label` too — found by
   * mutation: turning `label="بحث"` into `aria-label="بحث"` passed every
   * assertion this test first made. An `aria-label` is announced, and it
   * is NOT clickable and does NOT extend the field's hit area, which on a
   * phone is the whole point. So the element is looked up and then its
   * label element is found by `for`, which only a real one has.
   */
  const labelFor = (el: HTMLElement) =>
    el.id ? document.querySelector(`label[for="${el.id}"]`) : null;

  it('is a real labelled field, not a span above an input', async () => {
    await show([parcel('a', 'TRK-A', null)]);
    const search = screen.getByLabelText('بحث');
    expect(search.tagName).toBe('INPUT');
    expect(search.id, 'الحقلُ بلا مُعرِّف').toBeTruthy();
    expect(labelFor(search), 'لا تسميةَ تُشيرُ إلى الحقل — aria-label وحدَها لا تُوسِّعُ مساحةَ اللمس').toBeTruthy();
    expect(labelFor(search)!.textContent).toContain('بحث');
  });

  it('and so is the status picker', async () => {
    await show([parcel('a', 'TRK-A', null)]);
    const status = screen.getByLabelText('الحالة');
    expect(status.tagName).toBe('SELECT');
    expect(labelFor(status), 'القائمةُ بلا تسميةٍ مربوطة').toBeTruthy();
  });

  it('and it carries the product’s own field background', async () => {
    await show([parcel('a', 'TRK-A', null)]);
    // The token, not a colour: jsdom computes no custom properties, so what
    // is checkable here is that the field asks for the card surface at all.
    expect(screen.getByLabelText('بحث').className).toMatch(/bg-\[var\(--sys-card\)\]/);
    expect(screen.getByLabelText('الحالة').className).toMatch(/bg-\[var\(--sys-card\)\]/);
  });

  it('and nothing on this screen hand-rolls a field any more', () => {
    /*
     * The screen's own source, because a render cannot see a field that
     * was replaced — it can only see the one that is there. This is what
     * fails if somebody adds a bare `<input>` to this screen next month.
     */
    const src = readFileSync(join(process.cwd(), 'src/components/screens/TrackingScreen.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const bare = [...src.matchAll(/<(input|select|textarea)\s/g)].filter((m) => {
      const tag = src.slice(m.index, m.index + 400);
      return !/type="checkbox"|type="radio"/.test(tag);
    });
    expect(
      bare.map((m) => src.slice(0, m.index).split(/\r?\n/).length),
      'حقلٌ مكتوبٌ بيدٍ في شاشةٍ لها حقولُ النظام'
    ).toEqual([]);
  });
});
