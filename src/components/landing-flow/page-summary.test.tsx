// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { PageSummary } from './PageSummary';

/**
 * «عرض» — THE PAGE ON ONE CARD: product, link, status, live offers, and
 * edit / preview / duplicate. It prints what the server sent and works
 * nothing out; the numbers are one link away, on their one screen.
 */

const base = {
  lp: {
    name: 'صفحة الحزام',
    isPublished: false,
    product: { name: 'حزام الظهر' },
    theme: JSON.stringify({ accent: '#e11d48', design: 'rose-gold' }),
  },
  publicUrl: 'https://shop.test/lp/belt',
  offers: [{ id: 'o1', name: 'قطعتين', quantity: 2, freeQuantity: 0, price: 210 }],
  copied: false,
  onCopy: vi.fn(),
  onEdit: vi.fn(),
  onPreview: vi.fn(),
  onDuplicate: vi.fn(),
};

afterEach(cleanup);

describe('the page summary', () => {
  it('prints the product, the link and the status, and links the numbers to their one screen', () => {
    render(<PageSummary {...base} />);
    expect(screen.getByText('حزام الظهر')).toBeTruthy();
    expect(screen.getByText(base.publicUrl)).toBeTruthy();
    expect(screen.getByText('مسودة')).toBeTruthy();
    const numbers = screen.getByRole('link', { name: /المشاهدات والطلبات والتحويل/ });
    expect(numbers.getAttribute('href')).toBe('/growth/performance?tab=landing');
  });

  it('lists the live offers with the price as sent', () => {
    render(<PageSummary {...base} />);
    expect(screen.getByText('قطعتين')).toBeTruthy();
    expect(screen.getByText('قطعتين').parentElement!.textContent).toContain('210');
  });

  it('names the design the page was started from', () => {
    render(<PageSummary {...base} />);
    expect(screen.getByText('روز غولد')).toBeTruthy();
  });

  it('names no design for an unknown id or an unreadable theme', () => {
    render(<PageSummary {...base} lp={{ ...base.lp, theme: JSON.stringify({ design: 'no-such' }) }} />);
    expect(screen.queryByText('التصميم')).toBeNull();
    cleanup();
    render(<PageSummary {...base} lp={{ ...base.lp, theme: '{not json' }} />);
    expect(screen.queryByText('التصميم')).toBeNull();
  });

  it('says why there are no offers — none live, or no product at all', () => {
    render(<PageSummary {...base} offers={[]} />);
    expect(screen.getByText('ما في عروض شغّالة لهالمنتج.')).toBeTruthy();
    cleanup();
    render(<PageSummary {...base} offers={[]} lp={{ ...base.lp, product: null }} />);
    expect(screen.getByText('الصفحة بلا منتج، فما إلها عروض.')).toBeTruthy();
  });

  it('hands each of its four buttons to its own door', async () => {
    const user = userEvent.setup();
    render(<PageSummary {...base} />);
    await user.click(screen.getByRole('button', { name: 'تعديل' }));
    await user.click(screen.getByRole('button', { name: 'معاينة' }));
    await user.click(screen.getByRole('button', { name: 'انسخ الصفحة' }));
    await user.click(screen.getByRole('button', { name: 'انسخ الرابط' }));
    expect(base.onEdit).toHaveBeenCalledTimes(1);
    expect(base.onPreview).toHaveBeenCalledTimes(1);
    expect(base.onDuplicate).toHaveBeenCalledTimes(1);
    expect(base.onCopy).toHaveBeenCalledTimes(1);
  });
});
