'use client';

import { useSyncExternalStore } from 'react';

/**
 * IS THIS A PHONE-WIDTH SCREEN — below `md`, the width where `Rows` turns into cards.
 *
 * For the few screens whose phone layout is a DIFFERENT SET OF CONTROLS from the desk's, not the same
 * controls re-flowed: the bar that sits on the bottom edge of a phone holds buttons the desk draws
 * inline. Drawing both and hiding one with `md:hidden` leaves two copies of every button in the page —
 * two things a screen reader reads, two things a test cannot tell apart — so exactly one is drawn.
 *
 * The server and the first client render say «not a phone», so the desk never flashes the phone's
 * layout and nothing hydrates differently; a phone switches once, right after it mounts. Where there is
 * no `matchMedia` (a test, an old browser) it is the desk, which is the layout that has always been.
 */
const QUERY = '(max-width: 767.98px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

const snapshot = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
