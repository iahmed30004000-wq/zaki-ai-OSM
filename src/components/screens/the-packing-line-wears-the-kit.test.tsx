// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «التجهيز» ON THE KIT (R11a, plan 17/11 — written 18/11).
 *
 * The screen moved onto `PageShell`, the kit's `Button` and `Card`. What must NOT have moved with it: every press reaches
 * the same handler with the same row (the second row, never the first), the cancel posts the same body, the print asks
 * for that one order, and the frame draws one heading with the menu's name at the width it had. Every claim below has a
 * negative twin, so a wrong row, a dropped key check or a second heading turns it red.
 *
 * jsdom has no layout: «no sideways scroll at 375px» is checked as the classes that make it (the frame's `min-w-0`, no
 * fixed width in the tree, the phone's two half-width presses), and said so in the pull request.
 */

const { api, user, phone, opened, reviewed, rejecting, printed } = vi.hoisted(() => ({
  api: vi.fn(),
  user: { current: null as unknown },
  phone: { value: false },
  opened: [] as string[],
  reviewed: [] as string[],
  rejecting: { calls: [] as string[], submit: null as null | ((v: { rejectionReason: string; note?: string }) => Promise<void>) },
  printed: { calls: [] as unknown[][], hold: null as null | Promise<unknown> },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/ops/preparation',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current, t: { cancel: 'إلغاء' }, locale: 'ar' }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({ useTell: () => () => Promise.resolve() }));
vi.mock('@/components/labels/LabelSize', () => ({
  LabelSizePicker: () => null,
  useLabelSize: () => ({ dims: { width: 100, height: 150 } }),
}));
vi.mock('@/components/labels/openWaybills', () => ({
  BLOCKED_WAYBILLS: 'منع',
  describeRefused: () => '',
  WaybillError: class extends Error {
    refused: unknown[] = [];
  },
  openWaybills: (...a: unknown[]) => {
    printed.calls.push(a);
    return printed.hold ?? Promise.resolve({ count: 1, refused: [], opened: true });
  },
}));
// The three destinations: which order each was opened WITH is the argument under test.
vi.mock('@/components/orders/OrderDetailModal', () => ({
  OrderDetailModal: ({ orderId }: { orderId: string }) => {
    opened.push(orderId);
    return null;
  },
}));
vi.mock('@/components/orders/ChangeRequestReview', () => ({
  ChangeRequestReview: ({ requestId }: { requestId: string }) => {
    reviewed.push(requestId);
    return null;
  },
}));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({
  RejectDialog: ({ orderNumber, onSubmit }: { orderNumber: string; onSubmit: typeof rejecting.submit }) => {
    rejecting.calls.push(orderNumber);
    rejecting.submit = onSubmit;
    return null;
  },
}));

import { PreparationScreen } from './PreparationScreen';
import { routeLabel } from '@/lib/route-registry';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 15000 });

const line = (n: number, over: Record<string, unknown> = {}) => ({
  orderId: `o${n}`,
  orderNumber: `ORD-${n}`,
  customerName: `زبون ${n}`,
  regionName: 'دمشق',
  pendingChangeRequestId: `cr${n}`,
  quantity: 2,
  freeQuantity: 0,
  reservedQty: 2,
  shippingStatus: 'NOT_READY',
  variantSummary: null,
  ...over,
});
const DATA = {
  allowNegativeStock: false,
  totals: { products: 1, orders: 2, shortages: 0 },
  groups: [{ productId: 'p1', productName: 'كريم', orders: 2, required: 4, available: 9, shortage: 0, lines: [line(1), line(2)] }],
};

const ALL = ['orders.view', 'orders.cancel', 'ops.labels', 'ai.assist'];
const holding = (...keys: string[]) => {
  user.current = { id: 'u1', status: 'ACTIVE', role: 'CUSTOM', permissions: keys };
};

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  opened.length = 0;
  reviewed.length = 0;
  rejecting.calls.length = 0;
  rejecting.submit = null;
  printed.calls.length = 0;
  printed.hold = null;
  holding(...ALL);
  api.mockImplementation(async (url: string) => {
    if (url === '/api/ops/preparation') return DATA;
    if (url === '/api/orders/o2') return { order: { version: 7 } };
    if (url === '/api/ai/picking') return { suggestion: 'ابدأ بالكريم' };
    return {};
  });
});
afterEach(cleanup);

const draw = async () => {
  render(<PreparationScreen />);
  await waitFor(() => expect(document.querySelectorAll('li').length).toBe(2), WAIT);
};
/** The second row: a press that reaches the first row's order is the defect this file exists to catch. */
const second = () => document.querySelectorAll('li')[1] as HTMLElement;
const pieces = (...p: string[]) => p.join('-');

