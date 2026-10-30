import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A COPY MUST BE A PAGE THE SYSTEM CAN KEEP.
 *
 *  · its name fits the page-name limit (100): the copy of a long name was cut
 *    at 120, a name the page's own edit door then refused to save;
 *  · its address is not one a redirect still forwards away from: the live
 *    page wins, so taking such an address would switch a seller's accepted
 *    redirect off because somebody pressed «نسخ».
 */

const { db } = vi.hoisted(() => ({
  db: {
    landingPage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    storeRedirect: { findFirst: vi.fn() },
    landingPageRecommendation: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));

import { POST, copyName } from './[id]/duplicate/route';

const ctx = { params: Promise.resolve({ id: 'lp1' }) };
const dup = () => POST(new Request('http://localhost/x', { method: 'POST' }), ctx);
const arabic = (n: number) => 'ع'.repeat(n);

describe('the name of a copy', () => {
  it('fits 100 characters whatever the original’s length', () => {
    for (const n of [92, 93, 99, 100]) {
      const name = copyName(arabic(n), new Set());
      expect(name.length, String(n)).toBeLessThanOrEqual(100);
      expect(name.endsWith(' (نسخة)'), String(n)).toBe(true);
    }
  });

  it('keeps fitting when the number grows', () => {
    const original = arabic(100);
    const taken = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const name = copyName(original, taken);
      expect(name.length).toBeLessThanOrEqual(100);
      expect(taken.has(name), 'اسم مكرر').toBe(false);
      taken.add(name);
    }
    expect([...taken].some((n) => n.endsWith('(نسخة 12)'))).toBe(true);
  });

  it('copying a long copy does not stack suffixes', () => {
    const first = copyName(arabic(100), new Set());
    expect(copyName(first, new Set([first]))).toBe(copyName(arabic(100), new Set([first])));
  });

  it('does not leave a space before the suffix when the cut falls on one', () => {
    // 91 letters, a space, then more: the cut for « (نسخة)» (7) lands on 93.
    const original = `${arabic(92)} ${arabic(20)}`;
    expect(copyName(original, new Set())).not.toMatch(/\s\s\(نسخة\)$/);
  });

  it('never cuts an astral character in half', () => {
    const original = `${arabic(91)}😀😀😀😀`;
    const name = copyName(original, new Set());
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('NEGATIVE: a short name is left exactly as it was', () => {
    expect(copyName('عرض المنتج', new Set())).toBe('عرض المنتج (نسخة)');
    expect(copyName(arabic(93), new Set())).toBe(`${arabic(93)} (نسخة)`);
  });
});

describe('the address of a copy', () => {
  const source = {
    id: 'lp1', companyId: 'c1', storeId: 's1', name: 'صفحة', slug: 'offer',
    htmlContent: null, cssContent: null, pageSettings: null, builderMode: 'BLOCKS', theme: null, sections: null,
    productId: null, recommendations: [],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // The source page by id; every candidate-slug lookup finds nobody.
    db.landingPage.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === 'lp1' ? source : null
    );
    db.landingPage.findMany.mockResolvedValue([]);
    db.storeRedirect.findFirst.mockResolvedValue(null);
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        landingPage: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'copy', isPublished: false, ...data }) },
        landingPageRecommendation: db.landingPageRecommendation,
      })
    );
  });

  it('is the plain «-copy» when nothing forwards it', async () => {
    const res = await dup();
    expect(res.status).toBe(201);
    expect((await res.json()).page.slug).toBe('offer-copy');
    expect(db.storeRedirect.findFirst.mock.calls[0]![0].where).toEqual({ from: '/lp/offer-copy', isActive: true });
  });

  it('skips an address a redirect forwards away from', async () => {
    db.storeRedirect.findFirst.mockImplementation(async ({ where }: { where: { from: string } }) =>
      where.from === '/lp/offer-copy' ? { id: 'r1' } : null
    );
    expect((await (await dup()).json()).page.slug).toBe('offer-copy-2');
  });

  it('NEGATIVE: a switched-off redirect does not hold the address (only active ones are asked)', async () => {
    await dup();
    expect(db.storeRedirect.findFirst.mock.calls[0]![0].where.isActive).toBe(true);
  });

  it('NEGATIVE: an address another page already holds is still skipped', async () => {
    db.landingPage.findFirst.mockImplementation(async ({ where }: { where: { id?: string; slug?: string } }) => {
      if (where.id === 'lp1') return source;
      return where.slug === 'offer-copy' ? { id: 'other' } : null;
    });
    expect((await (await dup()).json()).page.slug).toBe('offer-copy-2');
  });

  it('the copy’s own name is stored within 100 characters', async () => {
    source.name = arabic(100);
    const res = await dup();
    expect((await res.json()).page.name.length).toBeLessThanOrEqual(100);
    source.name = 'صفحة';
  });
});
