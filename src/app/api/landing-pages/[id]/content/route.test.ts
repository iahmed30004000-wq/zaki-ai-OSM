import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SAVE DOOR OF THE EDITOR: what it refuses, and what it tells a window.
 *
 *  · a file the cleaner gave up on is REFUSED in words (400), not saved as a
 *    blank page and reported as done — the sentence the upload door gives;
 *  · a window that sends the fingerprint it opened on (`base`) saves only if
 *    the page is still that page, else 409; the same for the publish press;
 *  · a window that sends nothing keeps working exactly as before.
 */

const { db, requireContext, requirePermission, saveContent, saveContentIfBase, publishContent, draftState, revertContent } =
  vi.hoisted(() => ({
    db: { landingPage: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() } },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    saveContent: vi.fn(),
    saveContentIfBase: vi.fn(),
    publishContent: vi.fn(),
    draftState: vi.fn(),
    revertContent: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/landing-cache', () => ({ refreshLandingPages: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ allowed: true, retryAfterSec: 0 }) }));
vi.mock('@/lib/landing-draft', async (orig) => ({
  ...(await orig<typeof import('@/lib/landing-draft')>()),
  saveContent: (...a: unknown[]) => saveContent(...a),
  saveContentIfBase: (...a: unknown[]) => saveContentIfBase(...a),
  publishContent: (...a: unknown[]) => publishContent(...a),
  draftState: (...a: unknown[]) => draftState(...a),
  revertContent: (...a: unknown[]) => revertContent(...a),
}));

import { PUT, POST, PATCH } from './route';

const BASE = 'a'.repeat(32);
const ctx = { params: Promise.resolve({ id: 'lp1' }) };
const put = (body: unknown) =>
  PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify(body) }), ctx);
const press = (body?: unknown) =>
  POST(new Request('http://localhost/x', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }), ctx);

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'س' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);
  db.landingPage.findFirst.mockResolvedValue({ id: 'lp1', name: 'p', isPublished: true, productId: null });
  db.landingPage.findUniqueOrThrow.mockResolvedValue({ id: 'lp1', name: 'p', slug: 'p', isPublished: true, updatedAt: new Date() });
  saveContent.mockResolvedValue(undefined);
  saveContentIfBase.mockResolvedValue({ ok: true, wroteDraft: true, base: 'b'.repeat(32) });
  publishContent.mockResolvedValue(true);
  revertContent.mockResolvedValue(true);
  draftState.mockResolvedValue({ hasUnpublished: true, canRevert: false, publishedAt: null, base: 'd'.repeat(32), draft: null });
});

