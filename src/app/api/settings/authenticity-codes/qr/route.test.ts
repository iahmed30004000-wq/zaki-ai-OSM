import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/settings/authenticity-codes/qr` — the QR printed on a piece (20/11, owner: «يولد qr code خاص بيه»).
 *
 * Covers: read on `settings.view`; the QR holds the store's verify link with the code in it (or the code itself when it
 * is already a link); SVG and PNG; a download carries a safe file name; a code of another company is a 404; no active
 * store is a clear 409; `all=1` gives every code's SVG for the print sheet, inside the caller's company only.
 */

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  db: {
    authenticityCode: { findMany: vi.fn(), findFirst: vi.fn() },
    store: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/passkey', () => ({ publicOrigin: () => 'https://crm.zakiai.io' }));

import QRCode from 'qrcode';
import { GET } from './route';

const STORE = '168f776f-7144-4422-864d-e63ac8c6ddc8';
const get = (qs: string) => GET(new Request(`http://x/api/settings/authenticity-codes/qr?${qs}`));

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'co-1' });
  requirePermission.mockResolvedValue(undefined);
  db.store.findMany.mockResolvedValue([{ id: STORE }]);
  db.authenticityCode.findFirst.mockResolvedValue({ code: 'P-00042' });
  db.authenticityCode.findMany.mockResolvedValue([]);
});

describe('one code', () => {
  it('asks settings.view, and looks the code up inside the caller’s company only', async () => {
    await get('id=c1');
    expect(requirePermission).toHaveBeenCalledWith('settings.view');
    expect(db.authenticityCode.findFirst).toHaveBeenCalledWith({ where: { id: 'c1', companyId: 'co-1' }, select: { code: true } });
  });

  it('is an SVG of the store’s verify link with the code in it', async () => {
    const spy = vi.spyOn(QRCode, 'toString');
    const res = await get('id=c1&format=svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image\/svg\+xml/);
    expect(await res.text()).toMatch(/^<svg/);
    expect(spy.mock.calls[0][0]).toBe(`https://crm.zakiai.io/verify/${STORE}?code=P-00042`);
  });

  it('a code that is already a link is its own QR text', async () => {
    db.authenticityCode.findFirst.mockResolvedValue({ code: 'https://example.com/p/AbC' });
    const spy = vi.spyOn(QRCode, 'toString');
    await get('id=c1');
    expect(spy.mock.calls[0][0]).toBe('https://example.com/p/AbC');
  });

  it('is a PNG when asked, and a download carries a safe file name', async () => {
    db.authenticityCode.findFirst.mockResolvedValue({ code: 'منتج / P-7 <x>' });
    const res = await get('id=c1&format=png&download=1');
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="qr-P-7-x.png"');
  });

  it('another company’s code, or none, is a 404 — no image', async () => {
    db.authenticityCode.findFirst.mockResolvedValue(null);
    expect((await get('id=c9')).status).toBe(404);
    expect((await get('')).status).toBe(404);
  });

  it('with no active store there is no link to draw — a clear 409', async () => {
    db.store.findMany.mockResolvedValue([]);
    const res = await get('id=c1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/متجر/);
  });

  it('a refused permission is a 403, never an image', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission settings.view'));
    expect((await get('id=c1')).status).toBe(403);
  });
});

describe('the print sheet', () => {
  it('gives every code of the caller’s company with its link and SVG', async () => {
    db.authenticityCode.findMany.mockResolvedValue([
      { id: 'a', code: 'P-1', note: 'دفعة 1' },
      { id: 'b', code: 'https://example.com/x', note: null },
    ]);
    const res = await get('all=1');
    expect(res.status).toBe(200);
    expect(db.authenticityCode.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'co-1' } }));
    const { items } = await res.json();
    expect(items.map((i: { link: string }) => i.link)).toEqual([`https://crm.zakiai.io/verify/${STORE}?code=P-1`, 'https://example.com/x']);
    expect(items[0].svg).toMatch(/^<svg/);
    expect(items[0].note).toBe('دفعة 1');
  });
});
