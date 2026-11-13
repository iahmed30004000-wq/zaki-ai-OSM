// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STATEMENT_CLOSED_SENTENCE } from '@/lib/settlement-gates';
import { NEEDS_REVIEW_KEY_AR } from '@/lib/parcel-tracking/difference-words';

/**
 * «فيه فرق» — WHAT THE FOLLOW-UP SCREEN DRAWS (13/11).
 *
 *   «واذا المطابقة رجعت في فرق حط جنبو علامة انو في فرق عشان بنت المتابعة تشيك او اعمل قائمة ع محصل فيه فرق
 *    عشان بنت المتابعة تبث فيه وتعتمد رقمنا او رقم الشركة»
 *
 * The door sends each row of a person who holds the money sight a `difference` (or null) and the chip's number; the screen:
 *
 *   • draws a MARK beside the row's other chips — a real button, 44px on a phone, on the desk and on the card — with the gap
 *     said as a word (نقص / زيادة) and the figure, and once answered the answer's own word in its place;
 *   • draws the CHIP «فيه فرق N» with the server's number (never the page's), asks for exactly that word, and takes it back;
 *   • opens a DIALOG from the mark: the two figures, the company's own word, and the matching screen's own answers MOUNTED —
 *     the same field, the same buttons, the same door — only for a person the server says may decide, and never after the
 *     statement's matching is closed (the door's own sentence instead);
 *   • and draws nothing of it for an older server, nor for a row that carries none.
 */

const { api, tell, toast } = vi.hoisted(() => ({
  api: vi.fn(),
  tell: vi.fn<(options: unknown) => Promise<void>>(async () => undefined),
  toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>متابعة الشحن</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => true, useTell: () => tell }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { TrackingScreen } from '@/components/screens/TrackingScreen';

// What a test awaits it may wait eight seconds for: a loaded machine is not a failing test.
configure({ asyncUtilTimeout: 8000 });

const P1 = '11111111-1111-4111-8111-111111111111';
const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };
const SAID_COUNTS = { DELIVERED: 0, PARTIALLY_DELIVERED: 0, RETURNED: 0, CANCELLED: 0, FAILED_DELIVERY: 0 };
const RESOLVE = '/api/finance/statements/st1/matches/m1/resolve';

type Any = Record<string, any>;

const OK = { allowed: true, why: null };
const diff = (over: Any = {}): Any => ({
  matchId: 'm1',
  statementId: 'st1',
  statement: 'ST-2026-0007',
  ours: 20,
  theirs: 17,
  gap: 3,
  answered: false,
  resolution: null,
  resolutionNote: null,
  claim: null,
  closed: false,
  note: null,
  decisions: null,
  courierWord: { phrase: 'تم التوصيل', outcome: 'DELIVERED', known: true, label: 'تقول الشركة: سُلِّم' },
  statementLine: {
    merchantRef: 'REF-1',
    barcode: 'TRK-a',
    amount: 17,
    collected: 20,
    fee: 3,
    status: 'تم التوصيل',
    rawRow: 'REF-1 | تم التوصيل | 17 | العميل طلب خصم',
    receiverName: 'سارة',
    receiverPhone: '0790000000',
    receiverAddress: 'تلاع العلي',
    receiverCity: 'عمّان',
    receiverArea: null,
  },
  ...over,
});

const parcel = (id: string, over: Any = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus: 'DELIVERED',
  collectionStatus: 'PENDING_COLLECTION',
  settlementStatus: 'PENDING_COLLECTION',
  daysInTransit: 4,
  lateThresholdDays: 3,
  late: false,
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
  difference: null,
  ...over,
});

const ACTS_DECIDER = { deliver: true, transfer: true, writeOff: true, closeLegacy: false, decide: true };
const ACTS_VIEWER = { deliver: true, transfer: true, writeOff: true, closeLegacy: false, decide: false };

let rows: Any[];
/** What the door says the chip holds; `undefined` leaves the field out, as an older server does. */
let chipNumber: number | undefined;
let chipRows: Any[] | null;
let acts: Any | undefined;
let access: Any;

const gets = () =>
  api.mock.calls.filter((c) => !(c[1] && (c[1] as RequestInit).method)).map((c) => new URL(c[0] as string, 'http://x').searchParams);
const posts = () => api.mock.calls.filter((c) => c[1] && (c[1] as RequestInit).method === 'POST');

