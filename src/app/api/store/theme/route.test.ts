import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE STORE'S LOOK: ONE EDITOR, ONE STORE, ONE PERMISSION.
 *
 * Every test here is a refusal. The three things that must not be possible:
 * painting a shop you are not working in, painting one without the
 * permission to, and a Single Product store holding a cart-bar setting for
 * a cart it does not have.
 */

const { db, requireContext, requirePermission, logAudit, refreshLandingPages, revalidatePath } = vi.hoisted(() => ({
  db: { store: { findFirst: vi.fn(), update: vi.fn() }, landingPage: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  refreshLandingPages: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('next/cache', () => ({ revalidatePath }));
// A spy around the REAL refresher: the calls can be counted, and its never-throws promise is the one being tested,
// not a stand-in's.
vi.mock('@/lib/landing-cache', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/landing-cache')>();
  refreshLandingPages.mockImplementation(real.refreshLandingPages);
  return { refreshLandingPages };
});

import { GET, PATCH, POST, PUT } from './route';
import { DEFAULT_STORE_THEME } from '@/lib/store-theme';

const STORE = {
  id: 'store-1',
  name: 'صحة بلس',
  type: 'MULTI_PRODUCT',
  theme: null as string | null,
  logo: '/logo.webp',
  favicon: null,
};

const patch = (body: unknown) =>
  PATCH(new Request('http://localhost/api/store/theme', { method: 'PATCH', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'المالك' }, companyId: 'c1', storeId: 'store-1' });
  requirePermission.mockResolvedValue(undefined);
  db.store.findFirst.mockResolvedValue({ ...STORE });
  db.store.update.mockResolvedValue({});
});

describe('which store gets painted', () => {
  it('is the one the session is in — never one named in the body', async () => {
    await patch({ ...DEFAULT_STORE_THEME, accent: '#010203', id: 'someone-elses-store' });
    // The id in the body is not a field of the theme, so a strict parse
    // would reject it; what matters is the store looked up and written.
    const where = db.store.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'store-1', companyId: 'c1' });
  });

  it('is scoped to the company, so another tenant’s store reads as missing', async () => {
    db.store.findFirst.mockResolvedValue(null);
    const res = await patch(DEFAULT_STORE_THEME);
    expect(res.status).toBe(404);
    expect(db.store.update).not.toHaveBeenCalled();
  });
});

describe('who may paint it', () => {
  it('reading asks for storefront.view', async () => {
    await GET();
    expect(requirePermission).toHaveBeenCalledWith('storefront.view');
  });

  it('writing asks for storefront.manage, not geo.manage', async () => {
    await patch(DEFAULT_STORE_THEME);
    expect(requirePermission).toHaveBeenCalledWith('storefront.manage');
    expect(requirePermission).not.toHaveBeenCalledWith('geo.manage');
  });

  it('writes nothing when the permission is refused', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    await patch(DEFAULT_STORE_THEME);
    expect(db.store.update).not.toHaveBeenCalled();
  });
});

describe('what it refuses to store', () => {
  it('a colour that is not a colour', async () => {
    const res = await patch({ ...DEFAULT_STORE_THEME, colors: { textPrimary: 'blue' } });
    expect(res.status).toBe(400);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('a footer object it does not recognise — the links moved to the menus', async () => {
    // footer.links left the theme when «التذييل» became one of the five
    // menus; the theme keeps only the copyright line. The rule that a link
    // cannot point off-site now lives with the menus, and is tested there.
    const res = await patch({
      ...DEFAULT_STORE_THEME,
      footer: { copyright: 12 as unknown as string },
    });
    expect(res.status).toBe(400);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('a body that is not a theme at all', async () => {
    expect((await patch({ nonsense: true })).status).toBe(400);
    expect(db.store.update).not.toHaveBeenCalled();
  });
});

describe('a Single Product store has no cart, so it holds no cart-bar setting', () => {
  it('drops it on the way in — hiding the tab was never the enforcement', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, type: 'SINGLE_PRODUCT' });
    await patch({ ...DEFAULT_STORE_THEME, cartBar: { enabled: true, label: 'أكمل الطلب' } });
    // The DRAFT: saving in this editor no longer repaints the shop.
    const written = JSON.parse(db.store.update.mock.calls[0][0].data.themeDraft);
    expect(written.cartBar).toBeUndefined();
  });

  it('keeps it for a shop that does have a cart', async () => {
    await patch({ ...DEFAULT_STORE_THEME, cartBar: { enabled: false, label: 'السلة' } });
    const written = JSON.parse(db.store.update.mock.calls[0][0].data.themeDraft);
    expect(written.cartBar).toMatchObject({ enabled: false });
  });

  it('and says so in what it hands the screen', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, type: 'SINGLE_PRODUCT' });
    const body = await (await GET()).json();
    expect(body.store.cartBarApplies).toBe(false);
  });
});

