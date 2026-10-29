// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * THE SHIPMENT FOLLOW-UP, AS A LIST THAT IS READ IN PAGES — WITH CHIPS THAT ARE THE SERVER'S.
 *
 * «متابعة الشحن — صفحات + فلاتر + بحث». The screen held the two hundred oldest parcels, counted its seven chips over
 * them, sorted and filtered them in the browser and drew them all. What it owes now:
 *
 *   • 25 to a page, the pager only when there is a second page;
 *   • the search box is a REAL labelled field and is there before the first answer (a screen people find a parcel on
 *     must not open without it), and a link that carries `?order=` opens already searching;
 *   • the chips and the «late» badge are the SERVER'S numbers, over every parcel the search and the state match — a
 *     chip is a question put to the server, and a chip nobody is in is not drawn;
 *   • a company, a governorate and an age beside the state, each with the server's number, and only what was chosen is
 *     asked, and a change starts again at page one — and a new question starts a new selection;
 *   • and every action reloads the page the agent is ON, with what was chosen.
 */

const { api, search } = vi.hoisted(() => ({ api: vi.fn(), search: { value: '' } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>متابعة الشحن</h1> }));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => async () => null,
  useConfirm: () => async () => true,
}));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { TrackingScreen } from './TrackingScreen';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const R1 = '33333333-3333-4333-8333-333333333333';

const parcel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus: 'SHIPPED',
  collectionStatus: 'NOT_APPLICABLE',
  settlementStatus: 'NOT_APPLICABLE',
  daysInTransit: 1,
  lateThresholdDays: 3,
  late: false,
  totalAmount: 40,
  currency: 'JOD',
  deliveryFailureReason: null,
  customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
  region: { name: 'عمّان' },
  deliveryProvider: { id: P1, name: 'أبو علي', kind: 'COMPANY' },
  expectedCollection: 37.5,
  _count: { deliveryAttempts: 0, notes: 0 },
  alert: null,
  ...over,
});

const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };
const FACTS = {
  total: 60,
  tasks: { ...NO_TASKS, CANCELLED: 3, LATE: 11, COLLECT: 7 },
  lateCount: 11,
  couriers: [
    { id: P1, name: 'أبو علي', count: 40 },
    { id: P2, name: 'أمان', count: 15 },
    { id: 'none', name: 'بلا شركة شحن', count: 5 },
  ],
  regions: [
    { id: R1, name: 'عمّان', count: 45 },
    { id: 'none', name: 'بلا محافظة', count: 15 },
  ],
  ages: { fresh: 12, few: 18, week: 20, old: 10 },
};

/** What the door says right now. */
let facts: typeof FACTS;
let total: number;
let rowsOf: (page: number) => ReturnType<typeof parcel>[];
let capped: boolean;
let firstFails: boolean;

const gets = () =>
  api.mock.calls.filter((c) => !(c[1] && (c[1] as RequestInit).method)).map((c) => new URL(c[0] as string, 'http://x').searchParams);
const posts = () => api.mock.calls.filter((c) => c[1] && (c[1] as RequestInit).method === 'POST');
const lastAsked = () => gets().at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  search.value = '';
  facts = structuredClone(FACTS);
  total = 60;
  capped = false;
  firstFails = false;
  rowsOf = (page) => [parcel(`P${page}`)];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { message: 'سُجِّل' };
    if (firstFails && api.mock.calls.length === 1) throw new Error('تعذّر التحميل');
    const q = new URL(url, 'http://x').searchParams;
    const totalPages = Math.max(1, Math.ceil(total / 25));
    const page = Math.min(Number(q.get('page')), totalPages);
    return {
      count: total === 0 ? 0 : 1,
      orders: total === 0 ? [] : rowsOf(page),
      lateCount: facts.lateCount,
      dialCode: '962',
      pagination: { total, page, limit: 25, totalPages },
      facts,
      applied: {},
      capped,
    };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TrackingScreen />);
  await screen.findByLabelText('جهة الشحن');
};
const box = () => screen.getByLabelText('بحث') as HTMLInputElement;
const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((o) => o.textContent);
const chip = (re: RegExp) => screen.queryByRole('button', { name: re });
const pagerSentence = (found: boolean) =>
  (found ? screen.getByText : screen.queryByText)((_, el) => el?.tagName === 'SPAN' && /^عرض \d+ من \d+ شحنة$/.test(el.textContent ?? ''));

