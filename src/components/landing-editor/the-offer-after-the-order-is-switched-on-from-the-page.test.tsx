// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * «العرض بعد الطلب مش شغال الي بصفحة المنتج» · «بقلي انو الخدمة غير مفعلة لما اجي اعملها من صفحة الهبوط».
 *
 * The «بعد الطلب» panel of the landing editor, the real component, with the network replaced and nothing else:
 *
 *   · its upsell line is the server's answer for this page — read from `/api/landing-pages/[id]/after-order`, never
 *     counted out of `/api/offers` again — printed as sent, at the store's decimals;
 *   · whoever may manage offers turns the offer on, off and back on from here, through the offers' own doors, and
 *     each press sends exactly one body and then reads the answer again;
 *   · a refusal is the door's own sentence, word for word, and nothing else on the panel moves;
 *   · the panel never takes the after-order flag off a bundle — that would put its cheap price on the page.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson, apiFetch: vi.fn() }));
vi.mock('@/components/tracking/GlobalTrackingProvider', () => ({
  useTracking: () => ({ trackEvent: vi.fn(), registerPixels: vi.fn(), setPageContext: vi.fn() }),
}));

import { AfterOrderPanel } from './AfterOrderPanel';

const section = {
  whatsappAfter: false, whatsappLabel: '', whatsappMessage: '', whatsappNumber: '', whatsappAutoOpen: false,
  afterOrderFlow: 'together' as const, afterOrderBanner: 'none' as const, afterOrderBannerText: '', upsellLook: 'card' as const, crossSellLook: 'list' as const,
};

const READ = '/api/landing-pages/lp1/after-order';

type Answer = Record<string, unknown>;
const LIVE = { id: 'po', name: 'قطعة كمان', quantity: 1, freeQuantity: 0, price: 10, listPrice: null };
const base = (over: Answer = {}): Answer => ({
  productId: 'p1',
  productName: 'كريم مرطّب للوجه',
  offer: null,
  why: 'NONE',
  flagged: null,
  flaggedCount: 0,
  minorUnit: 3,
  canManage: true,
  ...over,
});
const on = (over: Answer = {}) => base({ offer: LIVE, why: null, flagged: { id: 'po', name: 'قطعة كمان' }, flaggedCount: 1, ...over });
const stopped = (over: Answer = {}) => base({ why: 'STOPPED', flagged: { id: 'po', name: 'قطعة كمان' }, flaggedCount: 1, ...over });
const ended = (over: Answer = {}) => base({ why: 'ENDED', flagged: { id: 'po', name: 'قطعة كمان' }, flaggedCount: 1, ...over });

/**
 * The network: the after-order read answers `answers` in turn (the last one repeats), the suggestions answer an
 * empty list, and every write is recorded — refused with `refuse` when it is set.
 */
let answers: Answer[] = [];
let refuse: string | null = null;
let writes: { url: string; method: string; body: Record<string, unknown> }[] = [];
const reads = () => apiJson.mock.calls.filter(([url]) => url === READ).length;

beforeEach(() => {
  vi.clearAllMocks();
  answers = [base()];
  refuse = null;
  writes = [];
  let served = 0;
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method) {
      writes.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      if (refuse) throw new Error(refuse);
      return { success: true };
    }
    if (url === READ) return structuredClone(answers[Math.min(served++, answers.length - 1)]);
    if (url === '/api/landing-pages/lp1/recommendations') return { recommendations: [] };
    throw new Error(`unexpected read ${url}`);
  });
});
afterEach(cleanup);

async function open(currency = 'JOD') {
  render(<AfterOrderPanel section={section} patch={vi.fn()} ctx={{ productId: 'p1', pageId: 'lp1', storePhone: null, currency }} />);
  await waitFor(() => expect(reads()).toBe(1));
  await act(async () => {});
}

