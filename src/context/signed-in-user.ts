'use client';

import { createContext, useContext } from 'react';
import type { SessionUser } from '@/types/auth';

/**
 * THE SIGNED-IN PERSON, FOR A SHARED COMPONENT THAT ONLY WANTS TO KNOW WHO IS ASKING.
 *
 * `AppProvider` fills it beside its own context. It lives in its own file so a component drawn everywhere — the contact strip
 * (`ContactButtons`) — can read it without depending on `AppContext`, which many screens' tests replace wholesale: there, and
 * anywhere outside the signed-in shell, it reads null and the component offers nothing that needs a person.
 */
export const SignedInUserContext = createContext<SessionUser | null>(null);

export function useSignedInUser(): SessionUser | null {
  return useContext(SignedInUserContext);
}
