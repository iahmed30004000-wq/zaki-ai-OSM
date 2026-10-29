// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * THE POSTPONED SCREEN, AS A LIST THAT IS READ IN PAGES.
 *
 * «الطلبات المؤجلة — اعملو صفحات + فلاتر + بحث». The screen used to draw the
 * first three hundred rows whole. What the screen owes now, beyond drawing:
 *
 *   • 25 to a page, and a bar that says where the page stands;
 *   • the search and the dropdowns on the screen, with the SERVER'S numbers
 *     beside the words — and a supervisor's «whose hands» that an agent is not
 *     shown at all;
 *   • only what was chosen is asked, and a change starts again at page one;
 *   • «إلى الطابور» reloads the page the reader is ON, not the first;
 *   • and an empty list that is empty BECAUSE of what was chosen says so, with
 *     a way out — not «no postponed orders».
 */

const { api, may } = vi.hoisted(() => ({ api: vi.fn(), may: { yes: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => may.yes }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>الطلبات المؤجلة</h1> }));

import { ConfirmationPostponedScreen } from './ConfirmationPostponedScreen';

const AGENT = '3d0e4a28-5c2f-4a4b-9a45-0f9f4b6c1d21';

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  totalAmount: 10,
  currency: 'USD',
  dueAt: '2026-10-22T10:00:00.000Z',
  daysRemaining: 1,
  postponePreferredTime: 'MORNING',
  postponeCount: 2,
  followUpReason: 'CUSTOMER_BUSY',
  actionable: true,
  customer: { fullName: 'عميل تجريبي', phone: '0790000000', city: 'عمّان' },
  claimer: { id: AGENT, name: 'سارة' },
  ...over,
});

const FACTS = {
  total: 60,
  whens: { now: 10, overdue: 3, soon: 7, week: 20, later: 30 },
  kinds: { postponed: 50, followup: 10 },
  times: { once: 40, many: 20 },
  agents: [
    { id: AGENT, name: 'سارة', count: 40 },
    { id: 'none', name: 'في الطابور — بلا موظف', count: 20 },
  ] as { id: string; name: string; count: number }[] | null,
};

/** What the route says right now — a claim changes it before the screen asks. */
let facts: typeof FACTS;
let rowsOf: (page: number) => ReturnType<typeof row>[];
let total: number;
let postFails: Error | null;
let firstFails: boolean;

const asked = () =>
  api.mock.calls
    .filter((c) => !(c[1] && (c[1] as RequestInit).method === 'POST'))
    .map((c) => new URL(c[0] as string, 'http://x').searchParams);
const posts = () => api.mock.calls.filter((c) => c[1] && (c[1] as RequestInit).method === 'POST');

beforeEach(() => {
  vi.clearAllMocks();
  may.yes = true;
  facts = structuredClone(FACTS);
  total = 60;
  postFails = null;
  firstFails = false;
  rowsOf = (page) => [row(`P${page}`)];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (postFails) throw postFails;
      return { success: true };
    }
    if (firstFails && api.mock.calls.length === 1) throw new Error('تعذّر التحميل');
    const q = new URL(url, 'http://x').searchParams;
    const totalPages = Math.max(1, Math.ceil(total / 25));
    const page = Math.min(Number(q.get('page')), totalPages);
    return {
      leadDays: 2,
      count: total,
      orders: total === 0 ? [] : rowsOf(page),
      pagination: { total, page, limit: 25, totalPages },
      facts,
      applied: {},
    };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<ConfirmationPostponedScreen />);
  await screen.findByLabelText('الموعد');
};
const lastAsked = () => asked().at(-1)!;
/** The page bar's own sentence — «عرض 25 من 60 طلب». The screen's explanation says «للعرض فقط», so the word alone is not enough. */
const pagerSentence = (found: boolean) =>
  (found ? screen.getByText : screen.queryByText)((_, el) => el?.tagName === 'SPAN' && /^عرض \d+ من \d+ طلب$/.test(el.textContent ?? ''));
