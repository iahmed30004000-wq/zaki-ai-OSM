// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «استلم المحدد» — WHAT THE FOLLOW-UP SCREEN DRAWS FOR A PRESS OVER A PAGE OF PARCELS.
 *
 * The delivery company's word is on each row (`courierSaid`); a parcel whose newest word is «تم التوصيل» and that has the
 * «استلم» box can be ticked, and one press records the ticked ones. The screen:
 *
 *   • draws a box ONLY on those rows — not on a part delivery, a postponement, a return, a parcel with no word, or a parcel
 *     whose state has no «استلم» — and none at all for a person without `ops.deliver`;
 *   • offers «حدّد كل اللي الشركة بتقول عنهم «تم التوصيل» بهالصفحة», which takes exactly those rows and no more than a press may carry;
 *   • asks first, in plain words — what will happen AND what will not (no money; the statement is the proof);
 *   • sends only what was ticked, once, and then draws the server's report: every parcel, recorded or not, with the reason;
 *   • shares the ticks, the bar and the page-turn rules with «استلمت منه», and never lets the two stand together;
 *   • and is the screen it was when no row carries the company's word.
 */

const { api, confirm, phone } = vi.hoisted(() => ({
  api: vi.fn(),
  confirm: vi.fn<(options: { title: string; body?: string; confirmLabel?: string }) => Promise<boolean>>(async () => true),
  phone: { value: false },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>متابعة الشحن</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => (o: never) => confirm(o), useTell: () => async () => undefined }));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

import { TrackingScreen } from '@/components/screens/TrackingScreen';
import { BULK_DELIVER_CONFIRM_AR, BULK_DELIVER_MOST } from '@/lib/parcel-tracking/bulk-deliver';

configure({ asyncUtilTimeout: 8000 });

const P1 = '11111111-1111-4111-8111-111111111111';
const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };
const SAID_COUNTS = { DELIVERED: 4, PARTIALLY_DELIVERED: 1, RETURNED: 0, CANCELLED: 0, FAILED_DELIVERY: 1 };

const word = (status: string, label: string) => ({ status, label, note: null, at: '2026-11-09T10:00:00.000Z', ageMinutes: 120 });
const DELIVERED_WORD = word('DELIVERED', 'تم التوصيل');
const parcel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus: 'SHIPPED',
  collectionStatus: 'NOT_APPLICABLE',
  settlementStatus: 'NOT_APPLICABLE',
  daysInTransit: 4,
  lateThresholdDays: 3,
  late: true,
  totalAmount: 40,
  currency: 'JOD',
  deliveryFailureReason: null,
  customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
  region: { name: 'عمّان' },
  deliveryProvider: { id: P1, name: 'الباشا', kind: 'COMPANY' },
  expectedCollection: 37.5,
  _count: { deliveryAttempts: 0, notes: 0 },
  alert: null,
  courierSaid: null,
  ...over,
});
/** A parcel the company calls delivered. */
const said = (id: string, over: Record<string, unknown> = {}) => parcel(id, { courierSaid: DELIVERED_WORD, ...over });
/** A delivered parcel with money waiting: the other kind of box. */
const owed = (id: string) => parcel(id, { shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', collectionStatus: 'PENDING_COLLECTION', late: false, daysInTransit: 2 });

let rows: ReturnType<typeof parcel>[];
let acts: Record<string, boolean> | undefined;
let access: { money: boolean; returns: boolean; collect: boolean };
let answer: unknown;
let posts: { url: string; body: unknown }[];

const listAnswer = () => ({
  count: rows.length,
  orders: rows,
  lateCount: 0,
  dialCode: '962',
  pagination: { total: rows.length, page: 1, limit: 25, totalPages: 1 },
  facts: { total: rows.length, tasks: { ...NO_TASKS, COLLECT: rows.filter((r) => r.shippingStatus === 'DELIVERED').length }, lateCount: 0, notLate: 0, couriers: [{ id: P1, name: 'الباشا', count: rows.length }], regions: [], ages: { fresh: 1, few: 0, week: 0, old: 0 }, said: SAID_COUNTS },
  applied: {},
  capped: false,
  access,
  ...(acts ? { acts } : {}),
});
const gets = () => api.mock.calls.filter((c) => !(c[1] && (c[1] as RequestInit).method));

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  confirm.mockImplementation(async () => true);
  rows = [];
  acts = { deliver: true, transfer: true, writeOff: true };
  access = { money: true, returns: true, collect: false };
  posts = [];
  answer = { results: [], delivered: 0, refused: 0 };
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return listAnswer();
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TrackingScreen />);
  await screen.findByLabelText('جهة الشحن');
};
const deskBoxes = () => Array.from(document.querySelectorAll('tbody input[type="checkbox"]')) as HTMLInputElement[];
const cardBoxes = () => Array.from(document.querySelectorAll('ul.md\\:hidden input[type="checkbox"]')) as HTMLInputElement[];
const selectAll = () => screen.getByRole('button', { name: /حدّد كل اللي الشركة بتقول عنهم «تم التوصيل» بهالصفحة/ });
const press = () => screen.getByRole('button', { name: /استلم المحدد/ }) as HTMLButtonElement;

