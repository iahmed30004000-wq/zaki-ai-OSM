'use client';

import { useEffect, useState } from 'react';
import { isDesignId, loadDesign } from '@/lib/landing-designs/load';
import type { DesignSkin } from '@/lib/landing-designs/skin';

/**
 * THE BUILDER'S PREVIEW WEARS THE PAGE'S DESIGN — loaded when it is named.
 *
 * One chunk per design, fetched the first time the editor meets the id, so an
 * editor open on a page with no design downloads none of the sixty-four.
 * Until it arrives the preview is the page in its own look, which is also what
 * it stays if the id is one this build does not carry.
 */
export function useDesignSkin(id: string | null | undefined): DesignSkin | null {
  const [skin, setSkin] = useState<DesignSkin | null>(null);
  useEffect(() => {
    let live = true;
    // An unknown id needs no reset: the return below hands out only the skin of the id asked for.
    if (!isDesignId(id)) return;
    loadDesign(id).then((s) => {
      if (live) setSkin(s);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return skin && skin.id === id ? skin : null;
}