const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('opening it', () => {
  it('— asks for page one, 25 to a page, and nothing else', async () => {
    await draw();
    expect(asked()).toHaveLength(1);
    expect(asked()[0].toString()).toBe('page=1&limit=25');
  });

  it('and draws the row, and a page bar that says where the page stands', async () => {
    await draw();
    expect(screen.getAllByText('ORD-P1').length).toBeGreaterThan(0);
    expect(pagerSentence(true)!.textContent).toBe('عرض 1 من 60 طلب');
    expect(screen.getByText('صفحة 1 من 3')).toBeTruthy();
  });

  it('and a first load that fails says so, and draws nothing else', async () => {
    firstFails = true;
    render(<ConfirmationPostponedScreen />);
    expect(await screen.findByText('تعذّر التحميل')).toBeTruthy();
    expect(screen.queryByLabelText('الموعد')).toBeNull();
  });
});

describe('the toolbar', () => {
  it('— a search box that says what it searches, and four dropdowns, each with the server’s number beside the word', async () => {
    await draw();
    expect(screen.getByRole('textbox', { name: /بحث برقم الطلب/ })).toBeTruthy();
    const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((o) => o.textContent);
    expect(options('الموعد')).toEqual([
      'كل المواعيد (60)',
      'قابل للعمل عليه (10)',
      'متأخر (3)',
      'يحين خلال 2 يوم (7)',
      'بعدها حتى 7 أيام (20)',
      'بعد أكثر من 7 أيام (30)',
    ]);
    expect(options('النوع')).toEqual(['كل الأنواع (60)', 'مؤجَّل بطلب العميل (50)', 'بحاجة متابعة (10)']);
    expect(options('مرات التأجيل')).toEqual(['أيّ عدد', 'مرّة واحدة (40)', 'مرّتين فأكثر (20)']);
    expect(options('الموظف')).toEqual(['كل الموظفين', 'سارة (40)', 'في الطابور — بلا موظف (20)']);
  });

  it('and an agent is not shown «الموظف» — her list is her own, and the server sent no agents', async () => {
    facts.agents = null;
    await draw();
    expect(screen.queryByLabelText('الموظف')).toBeNull();
    expect(screen.getByLabelText('الموعد')).toBeTruthy();
  });

  it('and nothing is chosen on opening: no «إعادة تعيين»', async () => {
    await draw();
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
  });
});

describe('choosing', () => {
  it('— a moment is asked for by its word, and only that', async () => {
    await draw();
    choose('الموعد', 'overdue');
    await waitFor(() => expect(asked()).toHaveLength(2));
    expect(lastAsked().toString()).toBe('when=overdue&page=1&limit=25');
  });

  it('and a change starts again at page one, from wherever the reader was', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    choose('النوع', 'followup');
    await waitFor(() => expect(lastAsked().get('kind')).toBe('followup'));
    expect(lastAsked().get('page')).toBe('1');
  });

  it('and the dropdowns together are one question — every one that was chosen, none that was not', async () => {
    await draw();
    choose('الموعد', 'soon');
    choose('مرات التأجيل', 'many');
    choose('الموظف', AGENT);
    await waitFor(() => expect(lastAsked().get('agent')).toBe(AGENT));
    expect(lastAsked().toString()).toBe(`agent=${AGENT}&times=many&when=soon&page=1&limit=25`);
  });

  it('and a typed word is asked after the burst, trimmed; blanks are nothing', async () => {
    await draw();
    fireEvent.change(screen.getByRole('textbox', { name: /بحث برقم الطلب/ }), { target: { value: '  سارة  ' } });
    await waitFor(() => expect(lastAsked().get('q')).toBe('سارة'));
    expect(asked()).toHaveLength(2); // the opening ask, and one for the word

    fireEvent.change(screen.getByRole('textbox', { name: /بحث برقم الطلب/ }), { target: { value: '   ' } });
    await waitFor(() => expect(asked()).toHaveLength(3));
    expect(lastAsked().has('q')).toBe(false);
  });

  it('and «إعادة تعيين» says how many are chosen, and clears every one — the search too', async () => {
    await draw();
    choose('الموعد', 'overdue');
    choose('النوع', 'followup');
    choose('مرات التأجيل', 'many');
    choose('الموظف', AGENT);
    fireEvent.change(screen.getByRole('textbox', { name: /بحث برقم الطلب/ }), { target: { value: 'سارة' } });
    const reset = await screen.findByRole('button', { name: 'إعادة تعيين (5)' });
    fireEvent.click(reset);
    await waitFor(() => expect(lastAsked().toString()).toBe('page=1&limit=25'));
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
    expect((screen.getByRole('textbox', { name: /بحث برقم الطلب/ }) as HTMLInputElement).value).toBe('');
    for (const label of ['الموعد', 'النوع', 'مرات التأجيل', 'الموظف']) {
      expect((screen.getByLabelText(label) as HTMLSelectElement).value, label).toBe('all');
    }
  });
});

