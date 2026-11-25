// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { ProductVerifyView } from './ProductVerifyView';
import { PRODUCT_VERIFY_CSS } from './product-verify-style';
import { VERIFY_NIGHT, type VerifyDesign } from '@/lib/product-verify-design';

/**
 * «باركود المنتجات» — the page a customer sees at `/v/<slug>`, and the owner's live preview of it.
 */

const DESIGN: VerifyDesign = {
  name: 'عطر زكي',
  headline: 'تحقق من قطعتك',
  description: 'وصف قصير',
  features: ['ثبات طويل', 'مكونات أصلية'],
  imageUrl: '/api/public/verify-product/AbCdEf123_-x/media/x.webp',
  logoUrl: null,
  primaryColor: '#0e9f6e',
  backgroundColor: '#f5f7fb',
  genuineMessage: 'أهلاً بك، قطعتك أصلية',
  notGenuineMessage: 'انتبه، الرمز غير مسجّل',
  whatsappUrl: 'https://wa.me/963912345678?text=x',
  reorderUrl: '/lp/atr',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the public page', () => {
  it('shows the product, its features and the two buttons, in the owner\'s colours', () => {
    const { container } = render(<ProductVerifyView design={DESIGN} publicId="AbCdEf123_-x" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('عطر زكي');
    for (const f of DESIGN.features) expect(screen.getByText(f)).toBeTruthy();
    expect(screen.getByRole('link', { name: /واتساب/ }).getAttribute('href')).toBe(DESIGN.whatsappUrl);
    expect(screen.getByRole('link', { name: /اطلب مرة تانية/ }).getAttribute('href')).toBe('/lp/atr');
    expect((container.querySelector('.vp') as HTMLElement).style.getPropertyValue('--vp-p')).toBe('#0e9f6e');
    // A light background cannot be a night page's: the night is drawn, untinted.
    expect((container.querySelector('.vp') as HTMLElement).style.getPropertyValue('--vp-base')).toBe(VERIFY_NIGHT);
    expect(screen.getByRole('heading', { name: 'عن المنتج' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'كيف يعمل؟' })).toBeTruthy();
    // The product picture sits in the framed stage, and the hero shield is not drawn twice.
    expect(container.querySelector('.vp-frame img')?.getAttribute('src')).toBe(DESIGN.imageUrl);
    expect(container.querySelector('.vp-shield')).toBeNull();
  });

  it('with nothing optional it still stands: the shield in place of a picture, no «عن المنتج», no buttons', () => {
    const bare: VerifyDesign = { ...DESIGN, description: '', features: [], imageUrl: null, whatsappUrl: null, reorderUrl: null };
    const { container } = render(<ProductVerifyView design={bare} publicId="AbCdEf123_-x" />);
    expect(container.querySelector('.vp-frame')).toBeNull();
    expect(container.querySelector('.vp-shield svg')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'عن المنتج' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'كيف يعمل؟' })).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('امسح بالكاميرا')).toBeTruthy();
  });

  it('every gradient the marks point at exists on the page, once', () => {
    const { container } = render(<ProductVerifyView design={DESIGN} preview={{ verdict: 'genuine' }} />);
    const ids = [...container.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const refs = [...container.querySelectorAll('path[fill^="url(#"]')].map((e) => e.getAttribute('fill')!.slice(5, -1));
    expect(refs.length).toBeGreaterThan(1);
    for (const id of refs) expect(ids).toContain(id);
  });

  it('a code in the link is checked by itself, against THIS page, and the owner\'s genuine message is shown', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ genuine: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ProductVerifyView design={DESIGN} publicId="AbCdEf123_-x" initialCode="P-0042" />);
    await waitFor(() => expect(screen.getByText('منتج أصلي')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText(DESIGN.genuineMessage)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/public/verify-product/AbCdEf123_-x', expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: 'P-0042' }) }));
  });

  it('NEGATIVE: not genuine shows the calm warning with the owner\'s words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ genuine: false }), { status: 200 })));
    render(<ProductVerifyView design={DESIGN} publicId="AbCdEf123_-x" />);
    fireEvent.change(screen.getByLabelText('رمز القطعة'), { target: { value: 'FAKE-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'تحقق' }));
    await waitFor(() => expect(screen.getByText(DESIGN.notGenuineMessage)).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByText('منتج أصلي')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('لم نتمكن من التأكد');
    // «أعد المحاولة» clears the code and the verdict.
    fireEvent.click(screen.getByRole('button', { name: 'أعد المحاولة' }));
    expect(screen.queryByText(DESIGN.notGenuineMessage)).toBeNull();
    expect((screen.getByLabelText('رمز القطعة') as HTMLInputElement).value).toBe('');
  });
});

describe('the owner\'s preview', () => {
  it('makes no request, and shows the verdict the owner picked', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<ProductVerifyView design={DESIGN} preview={{ verdict: 'genuine' }} initialCode="P-1" />);
    expect(screen.getByText(DESIGN.genuineMessage)).toBeTruthy();
    rerender(<ProductVerifyView design={DESIGN} preview={{ verdict: 'fake' }} />);
    expect(screen.getByText(DESIGN.notGenuineMessage)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('رمز القطعة'), { target: { value: 'X-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'تحقق' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the look', () => {
  it('every rule stays under .vp, reduced motion stops the animations, and nothing is pinned to the screen', () => {
    const selectors = PRODUCT_VERIFY_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
      .replace(/@(media|supports)[^{]+\{/g, '')
      .match(/[^{}]+(?=\{)/g)!
      .flatMap((sel) => sel.split(','))
      .map((sel) => sel.trim())
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(50);
    for (const sel of selectors) expect(sel, sel).toMatch(/^\.vp/);
    expect(PRODUCT_VERIFY_CSS).toMatch(/prefers-reduced-motion:reduce\)\{\s*\.vp \*,\.vp \*::before,\.vp \*::after\{animation:none!important/);
    // The page also sits inside the editor's preview box.
    expect(PRODUCT_VERIFY_CSS).not.toMatch(/position:fixed/);
  });
});
