'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { SessionUser } from '@/types/auth';
import { translations } from '@/lib/i18n';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * App-wide client context. The interface is Arabic RTL only (contract
 * PART 7) — `locale` and `isRtl` are constants kept so screens that still
 * read them keep compiling until each is rebuilt in its own stage.
 */

interface AppContextType {
  locale: 'ar';
  t: (typeof translations)['ar'];
  isRtl: true;
  currentUser: SessionUser | null;
  setCurrentUser: (user: SessionUser | null) => void;
  refreshUser: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

/**
 * WHAT MAKES ONE SIGNED-IN PERSON DIFFERENT FROM ANOTHER, TO A BROWSER.
 *
 * Everything the screens draw from `currentUser`: who it is, the role, the status, the company, the look, and — the
 * one that decides which buttons exist — the permission keys. Sorted, so the same grants in another order are not a
 * change. Compared as one string so that the server sending a NEW object with the SAME contents (every
 * `router.refresh()` does) costs no render and does not overwrite what a screen set locally.
 */
function signatureOf(user: SessionUser | null | undefined): string {
  if (!user) return '';
  return JSON.stringify([
    user.id,
    user.role,
    user.status,
    user.companyId ?? null,
    user.companyName ?? null,
    user.name,
    user.email,
    user.avatar ?? null,
    user.systemTheme ?? null,
    user.roleTheme ?? null,
    user.tourDoneAt ?? null,
    user.commissionRate ?? null,
    [...(user.permissions ?? [])].sort(),
  ]);
}

/** The least time between two permission re-reads on coming back to the screen. */
const MIN_PERMISSION_GAP_MS = 60_000;
/** A 401 from «who am I» is asked once more after this long before it is believed. */
const RETRY_AFTER_401_MS = 2_000;

export function AppProvider({
  children,
  initialUser,
}: {
  children: React.ReactNode;
  initialUser?: SessionUser | null;
}) {
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(initialUser || null);

  /*
   * THE SERVER'S USER IS ADOPTED WHEN IT CHANGES — NOT ONLY WHEN THE PAGE FIRST OPENS.
   *
   * `useState(initialUser)` reads its argument once. This provider lives in the `(system)` layout, which holds the
   * sign-in pages AND the whole system, so it is never re-mounted by moving between them: signing in is
   * `router.push('/')` and `router.refresh()`, the server sends the new user, and React threw it away — the person
   * stayed `null` for the whole session, `userCan(null, …)` is false even for the owner, and every button behind it
   * was missing until F5. The same wall hid a changed role, and showed the PREVIOUS account's role to the next
   * person who signed in on the tab.
   *
   * This is React's own pattern for state that follows a prop: remember which server answer was adopted, and when a
   * different one arrives set the state DURING the render, so no frame is ever drawn with the old person. The
   * comparison is by content (`signatureOf`), not by identity, because every refresh hands over a new object — except
   * after a 401 emptied the screen, when ANY new answer is taken (see `cleared`).
   */
  const [seenProp, setSeenProp] = useState(initialUser);
  /** True from the moment a 401 emptied the screen until somebody is read back in. */
  const [cleared, setCleared] = useState(false);
  if (initialUser !== seenProp) {
    setSeenProp(initialUser);
    // A different person, role or key set — or ANY fresh answer once the screen was emptied, even for the very same
    // account (signed out in another tab and back in): the signature is equal then, and the person would stay `null`.
    if (cleared || signatureOf(initialUser) !== signatureOf(seenProp)) {
      setCurrentUser(initialUser || null);
      setCleared(false);
    }
  }
  /** Which server answer the screen was last given — a read that started under another one is stale. */
  const epochRef = useRef(seenProp);
  const clearedRef = useRef(cleared);
  const mounted = useRef(true);
  useEffect(() => {
    epochRef.current = seenProp;
    clearedRef.current = cleared;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const router = useContext(AppRouterContext);

  /** The one door to «who am I» — a 401 is a real answer (signed out), anything else says nothing. */
  const readMe = useCallback(async () => {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) return { user: null, answered: true as const };
    if (!res.ok) return { user: null, answered: false as const };
    return { user: ((await res.json()).user ?? null) as SessionUser | null, answered: true as const };
  }, []);

  const refreshUser = async () => {
    try {
      const res = await fetch('/api/auth/me');
      setCurrentUser(res.ok ? (await res.json()).user : null);
    } catch (e) {
      console.error(e);
    }
  };

  /*
   * PERMISSIONS CHANGED WHILE THE TAB WAS OPEN.
   *
   * The server judges every request afresh, so a refusal is always right — but the buttons are drawn from the copy
   * the browser got at sign-in. After the manager grants «طلب تعديل» the button stayed missing until F5, and after it
   * was withdrawn the button stayed and the server said no. So coming back to the tab or window re-reads the user —
   * through `useLiveRefresh`, the one place that knows how to listen for a return — at most once a minute, and
   * changes the state only when the answer is different, so an unchanged person costs no render.
   *
   * ── A 401 IS NOT YET «SIGNED OUT» ──
   * `/api/auth/me` answers 401 whenever `getCurrentUser()` is null, and that includes a database hiccup. Emptying
   * the screen on that one answer takes every button away for good, so a 401 is asked ONCE MORE after two seconds,
   * and only a second 401 empties it. Even then the screen asks the SERVER to decide (`router.refresh()`): if the
   * session is fine the layout sends the person back and the screen adopts them, same account or not. And reading
   * does not stop while the screen is empty after such a 401, so a later return restores it without F5.
   *
   * A read that FAILS any other way leaves the screen as it was, and an answer to an OLD question (another account
   * was adopted while it was on its way) is dropped. Nobody is read in at all while there is no one signed in on
   * this tab and no 401 has emptied it (the sign-in pages).
   */
  const userRef = useRef(currentUser);
  // The clock starts at mount (not in render: a read of the time is impure there) — a tab just opened has just been read.
  const lastReadAt = useRef(0);
  useEffect(() => {
    lastReadAt.current = Date.now();
  }, []);
  useEffect(() => {
    userRef.current = currentUser;
  });
  const followPermissions = useCallback(async () => {
    if (!userRef.current && !clearedRef.current) return;
    if (Date.now() - lastReadAt.current < MIN_PERMISSION_GAP_MS) return;
    lastReadAt.current = Date.now();
    const asked = epochRef.current;
    try {
      let answer = await readMe();
      if (answer.answered && !answer.user) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_401_MS));
        if (!mounted.current || epochRef.current !== asked) return;
        answer = await readMe();
      }
      if (!mounted.current || epochRef.current !== asked || !answer.answered) return;
      const { user } = answer;
      if (user) {
        setCurrentUser((previous) => (signatureOf(previous) === signatureOf(user) ? previous : user));
        setCleared(false);
      } else if (userRef.current) {
        setCurrentUser(null);
        setCleared(true);
        router?.refresh();
      }
    } catch {
      // A dropped connection is not «signed out».
    }
  }, [readMe, router]);
  useLiveRefresh(followPermissions, { initial: false });

  return (
    <AppContext.Provider
      value={{
        locale: 'ar',
        t: translations.ar,
        isRtl: true,
        currentUser,
        setCurrentUser,
        refreshUser,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used within AppProvider');
  }
  return ctx;
}

/**
 * The same, for a component that also renders outside the provider and
 * must not fall over there (the assistant's bubble, drawn in isolation by
 * its own tests). Null outside it.
 */
export function useAppOptional() {
  return useContext(AppContext);
}
