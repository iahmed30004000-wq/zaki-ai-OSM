// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * «مكتبة القوالب» — THE SIXTY-FOUR, FILTERED, OPENED, AND STARTED FROM.
 *
 * His other platform's library, by its own words: «64 قالب · 28 متحرك»,
 * filters by product, mood, category and name, and a design view whose
 * «استخدم هالقالب» starts the wizard with that design chosen.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { LandingLibraryScreen, wizardHref } from './LandingLibraryScreen';
import { DESIGNS } from '@/lib/landing-designs/catalog';

const PRODUCT = { id: 'p1', name: 'حزام الظهر', basePrice: 120 };

/** The one product picker, opened and answered. */
const previewWith = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /بدون منتج/ }));
  await user.click(await screen.findByText(new RegExp(`^${PRODUCT.name}`)));
};

const cards = () => within(screen.getByRole('list', { name: 'القوالب' })).queryAllByRole('listitem');
const dialog = () => within(screen.getByRole('dialog'));

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/store/landing-pages/library');
  apiJson.mockImplementation(async (path: string) => (path === '/api/products' ? { products: [PRODUCT] } : {}));
});
afterEach(cleanup);

describe('the library', () => {
  it('counts itself in its title and shows every design', () => {
    render(<LandingLibraryScreen />);
    expect(screen.getByText('64 قالب · 28 متحرك')).toBeTruthy();
    expect(cards()).toHaveLength(64);
  });

  it('is the second tab beside the pages', () => {
    render(<LandingLibraryScreen />);
    const tab = screen.getByRole('link', { name: 'مكتبة القوالب' });
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'الصفحات' }).getAttribute('href')).toBe('/store/landing-pages');
  });

  it('filters by mood, and the category counts follow it', async () => {
    const user = userEvent.setup();
    render(<LandingLibraryScreen />);
    await user.selectOptions(screen.getByLabelText('الأسلوب'), 'dark');
    expect(cards()).toHaveLength(27);
    // «الكل» now counts the dark ones, not all sixty-four.
    expect(screen.getByRole('button', { name: /^الكل/ }).textContent).toContain('27');
  });

  it('filters by category', async () => {
    const user = userEvent.setup();
    render(<LandingLibraryScreen />);
    await user.click(screen.getByRole('button', { name: /^تفاعلي \(متحرك\)/ }));
    expect(cards()).toHaveLength(28);
  });

  it('searches by name, and says so when nothing is left', async () => {
    const user = userEvent.setup();
    render(<LandingLibraryScreen />);
    await user.type(screen.getByLabelText('بحث بالاسم'), 'روز غولد');
    expect(cards()).toHaveLength(1);
    await user.clear(screen.getByLabelText('بحث بالاسم'));
    await user.type(screen.getByLabelText('بحث بالاسم'), 'ما في هيك');
    expect(screen.queryByRole('list', { name: 'القوالب' })).toBeNull();
    expect(screen.getByText('ما في قالب بهالفلاتر.')).toBeTruthy();
  });

  it('draws every full-preview link with the product chosen to preview with', async () => {
    const user = userEvent.setup();
    render(<LandingLibraryScreen />);
    await previewWith(user);
    const links = screen.getAllByText('معاينة كاملة ↗').map((a) => a.closest('a')!.getAttribute('href'));
    expect(links.every((h) => h!.endsWith('?product=p1'))).toBe(true);
  });
});

describe('a design, opened', () => {
  it('shows its font, its colours, both devices, and «شوف كمان» without itself', async () => {
    const user = userEvent.setup();
    render(<LandingLibraryScreen />);
    await user.click(screen.getByRole('button', { name: 'افتح روز غولد' }));
    const rose = DESIGNS.find((d) => d.id === 'rose-gold')!;
    expect(dialog().getByText(rose.font)).toBeTruthy();
    for (const c of rose.swatches) expect(dialog().getByText(c)).toBeTruthy();
    const frame = dialog().getByTitle('معاينة روز غولد') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('/lp/design-preview/rose-gold');
    await user.click(dialog().getByRole('button', { name: 'موبايل' }));
    expect(frame.style.width).toBe('390px');
    expect(dialog().queryByRole('button', { name: 'افتح روز غولد' })).toBeNull();
    expect(dialog().getAllByRole('button', { name: /^افتح / }).length).toBeGreaterThan(0);
  });

  it('starts the wizard from it, on the design path and on the AI path', async () => {
    const user = userEvent.setup();
    render(<LandingLibraryScreen />);
    await previewWith(user);
    await user.click(screen.getByRole('button', { name: 'افتح روز غولد' }));
    expect(dialog().getByRole('link', { name: 'استخدم هالقالب' }).getAttribute('href')).toBe(
      '/store/landing-pages?new=1&way=design&design=rose-gold&product=p1'
    );
    expect(dialog().getByRole('link', { name: /اكتبها بالذكاء الاصطناعي بهالقالب/ }).getAttribute('href')).toBe(
      '/store/landing-pages?new=1&way=ai&design=rose-gold&product=p1'
    );
    expect(dialog().getByRole('button', { name: /انسخ البرومبت/ })).toBeTruthy();
  });

  it('opens straight away when the address names it, and not for an unknown id', () => {
    window.history.replaceState(null, '', '/store/landing-pages/library?design=cod-bold');
    render(<LandingLibraryScreen />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    cleanup();
    window.history.replaceState(null, '', '/store/landing-pages/library?design=no-such');
    render(<LandingLibraryScreen />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves the product out of the wizard address when none was chosen', () => {
    expect(wizardHref('design', 'cod-bold')).toBe('/store/landing-pages?new=1&way=design&design=cod-bold');
  });
});
