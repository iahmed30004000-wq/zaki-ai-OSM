'use client';

import React, { useEffect, useState } from 'react';
import { RiWifiOffLine } from '@remixicon/react';

/**
 * REGISTERING THE WORKER, AND SAYING WHEN THE LINE IS DOWN.
 *
 * The banner exists because of what the service worker deliberately does
 * NOT do. It queues nothing: a confirmation, a shipment or a cash movement
 * attempted with no signal fails there and then, and is not sent later.
 *
 * That is the right behaviour — replaying a forty-minute-old tap against a
 * world that has moved is how money gets written by accident — but it is
 * only safe if the person KNOWS. Somebody who believes their tap was "saved
 * for later" will not redo it, and the thing they meant to do simply never
 * happens. So the bar says both halves: the line is down, and nothing is
 * being kept.
 *
 * It sits at the top, above everything, and does not wait to be dismissed.
 */
export function OfflineWatch() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // navigator.onLine is only trustworthy when it says FALSE: a machine on
    // a wifi with no route out still reports true. Good enough for the
    // banner; the requests themselves are what actually prove it.
    const sync = () => setOffline(typeof navigator !== 'undefined' && !navigator.onLine);
    sync();
    addEventListener('online', sync);
    addEventListener('offline', sync);
    return () => {
      removeEventListener('online', sync);
      removeEventListener('offline', sync);
    };
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    /**
     * NOT IN DEVELOPMENT.
     *
     * The worker serves `/_next/static/` cache-first, which is safe in
     * production because every file there is content-hashed: changed bytes
     * mean a changed URL. In development they are NOT - the same URL is
     * rebuilt in place - so cache-first hands back yesterday's stylesheet
     * and yesterday's chunk, and the page renders the old colours over the
     * new markup. It cost an hour of chasing a "stale server" that was
     * this, and it will cost anybody else the same hour.
     *
     * A worker already installed on a developer's machine has to be taken
     * off it too, or it outlives the fix.
     */
    if (process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .then(() => (typeof caches !== 'undefined' ? caches.keys() : []))
        .then((keys) => Promise.all([...keys].map((k) => caches.delete(k))))
        .catch(() => undefined);
      return;
    }

    // After load: registering during hydration competes with the requests
    // the page is already making.
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (document.readyState === 'complete') register();
    else {
      addEventListener('load', register, { once: true });
      return () => removeEventListener('load', register);
    }
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      dir="rtl"
      className="sticky top-0 z-50 flex items-center gap-2 bg-[var(--sys-destructive)] px-3 py-2 text-sm text-[var(--sys-primary-foreground)]"
    >
      <RiWifiOffLine className="h-4 w-4 shrink-0" />
      <span>
        <strong>لا اتصال.</strong> لا شيء يُحفَظ الآن — أي إجراء تضغطه لن يُرسَل لاحقاً، أعِده بعد
        عودة الاتصال.
      </span>
    </div>
  );
}
