import { apiJson } from './api-client';
import { isWalletImageKey } from './wallet-look';

/**
 * THE WALLET'S PICTURE, SENT TO ITS DOOR — and the key it comes back with.
 *
 * `POST /api/finance/wallets/{id}/image` stores the file and answers `{ imageKey }`; it does not put the picture on the
 * wallet. The editor holds the key until the person presses «احفظ», and the wallet's PATCH door is the one that writes it.
 *
 * WHY IT IS A FUNCTION AND NOT A `fetch` IN THE DIALOG. `bare-fetch-ratchet.test.ts` lets the number of raw `fetch` calls in
 * the components only fall: the shared client gives the 401 redirect and the lost-context redirect a bare call does
 * without, and reads the server's own Arabic sentence out of a refusal (`apiJson` throws it, so the dialog shows what the
 * door said — «حجم الصورة يتجاوز…», «محتوى الملف ليس صورة صالحة» — rather than a generic «تعذّر الرفع»).
 *
 * `FormData` and no `Content-Type`: the browser writes the multipart boundary itself, and a header written by hand would
 * make every upload a 400. The wait is longer than the client's 15 seconds because a phone sends a picture over a
 * mobile connection; nothing else here waits that long.
 */
const UPLOAD_WAIT_MS = 45_000;

export async function uploadWalletImage(walletId: string, file: File): Promise<string> {
  const body = new FormData();
  body.append('file', file);
  const data = await apiJson<{ imageKey?: unknown }>(`/api/finance/wallets/${encodeURIComponent(walletId)}/image`, {
    method: 'POST',
    body,
    timeoutMs: UPLOAD_WAIT_MS,
  });
  // An answer that is not a key we could draw is a failed upload, not a picture to keep.
  if (!isWalletImageKey(data.imageKey)) throw new Error('تعذّر رفع الصورة');
  return data.imageKey;
}