beforeEach(() => {
  vi.clearAllMocks();
  rows = [parcel('a', { difference: diff() })];
  chipNumber = 1;
  chipRows = null;
  acts = ACTS_DECIDER;
  access = { money: true, returns: true, collect: false };
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { match: {}, message: 'تم' };
    const q = new URL(url, 'http://x').searchParams;
    const shown = q.get('task') === 'DIFFERENCE' && chipRows ? chipRows : rows;
    return {
      count: shown.length,
      orders: shown,
      lateCount: 0,
      dialCode: '962',
      pagination: { total: shown.length, page: 1, limit: 25, totalPages: 1 },
      facts: {
        total: rows.length,
        tasks: NO_TASKS,
        lateCount: 0,
        notLate: 0,
        couriers: [{ id: P1, name: 'الباشا', count: rows.length }],
        regions: [],
        ages: { fresh: 0, few: rows.length, week: 0, old: 0 },
        said: SAID_COUNTS,
        ...(chipNumber === undefined ? {} : { difference: chipNumber }),
      },
      applied: {},
      capped: false,
      access,
      ...(acts === undefined ? {} : { acts }),
    };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TrackingScreen />);
  await screen.findByLabelText('جهة الشحن');
};
/** The desk's table, and the phone's cards — `Rows` draws both and the stylesheet shows one. */
const desk = () => document.querySelector('table') as HTMLElement;
const cards = () => document.querySelector('ul.md\\:hidden') as HTMLElement;
const MARK = /فيه فرق|اعتُمد رقم الشركة|رقمنا هو المعتمد|قيد المراجعة/;
const markIn = (root: HTMLElement) => within(root).getByRole('button', { name: MARK });
const openDialog = async () => {
  await draw();
  fireEvent.click(markIn(desk()));
  return await screen.findByRole('dialog');
};

