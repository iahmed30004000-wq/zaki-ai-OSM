/**
 * SHOULD THE LOGIN PAGE OFFER «نسيت كلمة المرور»? (A5)
 *
 * Not in production: nothing sends the reset message from a real server, so the link makes a promise nobody keeps and
 * invites a stranger to ask for reset tokens for any email. In development it stays, because the token is printed for
 * the developer. `NEXT_PUBLIC_SHOW_FORGOT_PASSWORD=true` brings it back in production; it is read when the app is built
 * (the browser has no environment), so changing it needs a new build.
 *
 * The two reads are written out literally, as `process.env.NAME`: that spelling is the only one the build replaces in
 * code that runs in the browser.
 */
export function showForgotLink(
  env: { nodeEnv: string | undefined; show: string | undefined } = {
    nodeEnv: process.env.NODE_ENV,
    show: process.env.NEXT_PUBLIC_SHOW_FORGOT_PASSWORD,
  }
): boolean {
  if (env.nodeEnv !== 'production') return true;
  return (env.show ?? '').trim().toLowerCase() === 'true';
}
