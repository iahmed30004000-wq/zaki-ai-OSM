import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';

/**
 * THE WAYBILL LOGO IS SERVED SAFELY (25/11, F15).
 *
 * The own logo is stored as `/api/media/companies/<company>/products/<store>/<uuid>.webp` and drawn by the print page
 * from that door. This pins what that door does for it: signed-in only, this company only, the file's real image type
 * with `nosniff` (so nothing is ever run as a page or a script), never a path out of the folder — and that the print
 * page draws nothing from anywhere else.
 */

const { getCurrentUser, readStoredFile } = vi.hoisted(() => ({ getCurrentUser: vi.fn(), readStoredFile: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getCurrentUser: (...a: unknown[]) => getCurrentUser(...a) }));
vi.mock('@/lib/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/storage')>()),
  readStoredFile: (...a: unknown[]) => readStoredFile(...a),
}));

import { GET } from '@/app/api/media/[...key]/route';
import { storeLogoForPrint } from '@/lib/label-sheet';

const KEY = ['companies', 'c1', 'products', 's1', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp'];
const get = (key: string[]) => GET(new Request('http://x'), { params: Promise.resolve({ key }) });

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'CUSTOM', status: 'ACTIVE', companyId: 'c1' });
  readStoredFile.mockResolvedValue({ stream: Readable.from([Buffer.from('img')]), size: 3, mimeType: 'image/webp' });
});

describe('the waybill logo, as the print page fetches it', () => {
  it('is served with its image type and nosniff', async () => {
    const res = await get(KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('private');
  });

  it('NEGATIVE: not signed in — refused', async () => {
    getCurrentUser.mockResolvedValue(null);
    expect((await get(KEY)).status).toBe(401);
  });

  it('NEGATIVE: another company’s person — refused', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u2', role: 'CUSTOM', status: 'ACTIVE', companyId: 'c2' });
    expect((await get(KEY)).status).toBe(403);
    expect(readStoredFile).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a path that climbs out of the folder — refused before any read', async () => {
    expect((await get(['companies', 'c1', 'products', '..', 'x.webp'])).status).toBe(400);
    expect(readStoredFile).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the print page draws no logo from outside this application', () => {
    expect(storeLogoForPrint(`/api/media/${KEY.join('/')}`)).toBe(`/api/media/${KEY.join('/')}`);
    expect(storeLogoForPrint('https://elsewhere.example/logo.svg')).toBeNull();
    expect(storeLogoForPrint('javascript:alert(1)')).toBeNull();
    expect(storeLogoForPrint('data:image/svg+xml,<svg/>')).toBeNull();
  });
});
