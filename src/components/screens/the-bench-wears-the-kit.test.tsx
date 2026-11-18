// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «منصّة التجريب» ON THE KIT (R14c, plan 17/11 — written 18/11).
 *
 * The screen moved onto `PageShell`, `Card plain` and the kit's own button names. What must NOT have moved with it:
 * the one door it reads (`/api/growth/bench`, with no window), the verdict words and figures (B3's own test file
 * is unedited and stays green), every write's body, and a press inside a form that must not submit.
 *
 * And the one new line: the four report tabs share one span of days, this door takes none, so where the other
 * tabs draw the date box this one says «الأرقام هون لحظية — ما بتتبع المدة» — and it neither reads nor writes the
 * shared span, so the span picked on another tab is still there when the owner goes back.
 *
 * jsdom has no layout: «no sideways scroll at 375px» is checked as the classes that make it (the frame's
 * `min-w-0`, no width cap, the table through `Rows`), and said so in the pull request.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/growth/bench' }));

import { BenchScreen } from './BenchScreen';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { routeLabel } from '@/lib/route-registry';
import { DEFAULT_BENCH_RULES } from '@/lib/bench-verdict';

const LINE = 'الأرقام هون لحظية — ما بتتبع المدة';

const product = (id: string) => ({
  id,
  name: `منتج ${id}`,
  sku: null,
  bench: 'منصّة',
  price: 10,
  category: 'عناية',
  triedAt: '2026-11-16',
  orders: 10,
  delivered: 3,
  returned: 1,
  deliveryRate: 75,
  decided: 4,
  currency: 'USD',
  minorUnit: 2,
  today: '2026-11-18',
  test: {
    startDay: '2026-11-16', dayIndex: 3, spend: 30, orders: 10, confirmed: 8, confirmationRate: 80,
    costPerOrder: 3, costPerConfirmed: 3.75, missingSpendDays: [], ordersBeforeStart: 2, spendBeforeStart: 0,
  },
  rules: { ...DEFAULT_BENCH_RULES },
  customRules: true,
  verdict: { state: 'SUCCESS', reason: 'اليوم 3: تكلفة الطلب 3 تحت الهدف 4', flag: null },
  spendEntries: [{ id: 's1', day: '2026-11-16', amount: 10 }],
});

const FULL = {
  currency: 'USD',
  benches: [{ id: 'b1', name: 'منصّة' }],
  excluded: 'طلبات المنصّة ما بتدخل بالأرباح.',
  dna: {
    sellers: 12,
    minSellers: 10,
    whyNot: null,
    traits: [{ field: 'skin', label: 'نوع البشرة', value: 'جافّة', shared: 7, outOf: 9, line: '' }],
  },
  results: [product('a')],
};
const NO_BENCH = { currency: 'USD', benches: [], results: [], excluded: null, dna: { sellers: 0, minSellers: 10, traits: null, whyNot: null } };