describe('the logo and the favicon', () => {
  it('are returned to be shown and linked to, and there is no way to write them here', async () => {
    const body = await (await GET()).json();
    expect(body.store.logo).toBe('/logo.webp');
    await patch({ ...DEFAULT_STORE_THEME, logo: '/other.webp', favicon: '/other.ico' });
    const call = db.store.update.mock.calls[0]?.[0];
    // Only the DRAFT column is ever written by a save here. `theme` is
    // what a customer sees and it moves on publish, not on save.
    expect(Object.keys(call.data)).toEqual(['themeDraft']);
  });
});

describe('the change is recorded', () => {
  it('with the theme before and after', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: '{"accent":"#000000"}' });
    await patch({ ...DEFAULT_STORE_THEME, accent: '#111111' });
    const entry = logAudit.mock.calls[0][0];
    // Saving is a draft now, and the record says which act it was.
    expect(entry).toMatchObject({ action: 'STORE_THEME_DRAFT_SAVED', entity: 'Store', entityId: 'store-1' });
    expect(entry.newData.draft).toContain('#111111');
  });
});


/**
 * «مسودة · نشر بتأكيد · رجوع للنسخة السابقة بضغطة».
 *
 * The home page had all three since the day it was written. The LOOK had
 * none: every save wrote `theme`, which is what every live storefront page
 * paints from, so a seller adjusting a colour repainted the shop for every
 * customer standing in it.
 */
describe('the look is a draft until somebody publishes it', () => {
  const LIVE = JSON.stringify({ ...DEFAULT_STORE_THEME, accent: '#111111' });
  const DRAFT = JSON.stringify({ ...DEFAULT_STORE_THEME, accent: '#222222' });

  it('the editor opens on the draft, and on the live one when there is none', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themeDraft: null });
    const a = await (await GET()).json();
    expect(a.theme.accent).toBe('#111111');
    expect(a.hasUnpublished).toBe(false);

    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themeDraft: DRAFT });
    const b = await (await GET()).json();
    expect(b.theme.accent).toBe('#222222');
    // What the live shop still looks like, so the screen can say what
    // publishing would change.
    expect(b.live.accent).toBe('#111111');
    expect(b.hasUnpublished).toBe(true);
  });

  it('publishing moves the draft across and keeps what it replaced', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themeDraft: DRAFT });
    const res = await POST();
    expect(res.status).toBe(200);
    const data = db.store.update.mock.calls[0][0].data;
    expect(data.theme).toBe(DRAFT);
    // One step back, kept at the moment it is replaced — not read back out
    // of the audit log, which is a record and not a store.
    expect(data.themePrevious).toBe(LIVE);
    expect(data.themePublishedAt).toBeInstanceOf(Date);
  });

  it('and refuses to publish nothing', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themeDraft: LIVE });
    const res = await POST();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOTHING_TO_PUBLISH');
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('publishing is a different permission from laying out', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themeDraft: DRAFT });
    await POST();
    expect(requirePermission).toHaveBeenCalledWith('storefront.publish');
    vi.clearAllMocks();
    requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 'store-1' });
    requirePermission.mockResolvedValue(undefined);
    db.store.findFirst.mockResolvedValue({ ...STORE });
    db.store.update.mockResolvedValue({});
    await patch({ ...DEFAULT_STORE_THEME });
    expect(requirePermission).toHaveBeenCalledWith('storefront.manage');
  });
});

describe('one step back', () => {
  const LIVE = JSON.stringify({ ...DEFAULT_STORE_THEME, accent: '#222222' });
  const BEFORE = JSON.stringify({ ...DEFAULT_STORE_THEME, accent: '#111111' });

  it('restores what was live, in one press', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themePrevious: BEFORE });
    const res = await PUT();
    expect(res.status).toBe(200);
    expect((await res.json()).theme.accent).toBe('#111111');
    expect(db.store.update.mock.calls[0][0].data.theme).toBe(BEFORE);
  });

  it('and the draft with it, or the next publish puts the mistake back', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themeDraft: LIVE, themePrevious: BEFORE });
    await PUT();
    expect(db.store.update.mock.calls[0][0].data.themeDraft).toBe(BEFORE);
  });

  it('makes the thing it undid the next step back — pressing twice returns', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themePrevious: BEFORE });
    await PUT();
    // Anything else is a trap dressed as an undo.
    expect(db.store.update.mock.calls[0][0].data.themePrevious).toBe(LIVE);
  });

  it('says there is nothing to go back to, rather than clearing the shop', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themePrevious: null });
    const res = await PUT();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NO_PREVIOUS');
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('is a publish, so it needs the permission a publish needs', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themePrevious: BEFORE });
    await PUT();
    expect(requirePermission).toHaveBeenCalledWith('storefront.publish');
  });

  it('and the screen is told whether the button has anything to do', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themePrevious: null });
    expect((await (await GET()).json()).canRevert).toBe(false);
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themePrevious: BEFORE });
    expect((await (await GET()).json()).canRevert).toBe(true);
  });
});

