// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { ProductVerifyView } from './ProductVerifyView';
import type { VerifyDesign } from '@/lib/product-verify-design';

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