describe('the mark — beside the row’s other chips, on the desk and on the card', () => {
  it('is a real button on the desk and on the phone card, saying «فيه فرق», that it is a shortage, and by how much', async () => {
    await draw();
    for (const root of [desk(), cards()]) {
      const mark = markIn(root);
      expect(mark.tagName).toBe('BUTTON');
      expect(mark.getAttribute('type')).toBe('button');
      expect(mark.textContent).toContain('فيه فرق');
      expect(mark.textContent).toContain('نقص');
      expect(mark.textContent).toContain('3.00 JOD');
    }
  });

  it('draws one mark per parcel that carries one — and none for a parcel that does not', async () => {
    rows = [parcel('a', { difference: diff() }), parcel('b'), parcel('c', { difference: diff({ matchId: 'm3', gap: -2 }) })];
    await draw();
    expect(within(desk()).getAllByRole('button', { name: MARK })).toHaveLength(2);
    expect(within(cards()).getAllByRole('button', { name: MARK })).toHaveLength(2);
  });

  it('says a shortage as «نقص», more than we expected as «زيادة» — and says nothing of an amount when the figures agree', async () => {
    rows = [
      parcel('a', { difference: diff({ gap: 3 }) }),
      parcel('b', { difference: diff({ matchId: 'm2', gap: -2.5 }) }),
      parcel('c', { difference: diff({ matchId: 'm3', gap: 0, note: 'أجرة التوصيل 4 بدل 3' }) }),
      parcel('d', { difference: diff({ matchId: 'm4', gap: null }) }),
    ];
    await draw();
    const marks = within(desk()).getAllByRole('button', { name: MARK });
    expect(marks.map((m) => m.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'فيه فرق · نقص 3.00 JOD',
      'فيه فرق · زيادة 2.50 JOD',
      'فيه فرق',
      'فيه فرق',
    ]);
    // the sign is a WORD: no minus sign and no plus sign on the mark
    for (const m of marks) expect(m.textContent).not.toMatch(/[+\-−]/);
  });

  it('wears the colour of «not answered yet» — red — and a mark that is answered stops being red', async () => {
    rows = [parcel('a', { difference: diff() }), parcel('b', { difference: diff({ matchId: 'm2', answered: true, resolution: 'ACCEPTED_COURIER' }) })];
    await draw();
    const [open, answered] = within(desk()).getAllByRole('button', { name: MARK });
    expect(open.className).toContain('--sys-destructive');
    expect(answered.className).not.toContain('--sys-destructive');
    expect(answered.className).toContain('--sys-success');
  });

  it.each([
    ['ACCEPTED_COURIER', 'اعتُمد رقم الشركة', '--sys-success'],
    ['OURS_STANDS', 'رقمنا هو المعتمد', '--sys-success'],
    ['UNDER_REVIEW', 'قيد المراجعة', '--sys-warning'],
  ])('once answered — %s — it wears the answer’s own word in place of the red one, with the figure beside it', async (resolution, word, token) => {
    rows = [parcel('a', { difference: diff({ answered: true, resolution, resolutionNote: 'سبب مكتوب' }) })];
    await draw();
    for (const root of [desk(), cards()]) {
      const mark = markIn(root);
      expect(mark.textContent).toContain(word);
      expect(mark.textContent).not.toContain('فيه فرق');
      // the difference still happened: the order stays marked, with what it was
      expect(mark.textContent).toContain('نقص');
      expect(mark.textContent).toContain('3.00 JOD');
      expect(mark.className).toContain(token);
    }
  });

  it('an answer this screen has no word for is said as «انبتّ فيه» — never the code', async () => {
    rows = [parcel('a', { difference: diff({ answered: true, resolution: 'SOMETHING_NEW' }) })];
    await draw();
    expect(within(desk()).getByRole('button', { name: /^انبتّ فيه/ }).textContent).toContain('انبتّ فيه');
    expect(document.body.textContent).not.toContain('SOMETHING_NEW');
  });

  it('is a 44px target on a phone and an ordinary chip on a desk', async () => {
    await draw();
    for (const root of [desk(), cards()]) {
      const tokens = markIn(root).className.split(/\s+/);
      expect(tokens).toContain('min-h-11');
      expect(tokens).toContain('md:min-h-0');
    }
  });

  it('sits with the other chips of the row’s heading — after the reason it is here, before the desk’s alert', async () => {
    rows = [parcel('a', { late: true, daysInTransit: 9, shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', difference: diff() })];
    await draw();
    const heading = markIn(desk()).closest('td')!;
    const text = heading.textContent!;
    expect(text.indexOf('متأخرة')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('متأخرة')).toBeLessThan(text.indexOf('فيه فرق'));
  });

  it('says in its tooltip what pressing it does — to look and decide for whoever may decide, to look for whoever may not', async () => {
    await draw();
    expect(markIn(desk()).getAttribute('title')).toContain('وتبتّ فيه');
    cleanup();
    acts = ACTS_VIEWER;
    await draw();
    expect(markIn(desk()).getAttribute('title')).not.toContain('وتبتّ فيه');
    expect(markIn(desk()).getAttribute('title')).toContain('اضغط تشوف الرقمين');
  });

  it('a closed statement says so in the tooltip, and an answered row says what it was answered with', async () => {
    rows = [parcel('a', { difference: diff({ closed: true, answered: true, resolution: 'ACCEPTED_COURIER' }) })];
    await draw();
    const title = markIn(desk()).getAttribute('title')!;
    expect(title).toContain('انبتّ فيه: اعتُمد رقم الشركة');
    expect(title).toContain('الكشف مغلق');
    expect(title).not.toContain('وتبتّ فيه');
  });

  it('draws nothing of it for a row with none, nor for an older server that has never heard of it', async () => {
    rows = [parcel('a'), parcel('b', { difference: undefined })];
    chipNumber = undefined;
    acts = { deliver: true, transfer: true, writeOff: true };
    await draw();
    expect(screen.queryByRole('button', { name: MARK })).toBeNull();
    expect(document.body.textContent).not.toContain('فيه فرق');
    // …and nothing else broke: the rows are there, the strip too
    expect(within(desk()).getAllByText('ORD-a').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^الكل 2$/ })).toBeTruthy();
  });

  it('and nothing it draws is English — the figure’s currency code apart', async () => {
    rows = [
      parcel('a', { difference: diff() }),
      parcel('b', { difference: diff({ matchId: 'm2', gap: -1, answered: true, resolution: 'UNDER_REVIEW' }) }),
    ];
    await draw();
    for (const m of within(desk()).getAllByRole('button', { name: MARK })) {
      expect(m.textContent!.replace(/\d+(?:\.\d+)? [A-Z]{3}/g, '')).not.toMatch(/[A-Za-z]/);
      expect(m.getAttribute('title')).not.toMatch(/[A-Za-z]/);
    }
  });
});

describe('the chip «فيه فرق» — the server’s number, and the rows it brings', () => {
  const chip = (n: number) => screen.getByRole('button', { name: new RegExp(`^فيه فرق ${n}$`) });

  it('is drawn with the SERVER’s number — over every parcel the list holds, not the one row this page has', async () => {
    chipNumber = 7;
    await draw();
    expect(chip(7)).toBeTruthy();
    expect(rows).toHaveLength(1);
  });

  it('sits in the strip with «الكل» and the others — before «غير متأخرة», the one chip that is not a fault', async () => {
    chipNumber = 3;
    rows = [parcel('a', { difference: diff() }), parcel('b', { shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', late: false, daysInTransit: 1 })];
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return {};
      return {
        count: 2,
        orders: rows,
        lateCount: 0,
        dialCode: '962',
        pagination: { total: 2, page: 1, limit: 25, totalPages: 1 },
        facts: { total: 2, tasks: { ...NO_TASKS, COLLECT: 1 }, lateCount: 0, notLate: 1, couriers: [], regions: [], ages: { fresh: 1, few: 1, week: 0, old: 0 }, said: SAID_COUNTS, difference: 3 },
        applied: {},
        capped: false,
        access,
        acts,
      };
    });
    await draw();
    const strip = chip(3).parentElement!;
    const labels = [...strip.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['الكل 2', 'بانتظار التحصيل 1', 'فيه فرق 3', 'غير متأخرة 1']);
  });

  it('pressing it asks the server for exactly that word, from page one; «الكل» takes it back out', async () => {
    chipRows = [parcel('z', { difference: diff() })];
    await draw();
    fireEvent.click(chip(1));
    await waitFor(() => expect(gets().at(-1)!.get('task')).toBe('DIFFERENCE'));
    expect(gets().at(-1)!.get('page')).toBe('1');
    fireEvent.click(await screen.findByRole('button', { name: /^الكل 1$/ }));
    await waitFor(() => expect(gets().at(-1)!.has('task')).toBe(false));
  });

  it('the rows it brings are the server’s — the screen filters nothing itself', async () => {
    rows = [parcel('a'), parcel('b'), parcel('c', { difference: diff() })];
    chipRows = [parcel('c', { difference: diff() })];
    chipNumber = 1;
    await draw();
    expect(within(desk()).getAllByText(/^ORD-/)).toHaveLength(3);
    fireEvent.click(chip(1));
    await waitFor(() => expect(within(desk()).getAllByText(/^ORD-/)).toHaveLength(1));
    expect(within(desk()).getByText('ORD-c')).toBeTruthy();
  });

  it('is the chip of the highlighted kind while pressed: it wears the selected colours', async () => {
    chipRows = [parcel('z', { difference: diff() })];
    await draw();
    expect(chip(1).className).toContain('--sys-destructive');
    fireEvent.click(chip(1));
    await waitFor(() => expect(chip(1).className).toContain('--sys-heading'));
  });

  it('a chip nobody is in is not drawn: a zero, and an older server’s silence, draw none', async () => {
    chipNumber = 0;
    rows = [parcel('a')];
    await draw();
    expect(screen.queryByRole('button', { name: /^فيه فرق/ })).toBeNull();
    cleanup();
    chipNumber = undefined;
    await draw();
    expect(screen.queryByRole('button', { name: /^فيه فرق/ })).toBeNull();
  });

  it('is one of the choices «إعادة تعيين» counts and clears', async () => {
    chipRows = [parcel('z', { difference: diff() })];
    await draw();
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
    fireEvent.click(chip(1));
    fireEvent.click(await screen.findByRole('button', { name: 'إعادة تعيين (1)' }));
    await waitFor(() => expect(gets().at(-1)!.has('task')).toBe(false));
  });

  it('has a reason on it that says what to do, in Arabic', async () => {
    await draw();
    const why = chip(1).getAttribute('title')!;
    expect(why).toContain('ابتّ فيه');
    expect(why).not.toMatch(/[A-Za-z]/);
  });
});

describe('the dialog — the two figures, the company’s word, and the answers of the matching screen', () => {
  it('opens from the mark on the desk and on the card, and shows the order, the statement, both figures and the gap', async () => {
    await draw();
    fireEvent.click(markIn(cards()));
    const d = await screen.findByRole('dialog', { name: 'فيه فرق — ORD-a' });
    expect(within(d).getByText('كشف ST-2026-0007')).toBeTruthy();
    expect(within(d).getByText('رقمنا').parentElement!.textContent).toContain('20.00 JOD');
    expect(within(d).getByText('رقم الشركة').parentElement!.textContent).toContain('17.00 JOD');
    expect(within(d).getByText(/^نقص:/).textContent).toContain('3.00 JOD');
  });

  it('shows the company’s own word for the line the way the matching screen does — its status, its phone, and the whole row one press away', async () => {
    const d = await openDialog();
    expect(within(d).getByText('ما كتبته الشركة عن السطر')).toBeTruthy();
    expect(within(d).getByText(/«تم التوصيل»/)).toBeTruthy();
    expect(within(d).getByText('تقول الشركة: سُلِّم')).toBeTruthy();
    expect(within(d).getByText('0790000000')).toBeTruthy();
    expect(within(d).getByText('النص الأصلي')).toBeTruthy();
    expect(d.textContent).toContain('العميل طلب خصم');
  });

  it('a person the door did not give the company’s line to (the cash box alone) sees the figures and no empty box where it would be', async () => {
    rows = [parcel('a', { difference: diff({ courierWord: null, statementLine: null }) })];
    const d = await openDialog();
    expect(within(d).getByText('رقمنا').parentElement!.textContent).toContain('20.00 JOD');
    expect(within(d).queryByText('ما كتبته الشركة عن السطر')).toBeNull();
    expect(d.textContent).not.toContain('النص الأصلي');
  });

  it('says the gap as «زيادة» when more arrived than we expected — and says no gap at all when the figures agree, with the matching’s own sentence', async () => {
    rows = [parcel('a', { difference: diff({ gap: -2, theirs: 22 }) })];
    let d = await openDialog();
    expect(within(d).getByText(/^زيادة:/).textContent).toContain('2.00 JOD');
    cleanup();
    rows = [parcel('a', { difference: diff({ gap: 0, theirs: 20, note: 'أجرة التوصيل 4 بدل 3' }) })];
    d = await openDialog();
    expect(within(d).queryByText(/^(نقص|زيادة):/)).toBeNull();
    expect(within(d).getByText('ملاحظة المطابقة: أجرة التوصيل 4 بدل 3')).toBeTruthy();
  });

  it('a missing figure is a dash, never a zero', async () => {
    rows = [parcel('a', { difference: diff({ ours: null, gap: null }) })];
    const d = await openDialog();
    expect(within(d).getByText('رقمنا').parentElement!.textContent).toBe('رقمنا—');
  });

  it('closes from «رجوع» and from the corner, and writes nothing', async () => {
    let d = await openDialog();
    fireEvent.click(within(d).getByRole('button', { name: 'رجوع' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(markIn(desk()));
    d = await screen.findByRole('dialog');
    fireEvent.click(within(d).getByRole('button', { name: 'إغلاق' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(0);
  });

  it('is drawn in Arabic and nothing else — the figures’ currency apart', async () => {
    const d = await openDialog();
    const text = d.textContent!.replace(/\d+(?:\.\d+)? [A-Z]{3}/g, '').replace(/REF-1|TRK-a|ST-2026-0007|ORD-a/g, '');
    expect(text).not.toMatch(/[A-Za-z]/);
  });
});

describe('the answers — the matching screen’s own, mounted, and offered only where the door would take them', () => {
  it('for a person who may decide: the explanation field and the three answers, each a real button', async () => {
    const d = await openDialog();
    expect(within(d).getByLabelText('تفسير القرار').tagName).toBe('INPUT');
    for (const name of [/اعتُمد رقم الشركة/, /رقمنا هو المعتمد/, 'قيد المراجعة']) {
      const b = within(d).getByRole('button', { name });
      expect(b.tagName).toBe('BUTTON');
      expect((b as HTMLButtonElement).disabled).toBe(false);
    }
    expect(within(d).getByRole('button', { name: /التعليقات الداخلية/ })).toBeTruthy();
  });

  it('the answer goes through the EXISTING door — the matching screen’s resolve — with the explanation, trimmed', async () => {
    const d = await openDialog();
    fireEvent.change(within(d).getByLabelText('تفسير القرار'), { target: { value: '  خصم اتفقت عليه الموظفة  ' } });
    fireEvent.click(within(d).getByRole('button', { name: /اعتُمد رقم الشركة/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0] as [string, { method: string; body: string }];
    expect(url).toBe(RESOLVE);
    expect(JSON.parse(init.body)).toEqual({ resolution: 'ACCEPTED_COURIER', note: 'خصم اتفقت عليه الموظفة' });
    // and it is the ONLY write: nothing else is sent to any other address
    expect(api.mock.calls.filter((c) => c[1] && (c[1] as RequestInit).method).map((c) => c[0])).toEqual([RESOLVE]);
  });

  it('each answer sends its own word to that door', async () => {
    for (const [name, resolution] of [
      [/رقمنا هو المعتمد/, 'OURS_STANDS'],
      ['قيد المراجعة', 'UNDER_REVIEW'],
    ] as const) {
      vi.clearAllMocks();
      cleanup();
      const d = await openDialog();
      fireEvent.change(within(d).getByLabelText('تفسير القرار'), { target: { value: 'ننتظر تصحيح الشركة' } });
      fireEvent.click(within(d).getByRole('button', { name }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(JSON.parse((posts()[0][1] as { body: string }).body)).toEqual({ resolution, note: 'ننتظر تصحيح الشركة' });
    }
  });

  it('the explanation is the matching screen’s: four characters never leave the browser, and the sentence says why', async () => {
    const d = await openDialog();
    fireEvent.change(within(d).getByLabelText('تفسير القرار'), { target: { value: 'خصم' } });
    fireEvent.click(within(d).getByRole('button', { name: /اعتُمد رقم الشركة/ }));
    expect(await within(d).findByText(/اكتب تفسيراً واضحاً: 5 أحرف على الأقل/)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('a success closes the dialog, says so on the screen, and reads the list again', async () => {
    const d = await openDialog();
    const before = gets().length;
    fireEvent.change(within(d).getByLabelText('تفسير القرار'), { target: { value: 'خصم اتفقت عليه الموظفة' } });
    fireEvent.click(within(d).getByRole('button', { name: /اعتُمد رقم الشركة/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('انبتّ بفرق ORD-a — بيضل الطلب معلَّماً')).toBeTruthy();
    await waitFor(() => expect(gets().length).toBeGreaterThan(before));
  });

  it('what the list shows afterwards is the server’s: the row, read again, wears the answer’s word', async () => {
    const d = await openDialog();
    fireEvent.change(within(d).getByLabelText('تفسير القرار'), { target: { value: 'خصم اتفقت عليه الموظفة' } });
    rows = [parcel('a', { difference: diff({ answered: true, resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم اتفقت عليه الموظفة' }) })];
    fireEvent.click(within(d).getByRole('button', { name: /اعتُمد رقم الشركة/ }));
    await waitFor(() => expect(markIn(desk()).textContent).toContain('اعتُمد رقم الشركة'));
    expect(markIn(desk()).textContent).not.toContain('فيه فرق');
  });

  it('the door’s refusal is shown inside the dialog, which stays open — and the list is not read again', async () => {
    api.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('الطلب مُسوّى أصلاً (حُصّل يدوياً أو بكشف) — لا بتّ عليه');
      return {
        count: 1, orders: rows, lateCount: 0, dialCode: '962', pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        facts: { total: 1, tasks: NO_TASKS, lateCount: 0, notLate: 0, couriers: [], regions: [], ages: { fresh: 0, few: 1, week: 0, old: 0 }, said: SAID_COUNTS, difference: 1 },
        applied: {}, capped: false, access, acts,
      };
    });
    const d = await openDialog();
    const before = gets().length;
    fireEvent.change(within(d).getByLabelText('تفسير القرار'), { target: { value: 'خصم اتفقت عليه الموظفة' } });
    fireEvent.click(within(d).getByRole('button', { name: /اعتُمد رقم الشركة/ }));
    expect(await within(d).findByText(/الطلب مُسوّى أصلاً/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(gets().length).toBe(before);
    expect(screen.queryByText(/انبتّ بفرق/)).toBeNull();
  });

  it('what the door’s matrix refuses is grey, with its own sentence — read from the answer, never decided here', async () => {
    rows = [
      parcel('a', {
        shippingStatus: 'SHIPPED',
        difference: diff({
          decisions: {
            ACCEPTED_COURIER: OK,
            OURS_STANDS: { allowed: false, why: 'الطرد لم يُسجَّل مسلَّماً بعد — لا مطالبة قبل التسليم' },
            UNDER_REVIEW: OK,
          },
        }),
      }),
    ];
    const d = await openDialog();
    expect((within(d).getByRole('button', { name: /رقمنا هو المعتمد/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(d).getByRole('button', { name: /اعتُمد رقم الشركة/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(d).getByRole('button', { name: 'قيد المراجعة' }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(d).getByText('الطرد لم يُسجَّل مسلَّماً بعد — لا مطالبة قبل التسليم')).toBeTruthy();
  });

  it('an answered difference shows its answer, its reason and the claim — and, until the statement closes, a way to answer again', async () => {
    rows = [parcel('a', { difference: diff({ answered: true, resolution: 'OURS_STANDS', resolutionNote: 'الشركة بتصلّح الرقم', claim: 3 }) })];
    const d = await openDialog();
    expect(within(d).getByText('رقمنا هو المعتمد')).toBeTruthy();
    expect(within(d).getByText('الشركة بتصلّح الرقم')).toBeTruthy();
    expect(d.textContent).toContain('مطالبة على الشركة 3 JOD');
    expect(within(d).getByRole('button', { name: 'غيّر البتّ' })).toBeTruthy();
    // the way to answer again is the matching screen’s own: the field appears and the same door takes it
    fireEvent.click(within(d).getByRole('button', { name: 'غيّر البتّ' }));
    expect(within(d).getByLabelText('تفسير القرار')).toBeTruthy();
  });
});

describe('who may decide — and the statement that is closed', () => {
  it('NEGATIVE: a person who may see the figures but not decide gets the figures, the company’s word and the sentence that says why — and no answer to press', async () => {
    acts = ACTS_VIEWER;
    const d = await openDialog();
    expect(within(d).getByText('رقمنا').parentElement!.textContent).toContain('20.00 JOD');
    expect(within(d).getByText(/«تم التوصيل»/)).toBeTruthy();
    expect(within(d).getByText(NEEDS_REVIEW_KEY_AR)).toBeTruthy();
    expect(within(d).queryByLabelText('تفسير القرار')).toBeNull();
    for (const name of [/اعتُمد رقم الشركة/, /رقمنا هو المعتمد/, 'قيد المراجعة']) expect(within(d).queryByRole('button', { name })).toBeNull();
    expect(NEEDS_REVIEW_KEY_AR).toContain('مراجعة المطابقات');
  });

  it('an older server, which never says `decide`, is read as «no» — the answers are not drawn', async () => {
    acts = { deliver: true, transfer: true, writeOff: true };
    const d = await openDialog();
    expect(within(d).queryByLabelText('تفسير القرار')).toBeNull();
    expect(within(d).getByText(NEEDS_REVIEW_KEY_AR)).toBeTruthy();
  });

  it('a person who may not decide still sees an answered difference — read-only, with no way to change it', async () => {
    acts = ACTS_VIEWER;
    rows = [parcel('a', { difference: diff({ answered: true, resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم من الموظفة' }) })];
    const d = await openDialog();
    expect(within(d).getByText('اعتُمد رقم الشركة')).toBeTruthy();
    expect(within(d).getByText('خصم من الموظفة')).toBeTruthy();
    expect(within(d).queryByRole('button', { name: 'غيّر البتّ' })).toBeNull();
    expect(within(d).queryByText(NEEDS_REVIEW_KEY_AR)).toBeNull();
  });

  it('a closed statement takes no answer: the door’s own sentence, and NO button the door would refuse — even for a person who may decide', async () => {
    rows = [parcel('a', { difference: diff({ closed: true }) })];
    const d = await openDialog();
    expect(within(d).getByText(STATEMENT_CLOSED_SENTENCE)).toBeTruthy();
    expect(within(d).queryByLabelText('تفسير القرار')).toBeNull();
    for (const name of [/اعتُمد رقم الشركة/, /رقمنا هو المعتمد/, 'قيد المراجعة']) expect(within(d).queryByRole('button', { name })).toBeNull();
    // said once
    expect(d.textContent!.split(STATEMENT_CLOSED_SENTENCE).length - 1).toBe(1);
  });

  it('a closed statement with an answer: the sentence once, the answer read-only, no «غيّر البتّ»', async () => {
    rows = [parcel('a', { difference: diff({ closed: true, answered: true, resolution: 'OURS_STANDS', resolutionNote: 'نطالب الشركة', claim: 3 }) })];
    const d = await openDialog();
    expect(within(d).getByText(STATEMENT_CLOSED_SENTENCE)).toBeTruthy();
    expect(within(d).getByText('رقمنا هو المعتمد')).toBeTruthy();
    expect(within(d).getByText('نطالب الشركة')).toBeTruthy();
    expect(within(d).queryByRole('button', { name: 'غيّر البتّ' })).toBeNull();
    expect(within(d).queryByLabelText('تفسير القرار')).toBeNull();
    expect(d.textContent!.split(STATEMENT_CLOSED_SENTENCE).length - 1).toBe(1);
  });

  it('the sentence is the door’s: the very one `settlement-gates` gives every door of a closed statement', () => {
    expect(STATEMENT_CLOSED_SENTENCE).toBe('الكشف مغلق نهائياً — التصحيح بكشف تسوية');
  });

  it('a statement that is still open offers the answers — and says nothing of being closed', async () => {
    const d = await openDialog();
    expect(within(d).queryByText(STATEMENT_CLOSED_SENTENCE)).toBeNull();
    expect(within(d).queryByText(NEEDS_REVIEW_KEY_AR)).toBeNull();
  });
});

describe('on a phone — the card, the thumb and the same answers', () => {
  // The width the cards are drawn at (`useIsPhone`): below the desk's. jsdom has no `matchMedia`, so one is handed in.
  const asPhone = () =>
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('the card still carries the mark, a 44px target, and it opens the same dialog', async () => {
    asPhone();
    await draw();
    const mark = markIn(cards());
    expect(mark.className.split(/\s+/)).toContain('min-h-11');
    fireEvent.click(mark);
    const d = await screen.findByRole('dialog', { name: 'فيه فرق — ORD-a' });
    expect(within(d).getByText('رقمنا').parentElement!.textContent).toContain('20.00 JOD');
  });

  it('and the matching screen’s own phone layout of the answers is what the dialog mounts: what each one means is written under them — there is no hover on a phone', async () => {
    asPhone();
    await draw();
    fireEvent.click(markIn(cards()));
    const d = await screen.findByRole('dialog');
    expect(within(d).getByText(/الفرق مقبول — غالباً خصمٌ/)).toBeTruthy();
    expect(within(d).getByText(/الفرق غير مقبول — يُطالَب به من الشركة/)).toBeTruthy();
    // …and they are still the same buttons for the same door
    expect(within(d).getByRole('button', { name: /اعتُمد رقم الشركة/ }).tagName).toBe('BUTTON');
  });
});

describe('the dialog follows the page: what it shows is the row as the list holds it now', () => {
  it('a page read again while it is open shows the newest figures — never the ones it was opened with', async () => {
    const d = await openDialog();
    expect(within(d).getByText('رقم الشركة').parentElement!.textContent).toContain('17.00 JOD');
    rows = [parcel('a', { difference: diff({ theirs: 19, gap: 1 }) })];
    // coming back to the window reads the page again (`useLiveRefresh`)
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('رقم الشركة').parentElement!.textContent).toContain('19.00 JOD'));
    expect(within(screen.getByRole('dialog')).getByText(/^نقص:/).textContent).toContain('1.00 JOD');
  });

  it('a row that is no longer on the page closes the dialog — nothing stale is left to press', async () => {
    const d = await openDialog();
    expect(d).toBeTruthy();
    rows = [parcel('b')];
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(0);
  });

  it('and a dialog that closed this way does not come back when the parcel returns to the page — nobody pressed its mark', async () => {
    const d = await openDialog();
    expect(d).toBeTruthy();
    rows = [parcel('b')];
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // the parcel is on the page again (another choice asks the question anew)
    rows = [parcel('a', { difference: diff() })];
    fireEvent.change(screen.getByLabelText('جهة الشحن'), { target: { value: P1 } });
    await waitFor(() => expect(within(desk()).getAllByText('ORD-a').length).toBeGreaterThan(0));
    expect(screen.queryByRole('dialog')).toBeNull();
    // …and it opens again when somebody presses the mark
    fireEvent.click(markIn(desk()));
    expect(await screen.findByRole('dialog', { name: 'فيه فرق — ORD-a' })).toBeTruthy();
  });

  it('a row whose difference was taken away (a clean line settled it) closes the dialog too', async () => {
    const d = await openDialog();
    expect(d).toBeTruthy();
    rows = [parcel('a', { difference: null })];
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('NO NEW CSS — every class the new files use is one the product already ships', () => {
  /*
   * The dashboard's first-load stylesheet is under a ratchet (`quality-gates.test.ts`, measured only on CI's build): a class
   * nobody else ships grows it. The mark and the dialog are written from classes other screens already use, and this holds
   * them to that — the same scan the tracking dialogs are held to, widened to the colour maps (they are strings, not an
   * attribute) because the mark keeps its four tones in one.
   */
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);
  const classesOf = (src: string) => [
    ...[...src.matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)),
    ...[...src.matchAll(/className=\{`([^`]+)`\}/g)].flatMap((m) => m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)),
    ...[...src.matchAll(/'([^'\n]*var\(--sys[^'\n]*)'/g)].flatMap((m) => m[1].split(/\s+/)),
  ].filter(Boolean);

  for (const rel of [
    'components/screens/tracking/DifferenceMark.tsx',
    'components/screens/tracking/DifferenceDialog.tsx',
    'components/screens/finance/CourierReason.tsx',
  ]) {
    it(`\`${rel.split('/').pop()}\`'s classes all appear in another source file`, () => {
      const own = join(root, rel);
      const used = new Set(classesOf(readFileSync(own, 'utf8')));
      expect(used.size, 'the file has classes').toBeGreaterThan(5);
      const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => readFileSync(f, 'utf8').split(/\s+/)));
      const brandNew = [...used].filter((c) => !elsewhere.has(c));
      expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
    });
  }

  it('the screen itself adds no class of its own for the mark, the chip or the dialog: it reuses the components and the chip strip’s', () => {
    const src = readFileSync(join(root, 'components/screens/TrackingScreen.tsx'), 'utf8');
    const at = src.indexOf('<DifferenceMark');
    expect(at).toBeGreaterThan(0);
    // the call carries props and handlers and no class of its own
    expect(src.slice(at, src.indexOf('/>', at))).not.toMatch(/className/);
    const dialog = src.indexOf('<DifferenceDialog');
    expect(src.slice(dialog, src.indexOf('/>', dialog))).not.toMatch(/className/);
  });
});