/** The page of the story: two delivered words, and every kind of row that must NOT carry a box. */
const A = 'a1';
const B = 'b2';
const aMixedPage = () => [
  said(A),
  said(B, { shippingStatus: 'OUT_FOR_DELIVERY' }),
  parcel('c3', { courierSaid: word('PARTIALLY_DELIVERED', 'تم توصيلها بشكل جزئي') }),
  parcel('d4', { courierSaid: word('FAILED_DELIVERY', 'مؤجلة') }),
  parcel('e5', { courierSaid: word('RETURNED', 'تم ارجاعها') }),
  parcel('f6'),
  said('g7', { shippingStatus: 'FAILED_DELIVERY' }),
  said('h8', { shippingStatus: 'READY_FOR_PICKUP' }),
];

describe('the boxes: only where the company says «تم التوصيل» and the parcel has the «استلم»', () => {
  it('two boxes on a page of eight — on the desk’s table and on the phone’s cards alike', async () => {
    rows = aMixedPage();
    await draw();
    expect(deskBoxes()).toHaveLength(2);
    expect(cardBoxes()).toHaveLength(2);
  });

  it.each([
    ['a part delivery', parcel('x1', { courierSaid: word('PARTIALLY_DELIVERED', 'تم توصيلها بشكل جزئي') })],
    ['a postponement', parcel('x2', { courierSaid: word('FAILED_DELIVERY', 'مؤجلة') })],
    ['a return', parcel('x3', { courierSaid: word('RETURNED', 'تم ارجاعها') })],
    ['a cancellation', parcel('x4', { courierSaid: word('CANCELLED', 'ملغاة') })],
    ['no word at all', parcel('x5')],
    ['«تم التوصيل» on a parcel in «فشل التوصيل» (no «استلم» for it)', said('x6', { shippingStatus: 'FAILED_DELIVERY' })],
    ['«تم التوصيل» on a parcel that never left', said('x7', { shippingStatus: 'READY_FOR_PICKUP' })],
  ])('NEGATIVE: %s carries no box, and the screen draws no strip', async (_n, row) => {
    rows = [row];
    await draw();
    expect(deskBoxes()).toHaveLength(0);
    expect(cardBoxes()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /حدّد كل اللي الشركة بتقول/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /استلم المحدد/ })).toBeNull();
  });

  it('NEGATIVE: without «ops.deliver» there is no box, no strip and no select-all — the same rows, the same words', async () => {
    acts = { deliver: false, transfer: true, writeOff: true };
    rows = aMixedPage();
    await draw();
    expect(deskBoxes()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /حدّد كل اللي الشركة بتقول/ })).toBeNull();
    expect(screen.queryByText(/الشركة بتقول «تم التوصيل» على/)).toBeNull();
    // …but the chip that SAYS the word is still drawn: seeing is not acting.
    expect(screen.getAllByText(/الشركة بتقول: تم التوصيل/).length).toBeGreaterThan(0);
  });

  it('an answer that does not say what this person may press is read as «all», as the single buttons are', async () => {
    acts = undefined;
    rows = [said(A)];
    await draw();
    expect(deskBoxes()).toHaveLength(1);
  });

  it('the strip says how many on this page, in plain words', async () => {
    rows = aMixedPage();
    await draw();
    expect(screen.getByText('الشركة بتقول «تم التوصيل» على 2 طرد بهالصفحة')).toBeTruthy();
  });

  it('the single «استلم» is still on every parcel that had it, ticked or not', async () => {
    rows = aMixedPage();
    await draw();
    // SHIPPED: a1, c3, d4, e5, f6 · OUT_FOR_DELIVERY: b2 — six, as before. «فشل التوصيل» and «بانتظار الاستلام» never had it.
    expect(within(document.querySelector('table') as HTMLElement).getAllByRole('button', { name: 'استلم' })).toHaveLength(6);
  });
});

