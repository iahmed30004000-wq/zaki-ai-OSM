// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

/**
 * /lp/design-preview/<design>?product=<id> — STAFF ONLY, AND IT TAKES NO ORDER.
 *
 * The library's «معاينة كاملة» draws one design over the seller's own
 * product. It reads a company's product, so it is shut to everybody the
 * editor's own preview is shut to, and it answers «not found» rather than
 * «forbidden»: a stranger learns nothing, not even that the address is real.
 */

const h = vi.hoisted(() => ({
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  productFind: vi.fn(),
  storeFind: vi.fn(),
  offers: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/geo-context', () => ({ requireContext: h.requireContext }));
vi.mock('@/lib/authorization', () => ({ requirePermission: h.requirePermission }));
vi.mock('@/lib/offers', () => ({ activeOffersFor: h.offers }));
vi.mock('@/lib/db', () => ({ db: { product: { findFirst: h.productFind }, store: { findFirst: h.storeFind } } }));

import { DesignPreview } from './DesignPreview';
import { metadata } from '@/app/lp/design-preview/[design]/page';

const CTX = {
  companyId: 'c1',
  storeId: 's1',
  countryId: 'k1',
  user: { id: 'u1' },
  country: { id: 'k1', code: 'SY', currencyCode: 'USD', minorUnit: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireContext.mockResolvedValue(CTX);
  h.requirePermission.mockResolvedValue({ id: 'u1' });
  h.productFind.mockResolvedValue({ id: 'p1', name: 'طاقية الشعر', basePrice: 30, image: '/api/media/p1.jpg' });
  h.storeFind.mockResolvedValue({ name: 'متجر', logo: null, supportPhone: null });
  h.offers.mockResolvedValue([]);
});
afterEach(cleanup);

describe('who may see a design preview', () => {
  it('nobody without a session', async () => {
    h.requireContext.mockRejectedValue(new Error('Unauthorized'));
    await expect(DesignPreview({ design: 'cod-bold', productId: 'p1' })).rejects.toThrow('NOT_FOUND');
    expect(h.productFind).not.toHaveBeenCalled();
  });

  it('nobody without the landing pages permission', async () => {
    h.requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission landing_pages.view'));
    await expect(DesignPreview({ design: 'cod-bold', productId: 'p1' })).rejects.toThrow('NOT_FOUND');
    expect(h.requirePermission).toHaveBeenCalledWith('landing_pages.view');
    expect(h.productFind).not.toHaveBeenCalled();
  });

  it('no design this build does not carry', async () => {
    await expect(DesignPreview({ design: 'no-such-design', productId: 'p1' })).rejects.toThrow('NOT_FOUND');
  });

  it('no product of another company — the read itself is scoped to the viewer’s company', async () => {
    h.productFind.mockResolvedValue(null);
    await expect(DesignPreview({ design: 'cod-bold', productId: 'p-other' })).rejects.toThrow('NOT_FOUND');
    expect(h.productFind.mock.calls[0][0].where).toEqual({ id: 'p-other', companyId: 'c1' });
  });
});

describe('what a design preview shows', () => {
  it('the design over our default blocks, with the product’s own name — and a form that cannot take an order', async () => {
    const el = await DesignPreview({ design: 'cod-bold', productId: 'p1' });
    const { container } = render(el);
    expect(container.querySelector('[data-design="cod-bold"]')).not.toBeNull();
    expect(container.querySelector('[data-zd-role="hero"] h1')?.textContent).toBe('طاقية الشعر');
    expect(container.querySelector('#zaki-order-form')).toBeNull();
    expect(container.textContent).toContain('نموذج الطلب');
  });

  it('works without a product, as a frame the seller can judge', async () => {
    const el = await DesignPreview({ design: 'cod-bold', productId: null });
    const { container } = render(el);
    expect(h.productFind).not.toHaveBeenCalled();
    expect(container.querySelector('[data-design="cod-bold"] .zd-frame')).not.toBeNull();
  });

  it('asks search engines to stay out', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
