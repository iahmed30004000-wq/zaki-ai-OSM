import React from 'react';
import { SignInPolicyProvider } from '@/components/shell/SignInPolicy';
import { shortSessionsOn } from '@/lib/auth-switches';
import { trustDays } from '@/lib/trusted-device';

/**
 * THE SIGN-IN PAGE, TOLD BY THE SERVER HOW LONG A SIGN-IN LASTS.
 *
 * Rendered at request time (the system layout above it reads the session cookie, so nothing under it is built ahead): the
 * switches are read from the environment as it is NOW, so a variable changed in Coolify takes effect with a restart and no
 * rebuild. The page is a client component and cannot ask; see SignInPolicy.tsx.
 *
 *   · «تذكرني» is drawn only while sign-ins are short — when every one lasts a year the box would do nothing.
 *   · the second-factor step prints how many days a trusted device skips the code, from the same number the cookie uses.
 */
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <SignInPolicyProvider value={{ rememberBox: shortSessionsOn(), trustDays: trustDays() }}>
      {children}
    </SignInPolicyProvider>
  );
}