describe('choosing', () => {
  it('«حدّد كل اللي…» takes exactly the rows with a box — and the strip then offers the press', async () => {
    rows = aMixedPage();
    await draw();
    fireEvent.click(selectAll());
    expect(deskBoxes().filter((b) => b.checked)).toHaveLength(2);
    expect(screen.getByText('مختار 2 طرد')).toBeTruthy();
    expect(press().textContent).toContain('استلم المحدد (2)');
    // Everything is ticked: there is nothing left for «حدّد كل…» to take.
    expect(screen.queryByRole('button', { name: /حدّد كل اللي الشركة بتقول/ })).toBeNull();
  });

  it('one box at a time, and un-ticking the last one takes the press away', async () => {
    rows = aMixedPage();
    await draw();
    fireEvent.click(deskBoxes()[0]);
    expect(press().textContent).toContain('(1)');
    fireEvent.click(deskBoxes()[0]);
    expect(screen.queryByRole('button', { name: /استلم المحدد/ })).toBeNull();
  });

  it('«إلغاء الاختيار» puts the ticks away', async () => {
    rows = aMixedPage();
    await draw();
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء الاختيار' }));
    expect(deskBoxes().filter((b) => b.checked)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /استلم المحدد/ })).toBeNull();
  });

  it(`takes no more than a press may carry: ${BULK_DELIVER_MOST} of sixty`, async () => {
    rows = Array.from({ length: 60 }, (_, i) => said(`m${i}`));
    await draw();
    fireEvent.click(selectAll());
    expect(deskBoxes().filter((b) => b.checked)).toHaveLength(BULK_DELIVER_MOST);
    expect(screen.getByText(`مختار ${BULK_DELIVER_MOST} طرد`)).toBeTruthy();
  });

  it('a new question puts the ticks away, like «استلمت منه»’s', async () => {
    rows = aMixedPage();
    await draw();
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByRole('button', { name: /^الكل / }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /استلم المحدد/ })).toBeNull());
  });
});

describe('the press: asks first, then sends what was ticked, once', () => {
  it('the confirmation says what will happen AND what will not — the sentence the screen reads from the lib', async () => {
    rows = aMixedPage();
    await draw();
    fireEvent.click(selectAll());
    fireEvent.click(press());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const asked = confirm.mock.calls[0][0];
    expect(asked.title).toBe('استلم 2 طرد دفعة وحدة؟');
    expect(asked.body).toBe(BULK_DELIVER_CONFIRM_AR);
    // What happens…
    expect(asked.body).toContain('بينسجّل إنها انسلّمت للزبون وبتنزل من المخزون');
    // …and what does NOT: no money, the statement is the proof, the company's word is a word.
    expect(asked.body).toContain('ما رح ينكتب أي مبلغ');
    expect(asked.body).toContain('كشف الشركة');
    expect(asked.body).toContain('كلمة الشركة مجرد كلمة، والكشف هو الإثبات');
    // …and that the server looks at each one.
    expect(asked.body).toContain('السيرفر بيفحص كل طرد لحاله');
  });

  it('NEGATIVE: «لا» sends nothing, and the ticks stay', async () => {
    confirm.mockImplementation(async () => false);
    rows = aMixedPage();
    await draw();
    fireEvent.click(selectAll());
    fireEvent.click(press());
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(posts).toHaveLength(0);
    expect(deskBoxes().filter((b) => b.checked)).toHaveLength(2);
  });

  it('«نعم» sends the ticked ids, and only those, to the one door', async () => {
    answer = { results: [{ orderId: A, orderNumber: `ORD-${A}`, ok: true }], delivered: 1, refused: 0 };
    rows = aMixedPage();
    await draw();
    fireEvent.click(deskBoxes()[0]);
    fireEvent.click(press());
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toBe('/api/ops/tracking/deliver-many');
    expect(posts[0].body).toEqual({ orderIds: [A] });
  });

  it('the button shuts while the request is in the air, so a double tap is one press', async () => {
    let finish!: (v: unknown) => void;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Promise((r) => (finish = r));
      }
      return listAnswer();
    });
    rows = [said(A)];
    await draw();
    fireEvent.click(selectAll());
    fireEvent.click(press());
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(press().disabled).toBe(true));
    fireEvent.click(press());
    expect(posts).toHaveLength(1);
    finish({ results: [{ orderId: A, orderNumber: 'ORD-a1', ok: true }], delivered: 1, refused: 0 });
    await waitFor(() => expect(screen.getByLabelText('تقرير الاستلام الجماعي')).toBeTruthy());
  });
});

