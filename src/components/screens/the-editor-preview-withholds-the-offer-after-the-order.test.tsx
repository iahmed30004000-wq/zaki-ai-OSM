// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE EDITOR'S PREVIEW IS THE PUBLISHED PAGE — AND THE PUBLISHED PAGE NEVER OFFERS THE BUNDLE AFTER THE ORDER.
 *
 * `liveOfferWhere` withholds a bundle flagged «بعد الطلب» from every door, so a visitor cannot pick the cheap
 * «زيد علبة» price as the first order's. The editor read the same product's offers and kept every ACTIVE one —
 * the after-order bundle among them — so the seller previewed a picker the page does not have.
 *
 * The real screen, with the network and the builder replaced: the builder only records the offers it is handed.
 */

const { crmApi, handed } = vi.hoisted(() => ({ crmApi: vi.fn(), handed: [] as { id: string }[][] }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'lp1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/screen-api', () => ({ screenApi: crmApi }));
vi.mock('@/components/ui/PageHeader', () => ({ PageHeader: () => null }));
vi.mock('@/components/landing-editor/BlockBuilder', () => ({
  BlockBuilder: (props: { offers: { id: string }[] }) => {
    handed.push(props.offers);
    return null;
  },
}));

import { LandingPageEditorScreen } from './LandingPageEditorScreen';

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, quantity: 1, freeQuantity: 0, sellingPrice: 14, isDefault: false, status: 'ACTIVE', postOrderOffer: false, ...over,
});

afterEach(cleanup);

describe('the preview’s pickable offers', () => {
  it('leave the after-order bundle out, exactly as the published page does — and keep every other live one', async () => {
    crmApi.mockImplementation(async (url: string) => {
      if (url === '/api/landing-pages/lp1') {
        return {
          landingPage: {
            id: 'lp1', slug: 'demo', productId: 'p1', isPublished: true, builderMode: 'BLOCKS',
            sections: null, theme: null, htmlContent: null, cssContent: null, pageSettings: null,
            product: { id: 'p1', name: 'كريم مرطّب للوجه', basePrice: 14, image: null },
            store: { name: 'المتجر', logo: null, supportPhone: null, country: { currencyCode: 'JOD' } },
          },
          family: null, hasUnpublished: false, canRevert: false,
        };
      }
      if (url === '/api/offers?productId=p1') {
        return {
          offers: [
            row('one', { isDefault: true }),
            row('after', { name: 'قطعة كمان', sellingPrice: 10, postOrderOffer: true }),
            row('stopped', { status: 'INACTIVE' }),
            row('two', { quantity: 2, sellingPrice: 25 }),
          ],
        };
      }
      if (url === '/api/landing-pages/lp1/recommendations') return { recommendations: [] };
      throw new Error(`unexpected ${url}`);
    });

    render(<LandingPageEditorScreen />);
    await waitFor(() => expect(handed.at(-1)?.length).toBeGreaterThan(0));
    expect(handed.at(-1)!.map((o) => o.id)).toEqual(['one', 'two']);
  });
});