describe('opening it', () => {
  it('— asks for page one, 25 to a page, and nothing else: the default state is the screen’s own', async () => {
    await draw();
    expect(gets()).toHaveLength(1);
    expect(gets()[0].toString()).toBe('page=1&limit=25');
  });

  it('and the search box is a REAL labelled field, there before the first answer', async () => {
    render(<TrackingScreen />);
    const field = box();
    expect(field.tagName).toBe('INPUT');
    expect(field.id).toBeTruthy();
    expect(document.querySelector(`label[for="${field.id}"]`)?.textContent).toBe('بحث');
    await screen.findByLabelText('جهة الشحن');
  });

  it('and a link that carries an order number opens already searching it — the first question has the word in it', async () => {
    search.value = 'order=SY-2026-0148';
    await draw();
    expect(box().value).toBe('SY-2026-0148');
    expect(gets()[0].get('q')).toBe('SY-2026-0148');
  });

  it('and a first load that fails says so — and the box is still there', async () => {
    firstFails = true;
    render(<TrackingScreen />);
    expect(await screen.findByText('تعذّر التحميل')).toBeTruthy();
    expect(box()).toBeTruthy();
  });

  it('and draws the page, with a bar that says where it stands', async () => {
    await draw();
    expect(screen.getAllByText('ORD-P1').length).toBeGreaterThan(0);
    expect(pagerSentence(true)!.textContent).toBe('عرض 1 من 60 شحنة');
    expect(screen.getByText('صفحة 1 من 3')).toBeTruthy();
  });

  it('and nothing is «chosen» on opening: no «إعادة تعيين»', async () => {
    await draw();
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
  });
});

describe('the chips and the badge — the server’s numbers', () => {
  it('— «الكل» is the whole of the list, each chip has its number, and a chip nobody is in is not drawn', async () => {
    await draw();
    expect(chip(/^الكل 60$/)).toBeTruthy();
    expect(chip(/أُلغي والطرد يسير 3/)).toBeTruthy();
    expect(chip(/متأخرة 11/)).toBeTruthy();
    expect(chip(/بانتظار التحصيل 7/)).toBeTruthy();
    expect(chip(/تغيّرت بياناته/)).toBeNull();
    expect(chip(/فشل التوصيل \d/)).toBeNull();
    expect(chip(/بلا باركود/)).toBeNull();
  });

  it('and the badge says how many are late over ALL of the list — not the one on this page', async () => {
    await draw();
    expect(screen.getByText(/11 شحنة متأخرة/)).toBeTruthy();
    cleanup();
    facts = { ...FACTS, lateCount: 0, tasks: { ...NO_TASKS } };
    render(<TrackingScreen />);
    await screen.findByLabelText('جهة الشحن');
    expect(screen.queryByText(/شحنة متأخرة/)).toBeNull();
  });

  it('and pressing a chip is a QUESTION for the server — `task`, from page one — and «الكل» takes it back', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    fireEvent.click(chip(/متأخرة 11/)!);
    await waitFor(() => expect(lastAsked().get('task')).toBe('LATE'));
    expect(lastAsked().get('page')).toBe('1');
    fireEvent.click(chip(/^الكل 60$/)!);
    await waitFor(() => expect(lastAsked().has('task')).toBe(false));
  });

  it('and the chip in force is the one marked — the others keep their tone', async () => {
    await draw();
    const late = chip(/متأخرة 11/)!;
    const before = late.className;
    fireEvent.click(late);
    await waitFor(() => expect(lastAsked().get('task')).toBe('LATE'));
    expect(chip(/متأخرة 11/)!.className).not.toBe(before);
  });

  it('and a chip whose last parcel was just dealt with is put back at «الكل» — a filter on a condition nobody meets is a dead end', async () => {
    await draw();
    fireEvent.click(chip(/أُلغي والطرد يسير 3/)!);
    await waitFor(() => expect(lastAsked().get('task')).toBe('CANCELLED'));
    // The last cancelled parcel was acknowledged: the numbers no longer hold it.
    facts = { ...facts, tasks: { ...facts.tasks, CANCELLED: 0 } };
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().has('task')).toBe(false));
  });
});