describe('the report: every parcel, recorded or not, in the server’s own words', () => {
  it('one recorded and one refused: both are named, the refusal with its reason, and the list is asked again', async () => {
    answer = {
      results: [
        { orderId: A, orderNumber: `ORD-${A}`, ok: true },
        { orderId: B, orderNumber: `ORD-${B}`, ok: false, reason: 'آخر شي قالته الشركة: «مؤجلة» — مش «تم التوصيل»' },
      ],
      delivered: 1,
      refused: 1,
    };
    rows = aMixedPage();
    await draw();
    const before = gets().length;
    fireEvent.click(selectAll());
    fireEvent.click(press());
    const report = await screen.findByLabelText('تقرير الاستلام الجماعي');
    expect(within(report).getByText('انسجّل 1 وما انسجّل 1')).toBeTruthy();
    const lines = within(report).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain(`ORD-${A}`);
    expect(lines[0].textContent).toContain('انسجّل');
    expect(lines[1].textContent).toContain(`ORD-${B}`);
    expect(lines[1].textContent).toContain('آخر شي قالته الشركة: «مؤجلة» — مش «تم التوصيل»');
    // The ticks are put away and the list is read again — the recorded ones leave it.
    expect(deskBoxes().filter((b) => b.checked)).toHaveLength(0);
    await waitFor(() => expect(gets().length).toBeGreaterThan(before));
  });

  it('a parcel is named by the reference its row showed — the merchant’s reference when it has one', async () => {
    answer = { results: [{ orderId: A, orderNumber: 'ORD-a1', ok: true }], delivered: 1, refused: 0 };
    rows = [said(A, { merchantRef: 'SH-9001' })];
    await draw();
    fireEvent.click(selectAll());
    fireEvent.click(press());
    const report = await screen.findByLabelText('تقرير الاستلام الجماعي');
    expect(within(report).getByText('SH-9001')).toBeTruthy();
    expect(within(report).getByText('انسجّل 1 طرد')).toBeTruthy();
  });

  it('«تمام» puts the report away', async () => {
    answer = { results: [{ orderId: A, orderNumber: 'ORD-a1', ok: true }], delivered: 1, refused: 0 };
    rows = [said(A)];
    await draw();
    fireEvent.click(selectAll());
    fireEvent.click(press());
    await screen.findByLabelText('تقرير الاستلام الجماعي');
    fireEvent.click(screen.getByRole('button', { name: 'تمام' }));
    expect(screen.queryByLabelText('تقرير الاستلام الجماعي')).toBeNull();
  });

  it('NEGATIVE: a door that refuses the request (403) shows its sentence in the error line, keeps the ticks, and draws no report', async () => {
    answer = new Error('لا تملك صلاحية «تسجيل التسليم». اطلبها من مدير النظام إن كانت من عملك.');
    rows = [said(A)];
    await draw();
    fireEvent.click(selectAll());
    fireEvent.click(press());
    await screen.findByText(/لا تملك صلاحية «تسجيل التسليم»/);
    expect(screen.queryByLabelText('تقرير الاستلام الجماعي')).toBeNull();
    expect(deskBoxes().filter((b) => b.checked)).toHaveLength(1);
  });
});

describe('a phone: the bar carries the press', () => {
  beforeEach(() => {
    phone.value = true;
  });

  it('the strip offers the choice; after a tick the bar (a toolbar at the bottom) offers the press and the strip no longer does', async () => {
    rows = aMixedPage();
    await draw();
    expect(screen.queryByRole('toolbar')).toBeNull();
    fireEvent.click(selectAll());
    const bar = screen.getByRole('toolbar');
    expect(within(bar).getByText('مختار 2 طرد')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'استلم المحدد (2)' })).toBeTruthy();
    // One press only: the strip’s is the desk’s.
    expect(screen.getAllByRole('button', { name: /استلم المحدد/ })).toHaveLength(1);
  });

  it('and the press from the bar sends the same request', async () => {
    answer = { results: [{ orderId: A, orderNumber: 'ORD-a1', ok: true }, { orderId: B, orderNumber: 'ORD-b2', ok: true }], delivered: 2, refused: 0 };
    rows = aMixedPage();
    await draw();
    fireEvent.click(selectAll());
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: /استلم المحدد/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ orderIds: [A, B] });
  });
});

