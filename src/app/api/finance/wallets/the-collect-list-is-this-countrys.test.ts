import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «بحطلي محافظ الأردن وأنا بسوريا؟» — `GET /api/finance/wallets?scope=collect` (F9, 23/11).
 *
 * The list a courier's handover picks a wallet from: this store's or an unplaced one, of THIS country, and active — the same
 * wallets the receipts door accepts. Opt-in: the default list and «transfer» ask the database exactly what they asked
 * before, and answer with exactly the fields they answered with (no `unassigned` on them).
 */

const { db, requireContext, can, walletBalance } = vi.hoisted(() => ({
  db: { wallet: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  walletBalance: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(async () => undefined), can: (...a: unknown[]) => can(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ walletBalance: (...a: unknown[]) => walletBalance(...a) }));

import { GET } from './route';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'w1', name: 'صندوق الليرة', currencyCode: 'SYP', isActive: true, countryId: 'sy', storeId: 's1',
  country: { id: 'sy', name: 'سوريا', code: 'SY', minorUnit: 2 }, store: { id: 's1', name: 'المتجر' }, openingCount: null,
  imageKey: null, iconKey: null, colorKey: null,
  ...over,
});
const get = async (q = '') => (await GET(new Request(`http://x/api/finance/wallets${q}`))).json();
const where = () => db.wallet.findMany.mock.calls[0][0].where;

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'co', storeId: 's1', country: { id: 'sy', minorUnit: 2 } });
  can.mockReturnValue(true);
  walletBalance.mockResolvedValue({ balance: 0, movements: 0 });
  db.wallet.findMany.mockResolvedValue([row(), row({ id: 'w2', name: 'صندوق عام', storeId: null, store: null })]);
});

describe('?scope=collect', () => {
  it('asks for this country’s ACTIVE wallets, in this store or in none', async () => {
    await get('?scope=collect');
    expect(where()).toEqual({ companyId: 'co', OR: [{ storeId: 's1' }, { storeId: null }], countryId: 'sy', isActive: true });
  });

  it('says which one is unplaced («غير مخصّصة») — to the cash box and to the settlement list alike', async () => {
    const body = await get('?scope=collect');
    expect(body.wallets.map((w: { id: string; unassigned: boolean }) => [w.id, w.unassigned])).toEqual([['w1', false], ['w2', true]]);
    vi.clearAllMocks();
    can.mockReturnValue(false);
    db.wallet.findMany.mockResolvedValue([row(), row({ id: 'w2', storeId: null })]);
    const narrow = await get('?scope=collect');
    expect(narrow.wallets.map((w: { unassigned: boolean }) => w.unassigned)).toEqual([false, true]);
  });
});

describe('NEGATIVE: the lists that did not ask for it are what they were', () => {
  it('the default list asks no country and no activity, and carries no «unassigned»', async () => {
    const body = await get();
    expect(where()).toEqual({ companyId: 'co', OR: [{ storeId: 's1' }, { storeId: null }] });
    expect(body.wallets.every((w: object) => !('unassigned' in w))).toBe(true);
  });

  it('the transfer list still asks for every wallet of the company', async () => {
    const body = await get('?scope=transfer');
    expect(where()).toEqual({ companyId: 'co' });
    expect(body.wallets.every((w: object) => !('unassigned' in w))).toBe(true);
  });

  it('the settlement list (no cash-box view) is unchanged too', async () => {
    can.mockReturnValue(false);
    const body = await get();
    expect(where()).toEqual({ companyId: 'co', OR: [{ storeId: 's1' }, { storeId: null }] });
    expect(Object.keys(body.wallets[0]).sort()).toEqual(
      ['colorKey', 'country', 'currencyCode', 'iconKey', 'id', 'imageKey', 'isActive', 'name'].sort()
    );
  });
});
