/**
 * A CLIENT-MADE ID for a document a screen asks a door to write (a stock transfer, a stock exit), made ONCE when the form
 * opens: the same press sent twice — a double click, a retry after a lost answer — carries the same id, and the door's
 * replay guard answers it as the one document it already is.
 *
 * Moved here from `StockTransfersScreen` (20/11, W6b) so the exit screen asks the same function instead of a copy of it.
 * Pure: no React, no session, no network.
 */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Older browsers: a version-4 shape from the browser's own random numbers.
  const b = new Uint8Array(16);
  c?.getRandomValues?.(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
