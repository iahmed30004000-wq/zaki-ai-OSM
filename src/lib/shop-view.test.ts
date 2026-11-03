import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  previewId: null as string | null,
  sessionId: null as string | null,
  findFirst: vi.fn(),
  getStorefront: vi.fn(),
}));

// The frame's answer implies the session's: a test that sets one sets both unless it says otherwise.
vi.mock('./store-preview', () => ({
  previewStoreIdFor: async () => h.previewId,
  previewSessionStoreId: async () => h.sessionId ?? h.previewId,
}));
vi.mock('./db', () => ({ db: { store: { findFirst: (a: unknown) => h.findFirst(a) } } }));
vi.mock('./storefront', async (orig) => ({
  ...(await orig<typeof import('./storefront')>()),
  getStorefront: (s: string) => h.getStorefront(s),
}));
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));

import { getShopView } from './shop-view';
import { parseStoreTheme } from './store-theme';

const LIVE = JSON.stringify({ accent: '#111111', mood: 'clean', font: 'cairo', corners: 'soft', checkout: { submitText: 'الحي', fieldOrder: [], required: [], hidden: [], afterOrderMessage: '' } });
const DRAFT = JSON.stringify({ accent: '#e0533d', mood: 'clean', font: 'cairo', corners: 'soft', look: 'nova', checkout: { submitText: 'المسودة', fieldOrder: [], required: ['note'], hidden: [], afterOrderMessage: '' } });

const live = { id: 's1', companyId: 'c1', slug: 'my-shop', theme: parseStoreTheme(LIVE), homeLive: '[]' };

beforeEach(() => {
  h.previewId = null;
  h.sessionId = null;
  h.getStorefront.mockReset().mockResolvedValue(live);
  h.findFirst.mockReset().mockResolvedValue({ theme: LIVE, themeDraft: DRAFT, homeDraft: '[{"x":1}]', homeLive: '[]' });
});

describe('a customer gets the live shop, the very object getStorefront read', () => {
  it('and no draft column is read', async () => {
    expect(await getShopView('my-shop')).toBe(live);
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it('a shop that is not open is not found, preview or not', async () => {
    h.getStorefront.mockResolvedValue(null);
    h.previewId = 's1';
    expect(await getShopView('my-shop')).toBeNull();
  });
});

describe('inside the seller’s preview frame', () => {
  beforeEach(() => {
    h.previewId = 's1';
  });

  it('draws the draft theme and the draft home, read by this store AND company', async () => {
    const shop = await getShopView('my-shop');
    expect(h.findFirst.mock.calls[0][0].where).toEqual({ id: 's1', companyId: 'c1' });
    expect(shop?.preview).toBe(true);
    expect(shop?.theme.accent).toBe('#e0533d');
    expect(shop?.theme.look).toBe('nova');
    expect(shop?.homeLive).toBe('[{"x":1}]');
  });

  it('but the order form is the LIVE one — the one the door enforces today', async () => {
    const shop = await getShopView('my-shop');
    expect(shop?.theme.checkout?.submitText).toBe('الحي');
    expect(shop?.theme.checkout?.required).toEqual([]);
  });

  it('a preview cookie for another store changes nothing here', async () => {
    h.previewId = 's2';
    expect(await getShopView('my-shop')).toBe(live);
  });

  it('a store with no draft previews as it is', async () => {
    h.findFirst.mockResolvedValue({ theme: LIVE, themeDraft: null, homeDraft: null, homeLive: '[]' });
    const shop = await getShopView('my-shop');
    expect(shop?.theme.accent).toBe('#111111');
    expect(shop?.homeLive).toBe('[]');
  });
});

describe('the preview door’s seller outside the frame (a link clicked in it, the thank-you page)', () => {
  beforeEach(() => {
    h.sessionId = 's1';
    h.previewId = null;
  });

  it('gets the LIVE shop, marked quiet — nothing reported, nothing of the draft', async () => {
    const shop = await getShopView('my-shop');
    expect(shop?.quiet).toBe(true);
    expect(shop?.preview).toBeUndefined();
    expect(shop?.theme.accent).toBe('#111111');
    expect(shop?.homeLive).toBe('[]');
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it('inside the frame the draft is drawn AND it is quiet', async () => {
    h.previewId = 's1';
    const shop = await getShopView('my-shop');
    expect(shop?.preview).toBe(true);
    expect(shop?.quiet).toBe(true);
  });

  it('a customer is neither', async () => {
    h.sessionId = null;
    const shop = await getShopView('my-shop');
    expect(shop).toBe(live);
    expect(shop && 'quiet' in shop).toBe(false);
  });
});
