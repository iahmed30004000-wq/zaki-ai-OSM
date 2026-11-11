import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «كل محفظة لازم تكون مميزة» — THE DOOR THAT GIVES A WALLET ITS LOOK (a picture, an icon, a colour).
 *
 * `PATCH /api/finance/wallets/{id}` takes three more fields, each optional and each `null` to clear. What is held here:
 *
 *   · THE KEY: the same `finance.wallets_manage` as renaming and stopping — nobody else writes a look, and a refusal
 *     writes nothing. (Proved by taking the check away: every case of «who may» goes red.)
 *   · THE LISTS: an icon or a colour that is not on the lists the screen draws its choices from is a 400 and nothing is written.
 *   · THE PICTURE: a key is saved only if it is one this company's door wrote for THIS wallet and the volume holds it.
 *     A key of another company, of another wallet, a URL, a path with dots and a key nobody uploaded are all refused with
 *     the SAME sentence — and the volume is not even asked about a key that is not this wallet's, so the door cannot be
 *     used to find out what another company holds. (Proved by taking the ownership check away.)
 *   · THE REST: a wallet of another company is a 404, an absent field is left alone, `null` clears, and a picture that is
 *     replaced or cleared is not deleted from the volume.
 */

const { db, requireContext, requirePermission, logAudit, storedFileExists, deleteStoredFile, who } = vi.hoisted(() => ({
  db: { wallet: { findFirst: vi.fn(), update: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  storedFileExists: vi.fn(),
  deleteStoredFile: vi.fn(),
  who: { keys: [] as string[] },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/storage', () => ({
  storedFileExists: (...a: unknown[]) => storedFileExists(...a),
  deleteStoredFile: (...a: unknown[]) => deleteStoredFile(...a),
}));

import { PATCH } from './route';

const COMPANY = '4f1c2a8e-7b3d-4e56-9a10-5c2d8e7f6a31';
const WALLET = '9d0e6b12-3c45-4f78-8a9b-0c1d2e3f4a5b';
const OTHER_COMPANY = '7a7a7a7a-1111-4222-8333-444455556666';
const OTHER_WALLET = '5b5b5b5b-1111-4222-8333-444455556666';
const FILE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.webp';
const OWN_KEY = `companies/${COMPANY}/products/${WALLET}/${FILE}`;

const BEFORE = {
  id: WALLET, name: 'صندوق الدولار', isActive: true, storeId: 's1',
  imageKey: null as string | null, iconKey: null as string | null, colorKey: null as string | null,
};

const patch = async (body: unknown, id = WALLET) => {
  const res = await PATCH(
    new Request(`http://x/api/finance/wallets/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  );
  return { status: res.status, body: await res.json() };
};

/**
 * What the lookups answer: the wallet itself for `{ id, companyId }`, and «nobody has that name» for the clash check the
 * rename makes (`NOT: { id }`) — one fake answering both alike would make every rename a 409.
 */
const holds = (over: Record<string, unknown> | null) =>
  db.wallet.findFirst.mockImplementation(async ({ where }: { where: { NOT?: unknown } }) =>
    where.NOT || over === null ? null : { ...BEFORE, ...over }
  );

/** The data the door handed to Prisma — what would actually be written. */
const written = () => db.wallet.update.mock.calls[0]?.[0]?.data as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  who.keys = ['finance.wallets_manage'];
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'سامر' }, companyId: COMPANY, storeId: 's1' });
  requirePermission.mockImplementation(async (key: string) => {
    if (!who.keys.includes(key)) throw new Error(`Forbidden: missing required permission ${key}`);
  });
  holds({});
  db.wallet.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: WALLET, name: BEFORE.name, isActive: true, imageKey: null, iconKey: null, colorKey: null, ...data,
  }));
  storedFileExists.mockResolvedValue(true);
});

describe('who may give a wallet its look — the wallets’ own key', () => {
  it('asks finance.wallets_manage, and a holder sets an icon and a colour', async () => {
    const res = await patch({ iconKey: 'bank', colorKey: 'warning' });
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('finance.wallets_manage');
    expect(written()).toEqual({ iconKey: 'bank', colorKey: 'warning' });
    expect(res.body.wallet).toMatchObject({ id: WALLET, iconKey: 'bank', colorKey: 'warning', imageKey: null });
  });

  it('NEGATIVE: without the key every part of the look is refused with 403 and NOTHING is written', async () => {
    who.keys = ['finance.cashbox_view', 'finance.cashbox', 'storefront.manage', 'finance.create'];
    for (const body of [{ iconKey: 'bank' }, { colorKey: 'success' }, { imageKey: OWN_KEY }, { imageKey: null }, { iconKey: 'bank', colorKey: 'success', imageKey: OWN_KEY }]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    expect(db.wallet.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    // The wallet was not even looked up for somebody who may not touch it.
    expect(db.wallet.findFirst).not.toHaveBeenCalled();
  });

  it('a wallet of another company is a 404 — the lookup is by id AND company — and nothing is written', async () => {
    holds(null);
    const res = await patch({ iconKey: 'bank' }, OTHER_WALLET);
    expect(res.status).toBe(404);
    expect(db.wallet.findFirst.mock.calls[0][0].where).toEqual({ id: OTHER_WALLET, companyId: COMPANY });
    expect(db.wallet.update).not.toHaveBeenCalled();
  });
});

describe('the icon and the colour — only what the screen offers', () => {
  it('NEGATIVE: an icon that is not on the list is a 400 in Arabic and nothing is written', async () => {
    for (const iconKey of ['rocket', '', 'BANK', 'bank ', 5, true, ['bank'], {}]) {
      const res = await patch({ iconKey });
      expect(res.status, JSON.stringify(iconKey)).toBe(400);
      expect(res.body.error).toMatch(/[؀-ۿ]/);
    }
    expect(db.wallet.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a colour that is not on the list is a 400 in Arabic and nothing is written', async () => {
    for (const colorKey of ['hotpink', '#ff0000', 'red', '', 'primary ', 7, {}]) {
      const res = await patch({ colorKey });
      expect(res.status, JSON.stringify(colorKey)).toBe(400);
      expect(res.body.error).toMatch(/[؀-ۿ]/);
    }
    expect(db.wallet.update).not.toHaveBeenCalled();
  });

  it('every icon and every colour of the lists is accepted', async () => {
    const { WALLET_COLOR_KEYS, WALLET_ICON_KEYS } = await import('@/lib/wallet-look');
    for (const iconKey of WALLET_ICON_KEYS) expect((await patch({ iconKey })).status, iconKey).toBe(200);
    for (const colorKey of WALLET_COLOR_KEYS) expect((await patch({ colorKey })).status, colorKey).toBe(200);
  });
});

describe('the picture — only a key this company’s door wrote for this wallet', () => {
  it('saves a key of its own company and its own wallet, when the volume holds the file', async () => {
    const res = await patch({ imageKey: OWN_KEY });
    expect(res.status).toBe(200);
    expect(storedFileExists).toHaveBeenCalledWith(OWN_KEY);
    expect(written()).toEqual({ imageKey: OWN_KEY });
    expect(res.body.wallet.imageKey).toBe(OWN_KEY);
  });

  it('NEGATIVE: another company’s key is refused, and the volume is never asked about it', async () => {
    const res = await patch({ imageKey: `companies/${OTHER_COMPANY}/products/${WALLET}/${FILE}` });
    expect(res.status).toBe(400);
    expect(storedFileExists).not.toHaveBeenCalled();
    expect(db.wallet.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: another wallet’s key of the same company is refused too — a product’s or the shop’s picture is not a wallet’s', async () => {
    const res = await patch({ imageKey: `companies/${COMPANY}/products/${OTHER_WALLET}/${FILE}` });
    expect(res.status).toBe(400);
    expect(storedFileExists).not.toHaveBeenCalled();
    expect(db.wallet.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a URL, a path, a dot segment, a backslash and a wrong file name are refused and nothing is written', async () => {
    for (const imageKey of [
      'https://example.com/logo.png',
      `/api/media/${OWN_KEY}`,
      `companies/${COMPANY}/products/${WALLET}/../${OTHER_WALLET}/${FILE}`,
      `companies/${COMPANY}/products/${WALLET}/logo.svg`,
      `companies\\${COMPANY}\\products\\${WALLET}\\${FILE}`,
      '../../etc/passwd',
      'x',
      '',
    ]) {
      const res = await patch({ imageKey });
      expect(res.status, imageKey).toBe(400);
    }
    expect(storedFileExists).not.toHaveBeenCalled();
    expect(db.wallet.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a key of its own shape that nobody uploaded (the volume holds no such file) is refused', async () => {
    storedFileExists.mockResolvedValue(false);
    const res = await patch({ imageKey: OWN_KEY });
    expect(res.status).toBe(400);
    expect(db.wallet.update).not.toHaveBeenCalled();
  });

  it('every refusal says the same thing — it does not tell which of the questions failed', async () => {
    const said = new Set<string>();
    storedFileExists.mockResolvedValue(false);
    for (const imageKey of [
      OWN_KEY,
      `companies/${OTHER_COMPANY}/products/${WALLET}/${FILE}`,
      `companies/${COMPANY}/products/${OTHER_WALLET}/${FILE}`,
      'https://example.com/logo.png',
    ]) {
      const res = await patch({ imageKey });
      expect(res.status).toBe(400);
      said.add(JSON.stringify(res.body));
    }
    expect(said.size).toBe(1);
  });
});

describe('clearing, leaving alone, and what is kept', () => {
  it('`null` clears each part back to the default, and an absent part is not touched', async () => {
    holds({ imageKey: OWN_KEY, iconKey: 'bank', colorKey: 'warning' });
    await patch({ imageKey: null, iconKey: null, colorKey: null });
    expect(written()).toEqual({ imageKey: null, iconKey: null, colorKey: null });
    expect(storedFileExists).not.toHaveBeenCalled();

    db.wallet.update.mockClear();
    await patch({ iconKey: null });
    expect(written()).toEqual({ iconKey: null });

    db.wallet.update.mockClear();
    await patch({ name: 'اسم جديد' });
    expect(written()).toEqual({ name: 'اسم جديد' });
  });

  it('a picture that is replaced or cleared is NOT deleted from the volume (BACKLOG: the orphan sweep)', async () => {
    holds({ imageKey: OWN_KEY });
    await patch({ imageKey: null });
    await patch({ imageKey: `companies/${COMPANY}/products/${WALLET}/1a1a1a1a-4e5f-4a6b-8c7d-9e0f1a2b3c4d.webp` });
    expect(deleteStoredFile).not.toHaveBeenCalled();
  });

  it('renaming and stopping still work as they did, with no look in the body', async () => {
    const res = await patch({ name: 'الصندوق', isActive: false });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ name: 'الصندوق', isActive: false });
  });

  it('the audit line carries the look before and after, beside who changed it', async () => {
    holds({ iconKey: 'cash' });
    await patch({ iconKey: 'bank', colorKey: 'success' });
    const line = logAudit.mock.calls[0][0];
    expect(line).toMatchObject({ companyId: COMPANY, userId: 'u1', action: 'WALLET_UPDATED', entity: 'Wallet', entityId: WALLET });
    expect(line.previousData).toMatchObject({ iconKey: 'cash', colorKey: null, imageKey: null });
    expect(line.newData).toMatchObject({ iconKey: 'bank', colorKey: 'success', by: 'سامر' });
  });
});