describe('the toolbar', () => {
  it('— the state is always there; the company, the governorate and the age come with the server’s numbers', async () => {
    await draw();
    expect(options('الحالة')[0]).toBe('قيد الشحن وبانتظار التحصيل');
    expect(options('الحالة')).toContain('الكل');
    expect(options('جهة الشحن')).toEqual(['كل الجهات', 'أبو علي (40)', 'أمان (15)', 'بلا شركة شحن (5)']);
    expect(options('المحافظة')).toEqual(['كل المحافظات', 'عمّان (45)', 'بلا محافظة (15)']);
    expect(options('مدّة الشحن')).toEqual(['أيّ مدّة', 'اليوم أو أمس (12)', 'منذ 2–3 أيام (18)', 'منذ 4–7 أيام (20)', 'أكثر من أسبوع (10)']);
  });

  it('and the state’s box is a real labelled field too', async () => {
    await draw();
    const status = screen.getByLabelText('الحالة');
    expect(status.tagName).toBe('SELECT');
    expect(document.querySelector(`label[for="${status.id}"]`)).toBeTruthy();
  });

  it('and a company the new counts no longer hold stays in its box, with a zero', async () => {
    await draw();
    choose('جهة الشحن', P2);
    await waitFor(() => expect(lastAsked().get('courier')).toBe(P2));
    facts = { ...facts, couriers: [{ id: P1, name: 'أبو علي', count: 40 }] };
    choose('المحافظة', R1);
    await waitFor(() => expect(lastAsked().get('region')).toBe(R1));
    expect(options('جهة الشحن')).toEqual(['كل الجهات', 'أبو علي (40)', `${P2} (0)`]);
    expect((screen.getByLabelText('جهة الشحن') as HTMLSelectElement).value).toBe(P2);
  });
});

describe('choosing', () => {
  it('— a state is asked for by its word; the default is not sent; «الكل» is `every`, because `all` is «no filter» to the list hook', async () => {
    await draw();
    choose('الحالة', 'RETURN_REQUESTED');
    await waitFor(() => expect(lastAsked().get('status')).toBe('RETURN_REQUESTED'));
    choose('الحالة', 'every');
    await waitFor(() => expect(lastAsked().get('status')).toBe('every'));
    choose('الحالة', '');
    await waitFor(() => expect(lastAsked().has('status')).toBe(false));
  });

  it('and the dropdowns together are one question — every one that was chosen, none that was not', async () => {
    await draw();
    choose('جهة الشحن', 'none');
    choose('المحافظة', R1);
    choose('مدّة الشحن', 'old');
    await waitFor(() => expect(lastAsked().get('age')).toBe('old'));
    expect(lastAsked().toString()).toBe(`age=old&courier=none&region=${R1}&page=1&limit=25`);
  });

  it('and a change starts again at page one, from wherever the reader was', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    choose('مدّة الشحن', 'week');
    await waitFor(() => expect(lastAsked().get('age')).toBe('week'));
    expect(lastAsked().get('page')).toBe('1');
  });

  it('and a typed word is asked after the burst, trimmed; blanks are nothing', async () => {
    await draw();
    fireEvent.change(box(), { target: { value: '  0791  ' } });
    await waitFor(() => expect(lastAsked().get('q')).toBe('0791'));
    fireEvent.change(box(), { target: { value: '   ' } });
    await waitFor(() => expect(lastAsked().has('q')).toBe(false));
  });

  it('and «إعادة تعيين» counts the state, the chip, the dropdowns and the word — and puts every one back', async () => {
    await draw();
    choose('الحالة', 'RETURNED');
    choose('جهة الشحن', P1);
    choose('المحافظة', R1);
    choose('مدّة الشحن', 'few');
    fireEvent.click(chip(/متأخرة 11/)!);
    fireEvent.change(box(), { target: { value: 'TRK' } });
    const reset = await screen.findByRole('button', { name: 'إعادة تعيين (6)' });
    fireEvent.click(reset);
    await waitFor(() => expect(lastAsked().toString()).toBe('page=1&limit=25'));
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
    expect(box().value).toBe('');
    expect((screen.getByLabelText('الحالة') as HTMLSelectElement).value).toBe('');
    for (const label of ['جهة الشحن', 'المحافظة']) expect((screen.getByLabelText(label) as HTMLSelectElement).value, label).toBe('all');
  });
});