/**
 * «مش مربوط بصفحة الهبوط» — AND WHEN IT IS, A CACHED PAGE MUST NOT LAG A MINUTE BEHIND IT.
 *
 * Every landing page of the store now asks its order form's fields, its confirm button and its after-order line of
 * the store's «الدفع». A cached page (`LP_PAGE_CACHE=1`) was built from the old one, so a publish and a step back
 * rebuild that store's pages at once. A draft does not: no visitor is ever shown a draft.
 */
describe('a published look reaches the store’s cached landing pages at once', () => {
  const LIVE = JSON.stringify({ ...DEFAULT_STORE_THEME, accent: '#111111' });
  const DRAFT = JSON.stringify({
    ...DEFAULT_STORE_THEME,
    checkout: { ...DEFAULT_STORE_THEME.checkout!, submitText: 'احجز علبتك الآن' },
  });

  beforeEach(() => {
    db.landingPage.findMany.mockResolvedValue([{ slug: 'kamaa' }, { slug: 'sidr-honey' }]);
  });

  it('publishing rebuilds every page of this store, after the publish is written', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themeDraft: DRAFT });
    expect((await POST()).status).toBe(200);
    expect(refreshLandingPages).toHaveBeenCalledTimes(1);
    expect(refreshLandingPages).toHaveBeenCalledWith({ storeId: 'store-1', companyId: 'c1' });
    expect(db.landingPage.findMany.mock.calls[0][0].where).toEqual({ storeId: 'store-1', companyId: 'c1' });
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual(['/lp-cached/kamaa', '/lp-cached/sidr-honey']);
    // After the write, or a visit in between would rebuild the page from the look being replaced.
    expect(db.store.update.mock.invocationCallOrder[0]).toBeLessThan(refreshLandingPages.mock.invocationCallOrder[0]);
  });

  it('and so does a step back, which is a publish', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: DRAFT, themePrevious: LIVE });
    expect((await PUT()).status).toBe(200);
    expect(refreshLandingPages).toHaveBeenCalledTimes(1);
    expect(refreshLandingPages).toHaveBeenCalledWith({ storeId: 'store-1', companyId: 'c1' });
    expect(db.store.update.mock.invocationCallOrder[0]).toBeLessThan(refreshLandingPages.mock.invocationCallOrder[0]);
  });

  it('NEGATIVE: saving a draft rebuilds nothing — a visitor never sees a draft', async () => {
    const res = await patch(JSON.parse(DRAFT));
    expect(res.status).toBe(200);
    expect(db.store.update).toHaveBeenCalledTimes(1);
    expect(refreshLandingPages).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('NEGATIVE: nor does a publish or a step back that was refused', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themeDraft: LIVE });
    expect((await POST()).status).toBe(409);
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themePrevious: null });
    expect((await PUT()).status).toBe(409);
    expect(refreshLandingPages).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a refresh that fails never fails the publish — the new look is already live', async () => {
    db.landingPage.findMany.mockRejectedValue(new Error('db down'));
    db.store.findFirst.mockResolvedValue({ ...STORE, theme: LIVE, themeDraft: DRAFT });
    const published = await POST();
    expect(published.status).toBe(200);
    expect(db.store.update.mock.calls[0][0].data.theme).toBe(DRAFT);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STORE_THEME_PUBLISHED' }));

    db.store.findFirst.mockResolvedValue({ ...STORE, theme: DRAFT, themePrevious: LIVE });
    expect((await PUT()).status).toBe(200);
    expect(revalidatePath).not.toHaveBeenCalled();
    // The refresh DID run and fail, both times — or this would be a publish that never tried.
    expect(refreshLandingPages).toHaveBeenCalledTimes(2);
    expect(db.landingPage.findMany).toHaveBeenCalledTimes(2);
  });
});
