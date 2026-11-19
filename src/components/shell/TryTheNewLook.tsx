'use client';

import React, { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { useAppOptional } from '@/context/AppContext';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «جرّب الشكل الجديد» — OFFERED ONCE, NEVER FORCED (R5, 18/11).
 *
 * A NEW member of staff opens on «نظيف» (`NEW_STAFF_THEME`). Everybody who
 * already works here keeps the look they have: nothing writes their row.
 * This line is the only way the new look reaches them, and only by their
 * own press, through the same door the profile's picker uses
 * (`PATCH /api/profile/theme`).
 *
 * · Shown only when the look the frame was painted with is not «نظيف». It
 *   reads the frame's own attribute, which the SERVER wrote from
 *   `openingTheme` — so a look that comes from the role base counts too,
 *   and the shell does not have to carry the twelve palettes to ask.
 * · Never while the owner previews somebody («عاين كـ»): a preview is
 *   read-only, and a press here would be a write.
 * · Either answer hides it for good ON THIS DEVICE (a local key). Storage
 *   that fails means it shows again next time — never an error.
 * · A save that fails keeps the old look and says so in a sentence; the
 *   line stays, so the press can be tried again.
 * · In the page's flow, under the header: a bar laid over the page once hid
 *   the first row's buttons.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NEW_LOOK = 'clean';
const ANSWERED_KEY = 'zaki.newlook.answered';

function answered(): boolean {
  try {
    return localStorage.getItem(ANSWERED_KEY) === '1';
  } catch {
    return false;
  }
}

function remember() {
  try {
    localStorage.setItem(ANSWERED_KEY, '1');
  } catch {
    // Private mode or blocked storage: it simply asks again next time.
  }
}

/** Is this frame painted with another look, and has this device not answered yet? Asked in the browser only. */
function offered(): boolean {
  const painted = document.querySelector('[data-sys-theme]')?.getAttribute('data-sys-theme');
  return Boolean(painted) && painted !== NEW_LOOK && !answered();
}
const noSubscription = () => () => {};

export function TryTheNewLook() {
  const router = useRouter();
  const previewing = Boolean(useAppOptional()?.currentUser?.preview);
  // The server draws nothing (it has neither the frame's attribute nor the device's storage); the browser asks.
  const wanted = useSyncExternalStore(noSubscription, offered, () => false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!wanted || done || previewing) return null;

  const no = () => {
    remember();
    setDone(true);
  };

  const yes = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await apiFetch('/api/profile/theme', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: NEW_LOOK }),
      });
      if (!res.ok) throw new Error();
      remember();
      setDone(true);
      // The palette is written by the server for the look on the row: ask for the page again.
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="region" aria-label="الشكل الجديد" className="border-b border-[var(--sys-border)] bg-[var(--sys-card)] px-4 py-3">
      <p className="text-sm text-[var(--sys-foreground)]">
        في شكل جديد للنظام، أوضح وأهدى. جرّبه؟ بترجع لشكلك من الملف الشخصي وقت ما بدك.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" onClick={yes} disabled={busy}>
          جرّب الشكل الجديد
        </Button>
        <Button size="sm" variant="quiet" onClick={no} disabled={busy}>
          لا، شكراً
        </Button>
      </div>
      {failed && (
        <p role="alert" className="mt-2 text-sm text-[var(--sys-warning)]">
          ما قدرنا نحفظ الشكل الجديد هلّق، وشكلك ما تغيّر. جرّب كمان شوي.
        </p>
      )}
    </div>
  );
}