describe('the pages', () => {
  it('— a list that fits one page has no bar at all', async () => {
    total = 7;
    await draw();
    expect(screen.queryByRole('button', { name: 'الصفحة التالية' })).toBeNull();
    expect(pagerSentence(false)).toBeNull();
  });

  it('and «التالي» turns the SAME list — it keeps the chip and the dropdowns', async () => {
    await draw();
    fireEvent.click(chip(/متأخرة 11/)!);
    choose('جهة الشحن', P1);
    await waitFor(() => expect(lastAsked().get('courier')).toBe(P1));
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    expect(lastAsked().get('task')).toBe('LATE');
    expect(lastAsked().get('courier')).toBe(P1);
    expect(screen.getAllByText('ORD-P2').length).toBeGreaterThan(0);
  });

  it('and the list is drawn as the server gave it — worst first — the screen sorts nothing', async () => {
    rowsOf = () => [parcel('z'), parcel('a'), parcel('m')];
    await draw();
    const order = screen.getAllByText(/^ORD-/).map((el) => el.textContent).filter((v, i, all) => all.indexOf(v) === i);
    expect(order).toEqual(['ORD-z', 'ORD-a', 'ORD-m']);
  });

  it('and a list the read could not hold whole says so — it is never silently shorter than it looks', async () => {
    capped = true;
    await draw();
    expect(screen.getByText(/أقدم 20000 شحنة/)).toBeTruthy();
    cleanup();
    capped = false;
    await draw();
    expect(screen.queryByText(/أقدم 20000 شحنة/)).toBeNull();
  });
});

describe('«غير متأخرة» — the chip that is not a fault', () => {
  it('— is drawn with the server’s number, asks the server for NOT_LATE, and is not drawn when nobody is in it', async () => {
    facts = { ...FACTS, notLate: 9 } as typeof FACTS;
    await draw();
    expect(chip(/غير متأخرة 9/)).toBeTruthy();
    // The late chip is a different chip: «متأخرة 11» must not be found inside «غير متأخرة».
    expect(chip(/^متأخرة 11$/)).toBeTruthy();
    fireEvent.click(chip(/غير متأخرة 9/)!);
    await waitFor(() => expect(lastAsked().get('task')).toBe('NOT_LATE'));
    cleanup();
    facts = { ...FACTS, notLate: 0 } as typeof FACTS;
    await draw();
    expect(chip(/غير متأخرة/)).toBeNull();
  });
});