describe('html the cleaner cannot finish', () => {
  it('is refused in words and writes nothing', async () => {
    const res = await put({ html: '<meta '.repeat(40000) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('الملف معقّد أكثر من اللازم');
    expect(saveContent).not.toHaveBeenCalled();
    expect(saveContentIfBase).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an ordinary page is saved cleaned', async () => {
    const res = await put({ html: '<p>HELLO</p><script>alert(1)</script>' });
    expect(res.status).toBe(200);
    const patch = saveContent.mock.calls[0]![1] as { htmlContent: string };
    expect(patch.htmlContent).toContain('HELLO');
    expect(patch.htmlContent).not.toMatch(/<script/i);
  });

  it('NEGATIVE: clearing the page (empty html) still clears it', async () => {
    const res = await put({ html: '' });
    expect(res.status).toBe(200);
    expect((saveContent.mock.calls[0]![1] as { htmlContent: unknown }).htmlContent).toBeNull();
  });

  it('NEGATIVE: a file that is only an active tag is a valid empty save, not a refusal', async () => {
    const res = await put({ html: '<script>alert(1)</script>' });
    expect(res.status).toBe(200);
    expect((saveContent.mock.calls[0]![1] as { htmlContent: unknown }).htmlContent).toBe('');
  });
});

describe('a save from a window that sends its base', () => {
  it('lands through the guarded door and answers with the new base and where it went', async () => {
    const res = await put({ css: 'p{}', base: BASE });
    expect(res.status).toBe(200);
    expect(saveContentIfBase).toHaveBeenCalledTimes(1);
    expect(saveContent).not.toHaveBeenCalled();
    expect(saveContentIfBase.mock.calls[0]![2]).toBe(BASE);
    const json = await res.json();
    expect(json.base).toBe('b'.repeat(32));
    expect(json.hasUnpublished).toBe(true);
  });

  it('says what the ROW said at the write, not what was read before it', async () => {
    // The page was published by another window between the read and the write:
    // the row said «not published», so the save went live, and the answer says so.
    saveContentIfBase.mockResolvedValue({ ok: true, wroteDraft: false, base: 'b'.repeat(32) });
    expect((await (await put({ css: 'p{}', base: BASE })).json()).hasUnpublished).toBe(false);
  });

  it('is refused with 409 when the page changed under it', async () => {
    saveContentIfBase.mockResolvedValue({ ok: false });
    const res = await put({ css: 'p{}', base: BASE });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('تغيّرت الصفحة من نافذة أخرى — أعد التحميل');
    expect(json.code).toBe('PAGE_CHANGED');
  });

  it('NEGATIVE: a base that is not an md5 is a bad request, not a query', async () => {
    const res = await put({ css: 'p{}', base: "x'; DROP TABLE landing_pages;--" });
    expect(res.status).toBe(400);
    expect(saveContentIfBase).not.toHaveBeenCalled();
    expect(saveContent).not.toHaveBeenCalled();
  });

  it('OLD WINDOW: no base is the old door, and the answer still carries hasUnpublished', async () => {
    const res = await put({ css: 'p{}' });
    expect(res.status).toBe(200);
    expect(saveContent).toHaveBeenCalledTimes(1);
    expect(saveContentIfBase).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json.hasUnpublished).toBe(true);
    expect('base' in json).toBe(false);
  });
});

describe('the publish press', () => {
  it('with a base publishes only against that base', async () => {
    const res = await press({ base: BASE });
    expect(res.status).toBe(200);
    expect(publishContent).toHaveBeenCalledWith('lp1', BASE);
    expect((await res.json()).base).toBe('d'.repeat(32));
  });

  it('is refused with 409 when the draft is not the one the window saw', async () => {
    publishContent.mockResolvedValue(false);
    const res = await press({ base: BASE });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PAGE_CHANGED');
  });

  it('OLD WINDOW: a press with no body is the old press', async () => {
    const res = await press();
    expect(res.status).toBe(200);
    expect(publishContent).toHaveBeenCalledWith('lp1', undefined);
  });

  it('NEGATIVE: nothing to publish is still the old 409, before any write', async () => {
    draftState.mockResolvedValue({ hasUnpublished: false, canRevert: false, publishedAt: null, draft: null });
    const res = await press({ base: BASE });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOTHING_TO_PUBLISH');
    expect(publishContent).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a malformed base is refused', async () => {
    expect((await press({ base: 'nope' })).status).toBe(400);
    expect(publishContent).not.toHaveBeenCalled();
  });
});

describe('the step back', () => {
  const back = (body?: unknown) =>
    PATCH(new Request('http://localhost/x', { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }), ctx);

  it('hands the window the page’s new fingerprint', async () => {
    const res = await back();
    expect(res.status).toBe(200);
    expect((await res.json()).base).toBe('d'.repeat(32));
  });

  it('with a base takes the step only against that base', async () => {
    expect((await back({ base: BASE })).status).toBe(200);
    expect(revertContent).toHaveBeenCalledWith('lp1', BASE);
  });

  it('is refused with 409 PAGE_CHANGED when the page is no longer the one the window read', async () => {
    revertContent.mockResolvedValue(false);
    draftState.mockResolvedValue({ hasUnpublished: false, canRevert: true, publishedAt: null, draft: null });
    const res = await back({ base: BASE });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('PAGE_CHANGED');
    expect(json.error).toBe('تغيّرت الصفحة من نافذة أخرى — أعد التحميل');
  });

  it('NEGATIVE: no step to take is still NO_PREVIOUS, with or without a base', async () => {
    revertContent.mockResolvedValue(false);
    draftState.mockResolvedValue({ hasUnpublished: false, canRevert: false, publishedAt: null, draft: null });
    expect((await (await back({ base: BASE })).json()).code).toBe('NO_PREVIOUS');
    expect((await (await back()).json()).code).toBe('NO_PREVIOUS');
  });

  it('OLD WINDOW: a press with no body is the old press and reads no state on the way', async () => {
    expect((await back()).status).toBe(200);
    expect(revertContent).toHaveBeenCalledWith('lp1', undefined);
  });

  it('NEGATIVE: a malformed base is refused before anything moves', async () => {
    expect((await back({ base: 'nope' })).status).toBe(400);
    expect(revertContent).not.toHaveBeenCalled();
  });
});
