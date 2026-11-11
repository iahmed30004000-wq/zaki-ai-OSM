'use client';

import React, { createContext, useContext } from 'react';
import { REMEMBERED_SESSION_DAYS } from '@/lib/session-length';

/**
 * WHAT THE SERVER SAYS ABOUT HOW LONG A SIGN-IN LASTS, FOR THE SCREEN THAT ASKS FOR ONE.
 *
 * The login page is a client component and the browser has no environment — a `NEXT_PUBLIC_` variable would be baked in at
 * build time, out of reach of a variable changed in Coolify. So the login LAYOUT (a server component, rendered at request
 * time) reads the switches and hands the answers down here, once. Nothing else in the page asks the environment.
 */
export interface SignInPolicy {
  /**
   * Whether «تذكرني» is drawn. Only while sign-ins are short (`AUTH_SHORT_SESSIONS=on`): when every sign-in lasts a year
   * the box would do nothing, and a box that does nothing is a box that lies.
   */
  rememberBox: boolean;
  /** Days a trusted device skips the six digits — the number the second-factor step prints on its tick box. */
  trustDays: number;
}

/**
 * What a page rendered OUTSIDE the layout gets (a test, a future screen that forgot): the rule as it was before 11/11 — the
 * box drawn, thirty days. The layout is the only place that says otherwise, and it says it from the switches.
 */
const BEFORE_11_11: SignInPolicy = { rememberBox: true, trustDays: REMEMBERED_SESSION_DAYS };

const PolicyContext = createContext<SignInPolicy>(BEFORE_11_11);

export function SignInPolicyProvider({ value, children }: { value: SignInPolicy; children: React.ReactNode }) {
  return <PolicyContext.Provider value={value}>{children}</PolicyContext.Provider>;
}

export function useSignInPolicy(): SignInPolicy {
  return useContext(PolicyContext);
}
