import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DOOR THAT STORES A WALLET'S PICTURE — `POST /api/finance/wallets/{id}/image`.
 *
 * It stores a file and answers with its key; the wallet's PATCH door is the one that puts a key on a wallet. What is held:
 *
 *   · THE KEY: `finance.wallets_manage`, and only it — the shop's door asks `storefront.manage`, which a person who keeps the
 *     books does not hold. Without it nothing is stored. (Proved by taking the check away.)
 *   · THE FILE: png, jpeg and webp only — NO SVG, which can carry a script — and no more than 5 MB, which is smaller than the
 *     shop's 10 because the picture is drawn 44 pixels wide. Both are refused in Arabic before anything is stored.
 *   · THE FOLDER: the wallet's own id is the namespace, under the company's own folder, and the longest side is cut to 256.
 *   · THE REST: another company's wallet is a 404, the storage helper's own Arabic sentence is the answer to a file that is
 *     not an image, and nothing else the helper says (a disk error) reaches the person.
 */

const { db, requireContext, requirePermission, logAudit, saveProductImage, rateLimit, who } = vi.hoisted(() => ({
  db: { wallet: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  saveProductImage: vi.fn(),
  rateLimit: vi.fn(),
  who: { keys: [] as string[] },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));
// The helper's real validators stay (the type and the size are what is under test); only the part that writes a disk goes.
vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  saveProductImage: (...a: unknown[]) => saveProductImage(...a),
}));

import { POST } from './route';

const COMPANY = '4f1c2a8e-7b3d-4e56-9a10-5c2d8e7f6a31';
const WALLET = '9d0e6b12-3c45-4f78-8a9b-0c1d2e3f4a5b';
const STORED_KEY = `companies/${COMPANY}/products/${WALLET}/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.webp`;

const picture = (type = 'image/png', bytes = 2048, name = 'logo.png') => new File([new Uint8Array(bytes)], name, { type });

const post = async (file: File | null, id = WALLET, headers: Record<string, string> = {}) => {
  const form = new FormData();
  if (file) form.append('file', file);
  const res = await POST(new Request(`http://x/api/finance/wallets/${id}/image`, { method: 'POST', body: form, headers }), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  vi.clearAllMocks();
  who.keys = ['finance.wallets_manage'];
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'سامر' }, companyId: COMPANY, storeId: 's1' });
  requirePermission.mockImplementation(async (key: string) => {
    if (!who.keys.includes(key)) throw new Error(`Forbidden: missing required permission ${key}`);
  });
  rateLimit.mockReturnValue({ allowed: true, remaining: 19, retryAfterSec: 0 });
  db.wallet.findFirst.mockResolvedValue({ id: WALLET, name: 'صندوق الدولار' });
  saveProductImage.mockResolvedValue({ url: `/api/media/${STORED_KEY}`, storageKey: STORED_KEY, fileName: 'x.webp', mimeType: 'image/webp', fileSize: 4096 });
});

describe('who may store a wallet’s picture — the wallets’ own key', () => {
  it('asks finance.wallets_manage; a holder stores a png and gets its key back — which only the PATCH door can put on a wallet', async () => {
    const res = await post(picture());
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('finance.wallets_manage');
    expect(res.body).toEqual({ success: true, imageKey: STORED_KEY });
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      companyId: COMPANY, userId: 'u1', action: 'WALLET_PICTURE_UPLOADED', entity: 'Wallet', entityId: WALLET,
    });
  });

  it('NEGATIVE: the shop’s key is not enough — without finance.wallets_manage nothing is stored', async () => {
    who.keys = ['storefront.manage', 'finance.cashbox', 'finance.cashbox_view', 'finance.create'];
    const res = await post(picture());
    expect(res.status).toBe(403);
    expect(saveProductImage).not.toHaveBeenCalled();
    expect(db.wallet.findFirst).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a wallet of another company answers like one that does not exist, and nothing is stored', async () => {
    db.wallet.findFirst.mockResolvedValue(null);
    const res = await post(picture());
    expect(res.status).toBe(404);
    expect(db.wallet.findFirst.mock.calls[0][0].where).toEqual({ id: WALLET, companyId: COMPANY });
    expect(saveProductImage).not.toHaveBeenCalled();
  });

  it('a person who keeps pressing is slowed down, and nothing is stored while she waits', async () => {
    rateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSec: 120 });
    const res = await post(picture());
    expect(res.status).toBe(429);
    expect(saveProductImage).not.toHaveBeenCalled();
  });
});