let payload: unknown = FULL;
beforeEach(() => {
  payload = FULL;
  apiJson.mockReset();
  apiJson.mockImplementation(async (_url: string, init?: { method?: string }) => (init?.method === 'POST' ? { ok: true } : payload));
  try {
    window.sessionStorage.clear();
  } catch {
    /* a blocked storage is a case below */
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const draw = async (p: unknown = FULL) => {
  payload = p;
  render(<BenchScreen />);
  await waitFor(() => expect(screen.queryByText(/جارٍ التحميل/)).toBeNull());
};
const gets = () => apiJson.mock.calls.filter((c) => !c[1]);
const posts = () => apiJson.mock.calls.filter((c) => c[1]?.method === 'POST');
const openPanel = async () => {
  await draw();
  await userEvent.click(screen.getAllByRole('button', { name: 'الأرقام والصرف' })[0]);
  return screen.getByRole('dialog');
};
/** The class a kit part draws, read from the part itself — so no class name is written in this file. */
const classOf = (el: React.ReactElement) => {
  const { container, unmount } = render(el);
  const c = (container.firstElementChild as HTMLElement).className;
  unmount();
  return c;
};

describe('the frame', () => {
  it('draws ONE heading, the name the menu gives the page', async () => {
    await draw();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(routeLabel('/growth/bench'));
  });

  it('is the full width (no cap) and may shrink, so a phone never scrolls sideways', async () => {
    await draw();
    const frame = screen.getByRole('heading', { level: 1 }).closest('div.min-w-0') as HTMLElement;
    expect(frame).not.toBeNull();
    for (let el: HTMLElement | null = frame; el; el = el.parentElement) {
      expect(el.className, el.tagName).not.toMatch(/max-w-(3xl|4xl|6xl)/);
    }
    for (const f of ['BenchScreen.tsx', 'BenchTestPanel.tsx']) {
      const src = readFileSync(join(process.cwd(), 'src/components/screens', f), 'utf8');
      expect(src, f).not.toMatch(/overflow-x-(auto|scroll)|min-w-\[|w-\[\d{3,}px\]|whitespace-nowrap|<table\b/);
    }
  });
});

describe('the door takes no window, and the screen says so', () => {
  it('says the one line in the row under the header — with data, with no bench yet, and while loading', async () => {
    await draw();
    const line = screen.getByText(LINE);
    // In the frame's toolbar row: the row right after the header, before the content.
    const header = screen.getByRole('heading', { level: 1 }).closest('header, div')!;
    expect(header.contains(line)).toBe(false);
    cleanup();

    await draw(NO_BENCH);
    expect(screen.getByText('لا منصّة تجريب بعد')).toBeTruthy();
    expect(screen.getByText(LINE)).toBeTruthy();
    cleanup();

    apiJson.mockImplementation(() => new Promise(() => {}));
    render(<BenchScreen />);
    expect(screen.getByText(/جارٍ التحميل/)).toBeTruthy();
    expect(screen.getByText(LINE)).toBeTruthy();
  });

  it('draws NO date box — the line stands where it would be', async () => {
    await draw();
    const src = readFileSync(join(process.cwd(), 'src/components/screens/BenchScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/from '@\/components\/ui\/DateRange'/);
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(0);
  });

  it('asks the same one door, with no span of days in the address', async () => {
    await draw();
    expect(gets().length).toBeGreaterThan(0);
    for (const [url] of gets()) expect(url).toBe('/api/growth/bench');
  });

  it('keeps the span picked on another tab: the shared storage is the same before and after', async () => {
    window.sessionStorage.setItem('some-report-span', JSON.stringify({ from: '2026-11-01', to: '2026-11-07' }));
    const before = JSON.stringify({ ...window.sessionStorage });
    await openPanel();
    expect(JSON.stringify({ ...window.sessionStorage })).toBe(before);
    expect(window.sessionStorage.length).toBe(1);
  });

  it('a storage that throws changes nothing: the screen draws and says its line', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await draw();
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(screen.getAllByText('منتج a').length).toBeGreaterThan(0);
  });
});

describe('the surfaces and presses are the kit’s', () => {
  it('the «isolated» note and each shared trait sit on a dense card, and their words are unchanged', async () => {
    await draw();
    const dense = classOf(<Card plain padding="sm">x</Card>);
    const note = screen.getByText(/أرقام هذه الشاشة معزولة/).closest('div') as HTMLElement;
    expect(note.className).toBe(dense);
    expect(note.textContent).toContain('طلبات المنصّة ما بتدخل بالأرباح.');

    const plainBase = classOf(<Card plain>x</Card>);
    const trait = screen.getByText('جافّة').parentElement as HTMLElement;
    expect(trait.tagName).toBe('DIV');
    expect(trait.closest('li')).not.toBeNull();
    for (const c of plainBase.split(/\s+/).filter(Boolean)) expect(trait.classList.contains(c), c).toBe(true);
    expect(trait.textContent).toBe('نوع البشرة: جافّة7 من 9');
  });

  it('NEGATIVE: the dense card is not the page card (no theme corner on a note or a chip)', async () => {
    await draw();
    const page = classOf(<Card>x</Card>);
    const dense = classOf(<Card plain padding="sm">x</Card>);
    expect(page).not.toBe(dense);
    const note = screen.getByText(/أرقام هذه الشاشة معزولة/).closest('div') as HTMLElement;
    expect(note.className).not.toBe(page);
  });

  it('«الأرقام والصرف» is the kit’s secondary press', async () => {
    await draw();
    const kit = classOf(
      <Button type="button" size="sm" variant="secondary">
        x
      </Button>
    );
    expect(screen.getAllByRole('button', { name: 'الأرقام والصرف' })[0].className).toBe(kit);
  });

  it('the panel’s verdict sits on a dense card, and its row presses are the kit’s quiet ones', async () => {
    const d = await openPanel();
    const dense = classOf(<Card plain padding="sm">x</Card>);
    const verdictBox = within(d).getByText(/انحكم بهالقواعد/).parentElement as HTMLElement;
    for (const c of dense.split(/\s+/).filter(Boolean)) expect(verdictBox.classList.contains(c), c).toBe(true);
    const quiet = classOf(
      <Button type="button" size="sm" variant="quiet">
        x
      </Button>
    );
    expect(within(d).getByRole('button', { name: 'صحّح' }).className).toBe(quiet);
    expect(within(d).getByRole('button', { name: 'ألغِ' }).className).toBe(quiet);
  });
});

describe('inside a form, a press that must not submit does not submit', () => {
  it('every press in the panel says its type', async () => {
    const d = await openPanel();
    const buttons = [...d.querySelectorAll('form button')] as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(2);
    for (const b of buttons) expect(['button', 'submit'], b.textContent!).toContain(b.getAttribute('type'));
  });

  it('NEGATIVE: «صحّح», «رجوع» and «رجّع الافتراضي»… only «رجّع الافتراضي» writes — and it writes the reset, never a spend', async () => {
    const d = await openPanel();
    await userEvent.click(within(d).getByRole('button', { name: 'صحّح' }));
    await userEvent.click(within(d).getByRole('button', { name: 'رجوع' }));
    expect(posts()).toHaveLength(0);
    await userEvent.click(within(d).getByRole('button', { name: 'رجّع الافتراضي' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ productId: 'a', action: 'rules', rules: null });
  });
});

describe('the figures and the bodies did not move', () => {
  it('the row and the panel print the door’s numbers, untouched', async () => {
    const d = await openPanel();
    expect(within(d).getByText('اليوم 3 من التيست')).toBeTruthy();
    expect(within(d).getByText(/2 طلب قبل بداية التيست/)).toBeTruthy();
    cleanup();
    await draw();
    expect(screen.getAllByText('8 من 10').length).toBeGreaterThan(0);
    expect(screen.getAllByText('من 4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('عناية').length).toBeGreaterThan(0);
  });

  it('a correction posts the same body as before', async () => {
    const d = await openPanel();
    await userEvent.click(within(d).getByRole('button', { name: 'صحّح' }));
    const field = within(d).getByLabelText('المبلغ الصحيح');
    await userEvent.clear(field);
    await userEvent.type(field, '11');
    await userEvent.click(within(d).getByRole('button', { name: 'احفظ التصحيح' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ productId: 'a', action: 'correct', entryId: 's1', amount: '11' });
  });
});
