import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A PAGE CREATED FROM ONE OF THE SIXTY-FOUR DESIGNS SAYS WHICH ONE.
 *
 * The wizard's «استخدم تصميم» path sends the catalogue id as `design`. The
 * route's schema strips any key it does not name, so without the field the
 * choice reached the server and vanished. It is stored in the theme, where
 * the editor's own save carries it through, and an id the catalogue does
 * not know is refused rather than stored.
 */

const { db } = vi.hoisted(() => ({
  db: {
    landingPage: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(async () => []) },
    product: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));
vi.mock('@/lib/store-redirects', () => ({ standDownRedirectsTo: vi.fn() }));

import { POST } from './route';
import { DESIGNS } from '@/lib/landing-designs/catalog';
import { landingThemeSchema } from '@/lib/landing-theme';

const create = (body: Record<string, unknown>) =>
  POST(
    new Request('http://localhost/api/landing-pages', {
      method: 'POST',
      body: JSON.stringify({ name: 'صفحة', slug: 'page-1', ...body }),
    })
  );

const themeWritten = (): Record<string, unknown> =>
  JSON.parse(db.landingPage.create.mock.calls[0][0].data.theme);

beforeEach(() => {
  vi.clearAllMocks();
  db.landingPage.findFirst.mockResolvedValue(null);
  db.landingPage.create.mockImplementation(async ({ data }: { data: { slug: string } }) => ({ id: 'lp1', slug: data.slug }));
});

describe('the chosen design', () => {
  it('is kept in the theme of a page started from a ready-made shape', async () => {
    const res = await create({ template: 'classic', design: DESIGNS[0].id });
    expect(res.status).toBe(201);
    expect(themeWritten().design).toBe(DESIGNS[0].id);
  });

  it('and of a page started from a structure, beside the skin', async () => {
    const res = await create({ structure: 'problem-solution', design: 'cod-bold' });
    expect(res.status).toBe(201);
    expect(themeWritten().design).toBe('cod-bold');
  });

  it('is refused when the catalogue does not know it, and nothing is created', async () => {
    const res = await create({ template: 'classic', design: 'no-such-design' });
    expect(res.status).toBe(400);
    expect(db.landingPage.create).not.toHaveBeenCalled();
  });

  it('leaves a page with no design exactly as before — no key at all', async () => {
    const res = await create({ template: 'blank' });
    expect(res.status).toBe(201);
    expect('design' in themeWritten()).toBe(false);
  });

  it('survives the editor’s save, which parses the theme through its schema', () => {
    const saved = landingThemeSchema.parse({
      accent: '#e11d48', mood: 'clean', font: 'cairo', corners: 'soft', design: 'cod-bold',
    });
    expect(saved.design).toBe('cod-bold');
  });

  it('but the save refuses a value that is not an id', () => {
    const r = landingThemeSchema.safeParse({
      accent: '#e11d48', mood: 'clean', font: 'cairo', corners: 'soft', design: '<script>',
    });
    expect(r.success).toBe(false);
  });
});