describe('the frame', () => {
  it('draws ONE h1, the menu’s name read from the registry, inside the kit frame at the width it had', async () => {
    await draw();
    const h1s = document.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(routeLabel('/ops/preparation'));
    // the frame: its outermost element carries `min-w-0` and the medium cap (the max-w-4xl the screen had)
    const frame = h1s[0].closest(`.${pieces('min', 'w', '0')}.${pieces('max', 'w', '4xl')}`);
    expect(frame, 'الإطار مش PageShell بعرض medium').not.toBeNull();
    expect(frame!.parentElement!.tagName).toBe('DIV');
    expect(frame!.parentElement!.parentElement).toBe(document.body);
  });

  it('NEGATIVE: no second heading and no other cap anywhere in the tree', async () => {
    await draw();
    const caps = [...document.querySelectorAll('[class]')].filter((e) => /(?:^|\s)max-w-(?!4xl)\S+/.test(e.getAttribute('class')!));
    expect(caps).toEqual([]);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('every press reaches the same handler with the same row (desk)', () => {
  const PRESSES: [string, string, () => void][] = [
    ['افتح الطلب', 'opens THAT order', () => expect(opened.at(-1)).toBe('o2')],
    ['ألغِ الطلب', 'asks to cancel THAT order', () => expect(rejecting.calls.at(-1)).toBe('ORD-2')],
    ['طلب تعديل', 'reviews THAT request', () => expect(reviewed.at(-1)).toBe('cr2')],
  ];
  it.each(PRESSES)('«%s» %s', async (name, _what, check) => {
    await draw();
    fireEvent.click(within(second()).getByRole('button', { name }));
    await waitFor(check, WAIT);
  });

  it('«اطبع البوليصة» prints THAT order only, on the device’s paper', async () => {
    await draw();
    fireEvent.click(within(second()).getByRole('button', { name: 'اطبع البوليصة' }));
    await waitFor(() => expect(printed.calls).toEqual([[{ orderIds: ['o2'], width: 100, height: 150 }, 'print']]), WAIT);
  });

  it('the cancel posts the same body, for that order, with its fresh version', async () => {
    await draw();
    fireEvent.click(within(second()).getByRole('button', { name: 'ألغِ الطلب' }));
    await waitFor(() => expect(rejecting.submit).not.toBeNull(), WAIT);
    await rejecting.submit!({ rejectionReason: 'غيّر رأيه', note: 'اتصل' });
    const post = api.mock.calls.find((c) => c[0] === '/api/orders/o2/confirmation');
    expect(post).toBeTruthy();
    expect(post![1]).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', note: 'غيّر رأيه — اتصل', expectedVersion: 7 }),
    });
  });

  it('the names and the tooltips are the ones they were, and the three icons are kit buttons that never submit', async () => {
    await draw();
    const row = second();
    const TIPS: [string, string][] = [
      ['افتح الطلب', 'افتح الطلب وعدّله — ما لم تكن بوليصته قد طُبعت'],
      ['اطبع البوليصة', 'اطبع بوليصة هذا الطلب'],
      ['ألغِ الطلب', 'ألغِ الطلب — يعود المحجوز من بضاعته إلى المخزون'],
    ];
    for (const [name, tip] of TIPS) {
      const b = within(row).getByRole('button', { name });
      expect(b.getAttribute('title')).toBe(tip);
      expect(b.getAttribute('type')).toBe('button');
      expect(b.textContent?.trim()).toBe('');
      // the kit's square: width stated beside the height, 44px on a phone
      expect(b.className).toMatch(/(?:^|\s)w-11(?:\s|$)/);
      expect(b.className).toMatch(/(?:^|\s)md:w-8(?:\s|$)/);
    }
    const chip = within(row).getByRole('button', { name: 'طلب تعديل' });
    expect(chip.getAttribute('title')).toBe('طلب تعديل بانتظار البتّ — راجعه قبل التغليف');
    expect(chip.getAttribute('type')).toBe('button');
    // the chip keeps its warning frame around the kit press
    expect(chip.parentElement!.className).toContain('bg-[var(--sys-warning-soft)]');
  });

  it('NEGATIVE: printing one row disables that row’s print only', async () => {
    let finish: (v: unknown) => void = () => {};
    printed.hold = new Promise((r) => (finish = r));
    await draw();
    fireEvent.click(within(second()).getByRole('button', { name: 'اطبع البوليصة' }));
    await waitFor(() => expect((within(second()).getByRole('button', { name: 'اطبع البوليصة' }) as HTMLButtonElement).disabled).toBe(true), WAIT);
    const first = document.querySelectorAll('li')[0] as HTMLElement;
    expect((within(first).getByRole('button', { name: 'اطبع البوليصة' }) as HTMLButtonElement).disabled).toBe(false);
    finish({ count: 1, refused: [], opened: true });
    await waitFor(() => expect((within(second()).getByRole('button', { name: 'اطبع البوليصة' }) as HTMLButtonElement).disabled).toBe(false), WAIT);
  });

  it('NEGATIVE: without the keys, the row has none of the three presses — and the list is there', async () => {
    holding();
    await draw();
    for (const name of ['افتح الطلب', 'اطبع البوليصة', 'ألغِ الطلب']) expect(within(second()).queryByRole('button', { name })).toBeNull();
    // the change-request chip is not behind a key: it is drawn for whoever sees the row
    expect(within(second()).getByRole('button', { name: 'طلب تعديل' })).toBeTruthy();
    expect(screen.getAllByText('زبون 2').length).toBeGreaterThan(0);
  });

  it('NEGATIVE: a row with no waiting request has no chip', async () => {
    api.mockImplementation(async (url: string) =>
      url === '/api/ops/preparation'
        ? { ...DATA, groups: [{ ...DATA.groups[0], lines: [line(1), line(2, { pendingChangeRequestId: null })] }] }
        : {}
    );
    await draw();
    expect(within(second()).queryByRole('button', { name: 'طلب تعديل' })).toBeNull();
  });
});

describe('the fold and the assistant', () => {
  it('the group’s whole-row press folds THAT group, and opens it again', async () => {
    await draw();
    const fold = screen.getByText('كريم').closest('button') as HTMLButtonElement;
    fireEvent.click(fold);
    await waitFor(() => expect(document.querySelectorAll('li')).toHaveLength(0), WAIT);
    fireEvent.click(fold);
    await waitFor(() => expect(document.querySelectorAll('li')).toHaveLength(2), WAIT);
  });

  it('«رتّب لي الجولة» asks the same door once and draws the answer', async () => {
    await draw();
    const ask = screen.getByRole('button', { name: 'رتّب لي الجولة' });
    expect(ask.getAttribute('type')).toBe('button');
    fireEvent.click(ask);
    await screen.findByText('ابدأ بالكريم');
    expect(api.mock.calls.filter((c) => c[0] === '/api/ai/picking')).toEqual([['/api/ai/picking', { method: 'POST' }]]);
  });

  it('NEGATIVE: without the assistants’ key there is no box', async () => {
    holding('orders.view');
    await draw();
    expect(screen.queryByRole('button', { name: 'رتّب لي الجولة' })).toBeNull();
  });
});

describe('the surfaces', () => {
  it('the product group and the assistant box are the kit’s page-level Card (theme ornament on), the group still clips', async () => {
    await draw();
    const group = screen.getByText('كريم').closest('button')!.parentElement as HTMLElement;
    expect(group.className).toContain('zk-card');
    expect(group.className).toContain('overflow-hidden');
    const box = screen.getByRole('button', { name: 'رتّب لي الجولة' }).closest('.zk-card') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.className).toContain('p-3');
    expect(box).not.toBe(group);
  });

  it('NEGATIVE: the rows inside a group are not cards of their own', async () => {
    await draw();
    for (const li of document.querySelectorAll('li')) expect(li.closest('.zk-card')).not.toBe(li);
    expect(document.querySelectorAll('.zk-card')).toHaveLength(2);
  });
});

describe('a phone at 375px', () => {
  it('no fixed width anywhere in the tree, the frame shrinks, the two row presses share one row in halves', async () => {
    phone.value = true;
    await draw();
    const fixed = [...document.querySelectorAll('[class]')].filter((e) => /(?:^|\s)(?:min-)?w-\[\d/.test(e.getAttribute('class')!));
    expect(fixed).toEqual([]);
    const open = within(second()).getByRole('button', { name: 'افتح الطلب' });
    const cancel = within(second()).getByRole('button', { name: 'ألغِ الطلب' });
    expect(open.parentElement).toBe(cancel.parentElement);
    expect(open.parentElement!.className).toContain('grid-cols-2');
    fireEvent.click(open);
    await waitFor(() => expect(opened.at(-1)).toBe('o2'), WAIT);
    fireEvent.click(cancel);
    await waitFor(() => expect(rejecting.calls.at(-1)).toBe('ORD-2'), WAIT);
    fireEvent.click(within(second()).getByRole('button', { name: 'راجعه' }));
    await waitFor(() => expect(reviewed.at(-1)).toBe('cr2'), WAIT);
  });

  it('NEGATIVE: the phone draws no desk icons (no print press on the card) and the desk draws no «راجعه»', async () => {
    phone.value = true;
    await draw();
    expect(within(second()).queryByRole('button', { name: 'اطبع البوليصة' })).toBeNull();
    cleanup();
    phone.value = false;
    await draw();
    expect(within(second()).queryByRole('button', { name: 'راجعه' })).toBeNull();
  });
});