describe('the pages', () => {
  it('— «التالي» asks for the next page of the SAME list', async () => {
    await draw();
    choose('الموعد', 'week');
    await waitFor(() => expect(lastAsked().get('when')).toBe('week'));
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    expect(lastAsked().get('when')).toBe('week');
    expect(screen.getAllByText('ORD-P2').length).toBeGreaterThan(0);
    expect(screen.getByText('صفحة 2 من 3')).toBeTruthy();
  });

  it('and a list that fits one page has a bar that says so and turns nowhere', async () => {
    total = 7;
    rowsOf = () => Array.from({ length: 7 }, (_, i) => row(`R${i}`));
    await draw();
    expect(screen.getByText('صفحة 1 من 1')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'الصفحة التالية' }) as HTMLButtonElement).disabled).toBe(true);
    expect(pagerSentence(true)!.textContent).toBe('عرض 7 من 7 طلب');
  });
});

describe('when nothing is there', () => {
  it('— an empty list with nothing chosen says what a postponed order is for', async () => {
    total = 0;
    await draw();
    expect(screen.getByText('لا طلبات مؤجلة')).toBeTruthy();
    expect(screen.queryByText('لا طلبات بهذه الشروط')).toBeNull();
    expect(pagerSentence(false)).toBeNull(); // no page bar over nothing
  });

  it('and an empty list BECAUSE of what was chosen says that, and offers the way out', async () => {
    await draw();
    total = 0;
    choose('الموعد', 'overdue');
    expect(await screen.findByText('لا طلبات بهذه الشروط')).toBeTruthy();
    expect(screen.queryByText('لا طلبات مؤجلة')).toBeNull();
    total = 60;
    fireEvent.click(screen.getByRole('button', { name: 'امسح الفلاتر' }));
    await waitFor(() => expect(lastAsked().toString()).toBe('page=1&limit=25'));
    expect((screen.getByLabelText('الموعد') as HTMLSelectElement).value).toBe('all');
  });
});

