'use client';

/**
 * SALESFLOW — useOrderOwnership (Phase C client integration for Phase B APIs)
 *
 * Manages: claim, edit-lock lifecycle (acquire/heartbeat/release),
 * and version-conflict state. All authorization is backend-enforced;
 * this hook only surfaces server decisions to the UI.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '@/context/AppContext';
import { LOCK_CONFIG } from '@/lib/lock-config';
import { apiFetch } from '@/lib/api-client';

const { heartbeatIntervalMs } = LOCK_CONFIG;

export type LockState = {
  locked: boolean;
  lockedByMe: boolean;
  lockedBy?: string | null;
  lockExpiresAt?: string | null;
  lockedAt?: string | null;
};

export function useOrderOwnership(orderId: string | null) {
  const { currentUser, t } = useApp();
  const [actionLoading, setActionLoading] = useState<null | 'claim' | 'lock' | 'release'>(null);
  const [message, setMessage] = useState<{ type: 'error' | 'success' | 'conflict'; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [inEditMode, setInEditMode] = useState(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Order currently holding OUR lock (or null) — lets the visibility handler
  // renew the lock without re-subscribing on every orderId change
  const lockedOrderIdRef = useRef<string | null>(null);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  /** Single lock renewal (PUT /lock). On failure (lock lost/expired) drop
   *  out of edit mode gracefully so the UI reflects server reality. */
  const renewLock = useCallback(async (): Promise<boolean> => {
    const id = lockedOrderIdRef.current;
    if (!id) return false;
    try {
      const res = await apiFetch(`/api/orders/${id}/lock`, { method: 'PUT' });
      if (!res.ok) {
        // 404/409 (lock lost/expired) or any other failure — exit edit mode
        stopHeartbeat();
        lockedOrderIdRef.current = null;
        setInEditMode(false);
        return false;
      }
      return true;
    } catch {
      stopHeartbeat();
      lockedOrderIdRef.current = null;
      setInEditMode(false);
      return false;
    }
  }, [stopHeartbeat]);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    heartbeatRef.current = setInterval(() => { void renewLock(); }, heartbeatIntervalMs);
  }, [renewLock, stopHeartbeat]);

  // Pause the heartbeat while the tab is hidden (browsers throttle timers in
  // background tabs anyway, so the renewals would be unreliable), then renew
  // immediately on return and restart the interval.
  //
  // Trade-off: while hidden, the heartbeat is NOT sent — a tab hidden for
  // longer than the server lock TTL (~5 minutes) lets the lock expire by
  // design. On return, renewLock() detects the loss and exits edit mode
  // gracefully instead of silently editing with a stale lock.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        stopHeartbeat();
      } else if (lockedOrderIdRef.current) {
        void renewLock().then((ok) => {
          if (ok) startHeartbeat();
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [renewLock, startHeartbeat, stopHeartbeat]);

  // Cleanup on unmount — server-side expiration remains the source of truth
  useEffect(() => stopHeartbeat, [stopHeartbeat]);

  // Stop renewing the PREVIOUS order's lock when navigating between orders
  // (the modal stays mounted while orderId changes)
  useEffect(() => {
    stopHeartbeat();
  }, [orderId, stopHeartbeat]);

  // Reset edit-mode/message state when the viewed order changes
  // (render-time reset — the React-endorsed alternative to setState-in-effect)
  const [prevOrderId, setPrevOrderId] = useState(orderId);
  if (prevOrderId !== orderId) {
    setPrevOrderId(orderId);
    setInEditMode(false);
    setMessage(null);
  }

  /** Claim + digital signature */
  const claim = useCallback(
    async (orderId: string, onDone?: () => void) => {
      setActionLoading('claim');
      setMessage(null);
      try {
        const res = await apiFetch(`/api/orders/${orderId}/claim`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setMessage({ type: 'conflict', text: `${t.alreadyClaimedBy} ${data.claimedBy ?? ''}` });
        } else if (res.ok) {
          setMessage({ type: 'success', text: t.claimSuccess });
          onDone?.();
        } else {
          setMessage({ type: 'error', text: data.error || t.actionError });
        }
        return res.ok;
      } catch (e) {
        console.error('claim failed:', e);
        setMessage({ type: 'error', text: t.actionError });
        return false;
      } finally {
        setActionLoading(null);
      }
    },
    [t]
  );

  /** Acquire edit lock, then start heartbeat while editing.
   *  Returns the server-assigned expiry so callers can update local order state,
   *  and, when it was refused, the sentence to show (`error`). */
  const acquireLock = useCallback(
    async (orderId: string): Promise<{ ok: boolean; lockExpiresAt?: string | null; error?: string }> => {
      setActionLoading('lock');
      setMessage(null);
      try {
        const res = await apiFetch(`/api/orders/${orderId}/lock`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.status === 423 || res.status === 409) {
          const text = data.errorAr || data.error || t.editingBy;
          setMessage({ type: 'error', text });
          return { ok: false, error: text };
        }
        if (res.ok) {
          setInEditMode(true);
          lockedOrderIdRef.current = orderId;
          // Heartbeat: renew own lock every 45s — only ONE interval, cleaned on exit
          startHeartbeat();
          return { ok: true, lockExpiresAt: data.lockExpiresAt ?? null };
        }
        /*
         * A REFUSAL (403, 404) USED TO RETURN `{ ok: false }` AND NOTHING ELSE.
         *
         * The card opened its form anyway, the save failed later, and the
         * reason — «الطلب غير موجود», «لا تملك صلاحية تعديل الطلبات» — was
         * never on screen. The door's own Arabic is handed back now; a
         * refusal with none still says, in Arabic, that the edit did not open.
         */
        const text: string = data.errorAr || 'تعذّر فتح الطلب للتعديل.';
        setMessage({ type: 'error', text });
        return { ok: false, error: text };
      } catch (e) {
        console.error('acquireLock failed:', e);
        setMessage({ type: 'error', text: t.actionError });
        return { ok: false, error: t.actionError };
      } finally {
        setActionLoading(null);
      }
    },
    [startHeartbeat, stopHeartbeat, t]
  );

  /** Release lock + stop heartbeat (save-complete or cancel) */
  const releaseLock = useCallback(
    async (orderId: string) => {
      stopHeartbeat();
      lockedOrderIdRef.current = null;
      setInEditMode(false);
      setActionLoading('release');
      try {
        await apiFetch(`/api/orders/${orderId}/lock`, { method: 'DELETE' }).catch(() => {});
      } catch (e) {
        // Network failure releasing the lock is non-fatal — server expiry
        // remains the source of truth
        console.error('releaseLock failed:', e);
      } finally {
        setActionLoading(null);
      }
    },
    [stopHeartbeat]
  );

  return {
    actionLoading, message, setMessage, inEditMode, setInEditMode,
    claim, acquireLock, releaseLock, stopHeartbeat,
    canManage: true, // UI hint only — the backend enforces real permissions
  };
}