describe('beside «استلمت منه»: one selection, never two bars', () => {
  beforeEach(() => {
    access = { money: true, returns: true, collect: true };
  });

  it('a person who may collect and may deliver sees both kinds of box', async () => {
    rows = [said(A), owed('o9')];
    await draw();
    expect(deskBoxes()).toHaveLength(2);
  });

  it('ticking a parcel to collect puts the delivered-word ticks away, and the other way round', async () => {
    rows = [said(A), owed('o9')];
    await draw();
    fireEvent.click(selectAll());
    expect(screen.getByText('مختار 1 طرد')).toBeTruthy();
    // The collect box is the one on the delivered row.
    const collectBox = deskBoxes().find((b) => !b.checked)!;
    fireEvent.click(collectBox);
    expect(screen.getByText(/مختار 1 طلب/)).toBeTruthy();
    expect(screen.queryByText('مختار 1 طرد')).toBeNull();
    expect(screen.queryByRole('button', { name: /استلم المحدد/ })).toBeNull();
    // …and back.
    fireEvent.click(deskBoxes().find((b) => !b.checked)!);
    expect(screen.getByText('مختار 1 طرد')).toBeTruthy();
    expect(screen.queryByText(/مختار 1 طلب/)).toBeNull();
  });

  it('«اختر الكل» still takes only the money parcels, and «حدّد كل اللي…» only the words', async () => {
    rows = [said(A), said(B), owed('o9'), owed('o8')];
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'اختر الكل' }));
    expect(screen.getByText(/مختار 2 طلب/)).toBeTruthy();
    fireEvent.click(selectAll());
    expect(screen.getByText('مختار 2 طرد')).toBeTruthy();
    expect(screen.queryByText(/مختار \d+ طلب/)).toBeNull();
  });
});

describe('when no row carries the company’s word the screen is the screen it was', () => {
  it('a person who cannot collect: no column of boxes at all', async () => {
    rows = [parcel('p1'), parcel('p2', { shippingStatus: 'OUT_FOR_DELIVERY' })];
    await draw();
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(document.querySelector('thead th.w-10')).toBeNull();
    expect(screen.queryByText(/الشركة بتقول «تم التوصيل» على/)).toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('a person who can collect: exactly the boxes «استلمت منه» always had', async () => {
    access = { money: true, returns: true, collect: true };
    rows = [parcel('p1'), owed('o9')];
    await draw();
    expect(deskBoxes()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /حدّد كل اللي الشركة بتقول/ })).toBeNull();
  });
});

describe('how it is built', () => {
  const src = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/TrackingScreen.tsx'), 'utf8'));

  it('the screen asks the SAME test the lib states, goes to the one door, and keeps the single «استلم» on the same box rule', () => {
    expect(src()).toContain("from '@/lib/parcel-tracking/bulk-deliver'");
    expect(src()).toMatch(/visible\.filter\(canBulkDeliver\)/);
    expect(src()).toContain("'/api/ops/tracking/deliver-many'");
    expect(src()).toMatch(/acts\.deliver && hasDeliverBox\(o\.shippingStatus\)/);
    expect(src(), 'عادت قائمة الحالات مكتوبةً باليد').not.toMatch(/\['SHIPPED', 'OUT_FOR_DELIVERY'\]/);
  });

  it('the screen composes no reason of its own: it draws the server’s', () => {
    const report = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/tracking/BulkDeliverReport.tsx'), 'utf8'));
    expect(report).toContain('l.reason');
    expect(src()).not.toMatch(/reason\s*:\s*['`]/);
  });

  it('and still no clock, no sort, no money on the screen', () => {
    expect(src()).not.toMatch(/Date\.now\(\)|new Date\(\)|getTime\(\)|\.sort\(/);
    const bulk = src().slice(src().indexOf('const deliverable'), src().indexOf('const narrowing'));
    expect(bulk).not.toMatch(/collectedAmount|expectedCollection|totalAmount/);
  });
});