describe('collecting by hand, on the page that is shown', () => {
  const collectable = (id: string) => parcel(id, { shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', collectionStatus: 'PENDING_COLLECTION' });

  it('— the bar says the SERVER’S total of owed parcels, and «اختر الكل» takes the ones on THIS page', async () => {
    rowsOf = (page) => [collectable(`C${page}a`), collectable(`C${page}b`), parcel(`S${page}`)];
    await draw();
    // FACTS.tasks.COLLECT is 7: the page holds two of them, and the bar still says seven.
    expect(screen.getByText('7 مسلَّم بانتظار التحصيل —')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اختر الكل' }));
    expect(screen.getByText(/مختار 2 طلب · صافي 75/)).toBeTruthy();
  });

  it('— and the bar is there when this page holds none of them: money waits LAST in a worst-first list, so page one rarely does', async () => {
    rowsOf = (page) => [parcel(`S${page}a`), parcel(`S${page}b`)];
    await draw();
    expect(screen.getByText('7 مسلَّم بانتظار التحصيل —')).toBeTruthy();
    // Nothing on the page to tick, so no «اختر الكل» — but the way to them is one press.
    expect(screen.queryByRole('button', { name: 'اختر الكل' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'اعرضها' }));
    await waitFor(() => expect(lastAsked().get('task')).toBe('COLLECT'));
  });

  it('— the number does not move with the page: turning to page two says the same seven', async () => {
    rowsOf = (page) => [parcel(`S${page}`)];
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    expect(screen.getByText('7 مسلَّم بانتظار التحصيل —')).toBeTruthy();
  });

  it('— with the owed chip already pressed the link to it is gone, and with nothing owed the bar is not drawn', async () => {
    rowsOf = (page) => [collectable(`C${page}a`)];
    await draw();
    fireEvent.click(chip(/بانتظار التحصيل 7/)!);
    await waitFor(() => expect(lastAsked().get('task')).toBe('COLLECT'));
    expect(screen.getByText('7 مسلَّم بانتظار التحصيل')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'اعرضها' })).toBeNull();
    cleanup();
    facts = { ...FACTS, tasks: { ...NO_TASKS, LATE: 11 } };
    await draw();
    expect(screen.queryByText(/مسلَّم بانتظار التحصيل/)).toBeNull();
  });

  it('and a new question starts a new selection — what was ticked was on a page that is not on screen any more', async () => {
    rowsOf = (page) => [collectable(`C${page}a`), collectable(`C${page}b`)];
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'اختر الكل' }));
    expect(screen.getByText(/مختار 2 طلب/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    expect(screen.queryByText(/مختار \d+ طلب/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'اختر الكل' }));
    choose('جهة الشحن', P1);
    await waitFor(() => expect(lastAsked().get('courier')).toBe(P1));
    expect(screen.queryByText(/مختار \d+ طلب/)).toBeNull();
  });

  it('and a page turn puts the ticks away — the page they were made on, come back to, is not found ticked', async () => {
    rowsOf = (page) => [collectable(`C${page}a`), collectable(`C${page}b`)];
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'اختر الكل' }));
    expect(screen.getByText(/مختار 2 طلب/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة السابقة' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('1'));
    expect(screen.getAllByText('ORD-C1a').length).toBeGreaterThan(0);
    expect(screen.queryByText(/مختار \d+ طلب/)).toBeNull();
  });

  it('and pressing a chip puts the ticks away too — a chip, or «الكل», is a new question', async () => {
    rowsOf = (page) => [collectable(`C${page}a`), collectable(`C${page}b`)];
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'اختر الكل' }));
    expect(screen.getByText(/مختار 2 طلب/)).toBeTruthy();
    fireEvent.click(chip(/متأخرة 11/)!);
    await waitFor(() => expect(lastAsked().get('task')).toBe('LATE'));
    expect(screen.queryByText(/مختار \d+ طلب/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'اختر الكل' }));
    expect(screen.getByText(/مختار 2 طلب/)).toBeTruthy();
    fireEvent.click(chip(/^الكل 60$/)!);
    await waitFor(() => expect(lastAsked().has('task')).toBe(false));
    expect(screen.queryByText(/مختار \d+ طلب/)).toBeNull();
  });

  it('and a dropdown puts the ticks away too — the same parcels coming back under a new question are not found ticked', async () => {
    rowsOf = (page) => [collectable(`C${page}a`), collectable(`C${page}b`)];
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'اختر الكل' }));
    expect(screen.getByText(/مختار 2 طلب/)).toBeTruthy();
    choose('جهة الشحن', P1);
    await waitFor(() => expect(lastAsked().get('courier')).toBe(P1));
    expect(screen.getAllByText('ORD-C1a').length).toBeGreaterThan(0);
    expect(screen.queryByText(/مختار \d+ طلب/)).toBeNull();
  });
});

