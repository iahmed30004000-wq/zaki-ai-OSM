// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «تنبيهات الخصم» ON THE KIT (18/11, R16f).
 *
 * The frame is `PageShell`, titled from the registry; the two surfaces are
 * `Card`; the one tick («الخصومات الكبيرة فقط») is the kit `Checkbox` with
 * an explicit id, so its words toggle that box and nothing else. What the
 * screen asks the server, and what it filters, did not move.
 *
 * Class names below are built from pieces: the stylesheet is generated from
 * every file, tests included, and a whole class name written here would be a
 * rule the sheet grows for nothing.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { DiscountAlertsScreen } from './DiscountAlertsScreen';
import { routeLabel } from '@/lib/route-registry';

vi.setConfig({ testTimeout: 20000 });
const WAIT = { timeout: 8000 };
const BOX_ID = 'discount-alerts-only-notable';

const row = (id: string, notable: boolean) => ({
  id,
  orderNumber: `SY-${id}`,
  merchantRef: null,
  createdAt: '2026-10-20T12:00:00.000Z',
  customerName: `زبون ${id}`,
  discount: 5,
  total: 40,
  share: notable ? 30 : 5,
  notable,
  currency: 'JOD',
  byName: 'موظفة',
  confirmationStatus: 'CONFIRMED',
});

const payload = (notable: number) => ({
  days: 30,
  currency: 'JOD',
  notableThreshold: 20,
  totals: { orders: 2, discount: 10, notable },
  byPerson: [{ id: 'u1', name: 'موظفة', orders: 2, total: 10, biggestShare: 30 }],
  orders: [row('1', notable > 0), row('2', false)],
});