describe('«إلى الطابور»', () => {
  const press = () => fireEvent.click(screen.getAllByRole('button', { name: /إلى الطابور/ })[0]);

  it('— hands the order back, says so, and reloads the page the reader is ON — not the first', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    press();
    await screen.findByText(/في الطابور — ما زال مؤجَّلاً/);
    expect(JSON.parse((posts()[0][1] as RequestInit).body as string)).toEqual({ orderId: 'P2' });
    await waitFor(() => expect(asked().length).toBeGreaterThanOrEqual(3));
    expect(lastAsked().get('page')).toBe('2');
  });

  it('and keeps what was chosen through the reload', async () => {
    await draw();
    choose('النوع', 'postponed');
    await waitFor(() => expect(lastAsked().get('kind')).toBe('postponed'));
    press();
    await screen.findByText(/في الطابور — ما زال مؤجَّلاً/);
    await waitFor(() => expect(asked().length).toBeGreaterThanOrEqual(3));
    expect(lastAsked().get('kind')).toBe('postponed');
  });

  it('and is only offered on a row the server calls actionable', async () => {
    rowsOf = () => [row('far', { actionable: false, daysRemaining: 20 })];
    await draw();
    expect(screen.queryByRole('button', { name: /إلى الطابور/ })).toBeNull();
  });

  it('and a refusal is shown as the route said it, with the list left as it was', async () => {
    postFails = new Error('موعده لم يحن بعد');
    await draw();
    press();
    expect(await screen.findByText('موعده لم يحن بعد')).toBeTruthy();
    expect(screen.getAllByText('ORD-P1').length).toBeGreaterThan(0);
  });
});

describe('how it is built', () => {
  const src = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationPostponedScreen.tsx'), 'utf8'));

  it('— from the kit, not a fifth copy of it: the hook, the toolbar and the page bar', () => {
    expect(src()).toContain("from '@/hooks/usePagedList'");
    expect(src()).toContain("from '@/components/ui/ListToolbar'");
    expect(src()).toContain("from '@/components/ui/Pager'");
    expect(src(), 'عادت نسخة محلّية من شريط الصفحات').not.toMatch(/الصفحة التالية/);
  });

  it('and it computes no window itself — the server says which rows can be worked on, the labels come from one module', () => {
    expect(src()).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    expect(src()).toContain("from '@/lib/postponed-filters'");
  });
});

describe('the order number on a postponed row opens the order it names', () => {
  it('is a link to /orders/<id> for someone who may open the orders screen', async () => {
    render(<ConfirmationPostponedScreen />);
    // the table and the phone cards both draw the number: every copy is a link
    const numbers = await screen.findAllByText('ORD-P1');
    for (const n of numbers) {
      const link = n.closest('a');
      expect(link, 'الرقم نص عادي').not.toBeNull();
      expect(link!.getAttribute('href')).toBe('/orders/P1');
    }
  });

  it('NEGATIVE: for someone who may not, it is the same number as plain text — never a link to a refusal', async () => {
    may.yes = false;
    render(<ConfirmationPostponedScreen />);
    const numbers = await screen.findAllByText('ORD-P1');
    for (const n of numbers) expect(n.closest('a')).toBeNull();
  });
});

describe('drawn inside another screen (`embedded`)', () => {
  it('has its own heading on its own address — and none under the title of «طلباتي» or «المتابعة»', async () => {
    const own = render(<ConfirmationPostponedScreen />);
    await screen.findAllByText('ORD-P1');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    own.unmount();

    render(<ConfirmationPostponedScreen embedded />);
    await screen.findAllByText('ORD-P1');
    expect(screen.queryByRole('heading', { level: 1 }), 'عنوان ثانٍ تحت عنوان الصفحة').toBeNull();
  });
});


describe('the reason column speaks Arabic', () => {
  it('prints the Arabic label of a follow-up reason, never the code', async () => {
    rowsOf = () => [row('R1', { followUpReason: 'NO_ANSWER' })];
    await draw();
    expect(screen.getAllByText('لا يرد — إعادة المحاولة لاحقاً').length).toBeGreaterThan(0);
    expect(screen.queryByText('NO_ANSWER')).toBeNull();
  });

  it('and a code nobody labelled reads «سبب آخر», not the raw code', async () => {
    rowsOf = () => [row('R2', { followUpReason: 'CUSTOMER_BUSY' })];
    await draw();
    expect(screen.queryByText('CUSTOMER_BUSY')).toBeNull();
    expect(screen.getAllByText('سبب آخر').length).toBeGreaterThan(0);
  });
});
