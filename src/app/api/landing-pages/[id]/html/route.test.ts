import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * UPLOADING A FILE IS SAVING, NOT PUBLISHING.
 *
 * The route used to write the file into the live column, raw, on a page
 * visitors were reading. Now it is cleaned and goes through `saveContent`,
 * the door every other edit uses: the draft for a live page, the row itself
 * for one nobody can see yet.
 *
 * `saveContent` is the REAL one here and only the database is a mock, so the
 * assertion is on the statement that would have run: which column it
 * touches, and what text it carries.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    landingPage: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    $executeRawUnsafe: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { POST } from './route';

const ATTACK = '<html><head></head><body><script>steal()</script><img src=x onerror=steal()><a href="java&Tab;script:steal()">x</a><p>HELLO</p></body></html>';

const upload = (html: string, name = 'page.html') => {
  const body = new FormData();
  body.append('file', new File([html], name, { type: 'text/html' }));
  return POST(new Request('http://localhost/api/landing-pages/lp1/html', { method: 'POST', body }), {
    params: Promise.resolve({ id: 'lp1' }),
  });
};

const sqlOf = (n = -1) => (db.$executeRawUnsafe.mock.calls.at(n)![0] as string).replace(/\s+/g, ' ');

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: `c-${Math.random()}`, storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);
  db.$executeRawUnsafe.mockResolvedValue(1);
  db.landingPage.findUniqueOrThrow.mockResolvedValue({ id: 'lp1', name: 'p', slug: 'p', isPublished: true, updatedAt: new Date() });
});

describe('a file uploaded to a PUBLISHED page', () => {
  beforeEach(() => db.landingPage.findFirst.mockResolvedValue({ id: 'lp1', isPublished: true }));

  it('goes into the draft and never into the live column', async () => {
    const res = await upload('<html><body><p>HELLO</p></body></html>');
    expect(res.status).toBe(200);
    expect(sqlOf()).toContain('"contentDraft"');
    expect(sqlOf()).not.toMatch(/SET "htmlContent"/);
    expect(db.landingPage.update).not.toHaveBeenCalled();
  });

  it('says so: the answer carries hasUnpublished', async () => {
    const json = await (await upload('<html><body>x</body></html>')).json();
    expect(json.success).toBe(true);
    expect(json.hasUnpublished).toBe(true);
    expect(logAudit.mock.calls[0][0].newData.into).toBe('draft');
  });

  it('carries the CLEANED file, not the raw one', async () => {
    await upload(ATTACK);
    const draft = db.$executeRawUnsafe.mock.calls.at(-1)![2] as string;
    const html = JSON.parse(draft).htmlContent as string;
    expect(html).toContain('HELLO');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/javascript|java&Tab;script/i);
  });
});

describe('a file uploaded to a page nobody can see yet', () => {
  beforeEach(() => db.landingPage.findFirst.mockResolvedValue({ id: 'lp1', isPublished: false }));

  it('is written to the page itself, and a stale draft is cleared', async () => {
    const json = await (await upload('<html><body>x</body></html>')).json();
    expect(sqlOf()).toMatch(/SET "htmlContent" = \$2, "contentDraft" = NULL/);
    expect(json.hasUnpublished).toBe(false);
    expect(logAudit.mock.calls[0][0].newData.into).toBe('live');
  });

  it('is cleaned there too', async () => {
    await upload(ATTACK);
    const stored = db.$executeRawUnsafe.mock.calls.at(-1)![2] as string;
    expect(stored).toContain('HELLO');
    expect(stored).not.toMatch(/<script/i);
    expect(stored).not.toMatch(/onerror/i);
  });
});

describe('what the door still refuses', () => {
  beforeEach(() => db.landingPage.findFirst.mockResolvedValue({ id: 'lp1', isPublished: true }));

  it('a file that is not html writes nothing', async () => {
    const res = await upload('<html></html>', 'evil.exe');
    expect(res.status).toBe(400);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('a file the cleaner gives up on is refused in words, not saved as a blank page', async () => {
    const res = await upload('<meta '.repeat(40000));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('الملف معقّد أكثر من اللازم');
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('but a file that is nothing except an active tag is a valid, empty save', async () => {
    const res = await upload('<script>alert(1)</script>');
    expect(res.status).toBe(200);
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('a page that is not this company’s writes nothing', async () => {
    db.landingPage.findFirst.mockResolvedValue(null);
    const res = await upload('<html></html>');
    expect(res.status).toBe(404);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('without the permission nothing is read, let alone written', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const res = await upload('<html></html>');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