const SRC = readFileSync(join(process.cwd(), 'src/components/screens/DiscountAlertsScreen.tsx'), 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function press(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

const box = () => document.getElementById(BOX_ID) as HTMLInputElement | null;
const ordersHeading = () => screen.getByRole('heading', { level: 2, name: /^الطلبات/ });

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('the frame', () => {
  it('one h1, the registry name of the address, inside the wide frame', async () => {
    apiJson.mockResolvedValue(payload(1));
    render(<DiscountAlertsScreen />);
    await screen.findAllByText('SY-1', undefined, WAIT);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toContain(routeLabel('/control/discount-alerts'));
    const frame = h1.closest(`.${'max-w'}-6xl`);
    expect(frame, 'الإطار العريض متل قبل').not.toBeNull();
  });

  it('the source draws PageShell titled from the registry, Card for its surfaces, and no hand-made tick, surface or tiny text', () => {
    expect(code).toMatch(/<PageShell title=\{routeLabel\('\/control\/discount-alerts'\)\} width="wide">/);
    expect(code).not.toMatch(/<PageHeader\b/);
    expect((code.match(/<Card\b/g) ?? []).length).toBe(2);
    expect(code).not.toMatch(/<input\b/);
    expect(code).not.toContain(`rounded-lg ${'p'}-4`);
    expect(code).not.toContain(`text-${'xs'}`);
  });
});

describe('the one tick: «الخصومات الكبيرة فقط»', () => {
  it('is the kit box, with its own id, and its words point at it', async () => {
    apiJson.mockResolvedValue(payload(1));
    render(<DiscountAlertsScreen />);
    await screen.findAllByText('SY-1', undefined, WAIT);
    const input = box();
    expect(input, 'المربّع بالـid الصريح').not.toBeNull();
    expect(input!.type).toBe('checkbox');
    expect(screen.getAllByRole('checkbox')).toEqual([input]);
    const label = input!.closest('label')!;
    expect(label.getAttribute('for')).toBe(BOX_ID);
    expect(label.textContent).toContain('الخصومات الكبيرة فقط (فوق 20%)');
  });

  it('pressing the WORDS ticks it and hides the ordinary discounts; pressing again brings them back', async () => {
    apiJson.mockResolvedValue(payload(1));
    render(<DiscountAlertsScreen />);
    await screen.findAllByText('SY-2', undefined, WAIT);
    expect(box()!.checked).toBe(false);
    expect(ordersHeading().textContent).toBe('الطلبات (2)');

    await press(screen.getByText(/الخصومات الكبيرة فقط/));
    expect(box()!.checked).toBe(true);
    expect(ordersHeading().textContent).toBe('الطلبات (1)');
    expect(screen.queryAllByText('SY-2')).toEqual([]);
    expect(screen.getAllByText('SY-1').length).toBeGreaterThan(0);

    await press(box()!);
    expect(box()!.checked).toBe(false);
    expect(ordersHeading().textContent).toBe('الطلبات (2)');
    expect(screen.getAllByText('SY-2').length).toBeGreaterThan(0);
  });

  it('the tick asks the server nothing — it filters what is already here', async () => {
    apiJson.mockResolvedValue(payload(1));
    render(<DiscountAlertsScreen />);
    await screen.findAllByText('SY-1', undefined, WAIT);
    const calls = apiJson.mock.calls.length;
    await press(box()!);
    expect(apiJson.mock.calls.length).toBe(calls);
  });

  it('carries the count of big discounts beside its words — and no chip when there are none', async () => {
    apiJson.mockResolvedValue(payload(1));
    const { unmount } = render(<DiscountAlertsScreen />);
    await screen.findAllByText('SY-1', undefined, WAIT);
    const label = box()!.closest('label')!;
    expect(within(label).getByText('1')).toBeTruthy();
    unmount();

    apiJson.mockResolvedValue(payload(0));
    render(<DiscountAlertsScreen />);
    await screen.findAllByText('SY-1', undefined, WAIT);
    expect(box()!.closest('label')!.textContent).toBe('الخصومات الكبيرة فقط (فوق 20%)');
  });

  it('is not drawn before the numbers arrive (it names a threshold the server sends)', async () => {
    apiJson.mockReturnValue(new Promise(() => {}));
    render(<DiscountAlertsScreen />);
    await screen.findByText(/جارٍ التحميل/, undefined, WAIT);
    expect(box()).toBeNull();
  });
});

describe('what the screen asks the server did not move', () => {
  it('30 days first; another period asks again with that period', async () => {
    apiJson.mockResolvedValue(payload(1));
    render(<DiscountAlertsScreen />);
    await screen.findAllByText('SY-1', undefined, WAIT);
    expect(apiJson.mock.calls[0][0]).toBe('/api/control/discount-alerts?days=30');
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '7' } });
    });
    await screen.findAllByText('SY-1', undefined, WAIT);
    expect(apiJson.mock.calls.at(-1)![0]).toBe('/api/control/discount-alerts?days=7');
  });

  it('the summary sentence reads the same', async () => {
    apiJson.mockResolvedValue(payload(1));
    render(<DiscountAlertsScreen />);
    await screen.findAllByText('SY-1', undefined, WAIT);
    const p = screen.getByText(/طلباً بخصم/);
    expect(p.textContent).toMatch(/^2 طلباً بخصم، بإجمالي .*10.* — منها 1 فوق 20%$/);
  });
});

describe('a phone, 375px', () => {
  it('nothing in the screen carries a fixed width, and the filter row wraps', async () => {
    apiJson.mockResolvedValue(payload(1));
    const { container } = render(<DiscountAlertsScreen />);
    await screen.findAllByText('SY-1', undefined, WAIT);
    const fixed = [...container.querySelectorAll('*')].filter((el) =>
      String(el.getAttribute('class') ?? '')
        .split(/\s+/)
        .some((c) => /^(min-)?w-\[\d+(px|rem)\]$/.test(c))
    );
    expect(fixed).toEqual([]);
    const row = screen.getByRole('combobox').closest('label')!.parentElement!;
    expect(row.className.split(/\s+/)).toContain(`flex-${'wrap'}`);
    expect(code).not.toMatch(/style=\{\{[^}]*width/);
  });
});