describe('an action reloads the page the agent is ON', () => {
  it('— «استلم» records the door’s answer, says so, and asks again for the same page with the same choices', async () => {
    await draw();
    choose('الحالة', 'SHIPPED');
    await waitFor(() => expect(lastAsked().get('status')).toBe('SHIPPED'));
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    const before = gets().length;
    fireEvent.click(screen.getAllByRole('button', { name: 'استلم' })[0]);
    await screen.findByText('سُجِّل');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse((posts()[0][1] as RequestInit).body as string)).toEqual({ orderId: 'P2', outcome: 'ALL' });
    await waitFor(() => expect(gets().length).toBeGreaterThan(before));
    expect(lastAsked().get('page')).toBe('2');
    expect(lastAsked().get('status')).toBe('SHIPPED');
  });
});

describe('ringing the customer from the row', () => {
  it('— WhatsApp opens on the number in full international form: the calling code comes with the answer, the screen knows no country', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const list = api.getMockImplementation()!;
    api.mockImplementation(async (url: string, init?: RequestInit) =>
      url.startsWith('/api/settings/messages')
        ? { templates: [{ id: 't1', name: 'رسالة المتابعة', channel: 'BOTH', body: 'طلبك {رقم_الطلب}', situation: 'SHIPPED', lang: 'ar', active: true }] }
        : list(url, init)
    );
    await draw();
    fireEvent.click(screen.getAllByTitle('واتساب')[0]);
    fireEvent.click(await screen.findByText('رسالة المتابعة'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatch(/^https:\/\/wa\.me\/962790000000\?text=/);
    vi.unstubAllGlobals();
  });
});

describe('when nothing is there', () => {
  it('— says that the search or the state matched nothing, and how to widen it', async () => {
    total = 0;
    facts = { ...FACTS, total: 0, tasks: { ...NO_TASKS }, lateCount: 0 };
    await draw();
    expect(screen.getByText('لا شحناتٍ في هذا المرشِّح')).toBeTruthy();
    expect(screen.getByText(/لا شحنة تطابق البحث أو الحالة المختارة/)).toBeTruthy();
  });
});

describe('how it is built', () => {
  const src = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/TrackingScreen.tsx'), 'utf8'));

  it('— from the kit: the hook, the toolbar and the page bar; no loader, no refresh and no sort of its own', () => {
    expect(src()).toContain("from '@/hooks/usePagedList'");
    expect(src()).toContain("from '@/components/ui/ListToolbar'");
    expect(src()).toContain("from '@/components/ui/Pager'");
    expect(src(), 'عاد المحمِّل المكتوب باليد').not.toMatch(/useLiveRefresh|useCallback|setData\(/);
    expect(src(), 'عاد الفرزُ في المتصفّح').not.toMatch(/byUrgency|\.sort\(/);
    expect(src(), 'عادت الشرائح تُعَدُّ في المتصفّح').not.toMatch(/MATCHES\[/);
  });

  it('and the arrows are drawn only when there IS a second page', () => {
    expect(src()).toMatch(/\{pagination\.totalPages > 1 &&/);
  });

  it('and the chips are the server’s: counted from `facts`, drawn from the ranking’s own names', () => {
    expect(src()).toContain('facts.tasks[key]');
    expect(src()).toContain("from '@/lib/tracking-filters'");
    expect(src()).not.toMatch(/'CANCELLED', 'CHANGED', 'FAILED'/);
  });

  it('and it counts no day and compares no date — the days and the lateness are the door’s', () => {
    expect(src()).not.toMatch(/Date\.now\(\)|new Date\(\)|getTime\(\)/);
  });
});