describe('the file — png, jpeg, webp, and not large', () => {
  it('the three kinds are stored', async () => {
    for (const [type, name] of [['image/png', 'a.png'], ['image/jpeg', 'a.jpg'], ['image/webp', 'a.webp']]) {
      expect((await post(picture(type, 2048, name))).status, type).toBe(200);
    }
    expect(saveProductImage).toHaveBeenCalledTimes(3);
  });

  it('NEGATIVE: an SVG (a script can hide in it), a gif, a pdf and a text file are refused in Arabic and nothing is stored', async () => {
    for (const [type, name] of [['image/svg+xml', 'a.svg'], ['image/gif', 'a.gif'], ['application/pdf', 'a.pdf'], ['text/plain', 'a.txt'], ['', 'a']]) {
      const res = await post(picture(type, 2048, name));
      expect(res.status, type).toBe(400);
      expect(res.body.error).toMatch(/[؀-ۿ]/);
    }
    expect(saveProductImage).not.toHaveBeenCalled();
  });

  it('NEGATIVE: more than 5 MB is refused — the shop would take it, a 44-pixel picture does not need it', async () => {
    const res = await post(picture('image/png', 5 * 1024 * 1024 + 1));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('5 ميجابايت');
    expect(saveProductImage).not.toHaveBeenCalled();
    // And exactly 5 MB is still fine.
    expect((await post(picture('image/png', 5 * 1024 * 1024))).status).toBe(200);
  });

  it('NEGATIVE: a form that DECLARES more than the limit allows is refused before it is read (413), and nothing is stored', async () => {
    const res = await post(picture(), WALLET, { 'content-length': String(6 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error).toContain('5 ميجابايت');
    expect(saveProductImage).not.toHaveBeenCalled();
    // A form that declares the limit plus its framing is a 5 MB picture in a form, and is read as usual.
    expect((await post(picture(), WALLET, { 'content-length': String(5 * 1024 * 1024 + 1000) })).status).toBe(200);
  });

  it('NEGATIVE: no file, or a body that is not a form, is a 400 and nothing is stored', async () => {
    expect((await post(null)).status).toBe(400);
    const res = await POST(
      new Request(`http://x/api/finance/wallets/${WALLET}/image`, { method: 'POST', body: JSON.stringify({ file: 'x' }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: WALLET }) }
    );
    expect(res.status).toBe(400);
    expect(saveProductImage).not.toHaveBeenCalled();
  });
});

describe('where it is stored, and what is said when storing fails', () => {
  it('in the company’s own folder, under the wallet’s own id, cut to 256 pixels', async () => {
    await post(picture('image/jpeg', 4096, 'card.jpg'));
    const call = saveProductImage.mock.calls[0][0];
    expect(call).toMatchObject({ companyId: COMPANY, productId: WALLET, mimeType: 'image/jpeg', maxDimension: 256, originalName: 'card.jpg' });
    expect(Buffer.isBuffer(call.buffer)).toBe(true);
    expect(call.buffer.length).toBe(4096);
  });

  it('the storage helper’s own Arabic sentence is the answer to a file that only claims to be an image', async () => {
    saveProductImage.mockRejectedValue(new Error('محتوى الملف ليس صورة صالحة'));
    const res = await post(picture());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('محتوى الملف ليس صورة صالحة');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a disk error is not read out to the person — and is not an upload', async () => {
    saveProductImage.mockRejectedValue(new Error('EACCES: permission denied, open /app/uploads/companies/x'));
    const res = await post(picture());
    expect(res.status).toBeGreaterThanOrEqual(500);
    // The sentences a person reads. (`detail` is the shared mapper's own development-only aid; production omits it.)
    expect(`${res.body.error} ${res.body.errorAr}`).not.toMatch(/EACCES|uploads/);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