describe('the line is the server’s answer for this page', () => {
  it('it asks the page’s own door, and never counts the product’s offers by itself again', async () => {
    answers = [on()];
    await open();
    expect(apiJson.mock.calls.map(([url]) => url)).toContain(READ);
    expect(apiJson.mock.calls.some(([url]) => String(url).startsWith('/api/offers'))).toBe(false);
  });

  it('ON, in dinars: the charged price at three places, and «بدل» only when the door sent one', async () => {
    answers = [on({ offer: { ...LIVE, price: 10.125, listPrice: 14 } })];
    await open('JOD');
    expect(await screen.findByText('شغّال: قطعة كمان — 1 قطعة بـ10.125 JOD بدل 14.000')).toBeTruthy();
  });

  it('NEGATIVE: no «بدل» from the base price — the thank-you screen prints none for a bundle with no reduction', async () => {
    answers = [on()];
    await open('JOD');
    expect(await screen.findByText('شغّال: قطعة كمان — 1 قطعة بـ10.000 JOD')).toBeTruthy();
    expect(screen.queryByText(/بدل/)).toBeNull();
  });

  it.each([
    ['USD', 2, 12.5, 'بـ12.50 USD'],
    ['SYP', 0, 15000, 'بـ15,000 SYP'],
  ])('ON, in %s: the store’s %s places, the server’s figure untouched', async (currency, minorUnit, price, shown) => {
    answers = [on({ minorUnit, offer: { ...LIVE, price } })];
    await open(currency as string);
    expect(await screen.findByText(`شغّال: قطعة كمان — 1 قطعة ${shown}`)).toBeTruthy();
  });

  it('ON with a gift, as the thank-you card says it', async () => {
    answers = [on({ offer: { ...LIVE, name: '3+1', quantity: 3, freeQuantity: 1, price: 30 } })];
    await open();
    expect(await screen.findByText('شغّال: 3+1 — 3 قطعة + 1 مجاناً بـ30.000 JOD')).toBeTruthy();
  });

  it.each([
    [base(), 'مطفي — ما في عرض بعد الطلب لـ«كريم مرطّب للوجه»'],
    [stopped(), 'مطفي — العرض «قطعة كمان» موقّف'],
    [ended(), 'مطفي — العرض «قطعة كمان» خلص'],
    [base({ productId: null, productName: null, why: 'NO_PRODUCT' }), 'الصفحة ما إلها منتج — العرض بينحط على منتج الصفحة'],
  ])('OFF says why: %#', async (answer, line) => {
    answers = [answer];
    await open();
    expect(await screen.findByText(line)).toBeTruthy();
  });

  it('a read the server refuses shows the server’s own sentence, and no control', async () => {
    apiJson.mockImplementation(async (url: string) => {
      if (url === READ) throw new Error('لا تملك صلاحية «عرض العروض». اطلبها من مدير النظام إن كانت من عملك.');
      return { recommendations: [] };
    });
    render(<AfterOrderPanel section={section} patch={vi.fn()} ctx={{ productId: 'p1', pageId: 'lp1', currency: 'JOD' }} />);
    expect(await screen.findByText('لا تملك صلاحية «عرض العروض». اطلبها من مدير النظام إن كانت من عملك.')).toBeTruthy();
    expect(screen.queryAllByRole('button').filter((b) => /شغّل|أوقفه|رجّعه/.test(b.textContent ?? ''))).toEqual([]);
  });

  it('NEGATIVE: a read that crashed in English says nothing in English — the line stays «من عروض المنتج»', async () => {
    apiJson.mockImplementation(async (url: string) => {
      if (url === READ) throw new Error('HTTP 500');
      return { recommendations: [] };
    });
    render(<AfterOrderPanel section={section} patch={vi.fn()} ctx={{ productId: 'p1', pageId: 'lp1', currency: 'JOD' }} />);
    await waitFor(() => expect(reads()).toBe(1));
    await act(async () => {});
    expect(screen.getByText('من عروض المنتج')).toBeTruthy();
    expect(screen.queryByText(/HTTP/)).toBeNull();
  });
});

describe('switching it on from the page', () => {
  async function createWith(pieces: string, price: string) {
    fireEvent.change(screen.getByLabelText('كم قطعة'), { target: { value: pieces } });
    fireEvent.change(screen.getByLabelText('بكم'), { target: { value: price } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'شغّل العرض' }));
    });
  }

  it('«كم قطعة 1، بكم 10» posts exactly the bundle to the offers door, then reads the answer again', async () => {
    answers = [base(), on()];
    await open();
    expect((screen.getByLabelText('كم قطعة') as HTMLInputElement).value).toBe('1');
    await createWith('1', '10');
    expect(writes).toEqual([
      {
        url: '/api/offers',
        method: 'POST',
        body: { productId: 'p1', name: 'قطعة كمان', quantity: 1, sellingPrice: 10, postOrderOffer: true },
      },
    ]);
    expect(reads()).toBe(2);
    expect(await screen.findByText('شغّال: قطعة كمان — 1 قطعة بـ10.000 JOD')).toBeTruthy();
  });

  it.each([
    ['2', 'قطعتين كمان'],
    ['3', '3 قطع كمان'],
    ['10', '10 قطع كمان'],
    ['11', '11 قطعة كمان'],
    ['103', '103 قطع كمان'],
  ])('%s pieces are named «%s»', async (pieces, name) => {
    await open();
    await createWith(pieces, '20');
    expect(writes[0].body).toEqual({ productId: 'p1', name, quantity: Number(pieces), sellingPrice: 20, postOrderOffer: true });
  });

  it('NEGATIVE: no price, or no whole number of pieces, sends nothing', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('بكم'), { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'شغّل العرض' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('بكم'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('كم قطعة'), { target: { value: '1.5' } });
    expect((screen.getByRole('button', { name: 'شغّل العرض' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'شغّل العرض' }));
    expect(writes).toEqual([]);
  });

  it('NEGATIVE: a crash is not a reason — a message with no Arabic in it is not printed', async () => {
    await open();
    refuse = 'HTTP 502';
    await createWith('1', '10');
    expect(screen.getByRole('alert').textContent).toBe('ما زبط — جرّب كمان مرة.');
  });

  it.each([
    'لا يمكنك إنشاء العرض: السعر 15.000 أعلى من السعر الأساسي لقطعة واحدة (14.000)',
    'المنتج غير موجود في شركتك',
  ])('a refusal is printed word for word, and nothing else changes: «%s»', async (sentence) => {
    await open();
    refuse = sentence;
    await createWith('1', '15');
    expect(screen.getByRole('alert').textContent).toBe(sentence);
    // The line is still the one the server gave, the boxes keep what was typed, and nothing was read again.
    expect(screen.getByText('مطفي — ما في عرض بعد الطلب لـ«كريم مرطّب للوجه»')).toBeTruthy();
    expect((screen.getByLabelText('بكم') as HTMLInputElement).value).toBe('15');
    expect(reads()).toBe(1);
  });
});

describe('off and back on — the one flagged bundle’s own switch, and nothing else', () => {
  async function press(name: string) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
    });
  }

  it('«أوقفه» sends exactly { status: INACTIVE } to that bundle, and the line follows the server', async () => {
    answers = [on(), stopped()];
    await open();
    await press('أوقفه');
    expect(writes).toEqual([{ url: '/api/offers/po', method: 'PATCH', body: { status: 'INACTIVE' } }]);
    expect(await screen.findByText('مطفي — العرض «قطعة كمان» موقّف')).toBeTruthy();
  });

  it('«رجّعه يشتغل» sends exactly { status: ACTIVE }', async () => {
    answers = [stopped(), on()];
    await open();
    await press('رجّعه يشتغل');
    expect(writes).toEqual([{ url: '/api/offers/po', method: 'PATCH', body: { status: 'ACTIVE' } }]);
    expect(await screen.findByText('شغّال: قطعة كمان — 1 قطعة بـ10.000 JOD')).toBeTruthy();
  });

  it('a finished one comes back by losing its ending — exactly { endsAt: null }', async () => {
    answers = [ended(), on()];
    await open();
    await press('رجّعه يشتغل بلا تاريخ نهاية');
    expect(writes).toEqual([{ url: '/api/offers/po', method: 'PATCH', body: { endsAt: null } }]);
  });

  it('NEGATIVE: with a flagged bundle there is no second one to create — the door would strip the flag off the first', async () => {
    for (const answer of [stopped(), ended(), on()]) {
      answers = [answer];
      await open();
      expect(screen.queryByRole('button', { name: 'شغّل العرض' })).toBeNull();
      expect(screen.queryByLabelText('كم قطعة')).toBeNull();
      cleanup();
      apiJson.mockClear();
    }
  });

  it('a 3+1 flagged before the rule: «أوقفه» is refused by the door in its own words, shown as they are', async () => {
    const sentence =
      'العرض بعد الطلب لا يقبل كمية مجانية — الزيادة بعد الطلب تُسجَّل كسطر بسعرٍ وكمية، وما إلها مكان تكتب فيه الهدية. ' +
      'اكتب الهدية داخل الكمية والسعر، أو شيل علامة «العرض بعد الطلب».';
    answers = [on({ offer: { ...LIVE, quantity: 3, freeQuantity: 1, price: 30 } })];
    await open();
    refuse = sentence;
    await press('أوقفه');
    expect(screen.getByRole('alert').textContent).toBe(sentence);
    expect(reads()).toBe(1);
  });

  it('NEGATIVE: two flagged bundles — no write at all, any press would un-flag the other one', async () => {
    answers = [on({ flaggedCount: 2 })];
    await open();
    expect(screen.getByText(/في أكتر من عرض معلّم «بعد الطلب»/)).toBeTruthy();
    for (const name of ['أوقفه', 'رجّعه يشتغل', 'شغّل العرض']) expect(screen.queryByRole('button', { name })).toBeNull();
  });
});

describe('who sees the controls', () => {
  it('NEGATIVE: without offers.manage — the status and the link to the product’s offers, nothing to press', async () => {
    answers = [base({ canManage: false })];
    await open();
    expect(screen.getByText('مطفي — ما في عرض بعد الطلب لـ«كريم مرطّب للوجه»')).toBeTruthy();
    expect((screen.getByRole('link', { name: 'عروض المنتج' }) as HTMLAnchorElement).getAttribute('href')).toBe('/products/p1#offers');
    expect(screen.queryByRole('button', { name: 'شغّل العرض' })).toBeNull();
    expect(screen.queryByLabelText('كم قطعة')).toBeNull();
    expect(screen.queryByText('بيظهر للزبون بشاشة الشكر بس، وما بينختار قبل الطلب.')).toBeNull();
  });

  it('with it, the line under the controls says where the offer shows', async () => {
    await open();
    expect(screen.getByText('بيظهر للزبون بشاشة الشكر بس، وما بينختار قبل الطلب.')).toBeTruthy();
  });
});

describe('the flag is never taken off from here', () => {
  it('no body the panel can send carries postOrderOffer: false — the one key it writes is the literal true', () => {
    const src = stripComments(repoFile('src/components/landing-editor/AfterOrderPanel.tsx'));
    // Not false, not a variable that could be false, not a negation: the literal `true`, once, in the create.
    expect(src).not.toMatch(/postOrderOffer\s*:(?!\s*true\b)/);
    expect(src.match(/postOrderOffer\s*:/g)).toEqual(['postOrderOffer:']);
    expect(src).toContain('postOrderOffer: true');
  });

  it('and a seller pressing off and on in a row sends neither the flag nor its absence', async () => {
    answers = [on(), stopped(), on()];
    await open();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أوقفه' })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'رجّعه يشتغل' })));
    expect(writes.map((w) => w.body)).toEqual([{ status: 'INACTIVE' }, { status: 'ACTIVE' }]);
    expect(writes.some((w) => w.body.postOrderOffer === false)).toBe(false);
  });
});
